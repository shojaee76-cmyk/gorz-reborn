'use strict';
// ============================================================
// Gorz Reborn — tactics.js
// Interactive tactical battle simulation (pure, no DB).
//
// Model:
//   - 9x7 grid battlefield; squads occupy one cell each.
//   - Armies split into squads (<= SQUAD_SIZE soldiers, max 8/side).
//   - Simultaneous-turn ("WeGo"): both commanders submit orders per
//     round (move target, focus-fire target, stance), then the round
//     resolves: movement phase -> simultaneous strikes -> counters
//     -> morale/rout checks -> victory check.
//   - Terrain: forest (+def, negates cavalry charge), hill (+atk).
//   - Cavalry auto-charges when it moves 2+ cells into a strike.
//   - Morale: heavy casualties break squads (rout = flee, survive).
//
// Balance inputs come from balance.js (SOLDIERS + TACTICS).
// The AI commander lives here too: aiOrders() produces sane orders
// for absent/disconnected commanders.
// ============================================================

const { SOLDIERS, TACTICS } = require('./balance');

// Fail loudly at boot if a balance knob goes missing (silent NaNs are
// far worse than an early crash).
for (const key of [
  'gridW', 'gridH', 'squadSize', 'maxSquadsPerSide', 'maxRounds',
  'orderTimerSec', 'forestChance', 'hillChance', 'forestDefBonus',
  'hillAtkBonus', 'holdDefBonus', 'assaultAtkBonus', 'assaultDefPenalty',
  'chargeMult', 'focusBonus', 'rangedAdjacentMult', 'knowledgePerLevel',
  'killK', 'killC', 'counterMelee', 'counterAdjacentRanged',
  'moraleHitPerFraction', 'routMoraleThreshold', 'routChancePerPoint',
  'routThreshold', 'decisiveRatio', 'units',
]) {
  if (TACTICS[key] === undefined) {
    throw new Error(`[tactics] missing balance knob: TACTICS.${key}`);
  }
}

// ---------------- deterministic RNG (seeded per battle) --------
// State lives on an exposed object so a running battle can be frozen
// to JSON (rngState) and resumed after a server restart.
function makeRng(seed) {
  const st = { a: seed >>> 0 };
  const fn = function () {
    let a = st.a;
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    st.a = ((t ^ (t >>> 14)) >>> 0);
    return st.a / 4294967296;
  };
  fn.getState = () => st.a;
  fn.setState = (v) => { st.a = v >>> 0; };
  return fn;
}
const mulberry32 = makeRng; // alias

// ---------------- army splitting / deployment ------------------

// Split one soldier row into squads. Target SQUAD_SIZE per squad,
// hard cap MAX_SQUADS_PER_SIDE across the whole army.
function splitRow(type, count, attack, defense, hero, alloc) {
  if (!count || count <= 0) return [];
  const st = TACTICS.units[type];
  const n = Math.min(Math.ceil(count / TACTICS.squadSize), alloc);
  const per = Math.floor(count / n);
  const squads = [];
  let rem = count;
  for (let i = 0; i < n; i++) {
    const c = i === n - 1 ? rem : per; // last squad absorbs remainder
    rem -= c;
    squads.push(makeSquad(type, c, attack, defense, hero));
  }
  return squads;
}

function makeSquad(type, count, attack, defense, hero) {
  const base = SOLDIERS[type];
  const st = TACTICS.units[type];
  // Bake knowledge multiplier into per-unit stats (attack/defense args
  // are already trained values; caller multiplies knowledge level in).
  return {
    id: null, // assigned per-side at deploy
    type,
    name: base.name,
    count,                       // float internally, shown rounded
    unitHp: st.unitHp,
    hp: count * st.unitHp,
    maxHp: count * st.unitHp,
    unitAtk: attack,
    unitDef: defense,
    mp: st.mp,
    range: st.range,
    role: st.role,
    heroMult: hero ? 1 + (hero.attack_mod || 0) + (hero.defense_mod || 0) : 1,
    x: -1, y: -1,
    morale: 100,
    routed: false,
    chargeReady: false,          // set during movement, consumed in combat
  };
}

// Build one side from army rows [{type,count,attack,defense,knowledge}].
function buildSide(userId, hero, armyRows) {
  const squads = [];
  const startCounts = {};
  for (const row of armyRows) {
    if (!row.count || row.count <= 0) continue;
    startCounts[row.type] = (startCounts[row.type] || 0) + row.count;
    const knowMult = 1 + (row.knowledge_level || 0) * TACTICS.knowledgePerLevel;
    const squadsLeft = TACTICS.maxSquadsPerSide - squads.length;
    if (squadsLeft <= 0) break;
    squads.push(
      ...splitRow(row.type, row.count, row.attack * knowMult, row.defense * knowMult, hero, squadsLeft)
    );
  }
  return { userId, hero, squads, startCounts };
}

// Center-out column order on a W-wide grid.
function centerOut(w) {
  const order = [];
  const mid = Math.floor(w / 2);
  for (let d = 0; d <= mid; d++) {
    order.push(mid - d);
    if (d !== 0) order.push(mid + d);
  }
  return order.slice(0, w);
}

// Deploy squads: melee front row, ranged behind. Sides start 4 rows
// apart so there's a real approach phase (archer volleys, cavalry
// flanks) before the lines clash.
function deploy(gridW, gridH, sideObj, sideName, prefix) {
  const cols = centerOut(gridW);
  const melee = sideObj.squads.filter((s) => s.role === 'melee');
  const ranged = sideObj.squads.filter((s) => s.role === 'ranged');
  const frontRow = sideName === 'attacker' ? gridH - 2 : 1;
  const backRow = sideName === 'attacker' ? gridH - 1 : 0;
  let n = 0;
  for (const s of [...melee, ...ranged]) s.id = `${prefix}${++n}`;
  let cx = 0;
  for (const s of melee) {
    s.y = frontRow;
    s.x = cols[cx++ % cols.length];
  }
  for (const s of ranged) {
    s.y = backRow;
    s.x = cols[cx++ % cols.length];
  }
}

// ---------------- terrain --------------------------------------
function makeTerrain(w, h, rng) {
  const t = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const r = rng();
      row.push(r < TACTICS.forestChance ? 'forest' : r < TACTICS.forestChance + TACTICS.hillChance ? 'hill' : 'plain');
    }
    t.push(row);
  }
  return t;
}

// ---------------- helpers ---------------------------------------
const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

function squadAt(state, x, y) {
  return state.all.find((s) => !s.routed && s.x === x && s.y === y) || null;
}

function terrainOf(state, sq) {
  return (state.terrain[sq.y] && state.terrain[sq.y][sq.x]) || 'plain';
}

function stanceMods(stance) {
  if (stance === 'hold') return { atk: 1.0, def: 1 + TACTICS.holdDefBonus, move: false };
  if (stance === 'assault') return { atk: 1 + TACTICS.assaultAtkBonus, def: 1 - TACTICS.assaultDefPenalty, move: true };
  return { atk: 1.0, def: 1.0, move: true }; // advance
}

function livingEnemies(state, side) {
  return state.all.filter((s) => !s.routed && s.side !== side);
}

function sideSquads(state, side) {
  return state[side].squads.filter((s) => !s.routed);
}

function squadPower(state, sq) {
  const t = terrainOf(state, sq);
  const terrAtk = t === 'hill' ? 1 + TACTICS.hillAtkBonus : 1;
  return sq.unitAtk * sq.count * sq.heroMult * terrAtk;
}

function sidePower(state, side) {
  return sideSquads(state, side).reduce((acc, s) => acc + squadPower(state, s), 0);
}

// ---------------- order validation ------------------------------
// orders: { [squadId]: { move: {x,y}|null, focus: squadId|null, stance } }
function validateOrders(state, side, orders) {
  const clean = {};
  if (!orders || typeof orders !== 'object') return clean;
  const mine = state[side].squads.filter((s) => !s.routed);
  for (const sq of mine) {
    const o = orders[sq.id];
    if (!o) continue;
    const entry = { move: null, focus: null, stance: 'advance' };
    if (['advance', 'hold', 'assault'].includes(o.stance)) entry.stance = o.stance;
    if (o.move && Number.isInteger(o.move.x) && Number.isInteger(o.move.y)) {
      const { x, y } = o.move;
      // Any in-bounds, unoccupied destination is legal; the movement
      // phase walks at most MP steps toward it. (Capping the ORDER
      // distance at MP would make flanking/long marches impossible.)
      const occ = squadAt(state, x, y);
      if ((!occ || occ === sq) && entry.stance !== 'hold') {
        entry.move = { x, y };
      }
    }
    if (o.focus) {
      const tgt = state.all.find((s) => s.id === o.focus && !s.routed && s.side !== side);
      if (tgt) entry.focus = tgt.id;
    }
    clean[sq.id] = entry;
  }
  return clean;
}

// ---------------- movement --------------------------------------
// Greedy orthogonal stepping toward destination; blocked cells stop
// the walk early. Cavalry (mp 2) executes before everyone else.
function stepToward(state, sq, tx, ty) {
  const options = [];
  const dx = Math.sign(tx - sq.x);
  const dy = Math.sign(ty - sq.y);
  if (dx !== 0) options.push({ x: sq.x + dx, y: sq.y });
  if (dy !== 0) options.push({ x: sq.x, y: sq.y + dy });
  // prefer the axis with more distance to cover
  options.sort((a, b) =>
    (Math.abs(ty - a.y) + Math.abs(tx - a.x)) - (Math.abs(ty - b.y) + Math.abs(tx - b.x))
  );
  for (const opt of options) {
    if (opt.x < 0 || opt.x >= state.grid.w || opt.y < 0 || opt.y >= state.grid.h) continue;
    if (!squadAt(state, opt.x, opt.y)) return opt;
  }
  return null;
}

function runMovement(state, orders) {
  const events = [];
  // Alternate who wins the movement race each round. Round-1 priority
  // is a seeded coin flip (neither side owns the opening charge);
  // afterwards it strictly alternates.
  const attFirst =
    (state.round % 2 === 1) === (state.firstMoverAttacker !== false);
  const sideRank = (s) => (s.side === 'attacker') === attFirst ? 0 : 1;
  const movable = state.all
    .filter((s) => !s.routed)
    .sort((a, b) => b.mp - a.mp || sideRank(a) - sideRank(b) || a.id.localeCompare(b.id));
  for (const sq of movable) {
    const o = orders[sq.side][sq.id];
    const mods = stanceMods(o ? o.stance : 'advance');
    if (!mods.move) continue; // holding
    let dest = null;
    let auto = false;
    if (o && o.move) {
      dest = o.move;
    } else if (!o || o.stance !== 'hold') {
      // auto-pursue: idle squads with no adjacent enemy drift forward
      const foes = livingEnemies(state, sq.side);
      const adj = foes.some((f) => manhattan(f.x, f.y, sq.x, sq.y) <= sq.range);
      if (!adj && foes.length) {
        const near = foes
          .map((f) => ({ f, d: manhattan(f.x, f.y, sq.x, sq.y) }))
          .sort((a, b) => a.d - b.d)[0].f;
        dest = { x: near.x, y: near.y };
        auto = true;
      }
    }
    if (!dest) continue;

    let moved = 0;
    const from = { x: sq.x, y: sq.y };
    while (moved < sq.mp) {
      const nxt = stepToward(state, sq, dest.x, dest.y);
      if (!nxt) break;
      sq.x = nxt.x;
      sq.y = nxt.y;
      moved++;
    }
    if (moved > 0) {
      sq.chargeReady =
        sq.type === 'cavalry' &&
        moved >= 2 &&
        terrainOf(state, sq) !== 'forest';
      events.push({
        kind: 'move', squad: sq.id, side: sq.side, type: sq.type,
        from, to: { x: sq.x, y: sq.y }, auto,
      });
    }
  }
  return events;
}

// ---------------- combat ----------------------------------------
// kills = atkScore * K / (defScore + C), jittered, capped by target size.
function computeStrike(state, atkSq, defSq, opts) {
  const atkTerr = terrainOf(state, atkSq);
  const defTerr = terrainOf(state, defSq);
  const ao = orders_.for(atkSq.side, atkSq.id);
  const do_ = orders_.for(defSq.side, defSq.id);
  const aStance = stanceMods(ao ? ao.stance : 'advance');
  const dStance = stanceMods(do_ ? do_.stance : 'advance');
  const atkTerrMod = atkTerr === 'hill' ? 1 + TACTICS.hillAtkBonus : 1;
  const defTerrMod = defTerr === 'forest' ? 1 + TACTICS.forestDefBonus : 1;

  let atkScore =
    atkSq.unitAtk * atkSq.count * atkSq.heroMult * aStance.atk * atkTerrMod;
  if (opts.charge) atkScore *= TACTICS.chargeMult;
  if (opts.volley) atkScore *= 1 + TACTICS.focusBonus;
  if (opts.adjacentRanged) atkScore *= TACTICS.rangedAdjacentMult;
  if (opts.counterMult) atkScore *= opts.counterMult;

  const defScore =
    defSq.unitDef * defSq.count * defSq.heroMult * dStance.def * defTerrMod;

  const rng = state.rng;
  const jitter = 0.85 + rng() * 0.3;
  const raw = (atkScore * TACTICS.killK) / (defScore + TACTICS.killC) * jitter;
  const kills = Math.min(raw, defSq.count);
  return kills;
}

// Order lookup shim so computeStrike can read current stances without
// threading them through every call.
let orders_ = { map: null, for(side, id) { const m = this.map[side] || {}; return m[id] || null; } };

function chooseTarget(state, sq) {
  const foes = livingEnemies(state, sq.side);
  if (!foes.length) return null;
  const o = orders_.for(sq.side, sq.id);
  // ranged: focus target if within range, else nearest in range
  const inRange = foes.filter((f) => manhattan(f.x, f.y, sq.x, sq.y) <= sq.range);
  if (!inRange.length) return null;
  if (o && o.focus) {
    const foc = inRange.find((f) => f.id === o.focus);
    if (foc) return foc;
  }
  return inRange.sort(
    (a, b) =>
      manhattan(a.x, a.y, sq.x, sq.y) - manhattan(b.x, b.y, sq.x, sq.y) ||
      a.hp - b.hp
  )[0];
}

function runCombat(state) {
  const strikeEvents = [];
  const counterEvents = [];
  const strikers = state.all.filter((s) => !s.routed);

  // --- primary strikes (simultaneous: computed vs pre-strike state) ---
  const strikes = []; // {atk, def, kills, flags}
  for (const sq of strikers) {
    const tgt = chooseTarget(state, sq);
    if (!tgt) continue;
    const dist = manhattan(sq.x, sq.y, tgt.x, tgt.y);
    const o = orders_.for(sq.side, sq.id);
    const volley = !!o && !!o.focus && o.focus === tgt.id && sq.range > 1;
    const adjacentRanged = sq.range > 1 && dist === 1;
    const charge = sq.chargeReady && dist === 1;
    const kills = computeStrike(state, sq, tgt, { charge, volley, adjacentRanged });
    strikes.push({ atk: sq, def: tgt, kills, charge, volley, ranged: sq.range > 1 && dist > 1 });
  }

  // --- apply all primary strikes atomically ---
  for (const st of strikes) {
    applyDamage(state, st.def, st.kills);
  }

  // --- counters (only vs survivors of the primaries) ---
  // Compute every counter against PRE-COUNTER state, then apply all
  // damage at once. (Applying inline lets early counters weaken later
  // ones — and since attacker strikes are processed first, defenders
  // always countered first: a hidden systematic defender buff.)
  const pendingCounters = [];
  for (const st of strikes) {
    const def = st.def;
    if (def.count <= 0 || def.routed) continue;
    if (manhattan(def.x, def.y, st.atk.x, st.atk.y) !== 1) continue;
    if (st.ranged && def.range > 1) continue; // archer duel: no counter at range
    const counterMult = def.range > 1 ? TACTICS.counterAdjacentRanged : TACTICS.counterMelee;
    const kills = computeStrike(state, def, st.atk, { counterMult });
    pendingCounters.push({ def, atk: st.atk, kills });
  }
  for (const c of pendingCounters) {
    applyDamage(state, c.atk, c.kills);
    counterEvents.push({
      kind: 'counter', attacker: c.def.id, side: c.def.side, target: c.atk.id,
      targetSide: c.atk.side, kills: round1(c.kills),
    });
  }

  // --- emit strike events (causal order: strikes first, then counters) ---
  for (const st of strikes) {
    strikeEvents.push({
      kind: 'strike', attacker: st.atk.id, side: st.atk.side,
      target: st.def.id, targetSide: st.def.side,
      kills: round1(st.kills),
      charge: !!st.charge, volley: !!st.volley, ranged: !!st.ranged,
    });
  }
  const events = [...strikeEvents, ...counterEvents];

  // consume charge flags
  for (const sq of state.all) sq.chargeReady = false;
  return events;
}

function applyDamage(state, sq, kills) {
  if (kills <= 0 || sq.count <= 0) return;
  const before = sq.count;
  sq.count = Math.max(0, sq.count - kills);
  sq.hp = sq.count * sq.unitHp;
  const fracLost = (before - sq.count) / Math.max(before, 1e-9);
  sq.morale = Math.max(0, sq.morale - fracLost * TACTICS.moraleHitPerFraction);
}

const round1 = (n) => Math.round(n * 10) / 10;

// ---------------- morale / routs ---------------------------------
function runMorale(state) {
  const events = [];
  for (const sq of state.all) {
    if (sq.routed || sq.count <= 0) continue;
    if (sq.morale <= 0) {
      sq.routed = true;
      events.push({ kind: 'rout', squad: sq.id, side: sq.side, reason: 'broken' });
    } else if (sq.morale < TACTICS.routMoraleThreshold && state.rng() < (TACTICS.routMoraleThreshold - sq.morale) * TACTICS.routChancePerPoint) {
      sq.routed = true;
      events.push({ kind: 'rout', squad: sq.id, side: sq.side, reason: 'wavering' });
    }
  }
  return events;
}

// ---------------- outcome ----------------------------------------
function evaluateOutcome(state) {
  const aActive = sideSquads(state, 'attacker');
  const dActive = sideSquads(state, 'defender');
  if (!aActive.length && !dActive.length) return { over: true, winner: 'draw', reason: 'annihilation' };
  if (!dActive.length) return { over: true, winner: 'attacker', reason: 'enemy destroyed' };
  if (!aActive.length) return { over: true, winner: 'defender', reason: 'enemy destroyed' };

  const aFrac = sidePower(state, 'attacker') / Math.max(state.attacker.startPower, 1);
  const dFrac = sidePower(state, 'defender') / Math.max(state.defender.startPower, 1);
  const aLow = aFrac < TACTICS.routThreshold;
  const dLow = dFrac < TACTICS.routThreshold;
  if (aLow && dLow) {
    // both collapse the same round -> stronger remainder wins
    return {
      over: true,
      winner: aFrac === dFrac ? 'draw' : aFrac > dFrac ? 'attacker' : 'defender',
      reason: 'mutual collapse',
    };
  }
  if (aLow) return { over: true, winner: 'defender', reason: 'army routed' };
  if (dLow) return { over: true, winner: 'attacker', reason: 'army routed' };
  if (state.round >= TACTICS.maxRounds) {
    if (aFrac >= dFrac * TACTICS.decisiveRatio) return { over: true, winner: 'attacker', reason: 'decisive on points' };
    if (dFrac >= aFrac * TACTICS.decisiveRatio) return { over: true, winner: 'defender', reason: 'decisive on points' };
    return { over: true, winner: 'draw', reason: 'exhausted' };
  }
  return { over: false };
}

// ---------------- round resolution --------------------------------
// ordersBySide: { attacker: cleanOrders, defender: cleanOrders }
// Mutates state; returns { events, outcome }.
function resolveRound(state, ordersBySide) {
  orders_.map = ordersBySide;
  const events = [];
  state.round += 1;
  events.push(...runMovement(state, ordersBySide));
  events.push(...runCombat(state));
  events.push(...runMorale(state));
  const outcome = evaluateOutcome(state);
  if (outcome.over) {
    events.push({ kind: 'end', winner: outcome.winner, reason: outcome.reason });
  }
  // record the round for replays + the final log document
  state.log.push({ round: state.round, events });
  orders_.map = null;
  return { events, outcome };
}

// ---------------- AI commander ------------------------------------
// Sane defaults: infantry presses the nearest threat, archers hold and
// plink, cavalry dives the juiciest (lowest-def) target.
function aiOrders(state, side) {
  const orders = {};
  const foes = livingEnemies(state, side);
  for (const sq of sideSquads(state, side)) {
    const o = { move: null, focus: null, stance: 'advance' };
    if (!foes.length) { orders[sq.id] = o; continue; }
    const near = foes
      .map((f) => ({ f, d: manhattan(f.x, f.y, sq.x, sq.y) }))
      .sort((a, b) => a.d - b.d)[0];

    if (sq.range > 1) {
      // archers: stand ground, focus nearest
      o.stance = 'hold';
      if (near.d <= sq.range) o.focus = near.f.id;
    } else if (sq.type === 'cavalry') {
      // cavalry: dive the lowest-defense enemy in reach
      const prey = foes
        .slice()
        .sort((a, b) => a.unitDef * a.count - b.unitDef * b.count)[0];
      const d = manhattan(prey.x, prey.y, sq.x, sq.y);
      if (d > 1) o.move = { x: prey.x, y: prey.y }; // charge distance; mp caps actual steps
      o.focus = prey.id;
      o.stance = 'assault';
    } else {
      // infantry: close distance, hold once engaged
      if (near.d > 1) {
        // order the far destination; movement walks up to MP steps/round
        o.move = { x: near.f.x, y: near.f.y };
        o.stance = 'advance';
      } else {
        o.stance = 'hold';
      }
    }
    orders[sq.id] = o;
  }
  return orders;
}

// One-step move toward (tx,ty) that is legal & free (used by AI).
function nearestFreeStep(state, sq, tx, ty) {
  const cand = [
    { x: sq.x + Math.sign(tx - sq.x), y: sq.y },
    { x: sq.x, y: sq.y + Math.sign(ty - sq.y) },
  ].filter(
    (c) =>
      c.x >= 0 && c.x < state.grid.w &&
      c.y >= 0 && c.y < state.grid.h &&
      (c.x !== sq.x || c.y !== sq.y) &&
      !squadAt(state, c.x, c.y)
  );
  if (!cand.length) return null;
  cand.sort(
    (a, b) =>
      Math.abs(ty - a.y) + Math.abs(tx - a.x) - (Math.abs(ty - b.y) + Math.abs(tx - b.x))
  );
  return cand[0];
}

// ---------------- battle factory ----------------------------------
// Creates a full battle state from two built sides. seed should be the
// battle id (deterministic terrain per battle).
function createBattleState(battleId, attackerSide, defenderSide, seedExtra) {
  const w = TACTICS.gridW;
  const h = TACTICS.gridH;
  const rng = mulberry32(battleId * 7919 + (seedExtra || 0));
  const state = {
    battleId,
    round: 0,
    grid: { w, h },
    terrain: makeTerrain(w, h, rng),
    rng,
    attacker: attackerSide,
    defender: defenderSide,
    all: [],
    status: 'running',
    winner: null,
    log: [],
    firstMoverAttacker: rng() < 0.5,
  };
  // Stamp side ownership on every squad FIRST (deploy + combat read it),
  // then deploy with per-side prefixes for stable Persian ids.
  attackerSide.side = 'attacker';
  defenderSide.side = 'defender';
  for (const s of attackerSide.squads) s.side = 'attacker';
  for (const s of defenderSide.squads) s.side = 'defender';
  deploy(w, h, attackerSide, 'attacker', 'ح');
  deploy(w, h, defenderSide, 'defender', 'د');
  state.all = [...attackerSide.squads, ...defenderSide.squads];
  attackerSide.startPower = sidePower(state, 'attacker');
  defenderSide.startPower = sidePower(state, 'defender');
  return state;
}

// ---------------- persistence helpers -----------------------------
// A live battle must freeze to plain JSON (DB column battle_state_json)
// and restore exactly — including RNG position.
function serializeSide(side) {
  return {
    userId: side.userId,
    hero: side.hero ? { ...side.hero } : null,
    startCounts: { ...side.startCounts },
    startPower: side.startPower,
    squads: side.squads.map((s) => ({ ...s })),
  };
}

function serializeState(state) {
  return {
    battleId: state.battleId,
    round: state.round,
    grid: state.grid,
    terrain: state.terrain,
    rngState: state.rng.getState(),
    firstMoverAttacker: state.firstMoverAttacker,
    attacker: serializeSide(state.attacker),
    defender: serializeSide(state.defender),
    log: state.log || [],
  };
}

function restoreState(frozen) {
  const rng = makeRng(1);
  rng.setState(frozen.rngState);
  const hydrate = (side) => ({
    ...side,
    squads: side.squads.map((s) => ({ ...s })),
  });
  const attacker = hydrate(frozen.attacker);
  const defender = hydrate(frozen.defender);
  attacker.side = 'attacker';
  defender.side = 'defender';
  for (const s of attacker.squads) s.side = 'attacker';
  for (const s of defender.squads) s.side = 'defender';
  return {
    battleId: frozen.battleId,
    round: frozen.round,
    grid: frozen.grid,
    terrain: frozen.terrain,
    rng,
    firstMoverAttacker: frozen.firstMoverAttacker,
    attacker,
    defender,
    all: [...attacker.squads, ...defender.squads],
    status: 'running',
    winner: null,
    log: frozen.log || [],
  };
}

module.exports = {
  createBattleState,
  buildSide,
  validateOrders,
  resolveRound,
  aiOrders,
  sidePower,
  sideSquads,
  manhattan,
  serializeState,
  restoreState,
};
