'use strict';
// ============================================================
// Gorz Reborn - agent/hosted.js
// Self-contained hosted tournament runner for cloud runners
// (GitHub Actions, CI boxes, any machine without the game client).
//
// Unlike run-tournament.js (which drives a live server over HTTP
// with GorzAgent), this runs the ENTIRE stack in-process:
//   db (better-sqlite3) -> registry/evolution -> brain -> tactics
// No HTTP server, no port, no running instance needed. The only
// external surface is the SQLite file, selected via GORZ_DB.
//
// Usage:
//   node server/agent/hosted.js --gens 5 --pop 16
//   node server/agent/hosted.js --gens 10 --pop 24 --base-seed 42
//   node server/agent/hosted.js --json --out report.json
//
// Flags:
//   --gens <n>        generations (default 5, max 50)
//   --pop <n>         population size (default 16, max 40)
//   --base-seed <n>   deterministic seed (default 42)
//   --lineage <name>  lineage label (default "ci-sparta")
//   --json            also emit a machine-readable report
//   --out <path>      report path (default "gorz-battle-report.json")
//   --top <n>         genomes in the report (default 5)
//   --help            show this list
//
// Environment:
//   GORZ_DB           path to the SQLite file. ALWAYS SET THIS in
//                     hosted/CI use, otherwise server/db.js falls
//                     back to data/gorz.db (your real game DB).
//   HOSTED_KEEP_DB    set to keep the throwaway DB (default: deleted)
//
// Exit codes: 0 = all generations completed, 1 = fatal error,
// 2 = completed but zero decisive games (regression signal).
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ---------------- CLI parsing ----------------
function parseArgs(argv) {
  const out = {
    gens: 5, pop: 16, baseSeed: 42, lineage: 'ci-sparta',
    json: false, out: 'gorz-battle-report.json', top: 5, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--gens': out.gens = parseInt(next(), 10); break;
      case '--pop': out.pop = parseInt(next(), 10); break;
      case '--base-seed': out.baseSeed = parseInt(next(), 10); break;
      case '--lineage': out.lineage = String(next()); break;
      case '--json': out.json = true; break;
      case '--out': out.out = String(next()); break;
      case '--top': out.top = parseInt(next(), 10); break;
      case '--help': case '-h': out.help = true; break;
      default: break; // ignore unknown flags (CI runners pass odd extras)
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`Usage: node server/agent/hosted.js [flags]
  --gens <n>        generations (default 5, max 50)
  --pop <n>         population size (default 16, max 40)
  --base-seed <n>   deterministic seed (default 42)
  --lineage <name>  lineage label (default "ci-sparta")
  --json            write a machine-readable report
  --out <path>      report path (default gorz-battle-report.json)
  --top <n>         genomes in the per-gen report (default 5)
Env: GORZ_DB=<sqlite path>  HOSTED_KEEP_DB=1`);
  process.exit(0);
}

// ---------------- config validation ----------------
const GENS = Math.max(1, Math.min(50, Number.isFinite(args.gens) ? args.gens : 5));
const POP = Math.max(4, Math.min(40, Number.isFinite(args.pop) ? args.pop : 16));
const BASE_SEED = Number.isFinite(args.baseSeed) ? args.baseSeed : 42;
const LINEAGE = String(args.lineage || 'ci-sparta').replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) || 'ci-sparta';
const TOP_N = Math.max(1, Math.min(20, Number.isFinite(args.top) ? args.top : 5));
const REPORT_PATH = String(args.out || 'gorz-battle-report.json');

// ---------------- throwaway DB (CI-safe) ----------------
// GORZ_DB must be set BEFORE requiring server/db.js - that module
// reads it at require-time. If the caller already set it, respect it
// and never delete the file.
const callerDb = process.env.GORZ_DB;
if (!callerDb) {
  process.env.GORZ_DB = path.join(os.tmpdir(), `gorz-hosted-${crypto.randomBytes(4).toString('hex')}.db`);
}
const DB_FILE = process.env.GORZ_DB;

// ---------------- module wiring ----------------
const { db } = require('../db'); // opens/creates the DB, runs seed
const registry = require('./registry');
const evolution = require('./evolution');
const genomeLib = require('./genome');
const { listStrategies } = require('./strategies');

const START_MS = Date.now();
const STARTED_AT = new Date().toISOString();

// ---------------- helpers ----------------
function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  console.log(`[hosted ${t}] ${msg}`);
}

// Deterministic RNG (mulberry32) so --base-seed gives reproducible runs.
// Returns floats in [0,1) - the Math.random contract that randomGene,
// mutateGene and nextGeneration all assume (they do `rng() < rate` and
// `arr[Math.floor(rng() * arr.length)]`).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 120 | t)) | 0;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

// Fresh commander row for one genome carrier (mirrors routes.freshUserIds,
// in-process; agents never log in so the token hash is throwaway).
function freshUserIds(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const tag = crypto.randomBytes(3).toString('hex');
    const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 4);
    const info = db.prepare(
      `INSERT INTO users (email, pass_hash, gold, diamonds, level) VALUES (?,?,?,?,?)`
    ).run(`hosted-${tag}@agent.local`, hash, 10000, 100, 10);
    db.prepare(`INSERT INTO heroes (user_id, name, level, xp) VALUES (?,?,?,?)`)
      .run(info.lastInsertRowid, 'agent', 10, 0);
    db.prepare(`INSERT OR IGNORE INTO training_points (user_id, points) VALUES (?, 1000)`)
      .run(info.lastInsertRowid);
    ids.push(info.lastInsertRowid);
  }
  return ids;
}

// ---------------- seeding ----------------
// Seed order: named strategies first (English keys, e.g. genghis-wolf),
// then random-genome fill to reach POP.
function seedPopulation(rng) {
  const seeded = listStrategies();
  const named = seeded.slice(0, POP);
  const uids = freshUserIds(POP);
  const agents = [];

  named.forEach((s, i) => {
    const uid = uids[i];
    const agent = registry.create({
      userId: uid,
      lineage: LINEAGE,
      name: s.key,
      generation: 1,
      genome: JSON.parse(JSON.stringify(s.genome)),
    });
    evolution.applyGenomeToUser(uid, agent.genome);
    agents.push(agent);
    log(`seeded  ${s.key.padEnd(24)} id=${agent.id}`);
  });

  for (let i = named.length; i < POP; i++) {
    const uid = uids[i];
    const g = genomeLib.randomGene(rng);
    const agent = registry.create({
      userId: uid,
      lineage: LINEAGE,
      name: `random-${String(i).padStart(2, '0')}`,
      generation: 1,
      genome: g,
    });
    evolution.applyGenomeToUser(uid, g);
    agents.push(agent);
    log(`seeded  random-${String(i).padStart(2, '0')}        id=${agent.id}`);
  }
  return agents;
}

// ---------------- generations ----------------
function runGenerations(agents, rng) {
  const perGen = [];
  let seed = BASE_SEED;
  for (let g = 0; g < GENS; g++) {
    // Reapply genomes each gen so training/recruitment is apples-to-apples.
    for (const a of agents) evolution.applyGenomeToUser(a.userId, a.genome);
    const matches = evolution.roundRobin(agents, { baseSeed: seed });
    seed += 1;
    // roundRobin mutates fitness in the DB; re-read so the per-gen report
    // and elite ordering reflect the values that just got written.
    agents = agents.map((a) => registry.getById(a.id));

    const decisive = matches.filter((m) => m.decisive).length;
    const errors = matches.filter((m) => m.error);
    const sorted = agents.slice().sort((x, y) => y.fitness - x.fitness);
    const top = sorted.slice(0, TOP_N).map((a) => ({
      id: a.id,
      name: a.name || null,
      fitness: a.fitness,
      fingerprint: a.fingerprint,
      composition: a.genome.composition,
    }));

    perGen.push({
      generation: g + 1,
      matches: matches.length,
      decisive,
      decisiveRate: matches.length ? decisive / matches.length : 0,
      errors: errors.length,
      top,
    });

    log(`gen ${String(g + 1).padStart(2)}/${GENS}  matches=${matches.length}  decisive=${decisive} (${(perGen[perGen.length - 1].decisiveRate * 100).toFixed(1)}%)  errors=${errors.length}`);
    top.forEach((t, i) => {
      const c = t.composition;
      log(`   #${i + 1} ${(t.name || '?').padEnd(24)} fitness=${String(t.fitness).padStart(5)} comp=${(c.swordsman * 100).toFixed(0)}/${(c.archer * 100).toFixed(0)}/${(c.cavalry * 100).toFixed(0)}`);
    });

    // Evolve: spawn next gen from this pop (except after the last gen,
    // so the final leaderboard describes the pop that just fought).
    if (g < GENS - 1) {
      const freshUids = freshUserIds(POP);
      agents = evolution.nextGeneration(LINEAGE, {
        popSize: POP,
        newUserIds: freshUids,
        rng,
      });
    }
  }
  return { agents, perGen };
}

// ---------------- report ----------------
function buildReport(agents, perGen) {
  const finalBoard = agents.slice()
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, 10)
    .map((a) => ({
      id: a.id,
      name: a.name || null,
      generation: a.generation,
      parentAId: a.parentAId,
      parentBId: a.parentBId,
      fitness: a.fitness,
      wins: a.wins,
      losses: a.losses,
      draws: a.draws,
      fingerprint: a.fingerprint,
      genome: a.genome,
    }));
  return {
    runner: 'gorz-hosted-runner',
    lineage: LINEAGE,
    params: { gens: GENS, pop: POP, baseSeed: BASE_SEED, topN: TOP_N },
    startedAt: STARTED_AT,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - START_MS,
    dbFile: callerDb ? 'caller-managed (kept)' : 'throwaway (deleted)',
    generations: perGen,
    leaderboard: finalBoard,
    // full roster of every agent that fought (names visible to the master)
    roster: agents.slice()
      .sort((a, b) => b.fitness - a.fitness)
      .map((a) => ({
        id: a.id,
        name: a.name || null,
        generation: a.generation,
        fitness: a.fitness,
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
        fingerprint: a.fingerprint,
        genome: a.genome,
      })),
    champion: finalBoard[0] || null,
  };
}

// ---------------- main ----------------
function main() {
  log(`gorz hosted tournament - lineage=${LINEAGE} gens=${GENS} pop=${POP} seed=${BASE_SEED}`);
  log(`db: ${DB_FILE}${callerDb ? ' (caller-managed, kept)' : ' (throwaway, removed at exit)'}`);

  const rng = mulberry32(BASE_SEED);
  const agents = seedPopulation(rng);
  const { agents: finalPop, perGen } = runGenerations(agents, rng);
  const report = buildReport(finalPop, perGen);

  if (args.json) {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    log(`report written: ${path.resolve(REPORT_PATH)}`);
  }

  log('=== final leaderboard ===');
  report.leaderboard.forEach((e, i) => {
    log(`#${i + 1} ${(e.name || '?').padEnd(24)} id=${e.id} gen=${e.generation} fitness=${e.fitness} w/l/d=${e.wins}/${e.losses}/${e.draws}`);
  });
  const champ = report.champion;
  if (champ) {
    const c = champ.genome.composition;
    log(`champion: ${champ.name || '#' + champ.id} (fitness ${champ.fitness}) - comp ${(c.swordsman * 100).toFixed(0)}/${(c.archer * 100).toFixed(0)}/${(c.cavalry * 100).toFixed(0)}`);
  }

  const totalDecisive = perGen.reduce((s, g) => s + g.decisive, 0);
  const totalMatches = perGen.reduce((s, g) => s + g.matches, 0);
  const totalErrors = perGen.reduce((s, g) => s + g.errors, 0);
  log(`totals: ${totalMatches} matches, ${totalDecisive} decisive (${totalMatches ? ((totalDecisive / totalMatches) * 100).toFixed(1) : '0.0'}%), ${totalErrors} engine errors`);

  if (totalMatches === 0) {
    console.error('[hosted] no matches were played - failing the run.');
    process.exitCode = 1;
    return;
  }
  if (totalDecisive === 0) {
    console.error('[hosted] zero decisive games across all generations - exiting 2 (regression signal).');
    process.exitCode = 2;
    return;
  }
  process.exitCode = 0;
}

try {
  main();
} catch (err) {
  console.error('[hosted] FATAL:', (err && err.stack) || err);
  process.exitCode = 1;
} finally {
  // Clean up the throwaway DB unless the caller asked to keep it.
  // Close the handle first - on Windows unlink fails with EPERM while
  // better-sqlite3 still holds the file open.
  if (!callerDb && !process.env.HOSTED_KEEP_DB) {
    try { db.close(); } catch (_) { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ }
    }
  } else {
    log(`db kept at: ${DB_FILE}`);
  }
  log(`done in ${((Date.now() - START_MS) / 1000).toFixed(1)}s`);
}
