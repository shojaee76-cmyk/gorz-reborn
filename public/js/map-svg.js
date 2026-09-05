'use strict';
// ============================================================
// Gorz Reborn — map-svg.js
// Detailed SVG renderer for the v3 "Four Castles" battlefield.
//
// Renders from a view object:
//   { grid: {w,h}, terrain: string[][], castles: {key:{x,y,owner,...}},
//     objectives, squads: [...], round }
//
// Design goals (user spec):
//   - every element LOOKS like what it is (water flows, mountains have
//     snow caps, forests are tree clusters, jungle is dense canopy,
//     bridges are planks, castles have towers + faction banners)
//   - all terrain is functional (rendered from the same grid the
//     engine simulates on — no decorative lies)
//   - point-symmetric map, dark-ember theme, ONE accent
// ============================================================

(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // palette (dark ember theme, single accent family + semantic terrain)
  const C = {
    plainA: '#2b2f33', plainB: '#272b2f',       // checkered plains
    grid: 'rgba(255,255,255,0.045)',
    water: '#17384a', waterDeep: '#0f2735', waterLine: '#2c6a86',
    bridge: '#8a6a3f', bridgePlank: '#a5824e', bridgeEdge: '#5f4a2c',
    hill: '#4a4438', hillLight: '#5c5443',
    forestTree: '#2e5233', forestTreeDark: '#24402a', forestTrunk: '#4a3a26',
    jungleTree: '#1f4028', jungleTreeDark: '#16301d', jungleLight: '#2c5738',
    mountain: '#3f4145', mountainSnow: '#9aa2ab', mountainDark: '#2c2e32',
    castleWall: '#6b5a44', castleWallLight: '#857152', castleTower: '#514434',
    bannerA: '#c8742a', bannerA2: '#e0924a',   // ember/attacker
    bannerB: '#8a3232', bannerB2: '#b04a4a',   // crimson/defender
    neutral: '#7c8288',
    grid_ember: '#e0924a',
  };

  const UNIT_COLORS = {
    attacker: { main: '#d97a2b', dark: '#a3561c', light: '#f0a45c' },
    defender: { main: '#a83c3c', dark: '#7c2a2a', light: '#cc6060' },
  };
  const UNIT_ICONS = { swordsman: '⚔', archer: '🏹', cavalry: '🐎' };

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function txt(x, y, s, attrs, parent) {
    const t = el('text', Object.assign({ x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, attrs), parent);
    t.textContent = s;
    return t;
  }

  // ------------------------------------------------------------
  // Terrain tiles. Each renderer draws INSIDE cell (x*cs, y*cs, cs, cs).
  // ------------------------------------------------------------
  const T = {
    plain(g, px, py, cs, x, y) {
      el('rect', { x: px, y: py, width: cs, height: cs, fill: (x + y) % 2 ? C.plainA : C.plainB }, g);
    },
    hill(g, px, py, cs) {
      el('rect', { x: px, y: py, width: cs, height: cs, fill: C.plainA }, g);
      // two overlapping mounds
      el('path', {
        d: `M ${px + cs * 0.08} ${py + cs * 0.8} Q ${px + cs * 0.35} ${py + cs * 0.25} ${px + cs * 0.62} ${py + cs * 0.8} Z`,
        fill: C.hill,
      }, g);
      el('path', {
        d: `M ${px + cs * 0.4} ${py + cs * 0.85} Q ${px + cs * 0.66} ${py + cs * 0.3} ${px + cs * 0.94} ${py + cs * 0.85} Z`,
        fill: C.hillLight,
      }, g);
    },
    forest(g, px, py, cs, x, y) {
      el('rect', { x: px, y: py, width: cs, height: cs, fill: (x + y) % 2 ? C.plainA : C.plainB }, g);
      const tree = (tx, ty, r) => {
        el('rect', { x: tx - 1, y: ty + r * 0.5, width: 2.4, height: r * 0.9, fill: C.forestTrunk }, g);
        el('circle', { cx: tx, cy: ty, r, fill: C.forestTree }, g);
        el('circle', { cx: tx - r * 0.4, cy: ty + r * 0.35, r: r * 0.75, fill: C.forestTreeDark }, g);
      };
      tree(px + cs * 0.3, py + cs * 0.35, cs * 0.2);
      tree(px + cs * 0.68, py + cs * 0.3, cs * 0.17);
      tree(px + cs * 0.5, py + cs * 0.68, cs * 0.22);
    },
    jungle(g, px, py, cs) {
      el('rect', { x: px, y: py, width: cs, height: cs, fill: '#1a2e20' }, g);
      // dense canopy blobs — visibly thicker than forest
      for (let i = 0; i < 7; i++) {
        const cx = px + cs * (0.15 + 0.7 * ((i * 37 % 10) / 10));
        const cy = py + cs * (0.15 + 0.7 * ((i * 53 % 10) / 10));
        el('circle', { cx, cy, r: cs * (0.14 + (i % 3) * 0.03), fill: i % 2 ? C.jungleTree : C.jungleTreeDark }, g);
      }
      el('circle', { cx: px + cs * 0.5, cy: py + cs * 0.5, r: cs * 0.12, fill: C.jungleLight, opacity: 0.65 }, g);
    },
    water(g, px, py, cs, x, y, seed) {
      el('rect', { x: px, y: py, width: cs, height: cs, fill: C.water }, g);
      // wave strokes
      for (let i = 0; i < 2; i++) {
        const wy = py + cs * (0.3 + i * 0.35);
        const wob = Math.sin((x * 3 + y * 5 + i * 2 + (seed || 0)) * 1.7) * cs * 0.08;
        el('path', {
          d: `M ${px + cs * 0.15} ${wy + wob} q ${cs * 0.18} ${-cs * 0.1} ${cs * 0.35} 0 q ${cs * 0.18} ${cs * 0.1} ${cs * 0.35} 0`,
          stroke: C.waterLine, 'stroke-width': 1.4, fill: 'none', opacity: 0.55,
          'stroke-linecap': 'round',
        }, g);
      }
      el('rect', { x: px, y: py, width: cs, height: cs, fill: C.waterDeep, opacity: 0.25 }, g);
    },
    bridge(g, px, py, cs) {
      // river behind
      el('rect', { x: px, y: py, width: cs, height: cs, fill: C.water }, g);
      // wooden deck (vertical planks spanning the river)
      el('rect', { x: px + cs * 0.18, y: py, width: cs * 0.64, height: cs, fill: C.bridge }, g);
      for (let i = 1; i < 4; i++) {
        el('line', {
          x1: px + cs * 0.18, y1: py + (cs * i) / 4, x2: px + cs * 0.82, y2: py + (cs * i) / 4,
          stroke: C.bridgePlank, 'stroke-width': 1.1, opacity: 0.8,
        }, g);
      }
      el('rect', { x: px + cs * 0.18, y: py, width: cs * 0.64, height: cs, fill: 'none', stroke: C.bridgeEdge, 'stroke-width': 2 }, g);
    },
    mountain(g, px, py, cs) {
      el('rect', { x: px, y: py, width: cs, height: cs, fill: C.plainB }, g);
      el('path', {
        d: `M ${px + cs * 0.05} ${py + cs * 0.95} L ${px + cs * 0.5} ${py + cs * 0.12} L ${px + cs * 0.95} ${py + cs * 0.95} Z`,
        fill: C.mountain,
      }, g);
      el('path', {
        d: `M ${px + cs * 0.05} ${py + cs * 0.95} L ${px + cs * 0.5} ${py + cs * 0.12} L ${px + cs * 0.72} ${py + cs * 0.62} L ${px + cs * 0.4} ${py + cs * 0.95} Z`,
        fill: C.mountainDark,
      }, g);
      // snow cap
      el('path', {
        d: `M ${px + cs * 0.38} ${py + cs * 0.3} L ${px + cs * 0.5} ${py + cs * 0.12} L ${px + cs * 0.62} ${py + cs * 0.3} L ${px + cs * 0.54} ${py + cs * 0.38} L ${px + cs * 0.46} ${py + cs * 0.3} Z`,
        fill: C.mountainSnow,
      }, g);
    },
    castle(g, px, py, cs, owner) {
      const body = owner === 'attacker' ? '#5a4028' : owner === 'defender' ? '#4e2c2c' : '#4a4438';
      el('rect', { x: px, y: py, width: cs, height: cs, fill: body }, g);
      // wall
      el('rect', { x: px + cs * 0.14, y: py + cs * 0.3, width: cs * 0.72, height: cs * 0.6, fill: C.castleWall }, g);
      // crenellations
      for (let i = 0; i < 4; i++) {
        el('rect', { x: px + cs * (0.16 + i * 0.18), y: py + cs * 0.22, width: cs * 0.1, height: cs * 0.12, fill: C.castleWallLight }, g);
      }
      // gate
      el('path', { d: `M ${px + cs * 0.42} ${py + cs * 0.9} v ${-cs * 0.25} a ${cs * 0.08} ${cs * 0.1} 0 0 1 ${cs * 0.16} 0 v ${cs * 0.25} Z`, fill: '#2a2118' }, g);
      // towers
      el('rect', { x: px + cs * 0.06, y: py + cs * 0.38, width: cs * 0.14, height: cs * 0.52, fill: C.castleTower }, g);
      el('rect', { x: px + cs * 0.8, y: py + cs * 0.38, width: cs * 0.14, height: cs * 0.52, fill: C.castleTower }, g);
    },
  };

  // banner: small flag on a pole colored by owner (flips on capture)
  function banner(g, cx, cy, cs, owner) {
    const color = owner === 'attacker' ? C.bannerA : owner === 'defender' ? C.bannerB : C.neutral;
    const color2 = owner === 'attacker' ? C.bannerA2 : owner === 'defender' ? C.bannerB2 : '#9aa0a6';
    el('line', { x1: cx, y1: cy - cs * 0.32, x2: cx, y2: cy + cs * 0.1, stroke: '#d8c9a3', 'stroke-width': 1.6 }, g);
    el('path', { d: `M ${cx} ${cy - cs * 0.32} l ${cs * 0.3} ${cs * 0.09} l ${-cs * 0.3} ${cs * 0.09} Z`, fill: color }, g);
    el('path', { d: `M ${cx} ${cy - cs * 0.32} l ${cs * 0.3} ${cs * 0.09} l ${-cs * 0.3} ${cs * 0.02} Z`, fill: color2, opacity: 0.7 }, g);
  }

  // squad token: shield shape w/ unit icon + count + commander star
  function squadToken(g, sq, px, py, cs, opts) {
    const colors = UNIT_COLORS[sq.side] || UNIT_COLORS.attacker;
    const cx = px + cs / 2, cy = py + cs / 2;
    const R = cs * (sq.commander ? 0.42 : 0.36);
    const grp = el('g', { class: 'squad-token', 'data-squad': sq.id }, g);
    if (opts && opts.glow) {
      el('circle', { cx, cy, r: R * 1.5, fill: colors.main, opacity: 0.18, class: 'squad-glow' }, grp);
    }
    // shadow
    el('ellipse', { cx, cy: cy + R * 0.85, rx: R * 0.8, ry: R * 0.22, fill: '#000', opacity: 0.35 }, grp);
    // shield body
    el('path', {
      d: `M ${cx - R} ${cy - R * 0.75} h ${2 * R} v ${R * 0.9} q 0 ${R * 0.75} ${-R} ${R * 1.05} q ${-R} ${-R * 0.3} ${-R} ${-R * 1.05} Z`,
      fill: colors.main, stroke: colors.dark, 'stroke-width': 2,
    }, grp);
    if (sq.routed) {
      el('path', {
        d: `M ${cx - R * 0.8} ${cy + R * 0.9} l ${R * 1.6} ${-R * 1.6} M ${cx + R * 0.4} ${cy + R * 0.9} l ${R * 1.1} ${-R * 1.1}`,
        stroke: '#e8e2d4', 'stroke-width': 2, opacity: 0.85, 'stroke-linecap': 'round',
      }, grp);
      grp.setAttribute('opacity', 0.45);
    }
    txt(cx, cy - R * 0.1, UNIT_ICONS[sq.type] || '•', { 'font-size': R * 0.9, fill: '#1c1710' }, grp);
    txt(cx, cy + R * 0.62, String(sq.count), { 'font-size': R * 0.62, fill: '#f5efe2', 'font-weight': 700 }, grp);
    if (sq.commander) {
      // commander star above
      txt(cx, cy - R * 1.25, '★', { 'font-size': R * 0.7, fill: '#f2c14e' }, grp);
    }
    return grp;
  }

  // ------------------------------------------------------------
  // main renderer
  // ------------------------------------------------------------
  // opts: { seed, cellSize, legend, onSquadClick }
  function renderMap(container, view, opts) {
    opts = opts || {};
    container.innerHTML = '';
    const W = (view.grid && view.grid.w) || 21;
    const H = (view.grid && view.grid.h) || 15;
    const cs = opts.cellSize || 34;
    const svg = el('svg', {
      viewBox: `0 0 ${W * cs} ${H * cs}`,
      width: W * cs, height: H * cs, class: 'gorz-map',
    });
    const seed = opts.seed || 0;

    // terrain layer
    const terr = view.terrain;
    const gTerr = el('g', { class: 'layer-terrain' }, svg);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = (terr && terr[y] && terr[y][x]) || 'plain';
        (T[t] || T.plain)(gTerr, x * cs, y * cs, cs, x, y, seed);
      }
    }

    // grid lines (subtle)
    const gGrid = el('g', { class: 'layer-grid' }, svg);
    for (let x = 0; x <= W; x++) el('line', { x1: x * cs, y1: 0, x2: x * cs, y2: H * cs, stroke: C.grid, 'stroke-width': 1 }, gGrid);
    for (let y = 0; y <= H; y++) el('line', { x1: 0, y1: y * cs, x2: W * cs, y2: y * cs, stroke: C.grid, 'stroke-width': 1 }, gGrid);

    // castle banners (owner flips dynamically)
    const gFlags = el('g', { class: 'layer-castles' }, svg);
    const castles = view.castles || {};
    for (const key of Object.keys(castles)) {
      const c = castles[key];
      banner(gFlags, c.x * cs + cs * 0.5, c.y * cs + cs * 0.16, cs, c.owner);
    }

    // squad layer
    const gSquads = el('g', { class: 'layer-squads' }, svg);
    const squads = view.squads || [];
    for (const sq of squads) {
      if (sq.x == null || sq.x < 0) continue; // hidden/off-grid (tests)
      const tok = squadToken(gSquads, sq, sq.x * cs, sq.y * cs, cs, { glow: !!opts.highlightSquads });
      if (opts.onSquadClick) {
        tok.style.cursor = 'pointer';
        tok.addEventListener('click', () => opts.onSquadClick(sq));
      }
    }

    // effects layer (arrows, charges, flashes added by theater)
    const gFx = el('g', { class: 'layer-fx' }, svg);

    container.appendChild(svg);
    return { svg, gTerr, gSquads, gFx, cs, W, H };
  }

  // legend: what every element means (user demand: elements must show what they are)
  function renderLegend(container, lang) {
    const fa = lang !== 'en';
    const items = [
      { draw: (g, x, y, s) => T.plain(g, x, y, s, 0, 1), fa: 'دشت', en: 'Plain — open ground' },
      { draw: (g, x, y, s) => T.hill(g, x, y, s), fa: 'تپه +۱۵٪ حمله', en: 'Hill +15% attack' },
      { draw: (g, x, y, s) => T.forest(g, x, y, s, 0, 1), fa: 'جنگل +۳۵٪ دفاع، حمله سواره ممنوع', en: 'Forest +35% def, no charge' },
      { draw: (g, x, y, s) => T.jungle(g, x, y, s), fa: 'جنگل انبوه +۵۰٪ دفاع، کند', en: 'Jungle +50% def, slow (2MP)' },
      { draw: (g, x, y, s) => T.water(g, x, y, s, 0, 1, 0), fa: 'آب — غیرقابل عبور', en: 'Water — impassable' },
      { draw: (g, x, y, s) => T.bridge(g, x, y, s), fa: 'پل — تنها گذرگاه', en: 'Bridge — the only crossing' },
      { draw: (g, x, y, s) => T.mountain(g, x, y, s), fa: 'کوه — غیرقابل عبور', en: 'Mountain — impassable' },
      { draw: (g, x, y, s) => T.castle(g, x, y, s, null), fa: 'قلعه — هدف', en: 'Castle — objective' },
    ];
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'gorz-legend';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'gorz-legend-item';
      const mini = el('svg', { viewBox: '0 0 30 30', width: 30, height: 30 });
      it.draw(mini, 0, 0, 30, 0, 1, 0);
      row.appendChild(mini);
      const lbl = document.createElement('span');
      lbl.textContent = fa ? it.fa : it.en;
      row.appendChild(lbl);
      wrap.appendChild(row);
    }
    container.appendChild(wrap);
  }

  window.GorzMap = { renderMap, renderLegend, UNIT_COLORS, UNIT_ICONS };
})();
