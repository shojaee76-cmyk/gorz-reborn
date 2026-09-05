// One-off: wipe test pollution so a lone new user gets the vs-AI path.
const { db } = require('./server/db');
const u = db.prepare("SELECT id FROM users WHERE email LIKE '%@test.local%'").all();
console.log('test users to wipe:', u.length);
const ids = u.map(x => x.id);
if (ids.length) {
  db.prepare(`DELETE FROM battles WHERE attacker_id IN (${ids.join(',')}) OR defender_id IN (${ids.join(',')})`).run();
  db.prepare("DELETE FROM users WHERE email LIKE '%@test.local%'").run();
}
db.prepare('DELETE FROM users WHERE id <= -1').run();
const r = db.prepare('SELECT COUNT(*) c FROM users').get();
const b = db.prepare('SELECT COUNT(*) c FROM battles').get();
console.log('after wipe -> users:', r.c, 'battles:', b.c);
