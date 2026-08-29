#!/usr/bin/env node
'use strict';
// Wipes agent test data: only the agents rows + their dangling
// agent user rows. Keeps admin, missions, market, etc.
//
// SAFETY: requires GORZ_FORCE_WIPE=1 env var to actually run.
// This prevents parallel subagents from accidentally wiping each
// other's data — every subagent task should pass a UNIQUE lineage
// name to its run-tournament.js call and skip the wipe entirely.
const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.GORZ_DB || path.join(__dirname, '..', '..', 'data', 'gorz.db');
const db = new Database(dbPath);
if (process.env.GORZ_FORCE_WIPE !== '1') {
  console.error('REFUSING to wipe without GORZ_FORCE_WIPE=1 env var.');
  console.error('Each tournament should use a unique lineage name (e.g. nightly-2026-08-29) instead of wiping the agents table.');
  console.error('If you really mean it: GORZ_FORCE_WIPE=1 node server/agent/dbwipe.js');
  process.exit(2);
}
console.warn('!!! WIPING all agents + their users (GORZ_FORCE_WIPE=1)');
const tx = db.transaction(() => {
  db.prepare(`DELETE FROM training_points WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@agent.local' OR email LIKE 'test-agent-%@x.local')`).run();
  db.prepare(`DELETE FROM soldiers      WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@agent.local' OR email LIKE 'test-agent-%@x.local')`).run();
  db.prepare(`DELETE FROM heroes        WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@agent.local' OR email LIKE 'test-agent-%@x.local')`).run();
  db.prepare(`DELETE FROM agents`).run();
  db.prepare(`DELETE FROM users WHERE email LIKE '%@agent.local' OR email LIKE 'test-agent-%@x.local'`).run();
});
tx();
const counts = {
  agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
  users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
};
console.log('wiped. remaining:', counts);
db.close();