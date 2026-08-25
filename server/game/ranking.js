'use strict';
// ============================================================
// Gorz Reborn — ranking.js
// Commander ranking score (wins-weighted) + global leaderboard.
// DESIGN-v1.md §4.8 / §6.10: leaderboard updates after battles.
// ============================================================
const { db } = require('../db');
const { BATTLE, RAFFLE } = require('./balance');

// Apply a ranking delta to a user after a battle.
// winner: 1 => win, -1 => loss, 0 => draw.
// Wins/losses counters + prize points (1 per victory) also update.
function applyBattleResult(userId, outcome) {
  const deltas = {
    win: { score: BATTLE.ranking.win, wins: 1, losses: 0, prize: RAFFLE.prizePointsPerWin },
    lose: { score: BATTLE.ranking.lose, wins: 0, losses: 1, prize: 0 },
    draw: { score: BATTLE.ranking.draw, wins: 0, losses: 0, prize: 0 },
  };
  const d = deltas[outcome];
  if (!d) throw new Error(`unknown battle outcome: ${outcome}`);

  // Losses apply from 0 so fresh players actually see ranking move.
  // (No artificial floor at 0 — a loss is -5; wins are +20.)
  db.prepare(
    'UPDATE users SET ranking_score = ranking_score + ?, wins = wins + ?, losses = losses + ?, prize_points = prize_points + ? WHERE id = ?'
  ).run(d.score, d.wins, d.losses, d.prize, userId);

  return db.prepare('SELECT id, email, level, xp, ranking_score, wins, losses, prize_points FROM users WHERE id = ?').get(userId);
}

// Global leaderboard: wins-weighted ranking score, ties broken by level.
function leaderboard({ limit = 50 } = {}) {
  const rows = db
    .prepare(
      `SELECT id, email, level, xp, ranking_score, wins, losses, prize_points
       FROM users
       ORDER BY ranking_score DESC, level DESC, wins DESC, id ASC
       LIMIT ?`
    )
    .all(Math.min(Math.max(1, Number(limit) || 50), 200));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

module.exports = { applyBattleResult, leaderboard };
