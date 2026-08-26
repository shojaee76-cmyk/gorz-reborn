/* ============================================================
 * Gorz Reborn — battle.js (v2, tactical WeGo combat)
 * Board rendering, order planning (move/focus/stance), round
 * replays via Socket.IO, results + history.
 * W2 owns this ONE frontend file. All colors come from the
 * app.css design tokens (ember accent on tinted charcoal).
 * ============================================================ */
(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const fmtNum = (n) => Number(n || 0).toLocaleString('fa-IR');

  const TYPE_ICON = { swordsman: '⚔️', archer: '🏹', cavalry: '🐎' };
  const TERRAIN_LABEL = { plain: 'دشت', forest: 'جنگل', hill: 'تپه' };
  const STANCE_LABEL = { advance: 'پیشروی', hold: 'دفاع', assault: 'یورش' };

  // ---------- module state ----------
  let socket = null;
  let battleId = null;
  let mySide = null;
  let view = null;
  let draft = {};          // squadId -> {move, focus, stance}
  let selectedId = null;
  let countdown = null;    // interval handle
  let secondsLeft = 0;
  let replaying = false;

  const api = async (method, p, body) => {
    const res = await fetch('/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };

  // ============================================================
  // Page skeleton
  // ============================================================
  function battlePage() {
    const page = el('battle-page');
    if (!page) return;
    page.innerHTML = `
      <div class="battle-wrap">
        <div class="battle-header">
          <div>
            <h2>نبرد</h2>
            <p class="battle-sub">نبردِ تاکتیکی — هر دور دستورهای لشگرت را بده و نتیجه را زنده ببین.</p>
          </div>
          <div id="battle-actions" class="battle-actions">
            <button id="btn-enter-battle" class="btn btn-primary">ورود به نبرد</button>
            <button id="btn-open-battle" class="btn">چالش باز</button>
          </div>
          <span id="battle-status" class="battle-status"></span>
        </div>
        <div id="battle-view" class="battle-view"></div>
      </div>`;
    el('btn-enter-battle').addEventListener('click', enterBattle);
    el('btn-open-battle').addEventListener('click', openChallenge);
    connectSocket();
    loadHistory();
    resumeIfRunning();
  }

  function setStatus(msg, isErr) {
    const s = el('battle-status');
    if (!s) return;
    s.textContent = msg || '';
    s.classList.toggle('err', !!isErr);
  }

  // ============================================================
  // Socket live updates
  // ============================================================
  function connectSocket() {
    if (typeof io === 'undefined') return;
    if (!socket) socket = io();
    socket.on('battle:start', (p) => {
      if (!battleId && p && p.battleId) {
        // someone challenged us and matchmaking dropped us straight in
        battleId = p.battleId;
        resolveMySide(p.views);
        enterLive();
      }
    });
    socket.on('battle:round', (p) => {
      if (p && p.battleId === battleId && !replaying) playRound(p);
    });
    socket.on('battle:waiting', (p) => {
      if (p && p.battleId === battleId) {
        const mineSubmitted = p.submitted && p.submitted[mySide];
        if (mineSubmitted) setStatus('دستورها ثبت شد؛ در انتظار حریف…');
      }
    });
    socket.on('battle:finished', (p) => {
      if (p && p.battleId === battleId) renderFinished(p);
    });
  }

  // Figure out which side is ours by comparing hero/user ids is not
  // possible from views alone; ask the server instead (cheap).
  function resolveMySide(views) {
    mySide = null; // will be corrected by the live-view fetch below
    void views;
  }

  // ============================================================
  // Enter / challenge / resume
  // ============================================================
  async function enterBattle() {
    const btn = el('btn-enter-battle');
    if (btn) btn.disabled = true;
    setStatus('در جستجوی هم‌نبرد…');
    try {
      const r = await api('POST', '/battle/enter');
      if (!r.ok) throw new Error(r.data.error || 'خطای نبرد');
      setStatus('');
      if (r.data.mode === 'interactive') {
        battleId = r.data.battleId;
        mySide = r.data.side;
        window.GORZ_LAST_SIDE = mySide;
        enterLive();
      } else {
        // legacy/auto-mode payload: full result in one shot
        renderFinished(r.data);
        loadHistory();
      }
    } catch (err) {
      // maybe we already have a live battle -> resume it
      const resumed = await tryResume();
      if (!resumed) setStatus(err.message || 'خطا در ورود به نبرد', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openChallenge() {
    setStatus('چالش باز شد؛ تا آمدن حریف منتظر بمان…');
    try {
      const r = await api('POST', '/battle/open');
      if (!r.ok) throw new Error(r.data.error || 'خطا');
    } catch (err) {
      setStatus(err.message || 'خطا', true);
    }
  }

  async function resumeIfRunning() {
    await tryResume();
  }

  async function tryResume() {
    try {
      const r = await api('GET', '/battle/current');
      if (r.ok && r.data.battle) {
        battleId = r.data.battle.id;
        mySide = r.data.side;
        if (r.data.view) enterLive();
        return true;
      }
    } catch { /* none */ }
    return false;
  }

  // ============================================================
  // Live battle screen
  // ============================================================
  function enterLive() {
    stopCountdown();
    renderCommand(view);
    if (!view) {
      // fetch fresh authoritative view
      api('GET', '/battle/live/' + battleId).then((r) => {
        if (r.ok && r.data.view) {
          mySide = r.data.side;
          window.GORZ_LAST_SIDE = mySide;
          renderCommand(r.data.view);
        }
      });
    }
  }

  function renderCommand(v) {
    if (!v) return;
    view = v;
    draft = {};
    selectedId = null;
    for (const s of v.squads) {
      const mine = owns(s);
      if (!mine) continue;
      draft[s.id] = { move: null, focus: null, stance: 'advance' };
    }
    const main = el('battle-view');
    if (!main) return;
    main.innerHTML = `
      <div class="tac-wrap">
        <div class="tac-topbar">
          <div class="tac-round num">دور <b>${fmtNum(v.round + 1)}</b> / ${fmtNum(v.maxRounds)}</div>
          <div class="tac-powers">
            ${powerBar('you', v.powerFrac[sideKey(v)])}
            ${powerBar('foe', v.powerFrac[foeKey(v)])}
          </div>
          <div class="tac-timer"><span id="tac-clock" class="num">—</span></div>
        </div>
        <div class="tac-board-frame">
          <div class="tac-board" id="tac-board"></div>
        </div>
        <div class="tac-panel">
          <div id="tac-hint" class="tac-hint">یک گروه از لشگرت را انتخاب کن.</div>
          <div id="tac-controls" class="tac-controls"></div>
          <div class="tac-submit-row">
            <span id="tac-ready" class="tac-ready"></span>
            <button id="tac-submit" class="btn btn-primary">ثبت دستورات</button>
          </div>
        </div>
      </div>`;
    drawBoard(v);
    el('tac-submit').addEventListener('click', submitOrders);
    startCountdown(v.orderTimerSec);
    updateHint();
  }

  const owns = (s) => (mySide === 'attacker' ? s.id.startsWith('ح') : s.id.startsWith('د'));
  const sideKey = (v) => v.you;
  const foeKey = (v) => (v.you === 'attacker' ? 'defender' : 'attacker');

  function powerBar(kind, frac) {
    const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)));
    return `<div class="tac-power tac-power-${kind}">
      <span>${kind === 'you' ? 'قدرت تو' : 'حریف'}</span>
      <div class="tac-power-track"><div class="tac-power-fill ${kind}" style="width:${pct}%"></div></div>
      <b class="num">${fmtNum(pct)}٪</b>
    </div>`;
  }

  // Logical (x,y) -> visual row/col (viewer's army always at bottom).
  const visY = (y) => (view.you === 'attacker' ? y : view.grid.h - 1 - y);

  function drawBoard(v) {
    const board = el('tac-board');
    if (!board) return;
    board.style.setProperty('--cols', v.grid.w);
    board.style.setProperty('--rows', v.grid.h);
    let html = '';
    for (let vy = 0; vy < v.grid.h; vy++) {
      for (let x = 0; x < v.grid.w; x++) {
        const ly = v.you === 'attacker' ? vy : v.grid.h - 1 - vy; // logical y
        const t = v.terrain[ly][x];
        html += `<div class="tac-cell terr-${t}" data-x="${x}" data-y="${ly}"></div>`;
      }
    }
    for (const s of v.squads) {
      if (s.routed) continue; // routed chips are drawn faded separately
      html += squadChip(s);
    }
    for (const s of v.squads) {
      if (s.routed) html += squadChip(s);
    }
    board.innerHTML = html;
    board.querySelectorAll('.tac-cell').forEach((c) =>
      c.addEventListener('click', () => onCellClick(Number(c.dataset.x), Number(c.dataset.y)))
    );
    board.querySelectorAll('.tac-chip').forEach((ch) =>
      ch.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onChipClick(ch.dataset.sid);
      })
    );
    paintSelection();
  }

  function squadChip(s) {
    const mine = owns(s);
    const vy = visY(s.y);
    const morBand = mine ? '' : ` band-${s.moraleBand || 'high'}`;
    const morBar = mine
      ? `<i class="tac-morale"><b style="width:${Math.round(s.morale)}%"></b></i>`
      : '';
    return `<div class="tac-chip side-${mine ? 'mine' : 'foe'} type-${s.type}${s.routed ? ' routed' : ''}${morBand}"
      data-sid="${s.id}" style="--x:${s.x};--vy:${vy}">
      <span class="tac-chip-icon">${TYPE_ICON[s.type] || '•'}</span>
      <span class="tac-chip-count num">${fmtNum(s.count)}</span>
      ${morBar}
      ${s.routed ? '<span class="tac-rout-mark">فرار</span>' : ''}
    </div>`;
  }

  function onChipClick(sid) {
    if (!view || view.submitted || replaying) return;
    const s = view.squads.find((x) => x.id === sid);
    if (!s) return;
    if (owns(s)) {
      selectedId = selectedId === sid ? null : sid;
    } else {
      // clicking a foe: focus-fire for the selected squad if in range
      if (selectedId) toggleFocus(sid);
    }
    paintSelection();
    updateHint();
    renderControls();
  }

  function onCellClick(x, y) {
    if (!view || view.submitted || replaying || !selectedId) return;
    const s = view.squads.find((q) => q.id === selectedId);
    if (!s) return;
    const dist = Math.abs(s.x - x) + Math.abs(s.y - y);
    if (dist === 0) {
      draft[selectedId].move = null;
    } else if (dist <= s.mp + 3) { // generous ring; server clamps anyway
      draft[selectedId].move = { x, y };
    }
    paintSelection();
    updateHint();
  }

  function toggleFocus(fid) {
    if (!selectedId) return;
    const d = draft[selectedId];
    d.focus = d.focus === fid ? null : fid;
    paintSelection();
  }

  function paintSelection() {
    const board = el('tac-board');
    if (!board || !view) return;
    board.querySelectorAll('.tac-cell.in-range').forEach((c) => c.classList.remove('in-range'));
    board.querySelectorAll('.tac-chip').forEach((ch) => {
      ch.classList.toggle('selected', ch.dataset.sid === selectedId);
      const foc = selectedId && draft[selectedId] && draft[selectedId].focus === ch.dataset.sid;
      ch.classList.toggle('focused', !!foc);
    });
    board.querySelectorAll('.tac-move-dot').forEach((n) => n.remove());
    if (selectedId && !view.submitted) {
      const s = view.squads.find((q) => q.id === selectedId);
      if (s) {
        // movement ring
        for (let dy = -(s.mp + 2); dy <= s.mp + 2; dy++) {
          for (let dx = -(s.mp + 2); dx <= s.mp + 2; dx++) {
            const x = s.x + dx;
            const y = s.y + dy;
            if (x < 0 || x >= view.grid.w || y < 0 || y >= view.grid.h) continue;
            const cell = board.querySelector(`.tac-cell[data-x="${x}"][data-y="${y}"]`);
            if (cell) cell.classList.add('in-range');
          }
        }
        // pending move marker
        const mv = draft[selectedId] && draft[selectedId].move;
        if (mv) {
          const cell = board.querySelector(`.tac-cell[data-x="${mv.x}"][data-y="${mv.y}"]`);
          if (cell) {
            const dot = document.createElement('span');
            dot.className = 'tac-move-dot';
            cell.appendChild(dot);
          }
        }
      }
    }
  }

  function renderControls() {
    const box = el('tac-controls');
    if (!box) return;
    const s = selectedId && view.squads.find((q) => q.id === selectedId);
    if (!s) {
      box.innerHTML = '';
      return;
    }
    const cur = draft[selectedId] || {};
    box.innerHTML = `
      <div class="tac-ctrl-head">
        <span>${TYPE_ICON[s.type]} ${s.name}</span>
        <span class="num">${fmtNum(s.count)}</span>
      </div>
      <div class="tac-stances">
        ${['advance', 'hold', 'assault']
          .map(
            (st) =>
              `<button class="tac-stance ${cur.stance === st ? 'on' : ''}" data-st="${st}">${STANCE_LABEL[st]}</button>`
          )
          .join('')}
      </div>
      <button id="tac-clear" class="btn btn-sm">پاک‌کردن دستور</button>`;
    box.querySelectorAll('.tac-stance').forEach((b) =>
      b.addEventListener('click', () => {
        if (draft[selectedId]) draft[selectedId].stance = b.dataset.st;
        renderControls();
      })
    );
    const clr = el('tac-clear');
    if (clr)
      clr.addEventListener('click', () => {
        if (draft[selectedId]) draft[selectedId] = { move: null, focus: null, stance: 'advance' };
        paintSelection();
        renderControls();
      });
  }

  function updateHint() {
    const h = el('tac-hint');
    if (!h || !view) return;
    if (view.submitted) {
      h.textContent = 'دستورات این دور ثبت شده است؛ منتظر حریف…';
      return;
    }
    if (!selectedId) {
      h.textContent = 'یک گروه از لشگرت را انتخاب کن، مقصد حرکت و حالت را تعیین کن؛ روی دشمنِ در تیرس کلیک کن تا هدفِ تمرکز آتش شود.';
      return;
    }
    const s = view.squads.find((q) => q.id === selectedId);
    const d = draft[selectedId] || {};
    const bits = [];
    bits.push(d.move ? `حرکت به (${fmtNum(d.move.x)},${fmtNum(d.move.y)})` : 'بدون حرکت');
    bits.push(d.focus ? 'تمرکز آتش: ' + d.focus : 'بدون هدف‌گیری');
    bits.push(STANCE_LABEL[d.stance] || '');
    h.textContent = `${TYPE_ICON[s.type]} ${s.name}: ` + bits.join(' · ');
  }

  function startCountdown(sec) {
    stopCountdown();
    secondsLeft = sec;
    const tick = () => {
      const c = el('tac-clock');
      if (!c) {
        stopCountdown();
        return;
      }
      c.textContent = fmtNum(Math.max(0, secondsLeft)) + ' ثانیه';
      if (secondsLeft <= 0) {
        stopCountdown();
        submitOrders(); // auto-submit whatever was planned
        return;
      }
      secondsLeft -= 1;
    };
    tick();
    countdown = setInterval(tick, 1000);
  }
  function stopCountdown() {
    if (countdown) clearInterval(countdown);
    countdown = null;
  }

  async function submitOrders() {
    if (!view || view.submitted || replaying) return;
    stopCountdown();
    try {
      const r = await api('POST', `/battle/orders/${battleId}`, { orders: draft });
      if (!r.ok) throw new Error(r.data.error || 'خطا در ثبت دستورات');
      handleRoundResponse(r.data);
    } catch (err) {
      setStatus(err.message || 'خطا', true);
      startCountdown(10);
    }
  }

  function handleRoundResponse(data) {
    if (data.waiting) {
      view = data.view || view;
      if (view) markSubmitted();
      setStatus('دستورها ثبت شد؛ در انتظار حریف…');
      return;
    }
    if (data.events) playRound(data);
  }

  function markSubmitted() {
    view.submitted = true;
    const rd = el('tac-ready');
    if (rd) rd.textContent = '✔ ثبت شد';
    const sb = el('tac-submit');
    if (sb) sb.disabled = true;
    selectedId = null;
    paintSelection();
    updateHint();
    stopCountdown();
  }

  // ============================================================
  // Round replay
  // ============================================================
  async function playRound(payload) {
    replaying = true;
    stopCountdown();
    const board = el('tac-board');
    const evs = payload.events || [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    for (const e of evs) {
      if (!el('tac-board')) break; // user navigated away
      if (e.kind === 'move') {
        moveChip(e.squad, e.to);
        await wait(340);
      } else if (e.kind === 'strike') {
        flashChip(e.attacker, 'attacking');
        await wait(140);
        damageChip(e.target, e.kills, e.charge ? 'حملهٔ سواران!' : e.volley ? 'رگبار' : '');
        await wait(420);
      } else if (e.kind === 'counter') {
        flashChip(e.attacker, 'attacking');
        await wait(120);
        damageChip(e.target, e.kills, 'پاسخ');
        await wait(380);
      } else if (e.kind === 'rout') {
        routChip(e.squad);
        await wait(300);
      } else if (e.kind === 'end') {
        await wait(150);
      }
    }
    replaying = false;
    // snap to authoritative next-round view
    const nv = payload.views && payload.views[mySide];
    if (nv) renderCommand(nv);
    void board;
  }

  function chipNode(sid) {
    return document.querySelector(`.tac-chip[data-sid="${sid}"]`);
  }

  function moveChip(sid, to) {
    const ch = chipNode(sid);
    if (!ch || !view) return;
    view.you = view.you; // unchanged
    const vis = view.you === 'attacker' ? to.y : view.grid.h - 1 - to.y;
    ch.style.setProperty('--x', to.x);
    ch.style.setProperty('--vy', vis);
    ch.dataset.moved = '1';
  }

  function flashChip(sid, cls) {
    const ch = chipNode(sid);
    if (ch) {
      ch.classList.add(cls);
      setTimeout(() => ch.classList.remove(cls), 400);
    }
  }

  function damageChip(sid, kills, tag) {
    const ch = chipNode(sid);
    if (!ch) return;
    ch.classList.add('hit');
    setTimeout(() => ch.classList.remove('hit'), 500);
    const f = document.createElement('span');
    f.className = 'tac-float';
    f.textContent = `−${kills % 1 ? kills.toFixed(1) : kills}${tag ? ' ' + tag : ''}`;
    ch.appendChild(f);
    setTimeout(() => f.remove(), 900);
    // shrink the count label proportionally (visual only)
    const cnt = ch.querySelector('.tac-chip-count');
    if (cnt && kills > 0) {
      // Persian digits: convert back to a number, subtract, re-render
      const fa = '۰۱۲۳۴۵۶۷۸۹';
      let n = 0;
      for (const chr of cnt.textContent) {
        const i = fa.indexOf(chr);
        if (i >= 0) n = n * 10 + i;
      }
      const next = Math.max(0, n - Math.round(kills));
      cnt.textContent = fmtNum(next);
    }
  }

  function routChip(sid) {
    const ch = chipNode(sid);
    if (!ch) return;
    ch.classList.add('routed');
    const m = document.createElement('span');
    m.className = 'tac-rout-mark';
    m.textContent = 'فرار';
    ch.appendChild(m);
  }

  // ============================================================
  // Finished battle
  // ============================================================
  function renderFinished(res) {
    stopCountdown();
    battleId = null;
    mySide = null;
    view = null;
    replaying = false;
    const main = el('battle-view');
    if (!main) return;

    // Interactive payloads carry casualties + rewards keyed by side;
    // legacy auto payloads too. Determine "my" outcome if possible.
    const winner = res.winner;
    const cas = res.casualties || {};
    const rew = res.rewards || {};

    let outcomeClass = 'draw';
    let outcomeText = 'تساوی';
    if (res.myOutcome) {
      outcomeClass = res.myOutcome;
      outcomeText = res.myOutcome === 'win' ? 'پیروزی!' : res.myOutcome === 'lose' ? 'شکست' : 'تساوی';
    } else if (winner === 'attacker' || winner === 'defender') {
      outcomeText = winner === 'attacker' ? 'پیروزی مهاجم' : 'پیروزی مدافع';
    }

    const casList = (m) =>
      m && Object.keys(m).length
        ? Object.entries(m)
            .map(([t, n]) => `<li><span>${TYPE_ICON[t] || ''} ${t}</span><span class="num">−${fmtNum(n)}</span></li>`)
            .join('')
        : '<li class="empty">—</li>';

    const rewMine = mySideOrGuess(res);
    const rewardBox = rewMine && rew[rewMine]
      ? `<div class="tac-rewards">
          <h4>پاداش‌های شما</h4>
          <p>طلا: <b class="num">${fmtNum(rew[rewMine].gold)}</b> · تجربه: <b class="num">${fmtNum(rew[rewMine].xp)}</b></p>
        </div>`
      : '';

    main.innerHTML = `
      <div class="battle-result ${outcomeClass}">
        <div class="tac-final-banner">${outcomeText}</div>
        <p class="tac-reason">${reasonFa(res.reason)}</p>
        <div class="armies">
          <div class="army-col">
            <h4>تلفات مهاجم</h4>
            <ul class="army-list">${casList(cas.attacker)}</ul>
          </div>
          <div class="army-col">
            <h4>تلفات مدافع</h4>
            <ul class="army-list">${casList(cas.defender)}</ul>
          </div>
        </div>
        ${rewardBox}
        <details class="tac-log-details">
          <summary>گزارش کامل نبرد (${fmtNum((res.log || []).length)} دور)</summary>
          ${roundLogHtml(res.log)}
        </details>
      </div>`;
    loadHistory();
  }

  function mySideOrGuess(res) {
    if (res.rewards) {
      if (res.rewards.attacker && res.rewards.defender) return window.GORZ_LAST_SIDE || 'attacker';
      return res.rewards.attacker ? 'attacker' : 'defender';
    }
    return null;
  }

  function reasonFa(reason) {
    const map = {
      'army routed': 'لشگر حریف منهدم شد',
      'mutual collapse': 'هر دو لشگر در هم شکستند',
      exhausted: 'نبرد بی‌نتیجه پایان یافت',
      'enemy destroyed': 'دشمن نابود شد',
      'decisive on points': 'برتری در پایان نبرد',
      annihilation: 'نابودی متقابل',
    };
    return map[reason] || '';
  }

  function roundLogHtml(log) {
    if (!log || !log.length) return '';
    return `<div class="battle-log"><ul>${log
      .map((t) => {
        const evs = (t.events || [])
          .map((e) => {
            if (e.kind === 'strike')
              return `<li class="ev-${e.side}">${e.charge ? '⚡ ' : ''}${e.attacker} ← ${e.target}: <b class="num">${e.kills}</b> تلفات${e.volley ? ' (رگبار)' : ''}</li>`;
            if (e.kind === 'counter')
              return `<li class="ev-${e.side}">پاسخ ${e.attacker} ← ${e.target}: <b class="num">${e.kills}</b></li>`;
            if (e.kind === 'move') return `<li class="ev-none">${e.squad} حرکت کرد</li>`;
            if (e.kind === 'rout') return `<li class="ev-defender">🏳 ${e.squad} از میدان گریخت</li>`;
            if (e.kind === 'end') return `<li class="ev-attacker"><b>پایان نبرد</b></li>`;
            return '';
          })
          .join('');
        return `<li class="turn"><strong>دور ${fmtNum(t.round !== undefined ? t.round : t.turn)}</strong><ul>${evs}</ul></li>`;
      })
      .join('')}</ul></div>`;
  }

  // ============================================================
  // History
  // ============================================================
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
              const label =
                b.state === 'finished'
                  ? b.winner_id
                    ? 'پایان‌یافته'
                    : 'تساوی'
                  : b.state === 'open'
                  ? 'در انتظار حریف'
                  : 'در جریان';
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

  // ---------- public API ----------
  window.GorzBattle = {
    battlePage,
    enterBattle,
    renderResult: renderFinished,
    loadHistory,
    socket: () => socket,
  };
})();
