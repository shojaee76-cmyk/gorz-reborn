'use strict';
// Live smoke against the REAL dev server on :3000 (interactive mode).
const BASE = 'http://127.0.0.1:3000';
async function api(method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: res.headers.get('set-cookie') || cookie };
}
(async () => {
  // health
  const h = await api('GET', '/api/health');
  console.log('health:', h.data.ok);

  // register probe commander on the LIVE db (default army: 100 swordsmen)
  const email = `probe${Date.now()}@t.ir`;
  const reg = await api('POST', '/api/auth/register', { email, password: 'secret123' });
  console.log('registered:', reg.status, '| gold:', reg.data.user.gold);

  // current-battle endpoint (should be null battle)
  const cur = await api('GET', '/api/battle/current', undefined, reg.cookie);
  console.log('current:', cur.status, '| battle:', cur.data.battle);

  // enter -> matchmaking vs admin seed (level window) or 409 if none
  const ent = await api('POST', '/api/battle/enter', {}, reg.cookie);
  console.log('enter:', ent.status, '| mode:', ent.data.mode, '| side:', ent.data.side);
  if (ent.status === 200) {
    const v = ent.data.view;
    console.log('grid:', v.grid.w + 'x' + v.grid.h, '| squads:', v.squads.length, '| timer:', v.orderTimerSec + 's');
    const mine = v.squads.filter((s) => (ent.data.side === 'attacker' ? s.id.startsWith('A') : s.id.startsWith('B')));
    console.log('my squads:', mine.map((s) => s.id + ':' + s.count).join(', '));
    // submit orders for every squad to prove the endpoint round-trips
    const orders = {};
    for (const s of mine) orders[s.id] = { move: null, focus: null, stance: 'advance' };
    const sub = await api('POST', `/api/battle/orders/${ent.data.battleId}`, { orders }, reg.cookie);
    console.log('submit:', sub.status, '| waiting:', sub.data.waiting);
  }
  console.log('LIVE SMOKE DONE');
})().catch((e) => { console.error(e); process.exit(1); });
