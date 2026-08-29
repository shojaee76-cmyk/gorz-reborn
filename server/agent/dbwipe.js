#!/usr/bin/env node
'use strict';
// Wipes agent test data: only the agents rows + their dangling
// agent user rows. Keeps admin, missions, market, etc.
const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.GORZ_DB || path.join(__dirname, '..', '..', 'data', 'gorz.db');
const db = new Database(dbPath);
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