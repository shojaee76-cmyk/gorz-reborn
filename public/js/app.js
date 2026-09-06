/* ============================================================
 * Gorz Reborn — app.js
 * Landing auth + in-game dashboard logic (W3).
 * All panels call the HTTP API; sockets refresh stats live.
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const SOLDIER_NAMES = { swordsman: 'Swordsman', archer: 'Archer', cavalry: 'Cavalry' };
  const SOLDIER_ICONS = { swordsman: '⚔️', archer: '🏹', cavalry: '🐎' };
  const KIND_LABELS = {
    signup: 'Signup gift', train: 'Soldier training', recruit: 'Recruitment',
    battle: 'Battle', mission_reward: 'Mission reward', levelup: 'Level up',
    buy: 'Market purchase', sell: 'Market sale', buy_diamond: 'Diamond purchase',
    list: 'Listing created', cancel_listing: 'Listing cancelled', hero_levelup: 'Hero level up',
    generic: 'Transaction',
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(data.error || `Error (${res.status})`);
    return data;
  }

  /* ---------- toasts ---------- */
  function toast(msg, kind = 'info') {
    const wrap = $('toasts');
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.3s';
      setTimeout(() => t.remove(), 320);
    }, 3800);
  }

  /* ============================================================
   * LANDING (index.html) — register / login
   * ============================================================ */
  function initLanding() {
    if (!$('auth-form')) return;

    let mode = 'login';
    const title = $('auth-title');
    const sub = $('auth-sub');
    const errBox = $('form-error');
    const confirmGroup = $('confirm-group');
    const submitBtn = $('auth-submit');
    const altText = $('auth-alt-text');
    const altBtn = $('auth-alt-btn');

    function setMode(m) {
      mode = m;
      const login = m === 'login';
      title.textContent = login ? 'Sign in to Gorz Reborn' : 'Create a new account';
      sub.textContent = login ? 'Log in with your account.' : 'Register for free and take command.';
      $('tab-login').classList.toggle('active', login);
      $('tab-register').classList.toggle('active', !login);
      confirmGroup.classList.toggle('hidden', login);
      submitBtn.textContent = login ? 'Log in' : 'Register';
      altText.textContent = login ? 'No account yet?' : 'Already have an account?';
      altBtn.textContent = login ? 'Register' : 'Log in';
      errBox.classList.remove('show');
      $('password').setAttribute('autocomplete', login ? 'current-password' : 'new-password');
      $('confirm').setAttribute('autocomplete', 'new-password');
    }
    $('tab-login').addEventListener('click', () => setMode('login'));
    $('tab-register').addEventListener('click', () => setMode('register'));
    altBtn.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

    $('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.classList.remove('show');
      const email = $('email').value.trim();
      const password = $('password').value;
      const confirm = $('confirm').value;

      if (!email || !password) return showErr('Enter your email and password.');
      if (mode === 'register') {
        if (password.length < 6) return showErr('Password must be at least 6 characters.');
        if (password !== confirm) return showErr('Passwords do not match.');
      }

      submitBtn.disabled = true;
      submitBtn.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';
      try {
        await api(`/api/auth/${mode}`, {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        window.location.href = '/app.html';
      } catch (err) {
        showErr(err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'login' ? 'Log in' : 'Register';
      }
    });

    function showErr(msg) {
      errBox.textContent = msg;
      errBox.classList.add('show');
    }

    // If already logged in, skip straight to the dashboard.
    api('/api/auth/me').then(() => { window.location.href = '/app.html'; }).catch(() => {});
  }

  /* ============================================================
   * DASHBOARD (app.html)
   * ============================================================ */
  let socket = null;
  let user = null;
  let currentPanel = 'overview';
  let battleRendered = false;

  function initDashboard() {
    if (!$('mainnav')) return;
    bindNav();
    bindLogout();
    $('brand-link').addEventListener('click', (e) => {
      e.preventDefault();
      showPanel('overview');
    });

    // Socket.IO for live updates (stats refresh on battle:finished).
    if (typeof io !== 'undefined') {
      socket = io();
      socket.on('battle:finished', () => {
        refreshStats();
        if (currentPanel === 'overview') loadOverview();
        if (currentPanel === 'ranking') loadRanking();
      });
    }

    // W2 owns the battle UI; app.js just mounts it on demand (see loaders.battle).
    bindSellForm();
    boot();
  }

  async function boot() {
    try {
      user = (await api('/api/auth/me')).user;
    } catch {
      window.location.href = '/'; // not logged in
      return;
    }
    window.GORZ_USER = user;
    renderStats(user);
    // Deep-link support: /app.html?panel=barracks opens that panel directly.
    const wanted = new URLSearchParams(window.location.search).get('panel');
    if (wanted && loaders[wanted]) currentPanel = wanted;
    showPanel(currentPanel);
  }

  /* ---------- nav ---------- */
  function bindNav() {
    document.querySelectorAll('.mainnav button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = btn.dataset.panel;
        if (panel === 'battle') renderBattle();
        showPanel(panel);
      });
    });
  }

  function showPanel(name) {
    currentPanel = name;
    document.querySelectorAll('.mainnav button').forEach((b) =>
      b.classList.toggle('active', b.dataset.panel === name)
    );
    document.querySelectorAll('.panel').forEach((p) =>
      p.classList.toggle('active', p.id === `panel-${name}`)
    );
    loaders[name] && loaders[name]();
  }

  /* ---------- stats bar ---------- */
  function renderStats(u) {
    user = u;
    $('sb-level').textContent = fmt(u.level);
    $('sb-gold').textContent = fmt(u.gold);
    $('sb-diamond').textContent = fmt(u.diamonds);
    $('ov-level').textContent = fmt(u.level);
    $('ov-gold').textContent = fmt(u.gold);
    $('ov-diamond').textContent = fmt(u.diamonds);
    $('ov-rank').textContent = fmt(u.ranking_score);
    $('bk-gold').textContent = fmt(u.gold);
    $('bk-diamond').textContent = fmt(u.diamonds);
  }

  async function refreshStats() {
    try {
      const { user: u } = await api('/api/auth/me');
      renderStats(u);
    } catch { /* session gone */ }
  }

  /* ---------- panel loaders ---------- */
  const loaders = {
    overview: loadOverview,
    barracks: loadBarracks,
    heroes: loadHeroes,
    battle: renderBattle,
    market: loadMarket,
    bank: loadBank,
    missions: loadMissions,
    ranking: loadRanking,
  };

  /* ============ overview ============ */
  async function loadOverview() {
    try {
      const [armyData, heroData, misData] = await Promise.all([
        api('/api/barracks'),
        api('/api/heroes'),
        api('/api/missions'),
      ]);
      const army = armyData.army || [];
      const heroes = heroData.heroes || [];
      const missions = misData.missions || [];

      // army mini-list
      const armyHtml = army.length
        ? `<ul class="army-list">${army
            .filter((u) => u.count > 0)
            .map(
              (u) => `<li>
                <span class="u-name">${SOLDIER_ICONS[u.type]} ${SOLDIER_NAMES[u.type] || u.type}</span>
                <span class="u-count num">${fmt(u.count)}</span>
                <span class="u-atk">⚔ ${fmt(u.attack)}</span>
                <span class="u-def">🛡 ${fmt(u.defense)}</span>
              </li>`
            )
            .join('')}</ul>`
        : '<p class="empty">You have no army. Visit the barracks to recruit soldiers.</p>';
      $('ov-army').innerHTML = armyHtml;

      // best hero
      const hero = heroes[0];
      $('ov-hero').innerHTML = hero
        ? `<div class="hero-card" style="padding:14px">
            <div class="hero-avatar">⚔️</div>
            <div class="hero-info">
              <div class="hero-name">${hero.name}</div>
              <div class="hero-lvl">Level <span class="num">${fmt(hero.level)}</span></div>
              <div class="hero-xp">
                <div class="progress-label"><span>Experience</span><span class="num">${fmt(hero.xp)} / ${fmt(hero.level * 250)}</span></div>
                <div class="progress"><div class="fill" style="width:${heroXpPct(hero)}%"></div></div>
              </div>
            </div>
          </div>`
        : '<p class="empty">You have no heroes yet.</p>';

      // active missions (max 3, first not-done)
      const active = missions.filter((m) => !m.done).slice(0, 3);
      $('ov-missions').innerHTML = active.length
        ? active
            .map(
              (m) => `<div class="mission-card" style="padding:14px 16px; margin-bottom:10px">
                <div class="m-head"><h4>${m.title_fa}</h4><span class="m-state">${fmt(m.progress)} / ${fmt(m.target)}</span></div>
                <div class="progress"><div class="fill warn" style="width:${pct(m.progress, m.target)}%"></div></div>
              </div>`
            )
            .join('')
        : '<p class="empty">All missions completed. Well done! 🎉</p>';
    } catch { /* leave placeholders */ }
  }

  function heroXpPct(h) {
    const need = h.level * 250;
    return Math.min(100, Math.round((h.xp / need) * 100));
  }
  function pct(a, b) { return b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0; }

  /* ============ barracks ============ */
  async function loadBarracks() {
    try {
      const data = await api('/api/barracks');
      renderTrainingPoints(data.training_points, data.cap);
      const army = data.army || [];
      $('barracks-units').innerHTML = army
        .map((u) => unitCard(u, data.training_points, data.cap))
        .join('');
      bindUnitActions();
    } catch (err) {
      $('barracks-units').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  function renderTrainingPoints(points, cap) {
    $('tp-val').textContent = fmt(points);
    $('tp-cap').textContent = fmt(cap);
    $('tp-fill').style.width = `${pct(points, cap)}%`;
  }

  function unitCard(u, points, cap) {
    const kLvl = u.knowledge_level || 0;
    const spec = { swordsman: 5, archer: 7, cavalry: 10 };
    const per = spec[u.type] || 5;
    return `<div class="unit-card">
      <div class="u-head">
        <div class="flex"><span class="u-icon">${SOLDIER_ICONS[u.type]}</span><h3>${SOLDIER_NAMES[u.type]}</h3></div>
        <span class="knowledge-tag" title="Knowledge level">📖 Knowledge ${kLvl}</span>
      </div>
      <div class="u-stats">
        <div class="u-stat"><span class="k">Attack</span><span class="v num">${fmt(u.attack)}</span></div>
        <div class="u-stat"><span class="k">Defense</span><span class="v num">${fmt(u.defense)}</span></div>
        <div class="u-stat"><span class="k">Speed</span><span class="v num">${fmt(spec[u.type] || 0)}</span></div>
      </div>
      <p class="u-count">Count: <span class="num">${fmt(u.count)}</span></p>
      <div class="u-actions">
        <div class="u-train-row">
          <input type="number" class="train-count" data-type="${u.type}" data-stat="attack" min="1" value="1" placeholder="Qty" />
          <button class="btn btn-sm train-btn" data-type="${u.type}" data-stat="attack" title="Train attack">Train attack</button>
        </div>
        <div class="u-train-row">
          <input type="number" class="train-count" data-type="${u.type}" data-stat="defense" min="1" value="1" placeholder="Qty" />
          <button class="btn btn-sm train-btn" data-type="${u.type}" data-stat="defense" title="Train defense">Train defense</button>
        </div>
        <div class="u-train-row">
          <input type="number" class="recruit-count" data-type="${u.type}" min="1" value="10" placeholder="Qty" />
          <button class="btn btn-sm btn-primary recruit-btn" data-type="${u.type}">Recruit</button>
        </div>
      </div>
      <p class="small dim">Training cost: <span class="num">${fmt(per)}</span> gold and <span class="num">${fmt(u.type === 'cavalry' ? 3 : 2)}</span> points per soldier</p>
    </div>`;
  }

  function bindUnitActions() {
    document.querySelectorAll('.train-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const type = btn.dataset.type;
        const stat = btn.dataset.stat;
        const input = document.querySelector(`.train-count[data-type="${type}"][data-stat="${stat}"]`);
        const count = parseInt(input.value, 10) || 1;
        btn.disabled = true;
        try {
          const { soldier } = await api('/api/barracks/train', {
            method: 'POST',
            body: JSON.stringify({ type, stat, count }),
          });
          toast(`Training done: ${count} ${SOLDIER_NAMES[type]}`, 'success');
          await refreshStats();
          await loadBarracks();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('.recruit-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const type = btn.dataset.type;
        const input = document.querySelector(`.recruit-count[data-type="${type}"]`);
        const count = parseInt(input.value, 10) || 1;
        btn.disabled = true;
        try {
          const { soldier } = await api('/api/barracks/recruit', {
            method: 'POST',
            body: JSON.stringify({ type, count }),
          });
          toast(`${count} ${SOLDIER_NAMES[type]} joined your army`, 'success');
          await refreshStats();
          await loadBarracks();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  }

  /* ============ heroes ============ */
  async function loadHeroes() {
    try {
      const { heroes } = await api('/api/heroes');
      $('heroes-list').innerHTML = heroes.length
        ? heroes
            .map(
              (h) => `<div class="hero-card">
                <div class="hero-avatar">⚔️</div>
                <div class="hero-info">
                  <div class="hero-name">${h.name}</div>
                  <div class="hero-lvl">Level <span class="num">${fmt(h.level)}</span></div>
                  <div class="hero-mods">
                    <span>Attack: <span class="atk num">+${fmt(Math.round(h.attack_mod * 100))}%</span></span>
                    <span>Defense: <span class="def num">+${fmt(Math.round(h.defense_mod * 100))}%</span></span>
                  </div>
                  <div class="hero-xp">
                    <div class="progress-label"><span>Experience</span><span class="num">${fmt(h.xp)} / ${fmt(h.level * 250)}</span></div>
                    <div class="progress"><div class="fill" style="width:${heroXpPct(h)}%"></div></div>
                  </div>
                </div>
              </div>`
            )
            .join('')
        : '<p class="empty">You have no heroes yet.</p>';
    } catch (err) {
      $('heroes-list').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  /* ============ battle (mounts W2's battle.js) ============ */
  function renderBattle() {
    if (battleRendered) return;
    if (window.GorzBattle && typeof window.GorzBattle.battlePage === 'function') {
      window.GorzBattle.battlePage();
      battleRendered = true;
    } else {
      $('battle-page').innerHTML = '<div class="placeholder">Battle engine is loading…</div>';
    }
  }

  /* ============ market ============ */
  async function loadMarket() {
    try {
      const [all, mine] = await Promise.all([
        api('/api/market/listings'),
        api('/api/market/listings?mine=1'),
      ]);
      $('market-listings').innerHTML = renderListings(all.listings || [], { buyable: true });
      $('market-mine').innerHTML = renderListings(mine.listings || [], { buyable: false });
      bindListingActions();
    } catch (err) {
      $('market-listings').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  function renderListings(listings, { buyable }) {
    if (!listings.length) return '<p class="empty">No listings posted.</p>';
    return listings
      .map((l) => {
        const icon = l.item_type === 'diamond' ? '💎' : SOLDIER_ICONS[l.item_type] || '📦';
        const name = l.item_type === 'diamond' ? 'Diamond' : SOLDIER_NAMES[l.item_type] || l.item_type;
        return `<div class="listing-item">
          <div class="li-info">
            <span class="li-icon">${icon}</span>
            <div>
              <span class="li-name">${name} <span class="li-qty num">× ${fmt(l.qty)}</span></span>
              <span class="li-seller">Seller: <span class="mono">${l.seller_email || '—'}</span></span>
            </div>
          </div>
          <div class="flex">
            <span class="li-price num">${fmt(l.price_gold)} 🪙</span>
            ${buyable
              ? `<button class="btn btn-sm btn-primary buy-btn" data-id="${l.id}" data-name="${name}">Buy</button>`
              : `<button class="btn btn-sm btn-danger cancel-btn" data-id="${l.id}">Cancel</button>`}
          </div>
        </div>`;
      })
      .join('');
  }

  function bindListingActions() {
    document.querySelectorAll('.buy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/market/buy', { method: 'POST', body: JSON.stringify({ listing_id: Number(btn.dataset.id) }) });
          toast(`Bought ${btn.dataset.name} successfully`, 'success');
          await refreshStats();
          await loadMarket();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('.cancel-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/market/cancel', { method: 'POST', body: JSON.stringify({ listing_id: Number(btn.dataset.id) }) });
          toast('Listing cancelled', 'info');
          await loadMarket();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  }

  function bindSellForm() {
    const form = $('sell-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const item_type = $('sell-type').value;
      const qty = parseInt($('sell-qty').value, 10) || 0;
      const price_gold = parseInt($('sell-price').value, 10) || 0;
      if (qty <= 0 || price_gold <= 0) return toast('Enter a valid quantity and price.', 'error');
      try {
        await api('/api/market/list', {
          method: 'POST',
          body: JSON.stringify({ item_type, qty, price_gold }),
        });
        toast('Listing created', 'success');
        await refreshStats();
        await loadMarket();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  /* ============ bank ============ */
  async function loadBank() {
    try {
      const { ledger } = await api('/api/bank/ledger?limit=50');
      $('bank-ledger').innerHTML = ledger.length
        ? `<ul class="ledger-list">${ledger
            .map(
              (t) => `<li class="ledger-item">
                <div class="lx-note">
                  ${t.note || ''}
                  <span class="lx-kind">${KIND_LABELS[t.kind] || t.kind}</span>
                </div>
                <span class="lx-gold ${t.delta_gold > 0 ? 'pos' : t.delta_gold < 0 ? 'neg' : 'zero'}">${fmt(t.delta_gold)}</span>
                <span class="lx-gold ${t.delta_diamonds > 0 ? 'pos' : t.delta_diamonds < 0 ? 'neg' : 'zero'}">${t.delta_diamonds ? fmt(t.delta_diamonds) + ' 💎' : ''}</span>
                <span class="lx-time mono">${t.created_at || ''}</span>
              </li>`
            )
            .join('')}</ul>`
        : '<p class="empty">No transactions recorded.</p>';
    } catch (err) {
      $('bank-ledger').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  /* ============ missions ============ */
  async function loadMissions() {
    try {
      const { missions } = await api('/api/missions');
      $('missions-list').innerHTML = missions.length
        ? missions
            .map((m) => {
              const rewards = [];
              if (m.reward_gold) rewards.push(`<span class="gold">🪙 ${fmt(m.reward_gold)}</span>`);
              if (m.reward_xp) rewards.push(`<span class="xp">⚡ ${fmt(m.reward_xp)} XP</span>`);
              if (m.reward_diamonds) rewards.push(`<span class="dia">💎 ${fmt(m.reward_diamonds)}</span>`);
              const done = !!m.done;
              return `<div class="mission-card ${done ? 'done' : ''}">
                <div class="m-head">
                  <h4>${m.title_fa}</h4>
                  ${done
                    ? '<span class="m-state">Completed ✓</span>'
                    : `<button class="btn btn-sm btn-success claim-btn" data-id="${m.mission_id}">Claim reward</button>`}
                </div>
                <p class="m-desc">${m.desc_fa}</p>
                <div class="progress">
                  <div class="fill ${done ? 'good' : 'warn'}" style="width:${pct(m.progress, m.target)}%"></div>
                </div>
                <div class="progress-label"><span class="num">${fmt(m.progress)} / ${fmt(m.target)}</span><span class="m-rewards">${rewards.join('') || ''}</span></div>
              </div>`;
            })
            .join('')
        : '<p class="empty">No missions available.</p>';
      bindClaimButtons();
    } catch (err) {
      $('missions-list').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  function bindClaimButtons() {
    document.querySelectorAll('.claim-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await api('/api/missions/claim', {
            method: 'POST',
            body: JSON.stringify({ mission_id: Number(btn.dataset.id) }),
          });
          let msg = 'Reward claimed! 🎉';
          if (res.levelUps > 0) msg += ` Commander level up to ${fmt(res.level)}!`;
          toast(msg, 'success');
          await refreshStats();
          await loadMissions();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  }

  /* ============ ranking ============ */
  async function loadRanking() {
    try {
      const { ranking } = await api('/api/ranking?limit=50');
      $('ranking-list').innerHTML = ranking.length
        ? `<div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Rank</th><th>Commander</th><th>Level</th>
              <th>Score</th><th>Wins</th><th>Losses</th>
            </tr></thead>
            <tbody>
              ${ranking
                .map(
                  (r) => {
                    const me = user && r.id === user.id;
                    const top = r.rank <= 3;
                    return `<tr class="${me ? 'me-row' : ''}">
                      <td><div class="rank-row ${top ? 'top' + r.rank : ''}"><span class="rank-no">${fmt(r.rank)}</span>${me ? '<span class="rank-me">You</span>' : ''}</div></td>
                      <td><span class="mono">${r.email}</span></td>
                      <td><span class="num">${fmt(r.level)}</span></td>
                      <td><span class="rank-score num">${fmt(r.ranking_score)}</span></td>
                      <td><span class="num pos">${fmt(r.wins)}</span></td>
                      <td><span class="num neg">${fmt(r.losses)}</span></td>
                    </tr>`;
                  }
                )
                .join('')}
            </tbody>
          </table></div>`
        : '<p class="empty">No commanders ranked yet.</p>';
    } catch (err) {
      $('ranking-list').innerHTML = `<p class="empty">${err.message}</p>`;
    }
  }

  /* ---------- logout ---------- */
  function bindLogout() {
    $('btn-logout').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
      window.location.href = '/';
    });
  }

  /* ---------- boot ---------- */
  if (document.getElementById('mainnav')) {
    document.addEventListener('DOMContentLoaded', initDashboard);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      initLanding();
      bindSellForm(); // no-op on landing
    });
  }
})();
