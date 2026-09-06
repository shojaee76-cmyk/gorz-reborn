'use strict';
// ============================================================
// Gorz Reborn - agent/evolution.js
// Higher-order trainer: take the current population, run a
// round-robin tournament using the real tactics engine (state
// frozen per seed), score by Elo, then spawn the next generation.
//
// Each generation cycle is:
//   1. Apply each agent's genome to its dedicated user row
//      (so every fight is apples-to-apples: same level, same
//      resources, same hero baseline - only the genome varies).
//   2. For each pair, build sides via tactics.buildSide from the
//      user's barracks, createBattleState, and step rounds with
//      brain.planOrders for both sides until evaluateOutcome
//      says done.
//   3. Update Elo fitness on each agent (win/loss/decisive).
//   4. Replace the bottom of the pop with crossover+mutant
//      children of the top elite, retire the previous gen.
// ============================================================

const { db } = require('../db');
const registry = require('./registry');
const genomeLib = require('./genome');
const brain = require('./brain');
const heroes = require('../game/heroes');
const barracksSvc = require('../game/barracks');
const tactics = require('../game/tactics');
const { TACTICS } = require('../game/balance');

// Recreate the agent's commander so the army is exactly what the genome
// dictates. Returns userId.
function applyGenomeToUser(userId, genome, baselineLevel = 10) {
  db.prepare(`UPDATE users SET level = ?, xp = 0, ranking_score = 1000, gold = 10000, diamonds = 100 WHERE id = ?`)
    .run(baselineLevel, userId);
  // baseline hero
  db.prepare('DELETE FROM heroes WHERE user_id = ?').run(userId);
  db.prepare(`INSERT INTO heroes (user_id, name, level, xp, attack_mod, defense_mod) VALUES (?,?,?,?,?,?)`)
    .run(userId, 'agent', baselineLevel, 0, 0, 0);
  // Wipe army + add fresh soldiers by composition fraction
  db.prepare('DELETE FROM soldiers WHERE user_id = ?').run(userId);
  // refill training points to fat so training() always succeeds
  db.prepare('UPDATE training_points SET points = 1000 WHERE user_id = ?').run(userId);
  db.prepare('INSERT OR IGNORE INTO training_points (user_id, points) VALUES (?, 1000)').run(userId);

  const cap = TACTICS.squadSize * TACTICS.maxSquadsPerSide;
  const c = genome.composition;
  const nS = Math.max(1, Math.round(cap * c.swordsman));
  const nA = Math.max(1, Math.round(cap * c.archer));
  const nC = Math.max(1, Math.round(cap * c.cavalry));
  try { barracksSvc.recruit(userId, 'swordsman', nS); } catch (e) {}
  try { barracksSvc.recruit(userId, 'archer', nA); } catch (e) {}
  try { barracksSvc.recruit(userId, 'cavalry', nC); } catch (e) {}

  // training: extra stat on top of base (uses training points; we set fat cap above)
  for (const t of ['swordsman', 'archer', 'cavalry']) {
    const delta = genome.training[t] || 0;
    for (let i = 0; i < delta; i++) {
      try { barracksSvc.train(userId, t, 'attack', 1); } catch (e) {}
      try { barracksSvc.train(userId, t, 'defense', 1); } catch (e) {}
    }
  }
  return userId;
}

function armySnapshot(userId) {
  // Always 3 rows (swordsman, archer, cavalry), even if count=0
  const rows = db.prepare('SELECT type, count, attack, defense, knowledge FROM soldiers WHERE user_id = ?').all(userId);
  const map = { swordsman: null, archer: null, cavalry: null };
  for (const r of rows) map[r.type] = r;
  return ['swordsman', 'archer', 'cavalry'].map((type) => {
    const r = map[type] || { type, count: 0, attack: 0, defense: 0, knowledge: 0 };
    return {
      type,
      count: r.count,
      attack: r.attack,
      defense: r.defense,
      knowledge_level: Math.floor((r.knowledge || 0) / 100),
    };
  });
}

function getHeroFor(userId) {
  const h = db.prepare('SELECT * FROM heroes WHERE user_id = ? LIMIT 1').get(userId);
  if (!h) return { id: 0, name: 'agent', level: 10, ...heroes.modifier({ level: 10 }) };
  return { id: h.id, name: h.name, level: h.level, ...heroes.modifier({ level: h.level }) };
}

// Build sides + state for one duel.
function buildDuelState(userA, userB, seed) {
  const sideA = tactics.buildSide(userA.userId, getHeroFor(userA.userId), armySnapshot(userA.userId));
  const sideB = tactics.buildSide(userB.userId, getHeroFor(userB.userId), armySnapshot(userB.userId));
  return tactics.createBattleState(seed >>> 0, sideA, sideB, 0);
}

// Run a single head-to-head using the real engine.
function duel(userA, userB, { seed } = {}) {
  const state = buildDuelState(userA, userB, seed || Math.floor(Math.random() * 0xffffffff));
  let rounds = 0;
  let outcome = null;
  while (state.status === 'running') {
    rounds++;
    const ordersA = brain.planOrders(userA.genome, state, 'attacker');
    const ordersB = brain.planOrders(userB.genome, state, 'defender');
    const cleanedA = tactics.validateOrders(state, 'attacker', ordersA);
    const cleanedB = tactics.validateOrders(state, 'defender', ordersB);
    const res = tactics.resolveRound(state, { attacker: cleanedA, defender: cleanedB });
    if (res.outcome && res.outcome.over) {
      state.winner = res.outcome.winner;
      state.status = 'finished';
      outcome = res.outcome;
    } else if (rounds > TACTICS.maxRounds) {
      // safety valve
      state.status = 'finished';
      state.winner = 'draw';
      outcome = { winner: 'draw', reason: 'safety cap' };
    }
  }
  return { rounds, outcome, winnerSide: state.winner };
}

// Run round-robin over `agents`. Each pair fights exactly once.
// Returns array of { aId, bId, winnerId, outcome, rounds }.
function roundRobin(agents, { rng = Math.random, baseSeed = 1 } = {}) {
  const results = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i], b = agents[j];
      const seed = baseSeed + i * 1000 + j; // deterministic but unique per pairing
      try {
        const { rounds, outcome, winnerSide } = duel(a, b, { seed });
        const winnerId = winnerSide === 'attacker' ? a.id : (winnerSide === 'defender' ? b.id : null);
        const decisive = outcome && outcome.reason && outcome.reason !== 'exhausted' && outcome.reason !== 'safety cap';
        results.push({ aId: a.id, bId: b.id, winnerId, outcome, rounds, decisive });
        if (winnerId === a.id) {
          registry.updateFitness(a.id, { deltaWins: 1, decisiveWin: decisive, roundsSurvived: rounds });
          registry.updateFitness(b.id, { deltaLosses: 1, decisiveLoss: decisive, roundsSurvived: rounds });
        } else if (winnerId === b.id) {
          registry.updateFitness(b.id, { deltaWins: 1, decisiveWin: decisive, roundsSurvived: rounds });
          registry.updateFitness(a.id, { deltaLosses: 1, decisiveLoss: decisive, roundsSurvived: rounds });
        } else {
          registry.updateFitness(a.id, { deltaDraws: 1, roundsSurvived: rounds });
          registry.updateFitness(b.id, { deltaDraws: 1, roundsSurvived: rounds });
        }
      } catch (e) {
        results.push({ aId: a.id, bId: b.id, error: String(e && e.message || e) });
      }
    }
  }
  return results;
}

// Spawn the next generation from the current lineage population.
// Caller passes newUserIds[] so this module doesn't touch the user row.
// Returns spawnedAgents[].
function nextGeneration(lineage, opts = {}) {
  const {
    popSize = 12,
    eliteFrac = 0.34,
    mutationRate = 0.3,
    crossoverRate = 0.7,
    rng = Math.random,
    newUserIds = [],
  } = opts;
  const current = registry.listByLineage(lineage, { includeRetired: true, limit: 1000 });
  current.sort((a, b) => b.fitness - a.fitness);
  const eliteCount = Math.max(2, Math.floor(popSize * eliteFrac));
  const elites = current.slice(0, eliteCount);
  const maxGen = current.reduce((m, a) => Math.max(m, a.generation), 0);
  const newGen = maxGen + 1;
  const spawned = [];

  // carry elites as-is (with mild fitness erosion) - these are "proven"
  for (const e of elites) {
    const uid = newUserIds.shift();
    if (uid === undefined) break;
    registry.retire(e.id);
    const child = registry.create({
      userId: uid,
      lineage,
      name: e.name || `${lineage}-elite-g${newGen}`,
      generation: newGen,
      parentAId: e.id,
      parentBId: null,
      genome: genomeLib.cloneGene(e.genome),
    });
    registry.updateFitness(child.id, { fitness: Math.round(e.fitness * 0.9) });
    spawned.push(child);
  }
  // fill remainder with crossover/mutant children of elites
  while (spawned.length < popSize && newUserIds.length) {
    const uid = newUserIds.shift();
    const a = elites[Math.floor(rng() * elites.length)];
    const b = elites[Math.floor(rng() * elites.length)];
    let childGenome;
    if (rng() < crossoverRate && a.id !== b.id) {
      childGenome = genomeLib.crossoverGene(a.genome, b.genome, rng);
    } else {
      childGenome = genomeLib.cloneGene(a.genome);
    }
    childGenome = genomeLib.mutateGene(childGenome, rng, mutationRate);
    // Child name shows ancestry so the master can track bloodlines:
    // "genghis-wolf.shield-of-leonidas" = crossover of those two agents.
    const nameA = a.name || `a${a.id}`;
    const nameB = b.name || `b${b.id}`;
    const child = registry.create({
      userId: uid,
      lineage,
      name: `${nameA}.${nameB}`.slice(0, 60),
      generation: newGen,
      parentAId: a.id,
      parentBId: b.id,
      genome: childGenome,
    });
    spawned.push(child);
  }
  return spawned;
}

module.exports = {
  applyGenomeToUser,
  buildDuelState,
  duel,
  roundRobin,
  nextGeneration,
};