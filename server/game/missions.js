'use strict';
// ============================================================
// Gorz Reborn — missions.js
// Mission definitions, progress tracking, completion + rewards.
// Mission types: train, battle, win, level, market, gold.
// ============================================================
const { db } = require('../db');
const { MISSIONS, PLAYER } = require('./balance');
const { GameError } = require('./errors');
const { adjust } = require('./bank');

function allMissions() {
  return db.prepare('SELECT * FROM missions ORDER BY id').all();
}

// Accept a mission (or lazily attach all missions to the user).
function accept(userId, missionId) {
  const m = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  if (!m) throw new GameError(404, 'Mission not found.');
  const active = db.prepare('SELECT COUNT(*) AS n FROM user_missions WHERE user_id = ? AND done = 0').get(userId).n;
  if (active >= MISSIONS.dailyLimit) throw new GameError(400, 'You have reached the maximum number of active missions.');
  db.prepare('INSERT OR IGNORE INTO user_missions (user_id, mission_id, progress, done) VALUES (?,?,?,?)').run(
    userId,
    missionId,
    0,
    0
  );
  return db.prepare('SELECT * FROM user_missions WHERE user_id = ? AND mission_id = ?').get(userId, missionId);
}

// Sync a user's mission list (attach all seeded missions lazily).
function syncUserMissions(userId) {
  db.prepare('INSERT OR IGNORE INTO user_missions (user_id, mission_id, progress, done) SELECT ?, id, 0, 0 FROM missions').run(userId);
  return userMissions(userId);
}

function userMissions(userId) {
  const rows = db.prepare(
    `SELECT um.*, m.id AS mission_id, m.title, m.description, m.type, m.target, m.reward_gold, m.reward_xp, m.reward_diamonds
     FROM user_missions um JOIN missions m ON m.id = um.mission_id
     WHERE um.user_id = ? ORDER BY m.id`
  ).all(userId);
  return rows;
}

// Compute current progress for a mission from live state.
function computeProgress(userId, m) {
  switch (m.type) {
    case 'train': {
      const n = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND kind = ?').get(userId, 'train').n;
      return n;
    }
    case 'battle': {
      const n = db.prepare('SELECT COUNT(*) AS n FROM battles WHERE (attacker_id = ? OR defender_id = ?) AND state = ?').get(userId, userId, 'finished').n;
      return n;
    }
    case 'win': {
      const n = db.prepare('SELECT COUNT(*) AS n FROM battles WHERE winner_id = ? AND state = ?').get(userId, 'finished').n;
      return n;
    }
    case 'level': {
      const u = db.prepare('SELECT level FROM users WHERE id = ?').get(userId);
      return u.level;
    }
    case 'market': {
      const n = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND kind = ?').get(userId, 'sell').n;
      return n;
    }
    case 'gold': {
      const u = db.prepare('SELECT gold FROM users WHERE id = ?').get(userId);
      return u.gold;
    }
    default:
      return 0;
  }
}

// Refresh progress for all of a user's active missions; auto-complete
// those whose progress reached target. Returns list of completed missions.
function refresh(userId) {
  const completed = [];
  const rows = db.prepare('SELECT * FROM user_missions WHERE user_id = ? AND done = 0').all(userId);
  for (const um of rows) {
    const m = db.prepare('SELECT * FROM missions WHERE id = ?').get(um.mission_id);
    if (!m) continue;
    const progress = Math.min(m.target, computeProgress(userId, m));
    db.prepare('UPDATE user_missions SET progress = ? WHERE user_id = ? AND mission_id = ?').run(progress, userId, m.id);
    if (progress >= m.target) {
      db.prepare('UPDATE user_missions SET done = 1 WHERE user_id = ? AND mission_id = ?').run(userId, m.id);
      completed.push({ mission: m, progress });
    }
  }
  return completed;
}

// Claim rewards for a completed mission. Safe against double-claim.
function claim(userId, missionId) {
  // Refresh progress first so freshly-completed missions can be claimed.
  refresh(userId);
  const um = db.prepare('SELECT * FROM user_missions WHERE user_id = ? AND mission_id = ?').get(userId, missionId);
  if (!um) throw new GameError(404, 'Mission not found.');
  if (!um.done) throw new GameError(400, 'This mission is not completed yet.');

  const m = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  const claimed = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND kind = ? AND note = ?').get(
    userId,
    'mission_reward',
    `Mission: ${m.title}`
  ).n;
  if (claimed > 0) throw new GameError(400, 'This mission reward has already been claimed.');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  adjust(userId, {
    gold: m.reward_gold,
    diamonds: m.reward_diamonds,
    kind: 'mission_reward',
    note: `Mission: ${m.title}`,
  });

  // grant commander XP (+ level-up handling)
  const newXp = user.xp + m.reward_xp;
  let level = user.level;
  let levelUps = 0;
  let remaining = newXp;
  while (level < PLAYER.maxLevel && remaining >= level * PLAYER.xpPerLevel) {
    remaining -= level * PLAYER.xpPerLevel;
    level += 1;
    levelUps += 1;
  }
  if (level >= PLAYER.maxLevel) remaining = 0;
  db.prepare('UPDATE users SET xp = ?, level = ? WHERE id = ?').run(remaining, level, userId);
  if (levelUps > 0) {
    adjust(userId, {
      gold: levelUps * PLAYER.levelUpGold,
      diamonds: levelUps * PLAYER.levelUpDiamonds,
      kind: 'levelup',
      note: `Commander leveled up to ${level}`,
    });
  }

  return { mission: m, level, xp: remaining, levelUps };
}

module.exports = { allMissions, accept, syncUserMissions, userMissions, refresh, claim, computeProgress };
