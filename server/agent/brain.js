'use strict';
// ============================================================
// Gorz Reborn — agent/brain.js
// Translate a genome + live battle state into tactical orders
// (validated by tactics.validateOrders).
//
// state shape (from tactics.createBattleState):
//   state.attacker.squads[]        // {id, type, role, x, y, count, attack, ...}
//   state.defender.squads[]
//   state.keeps[]                 // {x, y, owner: 'attacker'|'defender'|null}
//   state.obstacles[]             // {kind, x, y}
//   state.grid = {w, h}
//   state.round
//
// Each squad has .x/.y directly (not .tile.x). Move orders use
// {move: {x,y}, focus: squadId|null, stance: 'advance'|'hold'|'assault'}.
// ============================================================

const { TACTICS } = require('../game/balance');

// Squads still alive this round.
function alive(squads) {
  return squads.filter((s) => s && s.count > 0 && s.routed !== true);
}

// Pick a stance for a squad from the genome + unit role.
function pickStance(genome, squad) {
  const a = genome.tactics.aggression;
  const d = genome.tactics.defense;
  const unitCfg = TACTICS.units[squad.type];
  const melee = unitCfg.role === 'melee';
  // ranged weight defense; melee weight aggression
  const holdScore = melee ? d : d + 0.25;
  const assaultScore = melee ? a + 0.1 : a;
  const advanceScore = 1.0;
  if (holdScore > assaultScore && holdScore > advanceScore) return 'hold';
  if (assaultScore > advanceScore && assaultScore > holdScore) return 'assault';
  return 'advance';
}

// Pick a focus target squad id from the opposite side.
function pickFocus(genome, state, squad, oppSquads) {
  if (!oppSquads.length) return null;
  let target = null;
  switch (genome.tactics.targetPriority) {
    case 'closest': {
      target = oppSquads.slice().sort((a, b) => {
        const da = Math.abs(a.x - squad.x) + Math.abs(a.y - squad.y);
        const db = Math.abs(b.x - squad.x) + Math.abs(b.y - squad.y);
        return da - db;
      })[0];
      break;
    }
    case 'weakest': {
      target = oppSquads.slice().sort((a, b) => (a.count * a.attack) - (b.count * b.attack))[0];
      break;
    }
    case 'archer_first': {
      target = oppSquads.find((s) => s.type === 'archer') || oppSquads[0];
      break;
    }
    case 'cavalry_first': {
      target = oppSquads.find((s) => s.type === 'cavalry') || oppSquads[0];
      break;
    }
    default: {
      target = oppSquads[Math.floor(Math.random() * oppSquads.length)];
    }
  }
  return target ? target.id : null;
}

// Pick a destination for a squad.
function pickMove(genome, state, squad, oppSquads) {
  const gridW = state.grid.w;
  const gridH = state.grid.h;
  const me = squad;
  const unitCfg = TACTICS.units[squad.type];
  const mp = unitCfg.mp;
  const mySide = squad.side;

  // 1) keep-capture bias: prefer marching toward unclaimed keeps
  if (genome.tactics.keepCapture > 0.55 && state.keeps && state.keeps.length) {
    const targetKeep = state.keeps.find((k) => k.owner === null) || state.keeps[0];
    if (targetKeep && targetKeep.owner !== mySide) {
      const tx = targetKeep.x, ty = targetKeep.y;
      const dx = Math.sign(tx - me.x) * Math.min(mp, Math.abs(tx - me.x));
      const dy = Math.sign(ty - me.y) * Math.min(mp, Math.abs(ty - me.y));
      return clampMove(state, me, { x: me.x + dx, y: me.y + dy });
    }
  }

  if (!oppSquads.length) return { x: me.x, y: me.y };

  // 2) target priority chooses which enemy to approach
  let target;
  if (genome.tactics.targetPriority === 'closest') {
    target = oppSquads.slice().sort((a, b) => {
      const da = Math.abs(a.x - me.x) + Math.abs(a.y - me.y);
      const db = Math.abs(b.x - me.x) + Math.abs(b.y - me.y);
      return da - db;
    })[0];
  } else if (genome.tactics.targetPriority === 'weakest') {
    target = oppSquads.slice().sort((a, b) => (a.count * a.attack) - (b.count * b.attack))[0];
  } else if (genome.tactics.targetPriority === 'archer_first') {
    target = oppSquads.find((s) => s.type === 'archer') || oppSquads[0];
  } else if (genome.tactics.targetPriority === 'cavalry_first') {
    target = oppSquads.find((s) => s.type === 'cavalry') || oppSquads[0];
  } else {
    target = oppSquads[Math.floor(Math.random() * oppSquads.length)];
  }
  const tx = target.x, ty = target.y;
  const dx = Math.sign(tx - me.x);
  const dy = Math.sign(ty - me.y);
  const adjDist = Math.abs(tx - me.x) + Math.abs(ty - me.y);

  // ranged kite when enemy adjacent + genome prefers disengage
  if (unitCfg.role === 'ranged' && adjDist === 1 && genome.tactics.rangedEngage < 0.5) {
    return clampMove(state, me, { x: me.x - dx, y: me.y - dy });
  }

  // cavalry charge toward the chosen target (capped by mp)
  if (squad.type === 'cavalry' && genome.tactics.cavalryCharge > 0.5 && adjDist > 1) {
    return clampMove(state, me, { x: me.x + Math.min(mp, Math.abs(tx - me.x)) * dx,
                                  y: me.y + Math.min(mp, Math.abs(ty - me.y)) * dy });
  }

  // default: step toward target using mp
  return clampMove(state, me, { x: me.x + Math.min(mp, Math.abs(tx - me.x)) * dx,
                                y: me.y + Math.min(mp, Math.abs(ty - me.y)) * dy });
}

// keep inside grid + avoid stacking on other squads or obstacles
function clampMove(state, me, p) {
  const W = state.grid.w, H = state.grid.h;
  const occ = new Set();
  for (const side of ['attacker', 'defender']) {
    for (const s of state[side].squads) {
      if (s && s.id !== me.id && s.count > 0 && !s.routed) occ.add(`${s.x},${s.y}`);
    }
  }
  for (const o of (state.obstacles || [])) occ.add(`${o.x},${o.y}`);
  let x = p.x, y = p.y;
  // simple: clamp to bounds and walk back toward original tile until free
  if (x < 0) x = 0; if (x >= W) x = W - 1;
  if (y < 0) y = 0; if (y >= H) y = H - 1;
  if (!occ.has(`${x},${y}`)) return { x, y };
  // try the 4 cardinal neighbors of me in order
  const cands = [
    { x: me.x + 1, y: me.y }, { x: me.x - 1, y: me.y },
    { x: me.x, y: me.y + 1 }, { x: me.x, y: me.y - 1 },
    { x: me.x, y: me.y },
  ];
  for (const c of cands) {
    if (c.x < 0 || c.x >= W || c.y < 0 || c.y >= H) continue;
    if (occ.has(`${c.x},${c.y}`)) continue;
    return c;
  }
  return { x: me.x, y: me.y };
}

// Produce full orders object for one side from a genome + state.
function planOrders(genome, state, sideKey) {
  const mySquads = alive(state[sideKey].squads);
  const oppKey = sideKey === 'attacker' ? 'defender' : 'attacker';
  const oppSquads = alive(state[oppKey].squads);
  const orders = {};
  for (const sq of mySquads) {
    const stance = pickStance(genome, sq);
    const move = pickMove(genome, state, sq, oppSquads);
    const focus = (genome.tactics.focusFire > 0.55) ? pickFocus(genome, state, sq, oppSquads) : null;
    orders[sq.id] = { move, focus, stance };
  }
  return orders;
}

module.exports = {
  pickStance,
  pickMove,
  pickFocus,
  planOrders,
  alive,
};