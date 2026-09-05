'use strict';
// ============================================================
// Gorz Reborn — mapgen.js (DESIGN v3 "The Four Castles")
//
// Builds the v3 battlefield:
//   - 21x15 grid, POINT-SYMMETRIC (180° rotation) by construction:
//     we generate the west half + center column, then mirror.
//   - Center river (x=10) full height, 3 plank bridges (y=3,7,11).
//   - 4 castles: west home (1,7), east home (19,7),
//     north keep (6,3), south keep (14,11).
//   - Terrain with REAL RULES (see DESIGN-v3 §1.2):
//       plain / hill / forest / jungle / water / bridge / mountain
//   - Deterministic given (battleId, seedExtra).
//
// Pure module: no DB, no I/O. tactics.js consumes this.
// ============================================================

const V3 = {
  W: 21,
  H: 15,
  RIVER_X: 10,
  BRIDGES: [3, 7, 11],           // y positions of the 3 bridges
  CASTLES: {
    westHome:  { x: 1,  y: 7,  startOwner: 'A', kind: 'capital', name: 'قلعه باختر' },
    eastHome:  { x: 19, y: 7,  startOwner: 'B', kind: 'capital', name: 'قلعه خاور' },
    northKeep: { x: 6,  y: 3,  startOwner: null, kind: 'keep',  name: 'دژ شمال' },
    southKeep: { x: 14, y: 11, startOwner: null, kind: 'keep',  name: 'دژ جنوب' },
  },
};

// Point-mirror across the map center (180° rotation):
// (x, y) → (W-1-x, H-1-y). The four castles, the three bridge rows and
// the center column are all self-symmetric under this transform, so any
// feature stamped this way keeps the whole map fair to both sides.
function mirrorPoint(x, y) {
  return { x: V3.W - 1 - x, y: V3.H - 1 - y };
}

// Paint a tile AND its point-mirror, so symmetry holds no matter what
// we stamp. (Protected tiles are themselves symmetric sets, so a guard
// skip on one side implies the skip on the other.)
function stampBoth(grid, x, y, type) {
  if (x < 0 || x >= V3.W || y < 0 || y >= V3.H) return;
  grid[y][x] = type;
  const m = mirrorPoint(x, y);
  if ((m.x !== x || m.y !== y) && m.x >= 0 && m.x < V3.W && m.y >= 0 && m.y < V3.H) {
    grid[m.y][m.x] = type;
  }
}

// Paint a filled rectangle + mirror. Guard rails keep features off the
// home columns, castle tiles, river column and bridge rows.
function stampRect(grid, x0, y0, w, h, type, forbidden) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= V3.W || y < 0 || y >= V3.H) continue;
      if (forbidden && forbidden(x, y)) continue;
      stampBoth(grid, x, y, type);
    }
  }
}

function inRiver(x) { return x === V3.RIVER_X; }
function onBridgeRow(y) { return V3.BRIDGES.includes(y); }

// Forbidden predicate: never overwrite river, bridges, or castle tiles.
function protectedTile(x, y) {
  if (inRiver(x)) return true;
  if (onBridgeRow(y) && inRiver(x)) return true;
  for (const key of Object.keys(V3.CASTLES)) {
    const c = V3.CASTLES[key];
    if (c.x === x && c.y === y) return true;
  }
  return false;
}

// ------------------------------------------------------------
// The generator.
// ------------------------------------------------------------
function generateV3Map(seedExtra) {
  // Start as all plain.
  const grid = [];
  for (let y = 0; y < V3.H; y++) {
    grid.push(new Array(V3.W).fill('plain'));
  }

  // --- 1. River: the full-height center column. Bridges replace it on
  // the three bridge rows.
  for (let y = 0; y < V3.H; y++) {
    grid[y][V3.RIVER_X] = onBridgeRow(y) ? 'bridge' : 'water';
  }

  // --- 2. Lakes: one 3x2 per side, mirrored. West lake in the NW
  // quadrant; stampBoth mirrors it to the SE quadrant.
  stampRect(grid, 2, 2, 3, 2, 'water', protectedTile);

  // --- 3. Mountains: one massif per side, mirrored. SW for the west
  // side; mirrored to NE.
  stampRect(grid, 2, 10, 3, 3, 'mountain', (x, y) => protectedTile(x, y) || onBridgeRow(y) ? true : false);

  // --- 4. Jungles: two clusters per side, mirrored (near north + south
  // bridge approaches).
  stampRect(grid, 6, 1, 3, 2, 'jungle', protectedTile);
  stampRect(grid, 6, 12, 2, 2, 'jungle', protectedTile);

  // --- 5. Hills: symmetric pairs overlooking the bridge roads.
  stampRect(grid, 8, 4, 2, 1, 'hill', protectedTile);   // mid-road
  stampRect(grid, 4, 6, 1, 1, 'hill', protectedTile);   // west keep road
  stampRect(grid, 8, 10, 2, 1, 'hill', protectedTile);  // south road

  // --- 6. Forests: filler clusters breaking sightlines on the lanes.
  stampRect(grid, 4, 4, 2, 1, 'forest', protectedTile);
  stampRect(grid, 5, 9, 2, 2, 'forest', protectedTile);
  stampRect(grid, 8, 6, 1, 2, 'forest', protectedTile);
  stampRect(grid, 3, 1, 1, 1, 'forest', protectedTile);
  stampRect(grid, 3, 13, 1, 1, 'forest', protectedTile);

  // --- 7. Castles (stamped last, they own their tile).
  const castles = {};
  for (const key of Object.keys(V3.CASTLES)) {
    const c = V3.CASTLES[key];
    grid[c.y][c.x] = 'castle';
    castles[key] = { ...c, owner: c.startOwner };
  }

  // --- 8. Symmetry verification: assert the invariant so a future edit
  // that breaks it fails loudly instead of silently skewing the meta.
  for (let y = 0; y < V3.H; y++) {
    for (let x = 0; x < V3.W; x++) {
      if (grid[y][x] !== grid[V3.H - 1 - y][V3.W - 1 - x]) {
        throw new Error(`[mapgen] point symmetry broken at (${x},${y})`);
      }
    }
  }

  return { grid, castles, V3 };
}

// ------------------------------------------------------------
// Terrain rule table (mirrors balance.js#TACTICS.terrainCfg).
// Single source of truth for the engine; mapgen exposes it so the
// client + rulebook + /api/agent/rules render from the same numbers.
// ------------------------------------------------------------
const TERRAIN_RULES = {
  plain:    { cost: 1, defBonus: 0,    atkBonus: 0,    charge: true,  passable: true,  fa: 'دشت',  en: 'Plain' },
  hill:     { cost: 1, defBonus: 0,    atkBonus: 0.15, charge: true,  passable: true,  fa: 'تپه',  en: 'Hill' },
  forest:   { cost: 1, defBonus: 0.35, atkBonus: 0,    charge: false, passable: true,  fa: 'جنگل', en: 'Forest' },
  jungle:   { cost: 2, defBonus: 0.5,  atkBonus: 0,    charge: false, passable: true,  fa: 'جنگل انبوه', en: 'Jungle' },
  water:    { cost: Infinity, defBonus: 0, atkBonus: 0, charge: false, passable: false, fa: 'آب', en: 'Water' },
  bridge:   { cost: 1, defBonus: 0,    atkBonus: 0,    charge: true,  passable: true,  fa: 'پل',  en: 'Bridge' },
  mountain: { cost: Infinity, defBonus: 0, atkBonus: 0, charge: false, passable: false, fa: 'کوه', en: 'Mountain' },
  castle:   { cost: 1, defBonus: 0.4,  atkBonus: 0,    charge: false, passable: true,  fa: 'قلعه', en: 'Castle' },
};

module.exports = { generateV3Map, TERRAIN_RULES, V3 };
