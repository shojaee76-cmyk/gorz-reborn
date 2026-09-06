'use strict';
// ============================================================
// Gorz Reborn — auth.js
// Register (email+password, bcrypt), login, session middleware.
// One account per email.
// ============================================================
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { STARTING, SOLDIERS } = require('./game/balance');
const { GameError } = require('./game/errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Create a new commander: user + first hero + starting army + gold/diamonds.
function register(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new GameError(400, 'Invalid email address.');
  if (!password || password.length < 6) throw new GameError(400, 'Password must be at least 6 characters.');

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) throw new GameError(409, 'This email is already registered.');

  const hash = bcrypt.hashSync(password, 10);
  const insertUser = db.prepare(
    'INSERT INTO users (email, pass_hash, gold, diamonds, level, xp, ranking_score) VALUES (?,?,?,?,?,?,?)'
  );
  const tx = db.transaction(() => {
    const info = insertUser.run(email, hash, STARTING.gold, STARTING.diamonds, 1, 0, 0);
    const uid = info.lastInsertRowid;
    db.prepare('INSERT INTO heroes (user_id, name, level, xp, attack_mod, defense_mod) VALUES (?,?,?,?,?,?)').run(
      uid,
      STARTING.heroName,
      1,
      0,
      0,
      0
    );
    db.prepare('INSERT INTO soldiers (user_id, type, count, attack, defense, knowledge) VALUES (?,?,?,?,?,?)').run(
      uid,
      'swordsman',
      STARTING.army,
      SOLDIERS.swordsman.attack,
      SOLDIERS.swordsman.defense,
      0
    );
    db.prepare('INSERT INTO training_points (user_id, points, last_update) VALUES (?,?,?)').run(
      uid,
      STARTING.trainingPoints,
      Math.floor(Date.now() / 1000)
    );
    db.prepare('INSERT INTO transactions (user_id, kind, delta_gold, delta_diamonds, note) VALUES (?,?,?,?,?)').run(
      uid,
      'signup',
      STARTING.gold,
      0,
      'Signup gift'
    );
    return uid;
  });
  const uid = tx();
  return { id: uid, email };
}

function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) throw new GameError(401, 'Wrong email or password.');
  const ok = bcrypt.compareSync(String(password || ''), user.pass_hash);
  if (!ok) throw new GameError(401, 'Wrong email or password.');
  return user;
}

// Express middleware: requires an authenticated session.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Please log in first.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Account not found.' });
  }
  req.user = user;
  next();
}

// Lightweight profile serializer used by routes.
function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    gold: u.gold,
    diamonds: u.diamonds,
    level: u.level,
    xp: u.xp,
    ranking_score: u.ranking_score,
    prize_points: u.prize_points,
    wins: u.wins,
    losses: u.losses,
  };
}

module.exports = { register, login, requireAuth, publicUser };
