'use strict';
// ============================================================
// Gorz Reborn — agent/genome.js
// A "genome" is a small JSON-serializable parameter vector that
// fully defines an agent's tactical + economic behavior. Evolving
// agents means mutating / crossing these.
//
// genome = {
//   composition: { swordsman: 0..1, archer: 0..1, cavalry: 0..1 }, // sum 1
//   training:    { swordsman: 0..N, archer: 0..N, cavalry: 0..N }, // stat-level added on top of base
//   tactics: {
//     aggression: 0..1,    // -> assault stance preference
//     defense:    0..1,    // -> hold stance preference
//     targetPriority: 'closest'|'weakest'|'archer_first'|'cavalry_first'|'any',
//     focusFire:   0..1,   // 0 = spread, 1 = hard focus
//     cavalryCharge: 0..1, // charge when opportunity >= threshold
//     rangedEngage: 0..1,  // 0 = melee kites, 1 = stands ground
//     keepCapture:  0..1,  // how much to divert toward neutral keeps
//   },
// }
//
// We deliberately keep it small + interpretable: 12 numbers + 1 enum.
// Mutation noise + 2-point crossover will explore this space well.
// ============================================================

function randomGene(rng) {
  // random unit composition (simplex via Dirichlet-like sum-to-1)
  const a = rng(), b = rng(), c = rng();
  const s = a + b + c;
  const training = {
    swordsman: Math.floor(rng() * 6), // 0-5 stat points
    archer:     Math.floor(rng() * 6),
    cavalry:    Math.floor(rng() * 6),
  };
  return {
    composition: { swordsman: a / s, archer: b / s, cavalry: c / s },
    training,
    tactics: {
      aggression:      rng(),
      defense:         rng(),
      targetPriority:  ['closest', 'weakest', 'archer_first', 'cavalry_first'][Math.floor(rng() * 4)],
      focusFire:       rng(),
      cavalryCharge:   rng(),
      rangedEngage:    rng(),
      keepCapture:     rng(),
    },
  };
}

function normalizeComposition(comp) {
  const a = Math.max(0.001, comp.swordsman || 0);
  const b = Math.max(0.001, comp.archer || 0);
  const c = Math.max(0.001, comp.cavalry || 0);
  const s = a + b + c;
  return { swordsman: a / s, archer: b / s, cavalry: c / s };
}

function cloneGene(g) {
  return JSON.parse(JSON.stringify(g));
}

// Bit-flip + Gaussian noise mutation, magnitude scaled by `rate`.
function mutateGene(g, rng, rate = 0.2) {
  const m = cloneGene(g);
  // composition (small directional drift, re-normalized)
  const drift = () => (rng() - 0.5) * rate * 0.3;
  m.composition = normalizeComposition({
    swordsman: m.composition.swordsman + drift(),
    archer:     m.composition.archer     + drift(),
    cavalry:    m.composition.cavalry    + drift(),
  });
  // training (integer steps, occasional ±1)
  for (const k of ['swordsman', 'archer', 'cavalry']) {
    if (rng() < rate) m.training[k] = Math.max(0, Math.min(8, m.training[k] + (rng() < 0.5 ? -1 : 1)));
  }
  // tactics (clamped Gaussian)
  for (const k of ['aggression', 'defense', 'focusFire', 'cavalryCharge', 'rangedEngage', 'keepCapture']) {
    const v = m.tactics[k] + (rng() - 0.5) * rate;
    m.tactics[k] = Math.max(0, Math.min(1, v));
  }
  // enum: occasional resample
  if (rng() < rate * 0.5) {
    m.tactics.targetPriority = ['closest', 'weakest', 'archer_first', 'cavalry_first'][Math.floor(rng() * 4)];
  }
  return m;
}

// Uniform 2-point crossover on flat fields.
function crossoverGene(a, b, rng) {
  const child = cloneGene(a);
  for (const k of ['swordsman', 'archer', 'cavalry']) {
    if (rng() < 0.5) child.composition[k] = b.composition[k];
  }
  for (const k of ['swordsman', 'archer', 'cavalry']) {
    if (rng() < 0.5) child.training[k] = b.training[k];
  }
  for (const k of ['aggression', 'defense', 'focusFire', 'cavalryCharge', 'rangedEngage', 'keepCapture']) {
    if (rng() < 0.5) child.tactics[k] = b.tactics[k];
  }
  if (rng() < 0.5) child.tactics.targetPriority = b.tactics.targetPriority;
  child.composition = normalizeComposition(child.composition);
  return child;
}

// Stable hash for a genome (used as identity for "did this gene evolve").
function fingerprint(g) {
  const c = g.composition, t = g.training, k = g.tactics;
  return [
    c.swordsman.toFixed(3), c.archer.toFixed(3), c.cavalry.toFixed(3),
    t.swordsman, t.archer, t.cavalry,
    k.aggression.toFixed(2), k.defense.toFixed(2), k.targetPriority,
    k.focusFire.toFixed(2), k.cavalryCharge.toFixed(2),
    k.rangedEngage.toFixed(2), k.keepCapture.toFixed(2),
  ].join('|');
}

module.exports = {
  randomGene,
  mutateGene,
  crossoverGene,
  normalizeComposition,
  cloneGene,
  fingerprint,
};