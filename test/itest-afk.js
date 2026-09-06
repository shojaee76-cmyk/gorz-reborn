'use strict';
// AFK-deadline test: A submits, B never does -> AI must resolve.
const BASE = 'http://127.0.0.1:3201';
async function api(method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: res.headers.get('set-cookie') || cookie };
}
(async () => {
  const a = await api('POST', '/api/auth/register', { email: 'x' + Date.now() + '@t.ir', password: 'secret123' });
  const b = await api('POST', '/api/auth/register', { email: 'y' + Date.now() + '@t.ir', password: 'secret123' });
  await api('POST', '/api/battle/open', {}, b.cookie);
  const ent = await api('POST', '/api/battle/enter', {}, a.cookie);
  console.log('enter:', ent.status, ent.data.mode);
  if (ent.status !== 200) process.exit(1);
  const ordersA = {};
  for (const s of ent.data.view.squads.filter((s) => s.id.startsWith('A'))) ordersA[s.id] = { move: null, focus: null, stance: 'advance' };
  await api('POST', '/api/battle/orders/' + ent.data.battleId, { orders: ordersA }, a.cookie);
  console.log('waiting for AI deadline (3s timer + sweep)...');
  let done = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await api('GET', '/api/battle/status/' + ent.data.battleId, undefined, a.cookie);
    if (st.data.battle.round >= 1) {
      console.log('AI deadline path WORKS: round advanced to', st.data.battle.round, '| state:', st.data.battle.state);
      done = true;
      break;
    }
  }
  console.log(done ? 'PASS' : 'FAIL: round never advanced');
  process.exit(done ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
