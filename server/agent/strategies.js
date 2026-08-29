'use strict';
// ============================================================
// Gorz Reborn — agent/strategies.js
// Named hand-crafted strategies ("DNA templates") + helpers to
// seed them into a population. Each strategy returns a complete
// genome.
//
// The "House of Darius" lineage favors cavalry charges.
// "Shield of Leonidas" holds a phalanx + focus fires.
// "Forest Archer" rides terrain + kite.
// "Rush Plato" goes wide-front infantry.
// "Genghis Wolf" pure cavalry + heavy charges.
// ============================================================

function makeGenome({ swordsman, archer, cavalry, training = {}, tactics = {} }) {
  // normalize composition
  const s = Math.max(0.001, swordsman);
  const a = Math.max(0.001, archer);
  const c = Math.max(0.001, cavalry);
  const sum = s + a + c;
  return {
    composition: { swordsman: s / sum, archer: a / sum, cavalry: c / sum },
    training: {
      swordsman: training.swordsman || 0,
      archer: training.archer || 0,
      cavalry: training.cavalry || 0,
    },
    tactics: Object.assign({
      aggression: 0.5,
      defense: 0.5,
      targetPriority: 'closest',
      focusFire: 0.5,
      cavalryCharge: 0.5,
      rangedEngage: 0.5,
      keepCapture: 0.5,
    }, tactics),
  };
}

const STRATEGIES = {
  'house-of-darius': {
    name: 'House of Darius',
    description: 'Cavalry-heavy Persian empire, charges everything in reach.',
    genome: makeGenome({
      swordsman: 0.2, archer: 0.2, cavalry: 0.6,
      training: { swordsman: 1, archer: 0, cavalry: 4 },
      tactics: { aggression: 0.85, defense: 0.15, cavalryCharge: 0.95, focusFire: 0.6, targetPriority: 'cavalry_first', keepCapture: 0.3 },
    }),
  },
  'shield-of-leonidas': {
    name: 'Shield of Leonidas',
    description: 'Spartan phalanx, hold stance, focus-fire enemies one at a time.',
    genome: makeGenome({
      swordsman: 0.55, archer: 0.3, cavalry: 0.15,
      training: { swordsman: 5, archer: 2, cavalry: 0 },
      tactics: { aggression: 0.2, defense: 0.9, focusFire: 0.95, targetPriority: 'closest', cavalryCharge: 0.1, keepCapture: 0.4 },
    }),
  },
  'forest-archer': {
    name: 'Forest Archer',
    description: 'Archer-heavy, kites melee, plays objectives.',
    genome: makeGenome({
      swordsman: 0.1, archer: 0.7, cavalry: 0.2,
      training: { swordsman: 0, archer: 4, cavalry: 1 },
      tactics: { aggression: 0.3, defense: 0.8, focusFire: 0.7, targetPriority: 'archer_first', rangedEngage: 0.1, keepCapture: 0.85 },
    }),
  },
  'rush-plato': {
    name: 'Rush Plato',
    description: 'Balanced infantrush — straight at the nearest enemy, no tricks.',
    genome: makeGenome({
      swordsman: 0.5, archer: 0.25, cavalry: 0.25,
      training: { swordsman: 3, archer: 2, cavalry: 2 },
      tactics: { aggression: 0.8, defense: 0.4, focusFire: 0.4, targetPriority: 'closest', cavalryCharge: 0.5, keepCapture: 0.5 },
    }),
  },
  'genghis-wolf': {
    name: 'Genghis Wolf',
    description: 'Pure horse archers — max cavalry, maximum charge.',
    genome: makeGenome({
      swordsman: 0.05, archer: 0.05, cavalry: 0.9,
      training: { swordsman: 0, archer: 0, cavalry: 6 },
      tactics: { aggression: 0.95, defense: 0.05, cavalryCharge: 1.0, focusFire: 0.5, targetPriority: 'archer_first', keepCapture: 0.2 },
    }),
  },
  'turtle': {
    name: 'Turtle',
    description: 'All swordsman, all hold, all patience. Plays keeps hard.',
    genome: makeGenome({
      swordsman: 0.85, archer: 0.1, cavalry: 0.05,
      training: { swordsman: 6, archer: 0, cavalry: 0 },
      tactics: { aggression: 0.0, defense: 1.0, focusFire: 0.6, targetPriority: 'weakest', cavalryCharge: 0.0, keepCapture: 0.95 },
    }),
  },
  'berserker': {
    name: 'Berserker',
    description: 'Half swordsman half cavalry, all aggression.',
    genome: makeGenome({
      swordsman: 0.5, archer: 0.0, cavalry: 0.5,
      training: { swordsman: 4, archer: 0, cavalry: 4 },
      tactics: { aggression: 1.0, defense: 0.0, focusFire: 0.3, targetPriority: 'weakest', cavalryCharge: 0.9, keepCapture: 0.1 },
    }),
  },
};

function listStrategies() {
  return Object.entries(STRATEGIES).map(([key, v]) => ({ key, ...v }));
}

module.exports = { STRATEGIES, listStrategies, makeGenome };