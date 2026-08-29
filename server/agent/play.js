#!/usr/bin/env node
'use strict';
// ============================================================
// Gorz Reborn — agent/play.js
// "Play one battle from the command line": spawns two named
// strategies head-to-head against each other (or a random
// opponent), prints the round-by-round event log, and reports
// the outcome. Useful for subagents doing strategy debugging.
// ============================================================
const { GorzAgent } = require('./client');
const { STRATEGIES, listStrategies } = require('./strategies');

const aSide = process.argv[2] || 'shield-of-leonidas';
const bSide = process.argv[3] || 'house-of-darius';
const seed  = parseInt(process.argv[4] || '42', 10);

(async function main() {
  const a = new GorzAgent(process.env.GORZ_URL || 'http://localhost:3000');
  const stratA = STRATEGIES[aSide] || STRATEGIES['random'];
  const stratB = STRATEGIES[bSide] || STRATEGIES['random'];
  if (!stratA || !stratB) {
    console.error('unknown strategy. Available:', listStrategies().map((s) => s.key).join(', '));
    process.exit(2);
  }
  console.log(`[play] A: ${stratA.name}  vs  B: ${stratB.name}  seed=${seed}`);
  const regA = await a.register({ name: aSide + '-a-' + Date.now().toString(36), lineage: 'arena', genome: stratA.genome });
  const regB = await a.register({ name: bSide + '-b-' + Date.now().toString(36), lineage: 'arena', genome: stratB.genome });
  console.log(`[play] A id=${regA.id}  B id=${regB.id}`);
  const result = await a.duel(regA.id, regB.id, seed);
  console.log(`[play] rounds=${result.rounds}  winner=${result.winnerSide}  reason=${result.outcome && result.outcome.reason}`);
})().catch((e) => {
  console.error('[play] FAILED:', e.message);
  process.exit(1);
});