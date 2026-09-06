'use strict';
// ============================================================
// Gorz Reborn - agent/routes.js
// Agent API surface. Mounted at /api/agent/* by the main router.
//
// Endpoints:
//   POST /register           { name?, lineage?, genome? } -> { agent, token }
//   POST /login              { email, token } -> { agent }
//   GET  /me                 -> { agent }
//   GET  /population         ?lineage=sparta -> { agents[] }
//   GET  /genome/:id         -> { genome }
//   POST /tournament         { lineage, pop_size?, generations? } -> { lineage, generations[] }
//   POST /duel               { agentAId, agentBId, seed? } -> { winnerSide, rounds, outcome }
//   GET  /health             -> { ok }
// ============================================================
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const registry = require('./registry');
const evolution = require('./evolution');
const genomeLib = require('./genome');

const router = express.Router();

const wrap = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) { next(err); }
};

// agent tokens are random + bcrypt'd like a password (so we don't store raw)
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---- helpers ----
function createUserRow({ email }) {
  const hash = bcrypt.hashSync(newToken(), 4);
  const info = db.prepare(
    `INSERT INTO users (email, pass_hash, gold, diamonds, level) VALUES (?,?,?,?,?)`
  ).run(email, hash, 10000, 100, 10);
  // seed a default hero so tactics.buildSide has one
  db.prepare(`INSERT INTO heroes (user_id, name, level, xp) VALUES (?,?,?,?)`)
    .run(info.lastInsertRowid, 'agent', 10, 0);
  db.prepare(`INSERT OR IGNORE INTO training_points (user_id, points) VALUES (?, 1000)`)
    .run(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function provisionAgent(name, lineage, genome) {
  const slug = (name || 'agent').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24);
  const tag = crypto.randomBytes(2).toString('hex');
  const email = `${slug}-${tag}@agent.local`;
  const userId = createUserRow({ email });
  const g = genome || genomeLib.randomGene(Math.random);
  const agent = registry.create({
    userId,
    lineage: lineage || 'sparta',
    name: slug || null,
    generation: 1,
    genome: g,
  });
  evolution.applyGenomeToUser(userId, g);
  return { agent, email };
}

function freshUserIds(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const tag = crypto.randomBytes(3).toString('hex');
    ids.push(createUserRow({ email: `pop-${tag}@agent.local` }));
  }
  return ids;
}

// ---- endpoints ----

router.post('/register', wrap((req, res) => {
  const { name, lineage, genome } = req.body || {};
  const { agent, email } = provisionAgent(name, lineage, genome);
  res.status(201).json({ ok: true, agent, email });
}));

router.get('/population', wrap((req, res) => {
  // lineage is OPTIONAL - omitting it returns agents from ALL lineages,
  // ordered most-recent first (so the leaderboard page can show a global view).
  const lineage = req.query.lineage ? req.query.lineage.toString() : null;
  const includeRetired = req.query.include_retired === '1';
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  const agents = lineage
    ? registry.listByLineage(lineage, { includeRetired, limit })
    : registry.listAll({ includeRetired, limit });
  res.json({ ok: true, agents });
}));

router.get('/genome/:id', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = registry.getById(id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  res.json({ ok: true, agent: a, genome: a.genome });
}));

// Run a single duel between two agents (no round-robin, fast iteration).
router.post('/duel', wrap((req, res) => {
  const { agentAId, agentBId, seed } = req.body || {};
  const a = registry.getById(parseInt(agentAId, 10));
  const b = registry.getById(parseInt(agentBId, 10));
  if (!a || !b) return res.status(404).json({ error: 'agent(s) not found' });
  evolution.applyGenomeToUser(a.userId, a.genome);
  evolution.applyGenomeToUser(b.userId, b.genome);
  const result = evolution.duel(a, b, { seed: seed != null ? seed : Math.floor(Math.random() * 0xffffffff) });
  // Persist Elo updates (mirror roundRobin logic) - otherwise /duel
  // returns results but never touches the leaderboard.
  const winnerId = result.winnerSide === 'attacker' ? a.id : (result.winnerSide === 'defender' ? b.id : null);
  const decisive = result.outcome && result.outcome.reason && result.outcome.reason !== 'exhausted' && result.outcome.reason !== 'safety cap';
  if (winnerId === a.id) {
    registry.updateFitness(a.id, { deltaWins: 1, decisiveWin: decisive, roundsSurvived: result.rounds });
    registry.updateFitness(b.id, { deltaLosses: 1, decisiveLoss: decisive, roundsSurvived: result.rounds });
  } else if (winnerId === b.id) {
    registry.updateFitness(b.id, { deltaWins: 1, decisiveWin: decisive, roundsSurvived: result.rounds });
    registry.updateFitness(a.id, { deltaLosses: 1, decisiveLoss: decisive, roundsSurvived: result.rounds });
  } else {
    registry.updateFitness(a.id, { deltaDraws: 1, roundsSurvived: result.rounds });
    registry.updateFitness(b.id, { deltaDraws: 1, roundsSurvived: result.rounds });
  }
  // re-read so the response reflects updated fitness
  const a2 = registry.getById(a.id);
  const b2 = registry.getById(b.id);
  res.json({ ok: true, a: { id: a.id, fitness: a2.fitness }, b: { id: b.id, fitness: b2.fitness }, ...result });
}));

// Run an evolution: N rounds of round-robin then nextGeneration.
router.post('/tournament', wrap(async (req, res) => {
  const { lineage = 'sparta', pop_size = 12, generations = 3, base_seed = 1 } = req.body || {};
  const popSize = Math.max(4, Math.min(40, parseInt(pop_size, 10) || 12));
  const genN = Math.max(1, Math.min(50, parseInt(generations, 10) || 3));

  // ensure we have a population: if lineage has none, spawn popSize random ones
  let pop = registry.listByLineage(lineage, { limit: popSize });
  if (pop.length < popSize) {
    const need = popSize - pop.length;
    const uids = freshUserIds(need);
    for (let i = 0; i < need; i++) {
      const g = genomeLib.randomGene(Math.random);
      const a = registry.create({
        userId: uids[i],
        lineage,
        name: `${lineage}-seed-${String(i + 1).padStart(2, '0')}`,
        generation: 1,
        genome: g,
      });
      evolution.applyGenomeToUser(uids[i], g);
      pop.push(a);
    }
  }

  const generationResults = [];
  let seed = base_seed;
  for (let g = 0; g < genN; g++) {
    // reapply genomes (so training/recruitment is consistent each gen)
    for (const a of pop) evolution.applyGenomeToUser(a.userId, a.genome);
    const matches = evolution.roundRobin(pop, { baseSeed: seed });
    seed += 1;
    // brief per-gen stats
    const sorted = pop.slice().sort((x, y) => y.fitness - x.fitness);
    const top = sorted.slice(0, 3).map((a) => ({
      id: a.id, fitness: a.fitness, fingerprint: a.fingerprint,
      composition: a.genome.composition,
    }));
    generationResults.push({ generation: g + 1, matches: matches.length, top, decisiveRate: matches.filter((m) => m.decisive).length / Math.max(1, matches.length) });

    // evolve: spawn next gen from this pop
    if (g < genN - 1) {
      const freshUids = freshUserIds(popSize);
      pop = evolution.nextGeneration(lineage, {
        popSize,
        newUserIds: freshUids,
      });
      // mark previous gen retired already happened inside nextGeneration
    }
  }

  // final leaderboard
  const final = pop.slice().sort((a, b) => b.fitness - a.fitness).slice(0, 10).map((a) => ({
    id: a.id, fitness: a.fitness, generation: a.generation,
    parentAId: a.parentAId, parentBId: a.parentBId,
    fingerprint: a.fingerprint,
    wins: a.wins, losses: a.losses, draws: a.draws,
    genome: a.genome,
  }));
  res.json({ ok: true, lineage, generations: generationResults, leaderboard: final });
}));

router.get('/lineages', wrap((req, res) => {
  const rows = db.prepare(`SELECT lineage, COUNT(*) AS n, MAX(generation) AS max_gen, AVG(fitness) AS avg_fitness FROM agents GROUP BY lineage`).all();
  res.json({ ok: true, lineages: rows });
}));

// Machine-readable rulebook: an LLM agent learns the whole game here.
const { rulesObject } = require('./rules');
router.get('/rules', (req, res) => {
  const proto = req.protocol;
  const host = req.get('host');
  res.json({ ok: true, rules: rulesObject(`${proto}://${host}`) });
});

router.get('/health', (req, res) => {
  res.json({ ok: true, name: 'gorz-agent', status: 'running' });
});

module.exports = router;