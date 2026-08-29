'use strict';
// ============================================================
// Gorz Reborn — agent/registry.js
// Persistent storage of agent records + genome + fitness.
//
// agents table:
//   id           INTEGER PK
//   user_id      INTEGER (FK -> users.id, the commander's row)
//   lineage      TEXT  (e.g. "sparta")
//   generation   INTEGER
//   parent_a_id  INTEGER NULL
//   parent_b_id  INTEGER NULL
//   genome_json  TEXT
//   fitness      REAL (running score; higher = stronger)
//   wins         INTEGER
//   losses       INTEGER
//   draws        INTEGER
//   decisive_wins INTEGER
//   decisive_losses INTEGER
//   born_at      TEXT
//   retired_at   TEXT NULL
// ============================================================

const { db } = require('../db');
const { fingerprint } = require('./genome');

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lineage           TEXT NOT NULL DEFAULT 'sparta',
      generation        INTEGER NOT NULL DEFAULT 1,
      parent_a_id       INTEGER,
      parent_b_id       INTEGER,
      genome_json       TEXT NOT NULL,
      fitness           REAL NOT NULL DEFAULT 1000,
      wins              INTEGER NOT NULL DEFAULT 0,
      losses            INTEGER NOT NULL DEFAULT 0,
      draws             INTEGER NOT NULL DEFAULT 0,
      decisive_wins     INTEGER NOT NULL DEFAULT 0,
      decisive_losses   INTEGER NOT NULL DEFAULT 0,
      avg_rounds_survived REAL NOT NULL DEFAULT 0,
      born_at           TEXT NOT NULL DEFAULT (datetime('now')),
      retired_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_lineage ON agents(lineage, generation);
    CREATE INDEX IF NOT EXISTS idx_agents_fitness ON agents(fitness DESC);
  `);
}
ensureSchema();

function rowToAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    lineage: row.lineage,
    generation: row.generation,
    parentAId: row.parent_a_id,
    parentBId: row.parent_b_id,
    genome: JSON.parse(row.genome_json),
    fingerprint: fingerprint(JSON.parse(row.genome_json)),
    fitness: row.fitness,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    decisiveWins: row.decisive_wins,
    decisiveLosses: row.decisive_losses,
    avgRoundsSurvived: row.avg_rounds_survived,
    bornAt: row.born_at,
    retiredAt: row.retired_at,
  };
}

function create({ userId, lineage = 'sparta', generation = 1, parentAId = null, parentBId = null, genome }) {
  const stmt = db.prepare(
    `INSERT INTO agents (user_id, lineage, generation, parent_a_id, parent_b_id, genome_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(userId, lineage, generation, parentAId, parentBId, JSON.stringify(genome));
  return getById(info.lastInsertRowid);
}

function getById(id) {
  return rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
}

function getByUserId(userId) {
  return rowToAgent(db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId));
}

function listByLineage(lineage, { includeRetired = false, limit = 100 } = {}) {
  const rows = includeRetired
    ? db.prepare('SELECT * FROM agents WHERE lineage = ? ORDER BY fitness DESC LIMIT ?').all(lineage, limit)
    : db.prepare('SELECT * FROM agents WHERE lineage = ? AND retired_at IS NULL ORDER BY fitness DESC LIMIT ?').all(lineage, limit);
  return rows.map(rowToAgent);
}

function updateFitness(id, { deltaWins = 0, deltaLosses = 0, deltaDraws = 0, decisiveWin = false, decisiveLoss = false, roundsSurvived = null, fitness = null }) {
  // Elo-ish: 1000 base. Win +20, Loss -18, Draw 0; decisive = 1.5x.
  const agent = getById(id);
  if (!agent) return null;
  let w = agent.wins + deltaWins;
  let l = agent.losses + deltaLosses;
  let d = agent.draws + deltaDraws;
  let dw = agent.decisiveWins + (decisiveWin ? 1 : 0);
  let dl = agent.decisiveLosses + (decisiveLoss ? 1 : 0);
  let avgR = agent.avgRoundsSurvived;
  if (roundsSurvived !== null) {
    const total = w + l + d;
    avgR = total <= 1 ? roundsSurvived : (avgR * (total - 1) + roundsSurvived) / total;
  }
  // Elo formula (K=24)
  const expected = 1 / (1 + Math.pow(10, (1000 - agent.fitness) / 400));
  const actual = 1; // we always update after a result we own
  const scoreChange = 24 * (actual - expected) * (decisiveWin || decisiveLoss ? 1.5 : 1);
  const newFitness = fitness !== null ? fitness : Math.round(agent.fitness + scoreChange);
  db.prepare(
    `UPDATE agents SET wins = ?, losses = ?, draws = ?, decisive_wins = ?, decisive_losses = ?,
                       avg_rounds_survived = ?, fitness = ? WHERE id = ?`
  ).run(w, l, d, dw, dl, avgR, newFitness, id);
  return getById(id);
}

function retire(id) {
  db.prepare(`UPDATE agents SET retired_at = datetime('now') WHERE id = ?`).run(id);
  return getById(id);
}

function topN(lineage, n = 10) {
  return listByLineage(lineage, { limit: n });
}

module.exports = {
  create,
  getById,
  getByUserId,
  listByLineage,
  updateFitness,
  retire,
  topN,
  // expose raw helpers
  _rowToAgent: rowToAgent,
};