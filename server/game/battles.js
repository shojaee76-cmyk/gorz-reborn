'use strict';
// ============================================================
// Gorz Reborn — battles.js
// Turn-based PvP battle engine (DESIGN-v1.md §4.4).
//
//  - enterBattle(userId): matchmaking picks a suitable opponent
//    (close in level), snapshots both armies, runs the fight.
//  - Turn engine: every turn both sides' units strike each other;
//    casualties from attack vs defense; battle ends on rout or
//    BATTLE.maxTurns draw.
//  - Power formula (§4.4): power = Σ units.attack * count
//    * (1 + knowledgeMult) * heroMult * terrainMod
//  - Rewards: gold, XP, knowledge; ranking via ranking.js.
//  - Persists battles (state, log_json, winner_id) to DB.
//  - Live: emits per-turn events into the battle's socket room.
// ============================================================
const { db } = require('../db');
const { BATTLE, SOLDIERS, PLAYER } = require('./balance');
const { GameError } = require('./errors');
const { adjust } = require('./bank');
const barracks = require('./barracks');
const heroes = require('./heroes');
const missions = require('./missions');
const ranking = require('./ranking');

// Socket.IO instance, attached by server/index.js (avoid require cycle).
let io = null;
function setIo(instance) {
  io = instance;
}
// Emit a battle event to the battle room AND both players' personal
// rooms, so any authenticated socket for those users receives it even
// if it never explicitly joined the battle room.
function emitToBattle(battleId, attackerId, defenderId, event, payload) {
  if (!io) return;
  io.to(`battle:${battleId}`).emit(event, payload);
  if (attackerId) io.to(`user:${attackerId}`).emit(event, payload);
  if (defenderId) io.to(`user:${defenderId}`).emit(event, payload);
}

// Open challenges expire after this many seconds (battles.created_at).
const OPEN_BATTLE_TTL_SECONDS = 120;

// ---------------- power / army helpers ----------------

// +10% attack/defense per knowledge level (mirror KNOWLEDGE.perLevelMult).
const KNOWLEDGE_PER_LEVEL_MULT = 0.1;

// Knowledge multiplier: +10% attack/defense per knowledge level.
function knowledgeMult(knowledge) {
  return 1 + barracks.knowledgeLevel(knowledge) * KNOWLEDGE_PER_LEVEL_MULT;
}

// Per-unit-type power of a soldier group.
// power = attack * count * (1 + knowledgeMult)
function unitPower(type, attack, count, knowledge) {
  const mult = knowledgeMult(knowledge);
  return attack * count * mult;
}

// Full army power for a user: Σ unit power × hero mult × terrain.
// Snapshot: caller decides the hero row; terrain from BATTLE.terrain.
function armyPower(army, hero, terrain = 'plain') {
  const terrainMod = BATTLE.terrain[terrain] || 1.0;
  let raw = 0;
  for (const u of army) {
    if (!u || u.count <= 0) continue;
    raw += unitPower(u.type, u.attack, u.count, u.knowledge);
  }
  const heroMult = hero ? 1 + hero.attack_mod + hero.defense_mod : 1;
  return raw * heroMult * terrainMod;
}

// Snapshot a user's army + best hero into a stable battle-side object.
// One terrain is rolled per battle and shared by both sides.
function snapshotSide(userId, terrainOverride) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new GameError(404, 'کاربر یافت نشد.');
  const army = barracks.army(userId).map((s) => ({
    type: s.type,
    name: SOLDIERS[s.type].name,
    count: s.count,
    attack: s.attack,
    defense: s.defense,
    knowledge: s.knowledge,
    knowledge_level: s.knowledge_level,
  }));
  const bestHero = heroes.list(userId)[0] || null;
  const hero = bestHero
    ? { id: bestHero.id, name: bestHero.name, level: bestHero.level, ...heroes.modifier(bestHero) }
    : null;
  const terrain = terrainOverride || pickTerrain();
  return { user_id: userId, army, hero, terrain, power: armyPower(army, hero, terrain) };
}

// Deterministic terrain roll (uniform across all 3 types).
function pickTerrain() {
  const keys = Object.keys(BATTLE.terrain);
  return keys[Math.floor(Math.random() * keys.length)];
}

// ---------------- matchmaking ----------------

// Find a suitable opponent: highest-priority open battle first,
// else a random user within a level window (closest level first).
function findOpponent(userId, level) {
  // Open challenges: battles where attacker == defender (state 'open').
  // Only fresh ones (within the TTL window) are joinable.
  const open = db
    .prepare(
      `SELECT * FROM battles
       WHERE state = 'open' AND attacker_id = defender_id AND created_at >= ?
       ORDER BY id ASC
       LIMIT 20`
    )
    .all(new Date(Date.now() - OPEN_BATTLE_TTL_SECONDS * 1000).toISOString());
  if (open.length) {
    const b = open[0];
    return { battleId: b.id, attackerId: b.attacker_id, defenderId: b.defender_id, isOpen: true };
  }

  // Fresh match: prefer users close in level, exclude self, prefer
  // opponents who aren't already in a live battle.
  const candidates = db
    .prepare(
      `SELECT u.id, u.level, u.email
       FROM users u
       WHERE u.id != ?
         AND NOT EXISTS (
           SELECT 1 FROM battles b
           WHERE b.state IN ('open','running')
             AND (b.attacker_id = u.id OR b.defender_id = u.id)
         )
       ORDER BY ABS(u.level - ?) ASC, u.id ASC
       LIMIT 200`
    )
    .all(userId, level);
  if (!candidates.length) return null;
  const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 10))];
  return { attackerId: pick.id, defenderId: userId, isOpen: false };
}

// ---------------- engine ----------------

// Compute one side's strikes against the other. Returns a map of
// type -> { killed, totalPower } for the target side, plus the
// attacking side's total strike power.
// Kills are proportional to power share and bounded so a single turn
// can't wipe out an entire army (casualties taper as units die).
function resolveStrikes(attacker, defender) {
  const strikes = {};
  let strikePower = 0;
  for (const u of attacker.army) {
    if (u.count <= 0) continue;
    const p = unitPower(u.type, u.attack, u.count, u.knowledge);
    if (p <= 0) continue;
    strikes[u.type] = { killed: 0, totalPower: p };
    strikePower += p;
  }
  if (strikePower <= 0) return { strikes, strikePower, kills: {} };

  const defTotal = defender.army.reduce((acc, u) => acc + u.defense * u.count, 0) || 1;
  const kills = {};
  for (const u of defender.army) {
    if (u.count <= 0) continue;
    const share = (u.defense * u.count) / defTotal;
    // Casualty fraction scales with relative power, decays as the
    // defender loses units (share drops). Capped at 45% per turn so
    // a fight always lasts several turns.
    let killed = Math.floor(strikePower * share * 0.1);
    killed = Math.min(killed, Math.ceil(u.count * 0.45), u.count);
    if (killed > 0) kills[u.type] = killed;
  }
  return { strikes, strikePower, kills };
}

// Execute one turn. Returns events describing casualties for the log.
// Each event names the ACTING side and the units they destroyed.
function runTurn(state, turn) {
  const events = [];
  const a = state.attacker;
  const d = state.defender;

  const aStrike = resolveStrikes(a, d);
  const dStrike = resolveStrikes(d, a);

  applyKills(d, aStrike.kills);
  applyKills(a, dStrike.kills);

  // attacker's strikes destroyed defender units
  for (const type of Object.keys(aStrike.kills)) {
    events.push({
      turn,
      acting: 'attacker',
      target: 'defender',
      type,
      killed: aStrike.kills[type],
      power: aStrike.strikes[type] ? aStrike.strikes[type].totalPower : 0,
    });
  }
  // defender's strikes destroyed attacker units
  for (const type of Object.keys(dStrike.kills)) {
    events.push({
      turn,
      acting: 'defender',
      target: 'attacker',
      type,
      killed: dStrike.kills[type],
      power: dStrike.strikes[type] ? dStrike.strikes[type].totalPower : 0,
    });
  }
  if (!events.length) {
    events.push({ turn, acting: 'none', target: null, type: null, killed: 0, power: 0, note: 'round of no casualties' });
  }

  return events;
}

function applyKills(side, kills) {
  for (const type of Object.keys(kills)) {
    const u = side.army.find((x) => x.type === type);
    if (u) u.count = Math.max(0, u.count - kills[type]);
  }
}

function sideAlive(side) {
  return side.army.some((u) => u.count > 0);
}

// Current combat power of a (possibly damaged) side snapshot.
function sidePower(side) {
  return armyPower(side.army, side.hero, side.terrain);
}

// A side routs once its current power drops below routThreshold of
// its starting power (DESIGN-v1.md §4.4: "battle ends on rout").
function sideRouted(side) {
  const start = side.startPower || side.power || 1;
  return sidePower(side) < start * BATTLE.routThreshold;
}

// Full fight simulation. Returns { winner: 'attacker'|'defender'|'draw',
// turns, log, attacker, defender } where attacker/defender are the
// mutated side snapshots.
function simulate(state) {
  const log = [];
  let turn = 0;
  let winner = null;

  // remember starting power for rout checks
  state.attacker.startPower = state.attacker.power;
  state.defender.startPower = state.defender.power;

  for (turn = 1; turn <= BATTLE.maxTurns; turn++) {
    const events = runTurn(state, turn);
    log.push({ turn, events });
    state.attacker.army = state.attacker.army.filter((u) => u.count > 0);
    state.defender.army = state.defender.army.filter((u) => u.count > 0);

    const aAlive = sideAlive(state.attacker);
    const dAlive = sideAlive(state.defender);
    if (!aAlive && !dAlive) { winner = 'draw'; break; }
    if (!dAlive) { winner = 'attacker'; break; }
    if (!aAlive) { winner = 'defender'; break; }

    // rout check: a side below 25% of starting power flees.
    // If both rout the same turn, the one with more power left wins.
    const aRouted = sideRouted(state.attacker);
    const dRouted = sideRouted(state.defender);
    if (aRouted && dRouted) {
      const aPow = sidePower(state.attacker);
      const dPow = sidePower(state.defender);
      winner = aPow === dPow ? 'draw' : aPow > dPow ? 'attacker' : 'defender';
      break;
    }
    if (dRouted) { winner = 'attacker'; break; }
    if (aRouted) { winner = 'defender'; break; }
  }
  if (!winner) winner = 'draw'; // maxTurns reached -> draw

  return { winner, turns: turn, log, attacker: state.attacker, defender: state.defender };
}

// ---------------- rewards ----------------

// Apply battle rewards (gold/XP/knowledge) + ranking + persistence.
// Returns { battleId, winner, log, rewards } for both sides.
function finalizeBattle(battleId, attackerId, defenderId, result) {
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const logJson = JSON.stringify({ winner: result.winner, turns: result.turns, log: result.log });

    let winnerUserId = null;
    if (result.winner === 'attacker') winnerUserId = attackerId;
    else if (result.winner === 'defender') winnerUserId = defenderId;

    db.prepare(
      `UPDATE battles SET state = 'finished', log_json = ?, winner_id = ?, ended_at = ?
       WHERE id = ? AND state IN ('open','running')`
    ).run(logJson, winnerUserId, now, battleId);

    const rewards = {};
    for (const [key, side] of [['attacker', result.attacker], ['defender', result.defender]]) {
      const uid = key === 'attacker' ? attackerId : defenderId;
      const won = result.winner === key;
      const draw = result.winner === 'draw';
      const reward = draw
        ? { gold: BATTLE.reward.drawGold, xp: BATTLE.reward.drawXp, outcome: 'draw' }
        : won
          ? { gold: BATTLE.reward.winGold, xp: BATTLE.reward.winXp, outcome: 'win' }
          : { gold: BATTLE.reward.loseGold, xp: BATTLE.reward.loseXp, outcome: 'lose' };

      // gold + commander XP
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      adjust(uid, { gold: reward.gold, kind: 'battle', note: `نتیجه نبرد: ${reward.outcome}` });
      const leveled = grantCommanderXp(user, reward.xp);

      // knowledge to each surviving soldier group
      const knowledgeGains = [];
      for (const u of side.army) {
        if (u.count <= 0) continue;
        const gain = barracks.addKnowledge(uid, u.type, BATTLE.reward.winKnowledge);
        knowledgeGains.push(gain);
      }

      // ranking + win/loss counters
      ranking.applyBattleResult(uid, reward.outcome);

      rewards[key] = { ...reward, knowledgeGains, leveled };
    }

    // mission progress (battle/win missions)
    missions.refresh(attackerId);
    missions.refresh(defenderId);

    return { rewards };
  });
  return tx();
}

// Commander XP + level-ups (mirrors missions.claim logic).
function grantCommanderXp(user, amount) {
  let xp = user.xp + Math.max(0, Math.floor(amount));
  let level = user.level;
  let levelUps = 0;
  while (level < PLAYER.maxLevel && xp >= level * PLAYER.xpPerLevel) {
    xp -= level * PLAYER.xpPerLevel;
    level += 1;
    levelUps += 1;
  }
  if (level >= PLAYER.maxLevel) xp = 0;
  db.prepare('UPDATE users SET xp = ?, level = ? WHERE id = ?').run(xp, level, user.id);
  if (levelUps > 0) {
    adjust(user.id, {
      gold: levelUps * PLAYER.levelUpGold,
      diamonds: levelUps * PLAYER.levelUpDiamonds,
      kind: 'levelup',
      note: `ارتقای فرمانده به سطح ${level}`,
    });
  }
  return { xp, level, levelUps };
}

// Expire open challenges nobody joined within the TTL window.
// Mark them finished with no winner (never fought).
function expireStaleOpens() {
  const stale = db
    .prepare(
      `SELECT id FROM battles
       WHERE state = 'open' AND attacker_id = defender_id AND created_at < ?`
    )
    .all(new Date(Date.now() - OPEN_BATTLE_TTL_SECONDS * 1000).toISOString());
  const upd = db.prepare("UPDATE battles SET state = 'finished', ended_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  for (const b of stale) upd.run(now, b.id);
  return stale.length;
}

// ---------------- public API ----------------

// Enter battle: matchmake, snapshot, run the fight, persist, emit.
function enterBattle(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new GameError(404, 'کاربر یافت نشد.');

  const inBattle = db
    .prepare("SELECT id FROM battles WHERE (attacker_id = ? OR defender_id = ?) AND state IN ('open','running')")
    .get(userId, userId);
  if (inBattle) throw new GameError(400, 'شما هم‌اکنون در یک نبرد هستید.');

  const opp = findOpponent(user.id, user.level);
  if (!opp) throw new GameError(409, 'هم‌نبرد مناسبی یافت نشد؛ کمی بعد دوباره تلاش کنید.');

  let battleId;
  let attackerId;
  let defenderId;

  if (opp.isOpen) {
    battleId = opp.battleId;
    attackerId = opp.attackerId;
    defenderId = userId; // user joins as defender of an open challenge
    // Claim the open challenge: set real defender, flip to running.
    db.prepare("UPDATE battles SET defender_id = ?, state = 'running' WHERE id = ?").run(defenderId, battleId);
  } else {
    attackerId = userId;
    defenderId = opp.attackerId;
    const info = db
      .prepare("INSERT INTO battles (attacker_id, defender_id, state, created_at) VALUES (?,?,?,?)")
      .run(attackerId, defenderId, 'running', new Date().toISOString());
    battleId = info.lastInsertRowid;
  }

  // Snapshot both sides AFTER the battle row exists (open battles were
  // snapshotted by their challenger, so re-snapshot from live state).
  // One terrain is rolled and shared by both sides.
  const terrain = pickTerrain();
  const aSide = snapshotSide(attackerId, terrain);
  const dSide = snapshotSide(defenderId, terrain);
  const state = { attacker: aSide, defender: dSide };

  const result = simulate(state);
  const { rewards } = finalizeBattle(battleId, attackerId, defenderId, result);

  const log = {
    battleId,
    attacker: aSide,
    defender: dSide,
    turns: result.turns,
    winner: result.winner,
    log: result.log,
    rewards,
    ended_at: new Date().toISOString(),
  };

  // live socket update (both players are in the battle room + personal room)
  emitToBattle(battleId, attackerId, defenderId, 'battle:finished', serialize(log));

  return { battleId, ...log };
}

// Open a challenge: matchmaking finds an opponent LATER (state='open').
// The challenger waits; the next enterBattle picks them up.
function openChallenge(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new GameError(404, 'کاربر یافت نشد.');
  const inBattle = db
    .prepare("SELECT id FROM battles WHERE (attacker_id = ? OR defender_id = ?) AND state IN ('open','running')")
    .get(userId, userId);
  if (inBattle) throw new GameError(400, 'شما هم‌اکنون در یک نبرد هستید.');

  const info = db
    .prepare("INSERT INTO battles (attacker_id, defender_id, state, created_at) VALUES (?,?,?,?)")
    .run(userId, userId, 'open', new Date().toISOString());
  return db.prepare('SELECT * FROM battles WHERE id = ?').get(info.lastInsertRowid);
}

// Public battle status (log + sides + winner + rewards).
function battleStatus(battleId, requesterId) {
  const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(battleId);
  if (!b) throw new GameError(404, 'نبرد یافت نشد.');
  if (b.attacker_id !== requesterId && b.defender_id !== requesterId) {
    throw new GameError(403, 'شما در این نبرد شرکت ندارید.');
  }
  let parsed = null;
  if (b.log_json) {
    try { parsed = JSON.parse(b.log_json); } catch { /* corrupt log */ }
  }
  // Keep log_json (raw persisted form) AND the parsed `log` object.
  return { ...b, log: parsed };
}

// Recent battles involving a user (dashboard history).
function battleHistory(userId, limit = 10) {
  return db
    .prepare(
      `SELECT id, attacker_id, defender_id, state, winner_id, created_at, ended_at
       FROM battles
       WHERE attacker_id = ? OR defender_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, userId, Math.min(Math.max(1, Number(limit) || 10), 50));
}

// Serialize a finished battle for socket/API consumers.
function serialize(battle) {
  return {
    battleId: battle.battleId,
    winner: battle.winner,
    turns: battle.turns,
    attacker: {
      user_id: battle.attacker.user_id,
      hero: battle.attacker.hero,
      terrain: battle.attacker.terrain,
      power: battle.attacker.power,
      army: battle.attacker.army,
    },
    defender: {
      user_id: battle.defender.user_id,
      hero: battle.defender.hero,
      terrain: battle.defender.terrain,
      power: battle.defender.power,
      army: battle.defender.army,
    },
    log: battle.log,
    rewards: battle.rewards,
    ended_at: battle.ended_at,
  };
}

module.exports = {
  setIo,
  enterBattle,
  openChallenge,
  battleStatus,
  battleHistory,
  expireStaleOpens,
  armyPower,
  unitPower,
  snapshotSide,
};
