'use strict';
// ============================================================
// Gorz Reborn — bank.js
// Gold + diamonds ledger with atomic transactions.
// Every gold/diamond change goes through here and is recorded.
// ============================================================
const { db } = require('../db');
const { GameError } = require('./errors');

// Adjust a user's gold/diamonds atomically. Negative deltas are
// validated against balance. Records a transaction row.
// Returns the updated user row.
function adjust(userId, { gold = 0, diamonds = 0, kind = 'generic', note = '' }) {
  const tx = db.transaction(() => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new GameError(404, 'کاربر یافت نشد.');

    const newGold = user.gold + gold;
    const newDiamonds = user.diamonds + diamonds;
    if (newGold < 0) throw new GameError(400, 'سکه کافی ندارید.');
    if (newDiamonds < 0) throw new GameError(400, 'الماس کافی ندارید.');

    db.prepare('UPDATE users SET gold = ?, diamonds = ? WHERE id = ?').run(newGold, newDiamonds, userId);
    db.prepare('INSERT INTO transactions (user_id, kind, delta_gold, delta_diamonds, note) VALUES (?,?,?,?,?)').run(
      userId,
      kind,
      gold,
      diamonds,
      note
    );
    return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  });
  return tx();
}

function ledger(userId, limit = 50) {
  return db
    .prepare('SELECT id, kind, delta_gold, delta_diamonds, note, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(Math.max(1, limit), 200));
}

module.exports = { adjust, ledger };
