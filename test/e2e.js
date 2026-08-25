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

async function main() {
  console.log('Gorz Reborn E2E — starting test server on :' + PORT);
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), GORZ_DB: TEST_DB },
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
  ok(!!trainMission, 'train-1 mission exists (آغاز سربازخانه)');
  if (trainMission) {
    ok(trainMission.title_fa.includes('سرباز'), 'mission has Persian title', trainMission.title_fa);
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
