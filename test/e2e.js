'use strict';
// ============================================================
// Gorz Reborn — E2E test (npm test)
// Exercises against a REAL running server (own instance on
// port 3100): register -> train -> mission -> market -> bank.
// Uses node's built-in fetch (Node 18+).
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { io: socketClient } = require('socket.io-client');

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

// Isolated test DB so the dev DB stays clean.
const TEST_DB = path.join(os.tmpdir(), `gorz-test-${Date.now()}.db`);

let serverProc = null;
let passed = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

async function api(method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, cookie: res.headers.get('set-cookie') || cookie };
}

// Connect a socket.io client with the given session cookie and wait for
// 'battle:finished' (delivered via the personal room: user:<id>).
function connectBattleSocket(cookie, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = socketClient(BASE, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, forceNew: true });
    let done = false;
    const finish = (received, id) => {
      if (done) return;
      done = true;
      try { s.close(); } catch { /* ignore */ }
      resolve({ received, battleId: id || null });
    };
    s.on('battle:finished', (data) => finish(true, data && data.battleId));
    s.on('connect_error', () => finish(false, null));
    setTimeout(() => finish(false, null), timeoutMs);
  });
}

// Both players' personal sockets should receive the finished event.
async function testBattleSockets(cookieA, cookieB) {
  const [a, b] = await Promise.all([
    connectBattleSocket(cookieA),
    connectBattleSocket(cookieB),
  ]);
  return { aReceived: a.received, aId: a.battleId, bReceived: b.received, bId: b.battleId };
}

// Connect both players' sockets FIRST, then trigger a fresh battle so
// the live 'battle:finished' event is observed in real time by both.
async function testLiveBattleSockets(cookieA, cookieB) {
  const a = connectBattleSocket(cookieA);
  const b = connectBattleSocket(cookieB);
  // give the sockets a moment to connect
  await new Promise((r) => setTimeout(r, 300));
  // A opens a challenge; B enters it -> both should get the event.
  await api('POST', '/api/battle/open', {}, cookieA);
  const enter = await api('POST', '/api/battle/enter', {}, cookieB);
  const [aRes, bRes] = await Promise.all([a, b]);
  return { aReceived: aRes.received, aId: aRes.battleId, bReceived: bRes.received, bId: bRes.battleId, enterStatus: enter.status };
}

async function main() {
  console.log('Gorz Reborn E2E — starting test server on :' + PORT);
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), GORZ_DB: TEST_DB, GORZ_BATTLE_MODE: 'auto' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', (d) => process.stderr.write(d));

  // wait for boot
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    console.error('✗ server failed to boot');
    process.exit(1);
  }
  console.log('  ✓ server booted');

  // ---- register ----
  const email = `e2e_${Date.now()}@test.ir`;
  const reg = await api('POST', '/api/auth/register', { email, password: 'secret123' });
  ok(reg.status === 201, 'register returns 201', reg.data);
  const cookie = reg.cookie;
  ok(!!cookie, 'register sets session cookie');
  ok(reg.data.user.gold === 1000, 'starting gold = 1000', reg.data.user.gold);
  ok(reg.data.user.diamonds === 100, 'starting diamonds = 100', reg.data.user.diamonds);

  // duplicate email rejected
  const dup = await api('POST', '/api/auth/register', { email, password: 'secret123' });
  ok(dup.status === 409, 'duplicate email rejected (409)');

  // ---- barracks ----
  const b = await api('GET', '/api/barracks', undefined, cookie);
  ok(b.status === 200, 'barracks state fetched');
  const swordsman = b.data.army.find((s) => s.type === 'swordsman');
  ok(swordsman && swordsman.count === 100, 'starting army = 100 swordsmen', swordsman && swordsman.count);

  // train 5 attack points
  const tr = await api('POST', '/api/barracks/train', { type: 'swordsman', stat: 'attack', count: 5 }, cookie);
  ok(tr.status === 200, 'train 5 attack on swordsman', tr.data);
  if (tr.status === 200) {
    const goldAfter = tr.data.soldier ? null : null;
    ok(tr.data.soldier && tr.data.soldier.attack === 15, 'swordsman attack 10 -> 15', tr.data.soldier && tr.data.soldier.attack);
  }

  // ---- missions ----
  const ms = await api('GET', '/api/missions', undefined, cookie);
  ok(ms.status === 200, 'missions fetched');
  ok(ms.data.missions.length >= 10, 'at least 10 seeded missions', ms.data.missions.length);
  const trainMission = ms.data.missions.find((m) => m.type === 'train' && m.target === 1);
  ok(!!trainMission, 'train-1 mission exists (Boot Camp)');
  if (trainMission) {
    ok(trainMission.title.includes('Boot Camp'), 'mission has English title', trainMission.title);
    const claim = await api('POST', '/api/missions/claim', { mission_id: trainMission.mission_id }, cookie);
    ok(claim.status === 200, 'claim train mission reward', claim.data);
    const dupClaim = await api('POST', '/api/missions/claim', { mission_id: trainMission.mission_id }, cookie);
    ok(dupClaim.status === 400, 'double-claim rejected');
  }

  // ---- market ----
  const mk = await api('GET', '/api/market/listings', undefined, cookie);
  ok(mk.status === 200, 'market listings fetched');

  // sell 10 swordsmen
  const sell = await api('POST', '/api/market/list', { item_type: 'swordsman', qty: 10, price_gold: 50 }, cookie);
  ok(sell.status === 201, 'create listing (sell 10 swordsmen)', sell.data);
  const listingId = sell.data && sell.data.listing && sell.data.listing.id;
  ok(!!listingId, 'listing has id');

  // register a second player to buy
  const email2 = `e2e_buyer_${Date.now()}@test.ir`;
  const reg2 = await api('POST', '/api/auth/register', { email: email2, password: 'secret123' });
  const cookie2 = reg2.cookie;
  const buy = await api('POST', '/api/market/buy', { listing_id: listingId }, cookie2);
  ok(buy.status === 200, 'second player buys listing', buy.data);
  if (buy.status === 200) {
    // fee math: price 50, fee 5% = 2, seller gets 48.
    // seller gold = 1000 - 25(train) + 50(train mission reward) + 48(sale, after 5% fee)
    const me = await api('GET', '/api/auth/me', undefined, cookie);
    ok(me.data.user.gold === 1000 - 25 + 50 + 48, 'seller gold = 1000 - 25(train) + 50(mission) + 48(sale, 5% fee)', me.data.user.gold);
  }

  // ---- bank ledger ----
  const ledger = await api('GET', '/api/bank/ledger', undefined, cookie);
  ok(ledger.status === 200, 'bank ledger fetched');
  ok(ledger.data.ledger.length >= 3, 'ledger has signup/train/sell rows', ledger.data.ledger.length);

  // ---- ranking ----
  const rank = await api('GET', '/api/ranking', undefined, cookie);
  ok(rank.status === 200, 'ranking fetched');
  ok(Array.isArray(rank.data.ranking), 'ranking is a list');

  // ================= BATTLE SCENARIO (W2) =================
  // Two accounts -> battle -> winner -> ranking delta.
  // Player A (attacker) is already registered; register player B.
  const emailB = `e2e_war_${Date.now()}@test.ir`;
  const regB = await api('POST', '/api/auth/register', { email: emailB, password: 'secret123' });
  ok(regB.status === 201, 'battle: second player registered', regB.data);
  const cookieB = regB.cookie;

  const meA = await api('GET', '/api/auth/me', undefined, cookie);
  const meB = await api('GET', '/api/auth/me', undefined, cookieB);
  ok(meA.data.user.ranking_score === 0 && meB.data.user.ranking_score === 0, 'battle: both start ranking 0');

  // Make B decisively stronger so the battle has a clear winner:
  // recruit 40 more swordsmen (B has 100 + 40 = 140; cost 40*20=800).
  const recruit = await api('POST', '/api/barracks/recruit', { type: 'swordsman', count: 40 }, cookieB);
  ok(recruit.status === 200, 'battle: B recruits 40 swordsmen', recruit.data);

  // Open a challenge from B (state=open), then A enters and joins it.
  const openB = await api('POST', '/api/battle/open', {}, cookieB);
  ok(openB.status === 200 && openB.data.battle && openB.data.battle.state === 'open', 'battle: B opens a challenge', openB.data);
  const openBattleId = openB.data && openB.data.battle && openB.data.battle.id;
  ok(!!openBattleId, 'battle: open challenge has id');

  // B is in a battle -> cannot open another
  const openB2 = await api('POST', '/api/battle/open', {}, cookieB);
  ok(openB2.status === 400, 'battle: B cannot open while already in a battle');

  // A enters -> should join B's open challenge and fight
  const entA = await api('POST', '/api/battle/enter', {}, cookie);
  ok(entA.status === 200, 'battle: A enters battle', entA.data);
  ok(entA.data.battleId === openBattleId, 'battle: A joined B\'s open challenge', entA.data.battleId);
  ok(['attacker', 'defender', 'draw'].includes(entA.data.winner), 'battle: battle has a result', entA.data.winner);
  ok(Array.isArray(entA.data.log) && entA.data.log.length > 0, 'battle: turn log present', entA.data.log && entA.data.log.length);

  const winnerId = entA.data.winner === 'attacker' ? meA.data.user.id : entA.data.winner === 'defender' ? meB.data.user.id : null;
  const loserId = winnerId === meA.data.user.id ? meB.data.user.id : meA.data.user.id;

  // Persisted: status endpoint reflects finished + log + winner.
  // (log_json is written by the battle transaction; re-read after commit.)
  let stA = null;
  for (let i = 0; i < 10 && !stA; i++) {
    const s = await api('GET', `/api/battle/status/${openBattleId}`, undefined, cookie);
    if (s.status === 200) stA = s;
    else await new Promise((r) => setTimeout(r, 100));
  }
  ok(stA && stA.data.battle.state === 'finished', 'battle: persisted as finished', stA && stA.data.battle.state);
  ok(stA && (stA.data.battle.winner_id !== null || entA.data.winner === 'draw'), 'battle: winner recorded (or draw)');
  ok(stA && !!stA.data.battle.log_json, 'battle: log_json persisted in DB row', stA && stA.data.battle.log_json && stA.data.battle.log_json.length);
  ok(stA && stA.data.battle.log && Array.isArray(stA.data.battle.log.log) && stA.data.battle.log.log.length > 0,
    'battle: status returns parsed turn log', stA && stA.data.battle.log && stA.data.battle.log.log && stA.data.battle.log.log.length);

  // Ranking delta + win/loss counters
  const meA2 = await api('GET', '/api/auth/me', undefined, cookie);
  const meB2 = await api('GET', '/api/auth/me', undefined, cookieB);
  const totalRanking = (meA2.data.user.ranking_score || 0) + (meB2.data.user.ranking_score || 0);
  ok(totalRanking === 15, 'battle: ranking delta 20 + (-5) = 15', totalRanking);
  const totalWins = (meA2.data.user.wins || 0) + (meB2.data.user.wins || 0);
  ok(totalWins === 1, 'battle: exactly one winner recorded', totalWins);
  const totalLosses = (meA2.data.user.losses || 0) + (meB2.data.user.losses || 0);
  ok(totalLosses === 1, 'battle: exactly one loser recorded', totalLosses);

  // Rewards: winner got gold, loser got gold (different amounts)
  const goldA = meA2.data.user.gold;
  const goldB = meB2.data.user.gold;
  ok(goldA !== goldB, 'battle: reward gold differs by outcome', { goldA, goldB });

  // Both armies lost soldiers (battle consumed units)
  const histA = await api('GET', '/api/battle/history', undefined, cookie);
  ok(histA.status === 200 && histA.data.battles.length >= 1, 'battle: A has history entry', histA.data.battles.length);
  const histB = await api('GET', '/api/battle/history', undefined, cookieB);
  ok(histB.data.battles.length >= 1, 'battle: B has history entry');

  // Socket: both players' personal sockets receive battle:finished.
  // (The event already fired during enter; the rooms deliver to any
  // socket connected as that user — we connect AFTER and still get it
  // only if the event is queued. So instead verify the real-time path:
  // we connect sockets first, then trigger a SECOND battle.)
  // Simpler deterministic check: open a new challenge + enter it while
  // both sockets are listening, and confirm both receive the event.
  const socketsResult = await testLiveBattleSockets(cookie, cookieB);
  ok(socketsResult.aReceived, 'socket: attacker received battle:finished');
  ok(socketsResult.bReceived, 'socket: defender received battle:finished');
  ok(socketsResult.aId !== null && socketsResult.bId !== null, 'socket: both received a battle id', socketsResult);

  // Post-battle: finished battles do not block a fresh battle; a new
  // enter should succeed (the socket battle already proved this, but
  // assert the leaderboard reflects the accumulated scores).
  const lb = await api('GET', '/api/ranking?limit=10', undefined, cookie);
  ok(lb.status === 200 && lb.data.ranking.length >= 2, 'battle: leaderboard has both players', lb.data.ranking.length);

  console.log('');
  console.log(`Results: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failed:', failures.join(', '));
  }
  serverProc.kill();
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
