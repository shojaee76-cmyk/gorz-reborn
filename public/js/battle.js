/* ============================================================
 * Gorz Reborn — battle.js
 * Battle UI logic (W2 owns this ONE frontend file).
 * Renders the two armies, runs the turn log, live updates via
 * Socket.IO. Calls the battle API. Style is minimal & consistent
 * with the dark fantasy theme; W3 will polish the visuals.
 * ============================================================ */
(function () {
  'use strict';

  // Socket.IO client is loaded by app.html (global io).
  const socket = (typeof io !== 'undefined') ? io() : null;

  const el = (id) => document.getElementById(id);
  const fmtNum = (n) => Number(n || 0).toLocaleString('fa-IR');

  // ---------- battle page ----------
  function battlePage() {
    const page = el('battle-page');
    if (!page) return;
    page.innerHTML = `
      <div class="battle-wrap">
        <div class="battle-header">
          <h2>نبرد</h2>
          <p class="battle-sub">هم‌نبرد خود را پیدا کن و بجنگ.</p>
          <button id="btn-enter-battle" class="btn btn-primary">ورود به نبرد</button>
          <span id="battle-status" class="battle-status"></span>
        </div>
        <div id="battle-view" class="battle-view"></div>
      </div>`;
    el('btn-enter-battle').addEventListener('click', enterBattle);
    loadHistory();
  }

  async function enterBattle() {
    const btn = el('btn-enter-battle');
    const status = el('battle-status');
    if (!btn || !status) return;
    btn.disabled = true;
    status.textContent = 'در جستجوی هم‌نبرد...';

    try {
      const res = await fetch('/api/battle/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطای نبرد');
      status.textContent = '';
      renderResult(data);
    } catch (err) {
      status.textContent = err.message || 'خطا در ورود به نبرد';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderResult(battle) {
    const view = el('battle-view');
    if (!view) return;
    const mine = battle.attacker;
    const theirs = battle.defender;
    const win = battle.winner;
    const heroRow = (h) => (h ? `${h.name} (سطح ${h.level})` : '—');

    view.innerHTML = `
      <div class="battle-result ${win === 'attacker' ? 'win' : win === 'defender' ? 'lose' : 'draw'}">
        <div class="battle-vs">
          <div class="side side-attacker">
            <h3>${heroRow(mine.hero)}</h3>
            <p class="power">قدرت: ${fmtNum(mine.power)}</p>
          </div>
          <div class="vs-mid">${win === 'attacker' ? 'پیروزی' : win === 'defender' ? 'شکست' : 'تساوی'}</div>
          <div class="side side-defender">
            <h3>${heroRow(theirs.hero)}</h3>
            <p class="power">قدرت: ${fmtNum(theirs.power)}</p>
          </div>
        </div>
        <div class="armies">
          <div class="army-col">
            <h4>لشگر شما</h4>
            ${renderArmy(mine.army)}
          </div>
          <div class="army-col">
            <h4>لشگر حریف</h4>
            ${renderArmy(theirs.army)}
          </div>
        </div>
        ${renderLog(battle.log, battle.turns)}
        ${renderRewards(battle.rewards)}
      </div>`;
  }

  function renderArmy(army) {
    if (!army || !army.length) return '<p class="empty">لشگر خالی است.</p>';
    return `<ul class="army-list">${army
      .map(
        (u) => `<li>
          <span class="u-name">${u.name}</span>
          <span class="u-count">${fmtNum(u.count)}</span>
          <span class="u-atk">⚔ ${fmtNum(u.attack)}</span>
          <span class="u-def">🛡 ${fmtNum(u.defense)}</span>
        </li>`
      )
      .join('')}</ul>`;
  }

  function renderLog(log, turns) {
    if (!log || !log.length) return '';
    const rows = log
      .map((t) => {
        const evs = t.events
          .map((e) => {
            if (e.acting === 'none') return '<li class="ev-none">— دور بدون تلفات</li>';
            const sideName = e.acting === 'attacker' ? 'شما' : 'حریف';
            const typeName = e.type || '';
            return `<li class="ev-${e.acting}">دور ${t.turn}: ${sideName} — ${e.killed} ${typeName} نابود شد (قدرت ${fmtNum(e.power)})</li>`;
          })
          .join('');
        return `<li class="turn"><strong>دور ${t.turn}</strong><ul>${evs}</ul></li>`;
      })
      .join('');
    return `<div class="battle-log"><h4>گزارش نبرد (${turns || log.length} دور)</h4><ul>${rows}</ul></div>`;
  }

  function renderRewards(rewards) {
    if (!rewards) return '';
    const side = rewards.attacker;
    if (!side) return '';
    return `<div class="battle-rewards">
      <h4>پاداش‌ها</h4>
      <p>طلا: ${fmtNum(side.gold)} · تجربه: ${fmtNum(side.xp)} · نتیجه: ${side.outcome}</p>
      <p class="small">دانش سربازان: ${side.knowledgeGains && side.knowledgeGains.length ? side.knowledgeGains.length + ' گروه ارتقا یافت' : '—'}</p>
    </div>`;
  }

  // ---------- battle history ----------
  async function loadHistory() {
    const wrap = el('battle-history');
    if (!wrap) return;
    try {
      const res = await fetch('/api/battle/history');
      const data = await res.json();
      if (!data.ok) return;
      wrap.innerHTML = data.battles.length
        ? `<h4>تاریخچه نبردها</h4><ul class="hist-list">${data.battles
            .map((b) => {
              const me = window.GORZ_USER && (b.attacker_id === window.GORZ_USER.id || b.defender_id === window.GORZ_USER.id);
              const label = b.state === 'finished' ? (b.winner_id ? 'پایان‌یافته' : 'تساوی') : b.state === 'open' ? 'در انتظار حریف' : 'در جریان';
              return `<li class="hist-item">
                <span class="hist-id">نبرد #${b.id}</span>
                <span class="hist-state">${label}</span>
                <span class="hist-time">${b.created_at || ''}</span>
              </li>`;
            })
            .join('')}</ul>`
        : '<p class="empty">هنوز نبردی نداشته‌اید.</p>';
    } catch { /* ignore */ }
  }

  // ---------- socket live updates ----------
  if (socket) {
    socket.on('battle:finished', (data) => {
      // If the battle view is showing and this battle is the current one,
      // re-render from the live payload. History is refreshed lazily.
      const view = el('battle-view');
      if (view && data && data.battleId && window.GORZ_CURRENT_BATTLE_ID === data.battleId) {
        renderResult(data);
      }
      loadHistory();
    });
  }

  // ---------- public API ----------
  window.GorzBattle = {
    battlePage,
    enterBattle,
    renderResult,
    loadHistory,
    socket,
  };
})();
