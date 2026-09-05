// Isolation wipe: DELETE all users+battles so a lonely new user gets vs-AI.
const { db } = require('./server/db');
db.pragma('foreign_keys=off');
db.exec('BEGIN');
// discover real tables
const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
const tables = rows.map(r => r.name);
console.log('tables:', tables);
for (const t of tables) {
  if (!t) continue;
  const n = db.prepare(`SELECT COUNT(*) c FROM [${t}]`).get().c;
  db.prepare(`DELETE FROM [${t}]`).run();
  console.log(`${t}: deleted (${n})`);
}
try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch (e) {}
db.exec('COMMIT');
db.pragma('foreign_keys=on');
console.log('users now:', db.prepare('SELECT COUNT(*) c FROM users').get().c,
            '| battles:', db.prepare('SELECT COUNT(*) c FROM battles').get().c);
