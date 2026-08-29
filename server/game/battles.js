'use strict';
// ============================================================
// Gorz Reborn — battles.js (v2, interactive tactical combat)
//
// Battle flow (interactive mode):
//   1. enterBattle(): matchmaking (unchanged), snapshots BOTH armies,
//      deploys squads on the tactics grid, persists live state,
//      emits battle:start. Round 1 begins.
//   2. Each round both commanders submit orders
//      (submitOrders): move destination, focus-fire target, stance.
//      When both are in, the round resolves server-side (movement ->
//      simultaneous strikes -> counters -> morale -> outcome), the
//      replay events are emitted (battle:round), state re-persisted.
//   3. A side that misses the order window gets AI orders
//      (in-process timer + lazy deadline sweep for restarts).
//   4. Outcome -> applyBattleResult(): REAL casualties persisted to
//      soldiers.count, rewards (gold/xp/knowledge to SURVIVORS),
//      ranking, missions, commander/hero XP — then battle:finished.
//
// GORZ_BATTLE_MODE=auto resolves the entire battle instantly with
// aiOrders for both sides (used by the E2E suite + quick demos);
// responses keep the legacy shape (winner/log/rewards in one call).
//
// All simulation math lives in game/tactics.js; all knobs in balance.js.
// ============================================================
const { db } = require('../db');
const { SOLDIERS, BATTLE, TACTICS } = require('./balance');
const { GameError } = require('./errors');
const { adjust } = require('./bank');
const barracks = require('./barracks');
const heroes = require('./heroes');
const missions = require('./missions');
const ranking = require('./ranking');
const tactics = require('./tactics');

const INTERACTIVE = (process.env.GORZ_BATTLE_MODE || 'interactive') !== 'auto';

// ---------------- single-player (vs AI) support ----------------
// When no human opponent is available, a solo commander can still play:
// the other side is filled by an AI commander. The AI lives as a dummy
// user row (id = -1) so battles.defender_id's FK is satisfied, and its
// army is built directly by buildAiSide() instead of read from barracks.
const AI_USER_ID = -1;
function ensureAiUser() {
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(AI_USER_ID);
  if (!exists) {
    db.prepare('INSERT INTO users (id, email, level, password_hash, created_at) VALUES (?,?,?,?,?)')
      .run(AI_USER_ID, 'ai@bot.local', 1, '', new Date().toISOString());
  }
}
// Build an AI tactical side scaled to the human commander's level, so a
// solo fight is a fair scrap, not a cannon fodder stroll.
function buildAiSide(level) {
  const lvl = Math.max(1, level || 1);
  const scale = 1 + (lvl - 1) * 0.15; // ~15% stronger per level
  const rows = [
    { type: 'swordsman', count: Math.round(6 * scale), attack: 18, defense: 14, knowledge_level: 0 },
    { type: 'archer',     count: Math.round(4 * scale), attack: 22, defense: 10, knowledge_level: 0 },
    { type: 'cavalry',    count: Math.round(2 * scale), attack: 26, defense: 16, knowledge_level: 0 },
  ];
  const hero = { id: 0, name: 'واشر', level: lvl, ...heroes.modifier({ level: lvl }) };
  const side = tactics.buildSide(AI_USER_ID, hero, rows);
  side.user = { id: AI_USER_ID, email: 'ai@bot.local', level: lvl };
  return side;
}
function isAiSide(row, side) {
  const id = side === 'attacker' ? row.attacker_id : row.defender_id;
  return id === AI_USER_ID;
}

// Socket.IO instance, attached by server/index.js (avoid require cycle).
let io = null;
function setIo(instance) {
  io = instance;
}
function emitToBattle(battleId, attackerId, defenderId, event, payload) {
  if (!io) return;
  io.to(`battle:${battleId}`).emit(event, payload);
  if (attackerId) io.to(`user:${attackerId}`).emit(event, payload);
  if (defenderId) io.to(`user:${defenderId}`).emit(event, payload);
}

// Open challenges expire after this many seconds (battles.created_at).
const OPEN_BATTLE_TTL_SECONDS = 120;

// ---------------- schema migration ----------------
// Live battles need their state frozen between rounds.
try {
  db.exec(`ALTER TABLE battles ADD COLUMN battle_state_json TEXT`);
} catch (e) { /* column exists */ }
try {
  db.exec(`ALTER TABLE battles ADD COLUMN orders_json TEXT`);
} catch (e) { /* column exists */ }
try {
  db.exec(`ALTER TABLE battles ADD COLUMN turn_deadline INTEGER`);
} catch (e) { /* column exists */ }
try {
  db.exec(`ALTER TABLE battles ADD COLUMN round INTEGER NOT NULL DEFAULT 0`);
} catch (e) { /* column exists */ }

// ---------------- matchmaking ----------------
function findOpponent(userId, level) {
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

function assertNotInBattle(userId) {
  const inBattle = db
    .prepare("SELECT id FROM battles WHERE (attacker_id = ? OR defender_id = ?) AND state IN ('open','running')")
    .get(userId, userId);
  if (inBattle) throw new GameError(400, 'شما هم‌اکنون در یک نبرد هستید.');
}

// ---------------- side building ----------------
// Snapshot a user's army (+best hero) into tactics.buildSide rows.
function buildTacticsSide(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new GameError(404, 'کاربر یافت نشد.');
  const bestHero = heroes.list(userId)[0] || null;
  const hero = bestHero
    ? { id: bestHero.id, name: bestHero.name, level: bestHero.level, ...heroes.modifier(bestHero) }
    : null;
  const rows = barracks.army(userId).map((r) => ({
    type: r.type,
    count: r.count,
    attack: r.attack,
    defense: r.defense,
    knowledge_level: r.knowledge_level || 0,
  }));
  const side = tactics.buildSide(userId, hero, rows);
  side.user = { id: user.id, email: user.email, level: user.level };
  return side;
}

// ---------------- persistence of live state ----------------
function saveLiveState(battleId, state, orders, deadlineSet) {
  const ordersJson =
    orders === undefined
      ? null // leave unchanged
      : JSON.stringify(orders);
  const deadline = deadlineSet ? Date.now() / 1000 + TACTICS.orderTimerSec : null;
  db.prepare(
    `UPDATE battles SET battle_state_json = ?, round = ?,
       orders_json = COALESCE(?, orders_json),
       turn_deadline = COALESCE(?, turn_deadline)
     WHERE id = ?`
  ).run(
    JSON.stringify(tactics.serializeState(state)),
    state.round,
    ordersJson,
    deadline,
    battleId
  );
}

function loadLiveBattle(battleId) {
  const b = db
    .prepare("SELECT * FROM battles WHERE id = ? AND state = 'running'")
    .get(battleId);
  if (!b || !b.battle_state_json) return null;
  let frozen;
  try {
    frozen = JSON.parse(b.battle_state_json);
  } catch {
    return null;
  }
  const state = tactics.restoreState(frozen);
  let orders = { attacker: null, defender: null };
  try {
    if (b.orders_json) orders = JSON.parse(b.orders_json);
  } catch { /* fresh */ }
  return { row: b, state, orders };
}

// Sweep running battles past their deadline: AI-submits the missing
// side and resolves. Called opportunistically (cheap indexed query).
function sweepDeadlines() {
  if (INTERACTIVE) {
    const stale = db
      .prepare(
        "SELECT id FROM battles WHERE state = 'running' AND turn_deadline IS NOT NULL AND turn_deadline < ?"
      )
      .all(Date.now() / 1000);
    for (const b of stale) {
      try {
        aiResolveIfDue(b.id);
      } catch (err) {
        console.error('[battles] deadline sweep failed for', b.id, err.message);
      }
    }
  }
}

// ---------------- in-process AI timers ----------------
const aiTimers = new Map(); // battleId -> timeout

function armAiTimer(battleId, missingSide) {
  clearAiTimer(battleId);
  const t = setTimeout(() => {
    aiTimers.delete(battleId);
    try {
      aiResolveIfDue(battleId);
    } catch (err) {
      console.error('[battles] ai timer failed for', battleId, err.message);
    }
  }, TACTICS.orderTimerSec * 1000);
  t.unref();
  aiTimers.set(battleId, t);
}

function clearAiTimer(battleId) {
  const t = aiTimers.get(battleId);
  if (t) {
    clearTimeout(t);
    aiTimers.delete(battleId);
  }
}

// If the given battle is still awaiting orders past its deadline,
// fill the missing side(s) with AI orders and resolve the round.
function aiResolveIfDue(battleId) {
  const live = loadLiveBattle(battleId);
  if (!live) return null;
  const { row, state, orders } = live;
  const due =
    !INTERACTIVE ||
    !row.turn_deadline ||
    row.turn_deadline <= Date.now() / 1000;
  if (!due) return null;

  if (orders.attacker == null) orders.attacker = tactics.validateOrders(state, 'attacker', tactics.aiOrders(state, 'attacker'));
  if (orders.defender == null) orders.defender = tactics.validateOrders(state, 'defender', tactics.aiOrders(state, 'defender'));
  return resolveAndAdvance(row, state, orders);
}

// Resolve one round from complete orders; finish the battle if over.
function resolveAndAdvance(row, state, orders) {
  const { events, outcome } = tactics.resolveRound(state, orders);

  if (outcome.over) {
    return finalizeBattle(row, state, orders, null, outcome);
  }

  saveLiveState(row.id, state, { attacker: null, defender: null }, true);
  emitToBattle(row.id, row.attacker_id, row.defender_id, 'battle:round', {
    battleId: row.id,
    round: state.round,
    events,
    viewFor: null,
    views: {
      attacker: getView(state, 'attacker', false),
      defender: getView(state, 'defender', false),
    },
  });
  armAiTimer(row.id, 'both');
  return { resolved: true, events, outcome };
}

// ---------------- public API ----------------

// Enter battle: matchmake, deploy the tactical battlefield.
// Interactive mode returns the round-1 view; auto mode fights to the end.
function enterBattle(userId) {
  sweepDeadlines();
  assertNotInBattle(userId);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new GameError(404, 'کاربر یافت نشد.');

  const opp = findOpponent(user.id, user.level);
  let battleId;
  let attackerId;
  let defenderId;
  if (!opp) {
    // No human commander available -> spin up an AI opponent so a single
    // player can still play the battle end-to-end (vs AI).
    ensureAiUser();
    attackerId = user.id;
    defenderId = AI_USER_ID;
    const info = db
      .prepare("INSERT INTO battles (attacker_id, defender_id, state, created_at) VALUES (?,?,?,?)")
      .run(attackerId, defenderId, 'running', new Date().toISOString());
    battleId = info.lastInsertRowid;
  } else if (opp.isOpen) {
    battleId = opp.battleId;
    attackerId = opp.attackerId;
    defenderId = userId;
    db.prepare("UPDATE battles SET defender_id = ?, state = 'running' WHERE id = ?").run(defenderId, battleId);
  } else {
    attackerId = userId;
    defenderId = opp.attackerId;
    const info = db
      .prepare("INSERT INTO battles (attacker_id, defender_id, state, created_at) VALUES (?,?,?,?)")
      .run(attackerId, defenderId, 'running', new Date().toISOString());
    battleId = info.lastInsertRowid;
  }

  // Build both tactical sides from LIVE armies. (AI side is synthetic.)
  const aSide = buildTacticsSide(attackerId);
  const dSide = defenderId === AI_USER_ID ? buildAiSide(user.level) : buildTacticsSide(defenderId);
  const state = tactics.createBattleState(battleId, aSide, dSide);

  const vsAi = isAiSide({ attacker_id: attackerId, defender_id: defenderId }, 'defender');

  // Persist deployment + reset orders/deadline for round 1.
  db.prepare(
    `UPDATE battles SET battle_state_json = ?, round = 0,
       orders_json = ?, turn_deadline = ?
     WHERE id = ?`
  ).run(
    JSON.stringify(tactics.serializeState(state)),
    JSON.stringify({ attacker: null, defender: null }),
    vsAi ? null : Date.now() / 1000 + TACTICS.orderTimerSec, // vs AI: human moves first, deadline after their submit
    battleId
  );

  // Expose vsAi on each side's view so the SPA knows it's single-player.
  const aView = getView(state, 'attacker', false);
  const dView = getView(state, 'defender', false);
  aView.vsAi = vsAi;
  dView.vsAi = vsAi;
  emitToBattle(battleId, attackerId, defenderId, 'battle:start', {
    battleId,
    vsAi,
    views: { attacker: aView, defender: dView },
  });

  if (!INTERACTIVE) {
    // AUTO MODE: fight the entire battle right now (AI vs AI) and
    // answer with the legacy single-shot result payload.
    let outcome = { over: false };
    let lastEvents = [];
    while (!outcome.over && state.round < TACTICS.maxRounds + 1) {
      const res = tactics.resolveRound(state, {
        attacker: tactics.validateOrders(state, 'attacker', tactics.aiOrders(state, 'attacker')),
        defender: tactics.validateOrders(state, 'defender', tactics.aiOrders(state, 'defender')),
      });
      outcome = res.outcome;
      lastEvents = res.events;
    }
    return finalizeBattle({ id: battleId, attacker_id: attackerId, defender_id: defenderId }, state, null, null, outcome);
  }

  armAiTimer(battleId, 'both');
  const me = userId === attackerId ? 'attacker' : 'defender';
  const retView = getView(state, me, false);
  retView.vsAi = vsAi;
  return {
    battleId,
    mode: 'interactive',
    side: me,
    vsAi,
    view: retView,
  };
}

// Submit this round's orders for one side. Resolves when both are in.
function submitOrders(userId, battleId, rawOrders) {
  if (!INTERACTIVE) throw new GameError(400, 'این نبرد در حالت خودکار است.');
  sweepDeadlines();

  const live = loadLiveBattle(Number(battleId));
  if (!live) throw new GameError(404, 'نبرد جاری یافت نشد.');
  const { row, state, orders } = live;
  if (row.attacker_id !== userId && row.defender_id !== userId) {
    throw new GameError(403, 'شما در این نبرد شرکت ندارید.');
  }
  const side = row.attacker_id === userId ? 'attacker' : 'defender';
  if (orders[side]) throw new GameError(400, 'دستورات این دور ثبت شده است؛ منتظر حریف باشید.');

  orders[side] = tactics.validateOrders(state, side, rawOrders || {});

  // vs AI: the other side is the AI commander — auto-fill its orders and
  // resolve the round immediately, so a single human submission plays a
  // full turn (human orders -> AI orders -> resolve -> next round).
  const other = side === 'attacker' ? 'defender' : 'attacker';
  const otherIsAi = isAiSide({ attacker_id: row.attacker_id, defender_id: row.defender_id }, other);
  if (!otherIsAi && (orders.attacker == null || orders.defender == null)) {
    // half-in: persist, wait for the opponent (deadline covers AFK)
    saveLiveState(row.id, state, orders, true);
    armAiTimer(row.id, other);
    emitToBattle(row.id, row.attacker_id, row.defender_id, 'battle:waiting', {
      battleId: row.id,
      round: state.round,
      submitted: { attacker: orders.attacker != null, defender: orders.defender != null },
    });
    return { ok: true, waiting: true, vsAi: false, view: getView(state, side, true) };
  }

  // Both sides have orders (AI auto-filled if needed). Resolve the round.
  if (otherIsAi && orders[other] == null) {
    orders[other] = tactics.validateOrders(state, other, tactics.aiOrders(state, other));
  }
  const result = resolveAndAdvance(row, state, orders);
  const me = userId === row.attacker_id ? 'attacker' : 'defender';
  const retView = getView(state, me, false);
  retView.vsAi = true;
  const out = {
    ok: true,
    vsAi: true,
    waiting: false,
    resolved: !!result && (result.resolved === true),
    ...result, // {resolved,events,outcome} (mid-battle) OR finalizeBattle payload {winner,...}
    view: retView,
  };
  // If the battle just ended, surface the win/loss outcome for the SPA.
  if (result && result.winner !== undefined) {
    out.myOutcome = result.winner === me ? 'win'
      : result.winner === (me === 'attacker' ? 'defender' : 'attacker') ? 'lose'
      : 'draw';
  }
  return out;
}

// Live view for a participant (also used after reconnect).
function getLiveView(userId, battleId) {
  sweepDeadlines();
  const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(Number(battleId));
  if (!b) throw new GameError(404, 'نبرد یافت نشد.');
  if (b.attacker_id !== userId && b.defender_id !== userId) {
    throw new GameError(403, 'شما در این نبرد شرکت ندارید.');
  }
  if (b.state !== 'running') return battleStatus(battleId, userId);
  const live = loadLiveBattle(b.id);
  if (!live) throw new GameError(500, 'وضعیت نبرد خراب است.');
  const side = b.attacker_id === userId ? 'attacker' : 'defender';
  const submitted =
    live.orders[side] != null;
  const view = getView(live.state, side, submitted);
  view.vsAi = isAiSide({ attacker_id: b.attacker_id, defender_id: b.defender_id }, view.you === 'attacker' ? 'defender' : 'attacker');
  return { ok: true, battleId: b.id, state: 'running', side, round: live.state.round, view };
}

// Client-facing projection of the battlefield for one side.
// Enemy squad morale is fuzzed to a band (fog of morale).
function getView(state, side, submitted) {
  const foeSide = side === 'attacker' ? 'defender' : 'attacker';
  const projSquad = (s, mine) => ({
    id: s.id,
    type: s.type,
    name: s.name,
    role: s.role,
    count: Math.max(0, Math.round(s.count)),
    hp: Math.round(s.hp),
    maxHp: s.maxHp,
    x: s.x,
    y: s.y,
    mp: s.mp,
    range: s.range,
    routed: !!s.routed,
    onKeep: !!s.onKeep,
    ...(mine
      ? { morale: Math.round(s.morale), unitAtk: Math.round(s.unitAtk * 10) / 10, unitDef: Math.round(s.unitDef * 10) / 10 }
      : { moraleBand: s.morale > 66 ? 'high' : s.morale > 33 ? 'medium' : 'low' }),
  });
  const powFrac = (sd) => tactics.sidePower(state, sd) / Math.max(state[sd].startPower, 1);
  return {
    battleId: state.battleId,
    grid: state.grid,
    terrain: state.terrain,
    obstacles: state.obstacles,
    keeps: state.keeps,
    objectives: state.objectives || { attacker: 0, defender: 0, neutral: state.keeps.length },
    round: state.round,
    maxRounds: TACTICS.maxRounds,
    orderTimerSec: TACTICS.orderTimerSec,
    you: side,
    submitted: !!submitted,
    powerFrac: { [side]: +powFrac(side).toFixed(3), [foeSide]: +powFrac(foeSide).toFixed(3) },
    squads: [
      ...state[side].squads.map((s) => projSquad(s, true)),
      ...state[foeSide].squads.map((s) => projSquad(s, false)),
    ],
  };
}

// ---------------- completion ----------------

// Apply the outcome: real casualties, rewards, ranking, persistence.
// `orders`/`cleared` may be null in auto mode.
function finalizeBattle(row, state, orders, clearedOrders, outcome) {
  clearAiTimer(row.id);
  const battleId = row.id;

  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const winnerUserId =
      outcome.winner === 'attacker' ? row.attacker_id : outcome.winner === 'defender' ? row.defender_id : null;

    // ---- survivors per side/type (real losses!) ----
    const survivorsOf = (sd) => {
      const map = {};
      for (const s of state[sd].squads) {
        if (s.routed) continue; // routed squads abandoned the field
        map[s.type] = (map[s.type] || 0) + Math.round(s.count);
      }
      return map;
    };
    const survivors = { attacker: survivorsOf('attacker'), defender: survivorsOf('defender') };
    const losses = {};
    for (const sd of ['attacker', 'defender']) {
      losses[sd] = {};
      for (const [type, n] of Object.entries(state[sd].startCounts)) {
        const lost = Math.max(0, n - (survivors[sd][type] || 0));
        if (lost > 0) losses[sd][type] = lost;
      }
    }
    const applyCasualties = (userId, lossMap) => {
      for (const [type, lost] of Object.entries(lossMap)) {
        db.prepare('UPDATE soldiers SET count = MAX(0, count - ?) WHERE user_id = ? AND type = ?').run(lost, userId, type);
      }
    };
    applyCasualties(row.attacker_id, losses.attacker);
    applyCasualties(row.defender_id, losses.defender);

    // ---- rewards (identical economy to v1) ----
    const rewards = {};
    for (const [key, sd] of [['attacker', 'attacker'], ['defender', 'defender']]) {
      const uid = key === 'attacker' ? row.attacker_id : row.defender_id;
      const won = outcome.winner === key;
      const draw = outcome.winner === 'draw';
      const reward = draw
        ? { gold: BATTLE.reward.drawGold, xp: BATTLE.reward.drawXp, outcome: 'draw' }
        : won
          ? { gold: BATTLE.reward.winGold, xp: BATTLE.reward.winXp, outcome: 'win' }
          : { gold: BATTLE.reward.loseGold, xp: BATTLE.reward.loseXp, outcome: 'lose' };

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      adjust(uid, { gold: reward.gold, kind: 'battle', note: `نتیجه نبرد: ${reward.outcome}` });

      // commander XP
      let xp = user.xp + Math.max(0, Math.floor(reward.xp));
      let level = user.level;
      let levelUps = 0;
      while (level < 100 && xp >= level * 500) {
        xp -= level * 500;
        level += 1;
        levelUps += 1;
      }
      if (level >= 100) xp = 0;
      db.prepare('UPDATE users SET xp = ?, level = ? WHERE id = ?').run(xp, level, uid);
      if (levelUps > 0) {
        adjust(uid, { gold: levelUps * 200, diamonds: levelUps * 10, kind: 'levelup', note: `ارتقای فرمانده به سطح ${level}` });
      }
      const leveled = { xp, level, levelUps };

      // hero XP
      const bestHero = heroes.list(uid)[0] || null;
      const heroGain = bestHero ? heroes.addXp(uid, bestHero.id, reward.xp) : null;

      // knowledge only to surviving soldier groups
      const knowledgeGains = [];
      for (const type of Object.keys(survivors[key])) {
        if ((survivors[key][type] || 0) <= 0) continue;
        knowledgeGains.push(barracks.addKnowledge(uid, type, BATTLE.reward.winKnowledge));
      }

      ranking.applyBattleResult(uid, reward.outcome);
      rewards[key] = { ...reward, knowledgeGains, leveled, heroGain };
    }

    missions.refresh(row.attacker_id);
    missions.refresh(row.defender_id);

    // ---- persist the final record ----
    const logDoc = buildFinalLog(state, outcome, survivors, losses, rewards);
    db.prepare(
      `UPDATE battles SET state = 'finished', log_json = ?, winner_id = ?, ended_at = ?,
         battle_state_json = NULL, orders_json = NULL, turn_deadline = NULL
       WHERE id = ?`
    ).run(JSON.stringify(logDoc), winnerUserId, now, battleId);

    const result = {
      battleId,
      winner: outcome.winner,
      reason: outcome.reason,
      turns: state.round,
      log: logDoc.log,
      attacker: legacySidePayload(state, 'attacker', survivors.attacker, row.attacker_id),
      defender: legacySidePayload(state, 'defender', survivors.defender, row.defender_id),
      rewards,
      ended_at: now,
      casualties: losses,
    };

    // Emit AFTER commit so status queries never race the event.
    setImmediate(() =>
      emitToBattle(battleId, row.attacker_id, row.defender_id, 'battle:finished', result)
    );
    return result;
  });
  return tx();
}

// Final persisted document (battles.log_json). NOTE: `.log` must stay a
// non-empty array of turn objects (tests + history UI rely on it).
function buildFinalLog(state, outcome, survivors, losses, rewards) {
  return {
    version: 2,
    winner: outcome.winner,
    reason: outcome.reason,
    rounds: state.round,
    terrain: state.terrain,
    initial: {
      attacker: { userId: state.attacker.userId, hero: state.attacker.hero, startCounts: state.attacker.startCounts, startPower: state.attacker.startPower },
      defender: { userId: state.defender.userId, hero: state.defender.hero, startCounts: state.defender.startCounts, startPower: state.defender.startPower },
    },
    log: state.log && state.log.length ? state.log : [{ round: 0, events: [{ kind: 'end', winner: outcome.winner, reason: outcome.reason }] }],
    final: {
      attacker: { survivors: survivors.attacker, losses: losses.attacker },
      defender: { survivors: survivors.defender, losses: losses.defender },
    },
    rewards: {
      attacker: rewards.attacker ? { outcome: rewards.attacker.outcome, gold: rewards.attacker.gold, xp: rewards.attacker.xp } : null,
      defender: rewards.defender ? { outcome: rewards.defender.outcome, gold: rewards.defender.gold, xp: rewards.defender.xp } : null,
    },
  };
}

// Legacy-shaped side payload (old UI + tests read hero/power/army).
function legacySidePayload(state, sd, survivors, userId) {
  const user = db.prepare('SELECT email, level FROM users WHERE id = ?').get(userId);
  const armyRows = Object.entries(survivors)
    .filter(([, n]) => n > 0)
    .map(([type, count]) => ({
      type,
      name: SOLDIERS[type].name,
      count,
      attack: state[sd].squads.find((s) => s.type === type)?.unitAtk ?? SOLDIERS[type].attack,
      defense: state[sd].squads.find((s) => s.type === type)?.unitDef ?? SOLDIERS[type].defense,
    }));
  return {
    user_id: userId,
    email: user ? user.email : null,
    hero: state[sd].hero,
    power: Math.round(tactics.sidePower(state, sd)),
    army: armyRows,
    terrain: state.terrain[state[sd].squads[0]?.y ?? 0]?.[state[sd].squads[0]?.x ?? 0] || 'plain',
  };
}

// ---------------- challenge opening ----------------
function openChallenge(userId) {
  assertNotInBattle(userId);
  const info = db
    .prepare("INSERT INTO battles (attacker_id, defender_id, state, created_at) VALUES (?,?,?,?)")
    .run(userId, userId, 'open', new Date().toISOString());
  return db.prepare('SELECT * FROM battles WHERE id = ?').get(info.lastInsertRowid);
}

// ---------------- status/history (compat) ----------------
function battleStatus(battleId, requesterId) {
  const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(Number(battleId));
  if (!b) throw new GameError(404, 'نبرد یافت نشد.');
  if (b.attacker_id !== requesterId && b.defender_id !== requesterId) {
    throw new GameError(403, 'شما در این نبرد شرکت ندارید.');
  }
  let parsed = null;
  if (b.log_json) {
    try { parsed = JSON.parse(b.log_json); } catch { /* corrupt log */ }
  }
  return { ...b, log: parsed };
}

function battleHistory(userId, limit = 10) {
  return db
    .prepare(
      `SELECT id, attacker_id, defender_id, state, winner_id, created_at, ended_at, round
       FROM battles
       WHERE attacker_id = ? OR defender_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, userId, Math.min(Math.max(1, Number(limit) || 10), 50));
}

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

module.exports = {
  setIo,
  enterBattle,
  submitOrders,
  getLiveView,
  openChallenge,
  battleStatus,
  battleHistory,
  expireStaleOpens,
  sweepDeadlines,
};
