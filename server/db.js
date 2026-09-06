'use strict';
// ============================================================
// Gorz Reborn — db.js
// better-sqlite3 schema (per DESIGN-v1.md section 7) + seed.
// Tables: users, heroes, soldiers, training_points, missions,
//         user_missions, battles, market_listings, transactions
// ============================================================
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { STARTING, SOLDIERS } = require('./game/balance');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.GORZ_DB || path.join(DATA_DIR, 'gorz.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------- schema ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  pass_hash     TEXT NOT NULL,
  gold          INTEGER NOT NULL DEFAULT 0,
  diamonds      INTEGER NOT NULL DEFAULT 0,
  level         INTEGER NOT NULL DEFAULT 1,
  xp            INTEGER NOT NULL DEFAULT 0,
  ranking_score INTEGER NOT NULL DEFAULT 0,
  prize_points  INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heroes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1,
  xp          INTEGER NOT NULL DEFAULT 0,
  attack_mod  REAL NOT NULL DEFAULT 0,
  defense_mod REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS soldiers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type      TEXT NOT NULL CHECK (type IN ('swordsman','archer','cavalry')),
  count     INTEGER NOT NULL DEFAULT 0,
  attack    INTEGER NOT NULL DEFAULT 0,   -- trained stat (base + training)
  defense   INTEGER NOT NULL DEFAULT 0,
  knowledge INTEGER NOT NULL DEFAULT 0,   -- knowledge XP (levels via KNOWLEDGE)
  UNIQUE (user_id, type)
);

CREATE TABLE IF NOT EXISTS training_points (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  points      INTEGER NOT NULL DEFAULT 0,
  last_update INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS missions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  type           TEXT NOT NULL,
  target         INTEGER NOT NULL,
  reward_gold    INTEGER NOT NULL DEFAULT 0,
  reward_xp      INTEGER NOT NULL DEFAULT 0,
  reward_diamonds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_missions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  progress   INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, mission_id)
);

CREATE TABLE IF NOT EXISTS battles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  attacker_id INTEGER NOT NULL REFERENCES users(id),
  defender_id INTEGER NOT NULL REFERENCES users(id),
  state       TEXT NOT NULL DEFAULT 'pending',  -- pending|running|finished
  log_json    TEXT,
  winner_id   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT
);

CREATE TABLE IF NOT EXISTS market_listings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type   TEXT NOT NULL CHECK (item_type IN ('swordsman','archer','cavalry','diamond')),
  item_id     INTEGER,
  qty         INTEGER NOT NULL,
  price_gold  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  delta_gold    INTEGER NOT NULL DEFAULT 0,
  delta_diamonds INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_heroes_user     ON heroes(user_id);
CREATE INDEX IF NOT EXISTS idx_soldiers_user   ON soldiers(user_id);
CREATE INDEX IF NOT EXISTS idx_user_missions   ON user_missions(user_id);
CREATE INDEX IF NOT EXISTS idx_battles_user    ON battles(attacker_id);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON market_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_tx_user         ON transactions(user_id);
`);

// ---------------- seed ----------------
const SEED_MISSIONS = [
  // type: 'train' | 'battle' | 'level' | 'spend_diamonds' | 'market' | 'gold'
  { type: 'train', target: 1, reward_gold: 50, reward_xp: 30, reward_diamonds: 0, title: 'Boot Camp', description: 'Train one soldier.' },
  { type: 'train', target: 10, reward_gold: 150, reward_xp: 60, reward_diamonds: 0, title: 'Serious Recruiting', description: 'Train ten soldiers.' },
  { type: 'train', target: 50, reward_gold: 400, reward_xp: 150, reward_diamonds: 5, title: 'Army in the Making', description: 'Train fifty soldiers.' },
  { type: 'battle', target: 1, reward_gold: 100, reward_xp: 80, reward_diamonds: 0, title: 'First Blood', description: 'Take part in a battle.' },
  { type: 'battle', target: 3, reward_gold: 250, reward_xp: 150, reward_diamonds: 3, title: 'Seasoned Warrior', description: 'Take part in three battles.' },
  { type: 'battle', target: 10, reward_gold: 800, reward_xp: 400, reward_diamonds: 10, title: 'Veteran Commander', description: 'Take part in ten battles.' },
  { type: 'win', target: 1, reward_gold: 200, reward_xp: 100, reward_diamonds: 2, title: 'First Victory', description: 'Win a battle.' },
  { type: 'win', target: 5, reward_gold: 600, reward_xp: 250, reward_diamonds: 8, title: 'Winning Streak', description: 'Win five battles.' },
  { type: 'level', target: 3, reward_gold: 150, reward_xp: 50, reward_diamonds: 2, title: 'Level 3 Commander', description: 'Reach level 3.' },
  { type: 'level', target: 5, reward_gold: 300, reward_xp: 100, reward_diamonds: 5, title: 'Level 5 Commander', description: 'Reach level 5.' },
  { type: 'market', target: 1, reward_gold: 100, reward_xp: 40, reward_diamonds: 0, title: 'Novice Merchant', description: 'Sell an item on the market.' },
  { type: 'gold', target: 2000, reward_gold: 100, reward_xp: 60, reward_diamonds: 0, title: 'Treasurer', description: 'Accumulate over 2,000 gold coins.' },
];

function seed() {
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@gorz.ir');
  if (!adminExists) {
    const hash = bcrypt.hashSync('gorz1234', 10);
    const info = db
      .prepare('INSERT INTO users (email, pass_hash, gold, diamonds, level, xp, ranking_score) VALUES (?,?,?,?,?,?,?)')
      .run('admin@gorz.ir', hash, 5000, 500, 10, 2500, 1000);
    const uid = info.lastInsertRowid;
    db.prepare('INSERT INTO heroes (user_id, name, level, xp) VALUES (?,?,?,?)').run(uid, 'Afrasiab', 8, 750);
    db.prepare('INSERT INTO training_points (user_id, points, last_update) VALUES (?,?,?)').run(uid, 100, Math.floor(Date.now() / 1000));
    const stmt = db.prepare('INSERT INTO soldiers (user_id, type, count, attack, defense, knowledge) VALUES (?,?,?,?,?,?)');
    stmt.run(uid, 'swordsman', 500, SOLDIERS.swordsman.attack, SOLDIERS.swordsman.defense, 300);
    stmt.run(uid, 'archer', 200, SOLDIERS.archer.attack, SOLDIERS.archer.defense, 120);
    stmt.run(uid, 'cavalry', 100, SOLDIERS.cavalry.attack, SOLDIERS.cavalry.defense, 80);
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM missions').get().n;
  if (count === 0) {
    const stmt = db.prepare(
      'INSERT INTO missions (title, description, type, target, reward_gold, reward_xp, reward_diamonds) VALUES (?,?,?,?,?,?,?)'
    );
    for (const m of SEED_MISSIONS) {
      stmt.run(m.title, m.description, m.type, m.target, m.reward_gold, m.reward_xp, m.reward_diamonds);
    }
  }
}

// Idempotent migration: pre-English databases carry Persian-named mission
// columns (title_fa/desc_fa). Rename them so the English seed matches, and
// replace any Persian mission rows with the English seed text.
function migrateMissionColumns() {
  const cols = db.prepare("PRAGMA table_info(missions)").all().map((c) => c.name);
  if (cols.includes('title_fa') && !cols.includes('title')) {
    db.exec('ALTER TABLE missions RENAME COLUMN title_fa TO title');
  }
  if (cols.includes('desc_fa') && !cols.includes('description')) {
    db.exec('ALTER TABLE missions RENAME COLUMN desc_fa TO description');
  }
  // Persian mission rows -> English seed text (match by type+target).
  const persianRe = /[\u0600-\u06FF]/;
  const rows = db.prepare('SELECT id, type, target, title, description FROM missions').all();
  const byKey = new Map(SEED_MISSIONS.map((m) => [m.type + ':' + m.target, m]));
  const upd = db.prepare('UPDATE missions SET title = ?, description = ? WHERE id = ?');
  for (const row of rows) {
    if (persianRe.test(row.title) || persianRe.test(row.description)) {
      const m = byKey.get(row.type + ':' + row.target);
      if (m) upd.run(m.title, m.description, row.id);
    }
  }
  // Persian hero names -> English defaults. The admin seed hero carried a
  // Persian name (matched via the escaped literal below -> 'Afrasiab');
  // agent clones carrying the Persian game title -> 'Gorz'.
  const persianHeroes = db
    .prepare('SELECT id, name FROM heroes')
    .all()
    .filter((h) => persianRe.test(h.name || ''));
  const updHero = db.prepare('UPDATE heroes SET name = ? WHERE id = ?');
  for (const h of persianHeroes) {
    updHero.run(h.name === '\u0627\u0641\u0631\u0627\u0633\u06cc\u0627\u0628' ? 'Afrasiab' : 'Gorz', h.id);
  }
}

migrateMissionColumns();
seed();

module.exports = { db, DB_PATH };
