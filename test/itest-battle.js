'use strict';
// Integration test: full interactive battle via HTTP API.
const BASE = 'http://127.0.0.1:3200';

async function api(method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: res.headers.get('set-cookie') || cookie };
}

(async () => {
  // register two commanders
  const a = await api('POST', '/api/auth/register', { email: `ta${Date.now()}@t.ir`, password: 'secret123' });
  const b = await api('POST', '/api/auth/register', { email: `tb${Date.now()}@t.ir`, password: 'secret123' });
  console.log('registered:', a.status, b.status);

  // B opens challenge; A enters
  await api('POST', '/api/battle/open', {}, b.cookie);
  const ent = await api('POST', '/api/battle/enter', {}, a.cookie);
  console.log('enter:', ent.status, '| mode:', ent.data.mode, '| side:', ent.data.side);
  if (ent.status !== 200) { console.log(JSON.stringify(ent.data)); process.exit(1); }
  const bid = ent.data.battleId;
  console.log('battleId:', bid, '| squads in view:', ent.data.view.squads.length, '| round:', ent.data.view.round);

  // A submits orders; expect waiting-for-opponent
  const ordersA = {};
  for (const s of ent.data.view.squads.filter((s) => s.id.startsWith('A'))) {
    ordersA[s.id] = { move: null, focus: null, stance: s.range > 1 ? 'hold' : 'advance' };
  }
  const subA = await api('POST', `/api/battle/orders/${bid}`, { orders: ordersA }, a.cookie);
  console.log('A submit:', subA.status, '| waiting:', subA.data.waiting);

  // B submits -> round should resolve
  const liveB = await api('GET', `/api/battle/live/${bid}`, undefined, b.cookie);
  console.log('B live view ok:', liveB.status, '| B sees', liveB.data.view.squads.length, 'squads');
  const ordersB = {};
  for (const s of liveB.data.view.squads.filter((s) => s.id.startsWith('B'))) {
    ordersB[s.id] = { move: s.x === 4 ? { x: 4, y: s.y + 1 } : null, focus: null, stance: 'advance' };
  }
  const subB = await api('POST', `/api/battle/orders/${bid}`, { orders: ordersB }, b.cookie);
  console.log('B submit:', subB.status, '| resolved this call:', !!subB.data.events, '| events:', subB.data.events ? subB.data.events.length : 0);
  if (subB.data.events && subB.data.view) {
    console.log('next round view round#:', subB.data.view.round, '| powerFrac:', JSON.stringify(subB.data.view.powerFrac));
  }

  // Loop rounds until finish (both sides auto-submit advance orders)
  let rounds = 1;
  let finished = null;
  while (rounds < 30) {
    rounds++;
    const va = await api('GET', `/api/battle/live/${bid}`, undefined, a.cookie);
    if (va.data.state !== 'running') break;
    const oa = {}, ob = {};
    for (const s of va.data.view.squads.filter((s) => s.id.startsWith('A') && !s.routed)) oa[s.id] = { move: null, focus: null, stance: 'advance' };
    const vb = await api('GET', `/api/battle/live/${bid}`, undefined, b.cookie);
    for (const s of vb.data.view.squads.filter((s) => s.id.startsWith('B') && !s.routed)) ob[s.id] = { move: null, focus: null, stance: 'advance' };
    const r1 = await api('POST', `/api/battle/orders/${bid}`, { orders: oa }, a.cookie);
    const r2 = await api('POST', `/api/battle/orders/${bid}`, { orders: ob }, b.cookie);
    const res = r2.data.events ? r2.data : (r1.data.events ? r1.data : null);
    if (!res) continue;
    // check finish by polling status
    const st = await api('GET', `/api/battle/status/${bid}`, undefined, a.cookie);
    if (st.data.battle.state === 'finished') { finished = st.data.battle.log; break; }
  }

  // If not finished through the loop (timer/AI path), poll status
  for (let i = 0; i < 20 && !finished; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await api('GET', `/api/battle/status/${bid}`, undefined, a.cookie);
    if (st.data.battle.state === 'finished') { finished = st.data.battle.log; break; }
  }
  console.log('FINISHED after ~', rounds, 'client rounds | log rounds persisted:', finished ? finished.length : 'NOT FINISHED');
  const me = await api('GET', '/api/auth/me', undefined, a.cookie);
  console.log('A ranking now:', me.data.user.ranking_score, '| wins:', me.data.user.wins, '| losses:', me.data.user.losses);
  process.exit(finished ? 0 : 1);
})().catch((e) => { console.error('ITEST CRASH:', e); process.exit(2); });
