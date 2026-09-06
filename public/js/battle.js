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
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

  const TYPE_ICON = { swordsman: '⚔️', archer: '🏹', cavalry: '🐎' };
  const TERRAIN_LABEL = { plain: 'Plain', forest: 'Forest', hill: 'Hill' };
  const STANCE_LABEL = { advance: 'Advance', hold: 'Hold', assault: 'Assault' };

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
            <h2>Battle</h2>
            <p class="battle-sub">Tactical combat — give your army orders every round and watch the result live.</p>
          </div>
          <div id="battle-actions" class="battle-actions">
            <button id="btn-enter-battle" class="btn btn-primary">Enter battle</button>
            <button id="btn-open-battle" class="btn">Open challenge</button>
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
        if (mineSubmitted) setStatus('Orders submitted; waiting for the opponent…');
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
    setStatus('Looking for an opponent…');
    try {
      const r = await api('POST', '/battle/enter');
      if (!r.ok) throw new Error(r.data.error || 'Battle error');
      setStatus('');
      if (r.data.mode === 'interactive') {
        battleId = r.data.battleId;
        mySide = r.data.side;
        window.GORZ_LAST_SIDE = mySide;
        if (r.data.vsAi) setStatus('Versus AI — your turn');
        enterLive();
      } else {
        // legacy/auto-mode payload: full result in one shot
        renderFinished(r.data);
        loadHistory();
      }
    } catch (err) {
      // maybe we already have a live battle -> resume it
      const resumed = await tryResume();
      if (!resumed) setStatus(err.message || 'Failed to enter battle', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openChallenge() {
    setStatus('Challenge opened; waiting for an opponent to accept…');
    try {
      const r = await api('POST', '/battle/open');
      if (!r.ok) throw new Error(r.data.error || 'Error');
    } catch (err) {
      setStatus(err.message || 'Error', true);
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
    // derive our side from the authoritative view so selection/ownership work
    // even when renderCommand is called directly (not via enterBattle).
    mySide = v.you || v.side || mySide;
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
          <div class="tac-round num">Round <b>${fmtNum(v.round + 1)}</b> / ${fmtNum(v.maxRounds)}</div>
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
          <div id="tac-hint" class="tac-hint">Select a squad from your army.</div>
          <div id="tac-controls" class="tac-controls"></div>
          <div class="tac-submit-row">
            <span id="tac-ready" class="tac-ready"></span>
            <button id="tac-submit" class="btn btn-primary">Submit orders</button>
          </div>
        </div>
      </div>`;
    drawBoard(v);
    el('tac-submit').addEventListener('click', submitOrders);
    startCountdown(v.orderTimerSec);
    updateHint();
  }

  const owns = (s) => (mySide === 'attacker' ? s.id.startsWith('A') : s.id.startsWith('B'));
  const sideKey = (v) => v.you;
  const foeKey = (v) => (v.you === 'attacker' ? 'defender' : 'attacker');

  function powerBar(kind, frac) {
    const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)));
    return `<div class="tac-power tac-power-${kind}">
      <span>${kind === 'you' ? 'Your power' : 'Opponent'}</span>
      <div class="tac-power-track"><div class="tac-power-fill ${kind}" style="width:${pct}%"></div></div>
      <b class="num">${fmtNum(pct)}%</b>
    </div>`;
  }

  // Logical (x,y) -> visual row/col (viewer's army always at bottom).
  const visY = (y) => (view.you === 'attacker' ? y : view.grid.h - 1 - y);

  function drawBoard(v) {
    const board = el('tac-board');
    if (!board) return;
    board.innerHTML = '';
    // Fantasy war-map SVG (no external assets). GorzMap.buildMap draws
    // attacker home at the bottom row, defender home at the top row.
    if (window.GorzMap && typeof window.GorzMap.buildMap === 'function') {
      try {
        const svg = window.GorzMap.buildMap(v, {
          seed: v.battleId,
          squads: v.squads,
          selectedId: selectedId || null,
          pendingMove: (selectedId && draft[selectedId] && draft[selectedId].move) || null,
          pendingFrom: (selectedId && draft[selectedId] && draft[selectedId].move && (function () {
            const s = v.squads.find((q) => q.id === selectedId);
            return s ? { x: s.x, y: s.y } : null;
          })()) || null,
          trails: (v.trails && v.trails.length ? v.trails : (window.__gorzTrails || [])),
          isMySquad: (sq) => owns(sq),
          onSelect: (sid) => onChipClick(sid),
        });
        board.appendChild(svg);
        if (window.GorzMap && window.GorzMap.attachPanZoom) window.GorzMap.attachPanZoom(svg, v);
        svg.querySelectorAll('.banner').forEach((g) =>
          g.addEventListener('click', (ev) => {
            ev.stopPropagation();
            onChipClick(g.dataset.squad);
          })
        );
        // click empty terrain (or a keep) to issue a move order
        svg.addEventListener('click', (ev) => {
          if (ev.target.closest('.banner')) return; // handled above
          const pt = svg.createSVGPoint();
          pt.x = ev.clientX; pt.y = ev.clientY;
          const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
          const vb = svg.viewBox.baseVal;
          const cw = vb.width / view.grid.w, ch = vb.height / view.grid.h;
          const gx = Math.floor(loc.x / cw), gy = Math.floor(loc.y / ch);
          if (gx < 0 || gx >= view.grid.w || gy < 0 || gy >= view.grid.h) return;
          onCellClick(gx, gy);
        });
        paintSelection();
        return;
      } catch (err) {
        console.error('[battle] map render failed, falling back to grid', err);
      }
    }
    // --- fallback: flat grid (only if the map module failed to load) ---
    let html = '<div class="tac-fx"></div>';
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
      ${s.routed ? '<span class="tac-rout-mark">Routed</span>' : ''}
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
    const usingMap = !!board.querySelector('svg.tac-map');
    if (usingMap) {
      board.querySelectorAll('.banner').forEach((g) => {
        g.classList.toggle('selected', g.dataset.squad === selectedId);
        const foc = selectedId && draft[selectedId] && draft[selectedId].focus === g.dataset.squad;
        g.classList.toggle('focused', !!foc);
      });
      const old = board.querySelectorAll('.tac-map-fx');
      old.forEach((n) => n.remove());
      if (selectedId && !view.submitted) {
        const s = view.squads.find((q) => q.id === selectedId);
        if (s) {
          const svg = board.querySelector('svg.tac-map');
          const vb = svg.viewBox.baseVal;
          const cw = vb.width / view.grid.w, ch = vb.height / view.grid.h;
          const cx = (x) => (x + 0.5) * cw, cy = (y) => (y + 0.5) * ch;
          const fx = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          fx.setAttribute('class', 'tac-map-fx');
          for (let dy = -(s.mp + 2); dy <= s.mp + 2; dy++) {
            for (let dx = -(s.mp + 2); dx <= s.mp + 2; dx++) {
              const x = s.x + dx, y = s.y + dy;
              if (x < 0 || x >= view.grid.w || y < 0 || y >= view.grid.h) continue;
              if (view.obstacles && view.obstacles.some((o) => o.x === x && o.y === y)) continue;
              const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
              rect.setAttribute('x', x * cw + 1); rect.setAttribute('y', y * ch + 1);
              rect.setAttribute('width', cw - 2); rect.setAttribute('height', ch - 2);
              rect.setAttribute('fill', 'rgba(224,138,60,.12)');
              rect.setAttribute('stroke', 'rgba(224,138,60,.45)');
              rect.setAttribute('stroke-width', '0.8');
              fx.appendChild(rect);
            }
          }
          const mv = draft[selectedId] && draft[selectedId].move;
          if (mv) {
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', cx(mv.x)); dot.setAttribute('cy', cy(mv.y)); dot.setAttribute('r', Math.min(cw, ch) * 0.22);
            dot.setAttribute('fill', '#f0a04e'); dot.setAttribute('stroke', '#0c0e11'); dot.setAttribute('stroke-width', 1);
            fx.appendChild(dot);
          }
          svg.appendChild(fx);
        }
      }
      return;
    }
    // fallback grid path
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
        for (let dy = -(s.mp + 2); dy <= s.mp + 2; dy++) {
          for (let dx = -(s.mp + 2); dx <= s.mp + 2; dx++) {
            const x = s.x + dx;
            const y = s.y + dy;
            if (x < 0 || x >= view.grid.w || y < 0 || y >= view.grid.h) continue;
            const cell = board.querySelector(`.tac-cell[data-x='${x}'][data-y='${y}']`);
            if (cell) cell.classList.add('in-range');
          }
        }
        const mv = draft[selectedId] && draft[selectedId].move;
        if (mv) {
          const cell = board.querySelector(`.tac-cell[data-x='${mv.x}'][data-y='${mv.y}']`);
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
      <button id="tac-clear" class="btn btn-sm">Clear order</button>`;
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
      h.textContent = 'Orders for this round are locked in; waiting for the opponent…';
      return;
    }
    if (!selectedId) {
      h.textContent = 'Pick a squad, set its move destination and stance; click an enemy within range to mark it for focus fire.';
      return;
    }
    const s = view.squads.find((q) => q.id === selectedId);
    const d = draft[selectedId] || {};
    const bits = [];
    bits.push(d.move ? `Move to (${fmtNum(d.move.x)},${fmtNum(d.move.y)})` : 'No movement');
    bits.push(d.focus ? 'Focus fire: ' + d.focus : 'No target');
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
      c.textContent = fmtNum(Math.max(0, secondsLeft)) + 's';
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
      if (!r.ok) throw new Error(r.data.error || 'Failed to submit orders');
      handleRoundResponse(r.data);
    } catch (err) {
      setStatus(err.message || 'Error', true);
      startCountdown(10);
    }
  }

  function handleRoundResponse(data) {
    // vs AI: the round resolves immediately on the human's single submit.
    if (data.vsAi && !data.waiting) {
      if (data.outcome && data.outcome.over) {
        // battle finished this round -> show results (server finalized)
        renderFinished(data);
        return;
      }
      if (data.winner !== undefined) {
        // finalized payload (finalizeBattle result): winner is set, no events
        renderFinished(data);
        return;
      }
      // mid-battle: replay the round's events, then snap to next-round view
      if (data.events) playRound(data);
      if (data.view) renderCommand(data.view);
      return;
    }
    if (data.waiting) {
      view = data.view || view;
      if (view) markSubmitted();
      if (data.vsAi) setStatus('Orders submitted; the AI is moving…');
      else setStatus('Orders submitted; waiting for the opponent…');
      return;
    }
    if (data.events) playRound(data);
  }

  function markSubmitted() {
    view.submitted = true;
    const rd = el('tac-ready');
    if (rd) rd.textContent = '✔ Submitted';
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
        damageChip(e.target, e.kills, e.charge ? 'Cavalry charge!' : e.volley ? 'Volley' : '');
        await wait(420);
      } else if (e.kind === 'counter') {
        flashChip(e.attacker, 'attacking');
        await wait(120);
        damageChip(e.target, e.kills, 'Counter');
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
      // parse the rendered count back to a number, subtract, re-render
      const n = parseInt(cnt.textContent.replace(/[^0-9]/g, ''), 10) || 0;
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
    m.textContent = 'Routed';
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
    let outcomeText = 'Draw';
    if (res.myOutcome) {
      outcomeClass = res.myOutcome;
      outcomeText = res.myOutcome === 'win' ? 'Victory!' : res.myOutcome === 'lose' ? 'Defeat' : 'Draw';
    } else if (winner === 'attacker' || winner === 'defender') {
      outcomeText = winner === 'attacker' ? 'Attacker wins' : 'Defender wins';
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
          <h4>Your rewards</h4>
          <p>Gold: <b class="num">${fmtNum(rew[rewMine].gold)}</b> · XP: <b class="num">${fmtNum(rew[rewMine].xp)}</b></p>
        </div>`
      : '';

    main.innerHTML = `
      <div class="battle-result ${outcomeClass}">
        <div class="tac-final-banner">${outcomeText}</div>
        <p class="tac-reason">${reasonText(res.reason)}</p>
        <div class="armies">
          <div class="army-col">
            <h4>Attacker casualties</h4>
            <ul class="army-list">${casList(cas.attacker)}</ul>
          </div>
          <div class="army-col">
            <h4>Defender casualties</h4>
            <ul class="army-list">${casList(cas.defender)}</ul>
          </div>
        </div>
        ${rewardBox}
        <details class="tac-log-details">
          <summary>Full battle log (${fmtNum((res.log || []).length)} rounds)</summary>
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

  function reasonText(reason) {
    const map = {
      'army routed': 'The enemy army was routed',
      'mutual collapse': 'Both armies collapsed',
      exhausted: 'The battle ended indecisively',
      'enemy destroyed': 'The enemy was destroyed',
      'decisive on points': 'Decisive on points at battle end',
      annihilation: 'Mutual annihilation',
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
              return `<li class="ev-${e.side}">${e.charge ? '⚡ ' : ''}${e.attacker} ← ${e.target}: <b class="num">${e.kills}</b> kills${e.volley ? ' (volley)' : ''}</li>`;
            if (e.kind === 'counter')
              return `<li class="ev-${e.side}">Counter ${e.attacker} ← ${e.target}: <b class="num">${e.kills}</b></li>`;
            if (e.kind === 'move') return `<li class="ev-none">${e.squad} moved</li>`;
            if (e.kind === 'rout') return `<li class="ev-defender">🏳 ${e.squad} fled the field</li>`;
            if (e.kind === 'end') return `<li class="ev-attacker"><b>Battle over</b></li>`;
            return '';
          })
          .join('');
        return `<li class="turn"><strong>Round ${fmtNum(t.round !== undefined ? t.round : t.turn)}</strong><ul>${evs}</ul></li>`;
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
        ? `<h4>Battle history</h4><ul class="hist-list">${data.battles
            .map((b) => {
              const label =
                b.state === 'finished'
                  ? b.winner_id
                    ? 'Finished'
                    : 'Draw'
                  : b.state === 'open'
                  ? 'Waiting for opponent'
                  : 'In progress';
              return `<li class="hist-item">
                <span class="hist-id">Battle #${b.id}</span>
                <span class="hist-state">${label}</span>
                <span class="hist-time">${b.created_at || ''}</span>
              </li>`;
            })
            .join('')}</ul>`
        : '<p class="empty">You have not fought any battles yet.</p>';
    } catch { /* ignore */ }
  }

  // ---------- public API ----------
  window.GorzBattle = {
    battlePage,
    enterBattle,
    renderResult: renderFinished,
    renderCommand,
    loadHistory,
    socket: () => socket,
  };
})();
