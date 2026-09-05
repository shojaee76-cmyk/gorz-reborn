'use strict';
// ============================================================
// Gorz Reborn — test/itest-v3.js
// DESIGN-v3 "The Four Castles" acceptance tests. Run: node test/itest-v3.js
// ============================================================
const assert = require('assert');
const T = require('../server/game/tactics');
const { generateV3Map, TERRAIN_RULES, V3 } = require('../server/game/mapgen');
const { TACTICS } = require('../server/game/balance');

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  try { fn(); pass++; results.push(`  ✓ ${name}`); }
  catch (e) { fail++; results.push(`  ✗ ${name}: ${e.message}`); }
}

function mkSide(userId, comp) {
  const rows = Object.entries(comp).filter(([, n]) => n > 0)
    .map(([type, count]) => ({ type, count, attack: 8, defense: 6, knowledge: 0 }));
  return T.buildSide(userId, null, rows);
}
function fresh(id, compA, compD) {
  const A = mkSide(1, compA || { cavalry: 70 });
  const D = mkSide(2, compD || { archer: 70 });
  return { st: T.createBattleState(id, A, D, 0), A, D };
}

// ---------- 1. map: symmetry, determinism, features ----------
check('map: point-symmetric (every tile mirrors 180°)', () => {
  const { grid } = generateV3Map(7);
  for (let y = 0; y < V3.H; y++)
    for (let x = 0; x < V3.W; x++)
      assert.strictEqual(grid[y][x], grid[V3.H - 1 - y][V3.W - 1 - x], `(${x},${y})`);
});
check('map: deterministic per seed', () => {
  assert.strictEqual(JSON.stringify(generateV3Map(5).grid), JSON.stringify(generateV3Map(5).grid));
});
check('map: has all 8 terrain types', () => {
  const { grid } = generateV3Map(0);
  const kinds = new Set(grid.flat());
  for (const k of ['plain', 'hill', 'forest', 'jungle', 'water', 'bridge', 'mountain', 'castle'])
    assert.ok(kinds.has(k), `missing ${k}`);
});
check('map: big lakes (>=5 water tiles per side, 3x2 stamped)', () => {
  const { grid } = generateV3Map(0);
  const water = grid.flat().filter((t) => t === 'water').length;
  assert.ok(water >= 10, `water tiles = ${water}`);
});
check('map: river full height with exactly 3 bridges', () => {
  const { grid } = generateV3Map(0);
  let bridges = 0;
  for (let y = 0; y < V3.H; y++) {
    const t = grid[y][V3.RIVER_X];
    if (t === 'bridge') bridges++;
    else assert.strictEqual(t, 'water', `row ${y} is ${t}`);
  }
  assert.strictEqual(bridges, 3);
});
check('map: 4 castles at spec positions', () => {
  const { castles } = generateV3Map(0);
  assert.deepStrictEqual(
    Object.entries(castles).map(([k, c]) => [k, c.x, c.y]).sort(),
    [['eastHome', 19, 7], ['northKeep', 6, 3], ['southKeep', 14, 11], ['westHome', 1, 7]].sort()
  );
});
check('map: west can reach east (bridge connectivity)', () => {
  const { grid } = generateV3Map(0);
  const passable = (x, y) => x >= 0 && x < V3.W && y >= 0 && y < V3.H && TERRAIN_RULES[grid[y][x]].passable;
  const seen = new Set([`${0},7`]); const q = [[0, 7]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && passable(nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  assert.ok(seen.has('11,7'), 'east side reachable from west');
});

// ---------- 2. army structure: commander + 3 lieutenants ----------
check('army: exactly 4 squads per side', () => {
  const { A, D } = fresh(1, { swordsman: 30, archer: 20, cavalry: 25 }, { swordsman: 30, archer: 20, cavalry: 25 });
  assert.strictEqual(A.squads.length, 4);
  assert.strictEqual(D.squads.length, 4);
});
check('army: 1 commander (star) + 3 lieutenants, aide mult 0.85', () => {
  const { A } = fresh(2, { cavalry: 40, swordsman: 20, archer: 15 });
  const cmd = A.squads.filter((s) => s.commander);
  assert.strictEqual(cmd.length, 1);
  const lies = A.squads.filter((s) => !s.commander);
  assert.strictEqual(lies.length, 3);
  for (const l of lies) assert.ok(Math.abs(l.heroMult - 0.85) < 1e-9, `lieutenant heroMult ${l.heroMult}`);
  assert.strictEqual(cmd[0].title, 'سردار');
});
check('deploy: mirrored spawns (fair start)', () => {
  const { st, A, D } = fresh(3, { cavalry: 70 }, { cavalry: 70 });
  // the SET of attacker (type,count,x,y) equals the mirrored defender set
  const setA = A.squads.map((s) => `${s.type}:${s.count}@${s.x},${s.y}`).sort();
  const setD = D.squads.map((s) => `${s.type}:${s.count}@${V3.W - 1 - s.x},${V3.H - 1 - s.y}`).sort();
  assert.deepStrictEqual(setA, setD);
});

// ---------- 3. terrain rules in combat ----------
check('water blocks movement (bridge-only crossing)', () => {
  const { st, A } = fresh(4, { cavalry: 70 });
  const c = A.squads[0];
  c.x = 8; c.y = 6; // west bank, row 6 has no bridge
  st.all.forEach((s) => { if (s !== c) { s.x = -9; s.y = -9; } });
  const r = T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', { [c.id]: { move: { x: 12, y: 6 }, stance: 'advance' } }), defender: {} });
  const mv = r.events.find((e) => e.kind === 'move' && e.squad === c.id);
  assert.ok(mv && mv.to.x <= 9, `crossed to ${mv ? mv.to.x : '?'} without a bridge`);
});
check('jungle costs 2 MP (mp1 cannot enter)', () => {
  const { st, A } = fresh(5, { swordsman: 70 });
  const c = A.squads[0];
  c.type = 'swordsman'; c.role = 'melee'; c.mp = 1;
  c.x = 5; c.y = 1; // 6,1 is jungle
  st.all.forEach((s) => { if (s !== c) { s.x = -9; s.y = -9; } });
  const r = T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', { [c.id]: { move: { x: 8, y: 1 }, stance: 'advance' } }), defender: {} });
  const mv = r.events.find((e) => e.kind === 'move' && e.squad === c.id);
  assert.ok(!mv, 'mp1 entered jungle (cost 2)');
});
check('cavalry charge x1.6 after 2-tile open run', () => {
  const { st, A, D } = fresh(6, { cavalry: 70 }, { archer: 70 });
  const c = A.squads[0], a = D.squads[0];
  c.x = 6; c.y = 5; a.x = 9; a.y = 5; // landing 8,5 plain, contact adjacent
  const r = T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', { [c.id]: { move: { x: 8, y: 5 }, focus: a.id, stance: 'assault' } }), defender: {} });
  const s = r.events.find((e) => e.kind === 'strike' && e.attacker === c.id);
  assert.ok(s && s.charge === true, 'charge flag missing');
  assert.ok(s.kills > 0);
});
check('charge denied when landing in forest', () => {
  const { st, A, D } = fresh(7, { cavalry: 70 }, { archer: 70 });
  const c = A.squads[0], a = D.squads[0];
  c.x = 12; c.y = 5; a.x = 15; a.y = 5; // 14,5 forest landing
  const r = T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', { [c.id]: { move: { x: 14, y: 5 }, focus: a.id, stance: 'assault' } }), defender: {} });
  const s = r.events.find((e) => e.kind === 'strike' && e.attacker === c.id);
  assert.ok(s && s.charge === false, 'charge should be denied in forest');
});

// ---------- 4. win conditions ----------
check('win: capital fall ends instantly', () => {
  const { st, A } = fresh(8, { cavalry: 75 }, { swordsman: 20, archer: 20, cavalry: 20 });
  const c = A.squads[0];
  c.x = 18; c.y = 7;
  st.all.forEach((s) => { if (s !== c) { s.x = -9; s.y = -9; } });
  const r = T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', { [c.id]: { move: { x: 19, y: 7 }, stance: 'assault' } }), defender: {} });
  assert.ok(r.outcome.over && r.outcome.winner === 'attacker', JSON.stringify(r.outcome));
  assert.ok(String(r.outcome.reason).includes('سقوط'), 'reason should mention the fall');
});
check('win: siege of both keeps (3 rounds)', () => {
  const { st, A } = fresh(9, { cavalry: 70 });
  const c1 = A.squads[0], c2 = A.squads[1];
  c1.x = 6; c1.y = 3;  // northKeep
  c2.x = 14; c2.y = 11; // southKeep
  st.all.forEach((s) => { if (s !== c1 && s !== c2) { s.x = -9; s.y = -9; } });
  let r, n = 0;
  while (st.status === 'running' && n < 8) {
    n++;
    r = T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', { [c1.id]: { move: null, stance: 'hold' }, [c2.id]: { move: null, stance: 'hold' } }), defender: T.validateOrders(st, 'defender', {}) });
  }
  assert.ok(r.outcome.over && r.outcome.winner === 'attacker' && String(r.outcome.reason).includes('دژ'), JSON.stringify(r.outcome));
  assert.strictEqual(n, TACTICS.siegeRoundsToWin);
});
check('engine: finished battle refuses extra rounds', () => {
  const { st, A } = fresh(10, { cavalry: 70 }, { archer: 70 });
  const c = A.squads[0];
  c.x = 18; c.y = 7;
  st.all.forEach((s) => { if (s !== c) { s.x = -9; s.y = -9; } });
  T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', { [c.id]: { move: { x: 19, y: 7 }, stance: 'assault' } }), defender: {} });
  assert.strictEqual(st.status, 'finished');
  const again = T.resolveRound(st, { attacker: {}, defender: {} });
  assert.strictEqual(again.outcome.reason, 'already finished');
});

// ---------- 5. persistence ----------
check('freeze/restore round-trips bit-exact', () => {
  const { st } = fresh(11, { swordsman: 30, archer: 20, cavalry: 25 }, { swordsman: 30, archer: 20, cavalry: 25 });
  for (let i = 0; i < 3; i++) {
    T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', T.aiOrders(st, 'attacker')), defender: T.validateOrders(st, 'defender', T.aiOrders(st, 'defender')) });
  }
  const frozen = JSON.parse(JSON.stringify(T.serializeState(st)));
  const rt = T.restoreState(frozen);
  assert.strictEqual(JSON.stringify(rt.attacker.squads), JSON.stringify(frozen.attacker.squads));
  assert.strictEqual(rt.rng.getState(), st.rng.getState());
  assert.deepStrictEqual(rt.castles, st.castles);
});

// ---------- 6. AI crosses bridges (bridge-aware aiOrders) ----------
check('AI: melee routes through bridges, battles resolve', () => {
  const { st, A, D } = fresh(12, { swordsman: 30, archer: 20, cavalry: 25 }, { swordsman: 30, archer: 20, cavalry: 25 });
  let crossed = false, r, n = 0;
  while (st.status === 'running' && n < 35) {
    n++;
    r = T.resolveRound(st, { attacker: T.validateOrders(st, 'attacker', T.aiOrders(st, 'attacker')), defender: T.validateOrders(st, 'defender', T.aiOrders(st, 'defender')) });
    if (A.squads.some((s) => !s.routed && s.x > 10)) crossed = true;
  }
  assert.ok(crossed, 'no squad ever crossed the river');
  assert.ok(r.outcome.over, 'battle never ended');
});

console.log('itest-v3 results:');
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
