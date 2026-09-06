/* ============================================================
 * Gorz Reborn — battle-map.js
 * A DETAILED illustrated fantasy war-map (self-contained SVG, no
 * external assets). The map is the background "picture"; castles,
 * neutral keeps, obstacles and army banners are placed ON TOP of it.
 *
 * Layers (back -> front):
 *   1. parchment land + torn-paper texture (feTurbulence)
 *   2. sea + coastline + wave hatching
 *   3. value-noise shading per cell (hand-drawn relief)
 *   4. rivers (real meandering watercourse), forests, mountains
 *   5. obstacles: lakes, mountain peaks, ruined forts (impassable)
 *   6. keeps (neutral -> captured) in the open middle band
 *   7. home castles + army banners
 *   8. compass rose + title cartouche + burnt border
 * ============================================================ */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // --- tiny seeded RNG (mulberry32) for stable per-battle detail ---
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ----- color palette -----
  const C = {
    seaTop: '#13506b', seaBot: '#0c3c54',
    coast: '#2f6f5e', coastLine: '#3b8a76',
    land: '#d8c79a', landEdge: '#b9a877',
    hill: '#b59b66', hillHi: '#d8c089',
    forest: '#3f6b3a', forestDk: '#2c4d2a',
    mtn: '#9a8a6a', mtnHi: '#c8b98e', mtnSh: '#6f6048',
    river: '#5fa8c9', riverHi: '#9fd6ea', riverBank: '#c2a86f',
    lake: '#3f7e96', lakeHi: '#7fc1d6',
    ruins: '#8a8270', ruinsDk: '#5f594b',
    keepStone: '#cdbf95', keepStoneDk: '#9b8f6c',
    castleA: '#e8812f', castleADk: '#9c4d12',
    castleD: '#c0392b', castleDDk: '#7a2018',
    ember: '#f0a04e', gold: '#e6c068',
    ink: '#2c2418',
  };

  window.GorzMap = {
    // Build the battle map SVG into `view`.
    // opts: { terrain, obstacles, keeps, onSelect, selectedId, pendingMove,
    //         moveRange, isMySquad, squads, round, seed }
    buildMap(view, opts) {
      opts = opts || {};
      const W = 960, H = Math.round((view.grid.h / view.grid.w) * W);
      const cols = view.grid.w, rows = view.grid.h;
      const cw = W / cols, ch = H / rows;
      const seed = (opts.seed != null ? opts.seed : (view.battleId || 1)) * 2654435761 >>> 0;
      const rnd = rng(seed);
      const defs = document.createElementNS(NS, 'defs');

      // canvas land rect
      const land = svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: C.land }, null);

      // paper grain
      const paper = svgEl('filter', { id: 'paper', x: '0', y: '0', width: '100%', height: '100%' }, defs);
      const turb = svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.9', numOctaves: '2', seed: String(seed % 100), result: 'n' }, paper);
      const paperC = svgEl('feColorMatrix', { in: 'n', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.06 0' }, paper);
      const paperComp = svgEl('feComposite', { in: 'SourceGraphic', in2: 'n', operator: 'over' }, paper);
      // glow
      const glow = svgEl('radialGradient', { id: 'mapglow', cx: '50%', cy: '0%', r: '90%' }, defs);
      svgEl('stop', { offset: '0%', 'stop-color': C.ember, 'stop-opacity': '0.10' }, glow);
      svgEl('stop', { offset: '60%', 'stop-color': C.ember, 'stop-opacity': '0' }, glow);
      // soft shadow
      const sh = svgEl('filter', { id: 'softshadow', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs);
      svgEl('feDropShadow', { dx: '0', dy: '1.5', stdDeviation: '1.6', 'flood-color': '#000', 'flood-opacity': '0.45' }, sh);

      const svg = svgEl('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'tac-map', width: '100%',
        preserveAspectRatio: 'xMidYMid meet', dir: 'ltr',
      }, null);
      svg.appendChild(defs);
      svg.appendChild(land);
      land.setAttribute('filter', 'url(#paper)');
      svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#mapglow)' }, svg);

      const cx = (x) => (x + 0.5) * cw;
      const cy = (y) => (y + 0.5) * ch;
      const cellIdx = (x, y) => y * cols + x;

      // -------- terrain relief (value-noise per cell) --------
      const tLayer = svgEl('g', { class: 'terrain' }, svg);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const t = (view.terrain[y] && view.terrain[y][x]) || 'plain';
          const px = x * cw, py = y * ch;
          const n = rnd();
          let fill = C.land;
          if (t === 'forest') fill = C.forestDk;
          else if (t === 'hill') fill = C.hill;
          else fill = n < 0.5 ? C.land : C.landEdge;
          svgEl('rect', { x: px, y: py, width: cw + 0.6, height: ch + 0.6, fill, opacity: 0.92 }, tLayer);
        }
      }

      // -------- sea + coastline along the top margin --------
      // (north edge = sea, with a wavy coast that the land meets)
      const coastY = ch * 1.1;
      const sea = svgEl('rect', { x: 0, y: 0, width: W, height: coastY, fill: 'url(#seaGrad)' }, svg);
      const seaGrad = svgEl('linearGradient', { id: 'seaGrad', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
      svgEl('stop', { offset: '0%', 'stop-color': C.seaTop }, seaGrad);
      svgEl('stop', { offset: '100%', 'stop-color': C.seaBot }, seaGrad);
      // coast path
      let coast = `M0 ${coastY}`;
      for (let x = 0; x <= W; x += 14) {
        coast += ` L${x} ${coastY + Math.sin(x / 26 + seed) * 6 + Math.sin(x / 9) * 2}`;
      }
      coast += ` L${W} 0 L0 0 Z`;
      svgEl('path', { d: coast, fill: C.coast, opacity: 0.55 }, svg);
      // wave hatching
      const waves = svgEl('g', { stroke: C.coastLine, 'stroke-width': '0.8', fill: 'none', opacity: 0.5 }, svg);
      for (let i = 0; i < 26; i++) {
        const wy = 6 + rnd() * (coastY - 12);
        const wx = rnd() * W;
        svgEl('path', { d: `M${wx} ${wy} q4 -3 8 0 q4 3 8 0` }, waves);
      }

      // -------- forests (dense, hand-drawn trees) --------
      const fLayer = svgEl('g', { class: 'forests' }, svg);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if ((view.terrain[y] && view.terrain[y][x]) !== 'forest') continue;
          const px = cx(x), py = cy(y);
          const count = 3;
          for (let i = 0; i < count; i++) {
            const ox = (rnd() - 0.5) * cw * 0.7;
            const oy = (rnd() - 0.5) * ch * 0.6;
            const s = cw * (0.13 + rnd() * 0.05);
            const tx = px + ox, ty = py + oy;
            // trunk
            svgEl('rect', { x: tx - s * 0.12, y: ty, width: s * 0.24, height: s * 0.5, fill: '#5a3d22' }, fLayer);
            // canopy (layered)
            svgEl('ellipse', { cx: tx, cy: ty - s * 0.1, rx: s * 0.7, ry: s * 0.55, fill: C.forest, opacity: 0.95 }, fLayer);
            svgEl('ellipse', { cx: tx - s * 0.2, cy: ty - s * 0.3, rx: s * 0.5, ry: s * 0.42, fill: C.forest, opacity: 0.95 }, fLayer);
            svgEl('ellipse', { cx: tx + s * 0.2, cy: ty - s * 0.25, rx: s * 0.45, ry: 0.4 * s, fill: '#4f7d46', opacity: 0.9 }, fLayer);
          }
        }
      }

      // -------- rivers (real meandering watercourse) --------
      // build a meander path from left edge to right, sine+noise
      const riverY0 = ch * (rows * 0.42);
      let d = `M0 ${riverY0}`;
      const steps = 60;
      let prevX = 0, prevY = riverY0;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = t * W;
        const baseY = riverY0 + Math.sin(t * 6 + seed) * ch * 0.9 + Math.sin(t * 13 + seed) * ch * 0.35;
        const y = clamp(baseY, ch * 0.2, H - ch * 0.2);
        const mx = (prevX + x) / 2, my = (prevY + y) / 2 + (rnd() - 0.5) * ch * 0.3;
        d += ` Q${mx.toFixed(1)} ${my.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
        prevX = x; prevY = y;
      }
      // bank
      svgEl('path', { d, fill: 'none', stroke: C.riverBank, 'stroke-width': ch * 0.34, 'stroke-linecap': 'round', opacity: 0.5 }, svg);
      svgEl('path', { d, fill: 'none', stroke: C.river, 'stroke-width': ch * 0.22, 'stroke-linecap': 'round' }, svg);
      svgEl('path', { d, fill: 'none', stroke: C.riverHi, 'stroke-width': ch * 0.06, 'stroke-linecap': 'round', opacity: 0.8 }, svg);

      // -------- obstacles (impassable landmarks) --------
      const obsLayer = svgEl('g', { class: 'obstacles' }, svg);
      (view.obstacles || []).forEach((o) => {
        const px = cx(o.x), py = cy(o.y), s = Math.min(cw, ch);
        if (o.kind === 'lake') {
          svgEl('ellipse', { cx: px, cy: py, rx: s * 0.42, ry: s * 0.36, fill: C.lake, filter: 'url(#softshadow)' }, obsLayer);
          svgEl('ellipse', { cx: px - s * 0.1, cy: py - s * 0.1, rx: s * 0.22, ry: s * 0.16, fill: C.lakeHi, opacity: 0.7 }, obsLayer);
        } else if (o.kind === 'mountain') {
          // jagged peak with shading
          svgEl('path', {
            d: `M${px - s * 0.45} ${py + s * 0.4} L${px - s * 0.05} ${py - s * 0.42} L${px + s * 0.18} ${py - s * 0.05} L${px + s * 0.45} ${py + s * 0.4} Z`,
            fill: C.mtn, filter: 'url(#softshadow)',
          }, obsLayer);
          svgEl('path', {
            d: `M${px - s * 0.05} ${py - s * 0.42} L${px + s * 0.18} ${py - s * 0.05} L${px + s * 0.02} ${py - s * 0.02} Z`,
            fill: C.mtnHi,
          }, obsLayer);
          svgEl('path', {
            d: `M${px + s * 0.18} ${py - s * 0.05} L${px + s * 0.45} ${py + s * 0.4} L${px + s * 0.1} ${py + s * 0.4} Z`,
            fill: C.mtnSh, opacity: 0.7,
          }, obsLayer);
          // snow cap
          svgEl('path', { d: `M${px - s * 0.12} ${py - s * 0.28} L${px - s * 0.05} ${py - s * 0.42} L${px + s * 0.04} ${py - s * 0.26} Z`, fill: '#f3efe4', opacity: 0.9 }, obsLayer);
        } else if (o.kind === 'ruins') {
          // broken fort
          svgEl('rect', { x: px - s * 0.4, y: py - s * 0.1, width: s * 0.8, height: s * 0.45, fill: C.ruinsDk }, obsLayer);
          for (let i = 0; i < 4; i++) {
            const bx = px - s * 0.4 + i * s * 0.22;
            const bh = s * (0.18 + rnd() * 0.3);
            svgEl('rect', { x: bx, y: py - s * 0.1 - bh, width: s * 0.16, height: bh + s * 0.1, fill: C.ruins }, obsLayer);
          }
          svgEl('path', { d: `M${px - s * 0.2} ${py + s * 0.2} l${s * 0.4} 0 l0 -${s * 0.18}`, fill: 'none', stroke: C.ruinsDk, 'stroke-width': 2 }, obsLayer);
        }
      });

      // -------- keeps (neutral -> captured) --------
      const keepLayer = svgEl('g', { class: 'keeps' }, svg);
      (view.keeps || []).forEach((k) => {
        const px = cx(k.x), py = cy(k.y), s = Math.min(cw, ch);
        const owner = k.owner;
        const stone = owner === 'attacker' ? C.castleA : owner === 'defender' ? C.castleD : C.keepStone;
        const stoneDk = owner === 'attacker' ? C.castleADk : owner === 'defender' ? C.castleDDk : C.keepStoneDk;
        const g = svgEl('g', { class: 'keep', 'data-keep': `${k.x},${k.y}` }, keepLayer);
        // tower
        svgEl('rect', { x: px - s * 0.3, y: py - s * 0.25, width: s * 0.6, height: s * 0.5, fill: stone, filter: 'url(#softshadow)' }, g);
        // battlements
        for (let i = 0; i < 3; i++) {
          svgEl('rect', { x: px - s * 0.3 + i * s * 0.22, y: py - s * 0.34, width: s * 0.14, height: s * 0.12, fill: stoneDk }, g);
        }
        // banner on top
        svgEl('rect', { x: px - s * 0.03, y: py - s * 0.5, width: s * 0.06, height: s * 0.18, fill: '#3a2c1a' }, g);
        svgEl('path', { d: `M${px + s * 0.03} ${py - s * 0.5} l${s * 0.16} ${s * 0.05} l${-s * 0.16} ${s * 0.06} Z`, fill: stone }, g);
        // flag ring to show ownership
        svgEl('circle', { cx: px, cy: py, r: s * 0.42, fill: 'none', stroke: stone, 'stroke-width': 1.5, 'stroke-dasharray': '3 3', opacity: 0.7 }, g);
        svgEl('text', { x: px, y: py + s * 0.4, 'text-anchor': 'middle', 'font-size': s * 0.18, fill: C.ink, 'font-family': 'sans-serif' }, g).textContent = k.name;
      });

      // -------- home castles --------
      const castle = (px, py, s, side) => {
        const stone = side === 'attacker' ? C.castleA : C.castleD;
        const stoneDk = side === 'attacker' ? C.castleADk : C.castleDDk;
        const g = svgEl('g', { class: 'castle', filter: 'url(#softshadow)' }, svg);
        svgEl('rect', { x: px - s * 0.5, y: py - s * 0.35, width: s, height: s * 0.7, fill: stone }, g);
        // towers
        [-0.5, 0.5].forEach((dx) => {
          svgEl('rect', { x: px + dx * s - s * 0.16, y: py - s * 0.5, width: s * 0.32, height: s * 0.85, fill: stoneDk }, g);
          for (let i = 0; i < 3; i++) svgEl('rect', { x: px + dx * s - s * 0.16 + i * s * 0.1, y: py - s * 0.58, width: s * 0.07, height: s * 0.1, fill: stone }, g);
        });
        // gate
        svgEl('path', { d: `M${px - s * 0.16} ${py + s * 0.35} l${s * 0.32} 0 l0 -${s * 0.22} a${s * 0.16} ${s * 0.16} 0 0 0 -${s * 0.32} 0 Z`, fill: C.ink }, g);
        // flag
        svgEl('rect', { x: px - s * 0.02, y: py - s * 0.78, width: s * 0.04, height: s * 0.22, fill: '#2c2418' }, g);
        svgEl('path', { d: `M${px + s * 0.02} ${py - s * 0.78} l${s * 0.24} ${s * 0.07} l${-s * 0.24} ${s * 0.08} Z`, fill: stone }, g);
        return g;
      };
      castle(cx(1), cy(rows - 1), Math.min(cw, ch) * 1.15, 'attacker');
      castle(cx(cols - 2), cy(0), Math.min(cw, ch) * 1.15, 'defender');

      // -------- army banners --------
      const banners = svgEl('g', { class: 'banners' }, svg);
      const glyph = { swordsman: '⚔️', archer: '🏹', cavalry: '🐎' };
      (opts.squads || view.squads || []).forEach((sq) => {
        if (sq.routed) return;
        const px = cx(sq.x), py = cy(sq.y), s = Math.min(cw, ch) * 0.5;
        const isMine = opts.isMySquad ? opts.isMySquad(sq) : true;
        const col = sq.side === 'attacker' ? C.castleA : C.castleD;
        const g = svgEl('g', {
          class: 'banner' + (sq.id === opts.selectedId ? ' sel' : ''),
          'data-squad': sq.id, 'data-x': sq.x, 'data-y': sq.y,
          transform: `translate(${px},${py})`,
        }, banners);
        if (sq.id === opts.selectedId) {
          svgEl('circle', { cx: 0, cy: 0, r: s * 1.35, fill: 'none', stroke: C.gold, 'stroke-width': 2 }, g);
        }
        if (sq.onKeep) svgEl('circle', { cx: 0, cy: 0, r: s * 1.1, fill: 'none', stroke: C.gold, 'stroke-width': 1, 'stroke-dasharray': '2 2', opacity: 0.8 }, g);
        // banner pole
        svgEl('rect', { x: -1.2, y: -s * 0.5, width: 2.4, height: s * 1.0, fill: '#2c2418', rx: 1 }, g);
        // pennant
        svgEl('path', { d: `M0 ${-s * 0.5} l${s * 0.7} ${s * 0.18} l${-s * 0.7} ${s * 0.18} Z`, fill: col, filter: 'url(#softshadow)' }, g);
        // icon
        const t = svgEl('text', { x: s * 0.32, y: -s * 0.16, 'font-size': s * 0.42, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, g);
        t.textContent = glyph[sq.type] || '⚔️';
        // count
        const c = svgEl('text', { x: 0, y: s * 0.62, 'font-size': s * 0.34, 'text-anchor': 'middle', fill: isMine ? '#fff' : C.ink, 'font-family': 'monospace', 'font-weight': '700' }, g);
        c.textContent = sq.count;
      });

      // -------- move range + pending move --------
      if (opts.moveRange && opts.moveRange.length) {
        const mr = svgEl('g', { class: 'move-range' }, svg);
        opts.moveRange.forEach((c) => {
          svgEl('rect', { x: c.x * cw, y: c.y * ch, width: cw, height: ch, fill: C.ember, opacity: 0.16 }, mr);
          svgEl('rect', { x: c.x * cw + 1, y: c.y * ch + 1, width: cw - 2, height: ch - 2, fill: 'none', stroke: C.ember, 'stroke-width': 0.8, opacity: 0.4 }, mr);
        });
      }
      if (opts.pendingMove) {
        const pm = svgEl('g', { class: 'pending-move' }, svg);
        svgEl('circle', { cx: cx(opts.pendingMove.x), cy: cy(opts.pendingMove.y), r: cw * 0.22, fill: 'none', stroke: C.ember, 'stroke-width': 2.5 }, pm);
        svgEl('path', { d: `M${cx(opts.pendingMove.x) - cw * 0.1} ${cy(opts.pendingMove.y)} h${cw * 0.2} M${cx(opts.pendingMove.x)} ${cy(opts.pendingMove.y) - cw * 0.1} v${cw * 0.2}`, stroke: C.ember, 'stroke-width': 2.5 }, pm);
      }

      // -------- scale legend (leagues) --------
      // A real cartouche scale bar: 1 cell ≈ 0.5 league, grid width -> total leagues.
      const leagues = +(cols * 0.5).toFixed(1);
      const legend = svgEl('g', { class: 'map-legend', transform: `translate(${W - 214},26)` }, svg);
      const barW = 120;
      svgEl('rect', { x: 0, y: -3, width: barW, height: 6, fill: 'rgba(244,235,210,0.9)', stroke: C.ink, 'stroke-width': 0.8 }, legend);
      // alternating ticks every quarter
      for (let i = 0; i <= 4; i++) {
        const tx = (i / 4) * barW;
        svgEl('rect', { x: tx - 0.6, y: -3, width: 1.2, height: 6, fill: C.ink }, legend);
      }
      svgEl('rect', { x: 0, y: -3, width: barW / 2, height: 6, fill: C.ink, opacity: 0.18 }, legend);
      svgEl('text', { x: barW / 2, y: -9, 'text-anchor': 'middle', 'font-size': 10, fill: C.ink, 'font-family': 'sans-serif', 'font-weight': '700' }, legend).textContent = `Scale: ${leagues} leagues`;
      svgEl('text', { x: barW / 2, y: 11, 'text-anchor': 'middle', 'font-size': 9, fill: C.ink, 'font-family': 'sans-serif' }, legend).textContent = `${leagues} leagues`;

      // -------- animated march trails (live draft + replay) --------
      const trailLayer = svgEl('g', { class: 'trails' }, svg);
      // 1) live pending move: dashed animated path from selected squad to target
      if (opts.pendingMove && opts.pendingFrom) {
        const fp = `M${cx(opts.pendingFrom.x)} ${cy(opts.pendingFrom.y)} L${cx(opts.pendingMove.x)} ${cy(opts.pendingMove.y)}`;
        svgEl('path', { d: fp, class: 'march-trail live', fill: 'none', stroke: C.ember, 'stroke-width': 2.4, 'stroke-dasharray': '5 4', 'stroke-linecap': 'round', opacity: 0.9 }, trailLayer);
        // marching dot that animates along the path
        const dot = svgEl('circle', { r: cw * 0.12, fill: C.gold, class: 'march-dot' }, trailLayer);
        const am = svgEl('animateMotion', { dur: '1.1s', repeatCount: 'indefinite', path: fp, rotate: 'auto' }, dot);
      }
      // 2) historical/replay trails (each: array of {x,y})
      (opts.trails || []).forEach((tr) => {
        if (!tr || tr.length < 2) return;
        let dd = `M${cx(tr[0].x)} ${cy(tr[0].y)}`;
        for (let i = 1; i < tr.length; i++) dd += ` L${cx(tr[i].x)} ${cy(tr[i].y)}`;
        svgEl('path', { d: dd, class: 'march-trail', fill: 'none', stroke: C.ember, 'stroke-width': 1.8, 'stroke-dasharray': '4 4', 'stroke-linecap': 'round', opacity: 0.6 }, trailLayer);
      });
      const compass = svgEl('g', { class: 'map-compass', transform: `translate(${W - 70},${H - 70})` }, svg);
      svgEl('circle', { cx: 0, cy: 0, r: 34, fill: 'rgba(244,235,210,0.85)', stroke: C.ink, 'stroke-width': 1.2 }, compass);
      svgEl('circle', { cx: 0, cy: 0, r: 28, fill: 'none', stroke: C.ink, 'stroke-width': 0.6, opacity: 0.5 }, compass);
      svgEl('path', { d: 'M0 -30 L7 0 L0 30 L-7 0 Z', fill: C.castleD }, compass);
      svgEl('path', { d: 'M0 -30 L7 0 L0 0 Z', fill: C.castleA }, compass);
      [['N', 0, -42], ['S', 0, 46], ['W', -42, 4], ['E', 44, 4]].forEach(([l, dx, dy]) => {
        svgEl('text', { x: dx, y: dy, 'text-anchor': 'middle', 'font-size': 9, fill: C.ink, 'font-family': 'sans-serif' }, compass).textContent = l;
      });
      // title cartouche
      const title = svgEl('g', { class: 'map-title', transform: `translate(20,24)` }, svg);
      svgEl('rect', { x: 0, y: -14, width: 220, height: 30, rx: 6, fill: 'rgba(44,36,24,0.78)' }, title);
      const tt = svgEl('text', { x: 110, y: 8, 'text-anchor': 'middle', 'font-size': 14, fill: C.gold, 'font-family': 'sans-serif', 'font-weight': '700' }, title);
      tt.textContent = `Battle Map — Round ${view.round || 1}`;
      // burnt border
      svgEl('rect', { x: 4, y: 4, width: W - 8, height: H - 8, fill: 'none', stroke: C.ink, 'stroke-width': 6, opacity: 0.55, 'stroke-linejoin': 'round' }, svg);
      svgEl('rect', { x: 9, y: 9, width: W - 18, height: H - 18, fill: 'none', stroke: C.castleADk, 'stroke-width': 1.5, opacity: 0.5 }, svg);

      return svg;
    },

    // Pan / zoom the battlefield map via its viewBox. Clicks (handled by the
    // caller) stay accurate because getScreenCTM() reflects the viewBox.
    attachPanZoom(svg, view) {
      const W = 960, H = Math.round((view.grid.h / view.grid.w) * W);
      let vbX = 0, vbY = 0, vbW = W, vbH = H;
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      function clampVB() {
        vbX = clamp(vbX, -vbW * 0.35, W - vbW * 0.65);
        vbY = clamp(vbY, -vbH * 0.35, H - vbH * 0.65);
      }
      function applyVB() { svg.setAttribute('viewBox', `${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`); }
      function resetVB() { vbX = 0; vbY = 0; vbW = W; vbH = H; applyVB(); }

      svg.style.cursor = 'grab';
      svg.style.touchAction = 'none';
      let dragging = false, moved = false, lastX = 0, lastY = 0;
      svg.addEventListener('mousedown', (e) => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; svg.style.cursor = 'grabbing'; });
      window.addEventListener('mouseup', () => { dragging = false; svg.style.cursor = 'grab'; });
      svg.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = svg.getBoundingClientRect();
        const sx = vbW / rect.width, sy = vbH / rect.height;
        const dx = (e.clientX - lastX) * sx, dy = (e.clientY - lastY) * sy;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        vbX -= dx; vbY -= dy; lastX = e.clientX; lastY = e.clientY; clampVB(); applyVB();
      });
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width, py = (e.clientY - rect.top) / rect.height;
        const mx = vbX + px * vbW, my = vbY + py * vbH;
        const factor = e.deltaY > 0 ? 1.12 : 0.89;
        const nw = clamp(vbW * factor, 260, W * 2.2), nh = clamp(vbH * factor, 260 * (H / W), H * 2.2);
        vbW = nw; vbH = nh;
        vbX = mx - px * vbW; vbY = my - py * vbH; clampVB(); applyVB();
      }, { passive: false });
      svg.addEventListener('click', (e) => { if (moved) { e.stopImmediatePropagation(); moved = false; } }, true);

      const board = svg.parentNode;
      if (board && !board.querySelector('.map-zoom-ctrl')) {
        const ctrl = document.createElement('div');
        ctrl.className = 'map-zoom-ctrl';
        ctrl.innerHTML = '<button data-z="in" title="Zoom in">+</button><button data-z="out" title="Zoom out">−</button><button data-z="reset" title="Reset view">⤢</button>';
        ctrl.style.position = 'absolute';
        ctrl.style.left = '14px';
        ctrl.style.right = 'auto';
        ctrl.style.bottom = '14px';
        ctrl.addEventListener('click', (e) => {
          const z = e.target.dataset.z; if (!z) return;
          const cx = vbX + vbW / 2, cy = vbY + vbH / 2, f = z === 'in' ? 0.8 : z === 'out' ? 1.25 : 1;
          if (z === 'reset') return resetVB();
          vbW = clamp(vbW * f, 260, W * 2.2); vbH = clamp(vbH * f, 260 * (H / W), H * 2.2);
          vbX = cx - vbW / 2; vbY = cy - vbH / 2; clampVB(); applyVB();
        });
        board.appendChild(ctrl);
      }
    },
  };
})();
