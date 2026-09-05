// End-to-end engine test for the "vs AI" solo-playable path.
// Flow: register a fresh user -> enter battle (gets AI opponent, not 409) ->
//   submit orders each round -> round resolves immediately -> battle finishes
//   with a winner + myOutcome. Asserts the playable loop, no matchmaking hang.
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const BASE = 'http://localhost:3001/api';
const crypto = require('crypto');

(async () => {
  const email = `solo_${Date.now()}@test.local`;
  const pw = 'password123';
  const jar = { cookie: null };
  const jfetch = (m, p, b) => fetch(`${BASE}${p}`, {
    method: m, headers: { 'Content-Type': 'application/json', cookie: jar.cookie || '' },
    body: b ? JSON.stringify(b) : undefined,
  }).then(r => { if (r.headers.get('set-cookie')) jar.cookie = r.headers.get('set-cookie').split(';')[0]; return r.json(); });

  const reg = await jfetch('POST', '/auth/register', { email, password: pw });
  if (!reg.ok) throw new Error('register failed: ' + JSON.stringify(reg));
  console.log('register ok:', email);

  const ent = await jfetch('POST', '/battle/enter');
  if (!ent.ok) throw new Error('enter failed: ' + JSON.stringify(ent));
  const vsAi = ent.data.vsAi === true;
  const side = ent.data.side;
  console.log('enter: vsAi=' + vsAi, 'side=' + side, 'round=' + ent.data.view.round,
    'squads=' + ent.data.view.squads.length, 'vsAiOnView=' + ent.data.view.vsAi);
  if (!vsAi) throw new Error('EXPECTED vsAi=true (solo should get an AI opponent, not 409)');
  if (ent.data.view.squads.length < 2) throw new Error('no squads on board');

  let rounds = 0, last = null;
  // play up to maxRounds+2; each submit should advance one round until finished
  while (rounds < 30) {
    const orders = {};
    for (const s of ent.data.view.squads) {
      // only our squads (ids start with ح for attacker)
      if (side === 'attacker' ? s.id.startsWith('ح') : s.id.startsWith('د')) {
        orders[s.id] = { move: null, focus: null, stance: 'advance' }; // stand still, hold position
      }
    }
    const sub = await jfetch('POST', `/battle/orders/${ent.data.battleId}`, { orders });
    if (!sub.ok) throw new Error('submit failed: ' + JSON.stringify(sub));
    last = sub.data;
    rounds++;
    console.log('  round', rounds, '-> vsAi=' + sub.data.vsAi, 'waiting=' + sub.data.waiting,
      'winner=' + (sub.data.winner !== undefined ? sub.data.winner : '-'),
      'events=' + (sub.data.events || []).length);
    if (sub.data.winner !== undefined || sub.data.outcome) {
      console.log('  BATTLE ENDED. winner=' + (sub.data.winner), 'myOutcome=' + sub.data.myOutcome, 'reason=' + sub.data.reason);
      break;
    }
    // re-read view for next iteration (state mutated server-side)
    const lv = await jfetch('GET', `/battle/live/${ent.data.battleId}`);
    if (lv.data.view) Object.assign(ent.data, { view: lv.data.view });
  }
  if (last && last.winner === undefined && !last.outcome) throw new Error('battle never ended after ' + rounds + ' rounds');
  console.log('PASS: solo vs-AI loop playable, battle resolved in', rounds, 'round(s).');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
