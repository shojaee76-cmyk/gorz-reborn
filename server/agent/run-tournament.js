#!/usr/bin/env node
'use strict';
// ============================================================
// Gorz Reborn — agent/run-tournament.js
// Seeds a population from the named strategy library, then runs
// N generations of round-robin + evolution. Prints a per-gen
// report and final leaderboard.
//
// Usage:
//   node server/agent/run-tournament.js [lineage] [pop] [gens]
//   node server/agent/run-tournament.js sparta 8 4
//
// What subagents should invoke to play the game and evolve:
//   this is the "make your subagents play the game for debug"
//   entrypoint — it does register + fight + evolve in one go
//   and emits a clean per-gen report.
// ============================================================
const { GorzAgent } = require('./client');
const { STRATEGIES, listStrategies } = require('./strategies');

const lineage = process.argv[2] || 'sparta';
const pop = parseInt(process.argv[3] || '8', 10);
const gens = parseInt(process.argv[4] || '3', 10);

(async function main() {
  const a = new GorzAgent(process.env.GORZ_URL || 'http://localhost:3000');
  const h = await a.health();
  console.log(`[tournament] server: ${h.name} (${h.status})`);
  console.log(`[tournament] lineage=${lineage} pop=${pop} gens=${gens}`);

  // step 1: seed population with one of every named strategy + random fill
  const seeded = listStrategies();
  console.log(`[tournament] seeding ${Math.min(seeded.length, pop)} named strategies`);
  for (let i = 0; i < Math.min(seeded.length, pop); i++) {
    const s = seeded[i];
    const ag = await a.register({ name: s.key, lineage, genome: s.genome });
    console.log(`  + ${s.name.padEnd(24)}  id=${ag.id} fp=${ag.fingerprint.slice(0, 24)}…`);
  }
  // top-up with random genomes to reach pop
  for (let i = seeded.length; i < pop; i++) {
    const ag = await a.register({ name: `random-${i}`, lineage });
    console.log(`  + random-${i.toString().padStart(2,'0')}                  id=${ag.id}`);
  }

  // step 2: run tournament over gens
  const result = await a.tournament({ lineage, pop_size: pop, generations: gens });
  console.log(`\n[tournament] generations run: ${result.generations.length}`);
  for (const g of result.generations) {
    console.log(`\n=== GEN ${g.generation} ===  matches=${g.matches}  decisive=${(g.decisiveRate*100).toFixed(1)}%`);
    g.top.forEach((t, i) => {
      console.log(`  #${i+1} id=${t.id} fitness=${t.fitness.toFixed(0)} comp=[${(t.composition.swordsman*100).toFixed(0)}/${(t.composition.archer*100).toFixed(0)}/${(t.composition.cavalry*100).toFixed(0)}] fp=${t.fingerprint.slice(0, 20)}…`);
    });
  }
  console.log(`\n[tournament] final leaderboard:`);
  result.leaderboard.slice(0, Math.min(10, result.leaderboard.length)).forEach((e, i) => {
    console.log(`  #${i+1} id=${e.id} gen=${e.generation} fitness=${e.fitness.toFixed(0)} w=${e.wins} l=${e.losses} d=${e.draws} fp=${e.fingerprint.slice(0, 24)}…`);
  });
})().catch((e) => {
  console.error('[tournament] FAILED:', e.message);
  process.exit(1);
});