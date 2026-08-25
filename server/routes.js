'use strict';
// ============================================================
// Gorz Reborn — routes.js
// HTTP API routes. W2 owns the battle/ranking sections below
// (marked with BATTLE-ROUTES-START / BATTLE-ROUTES-END) and may
// extend the socket wiring in index.js.
// ============================================================
const express = require('express');
const { register, login, requireAuth, publicUser } = require('./auth');
const { db } = require('./db');
const heroes = require('./game/heroes');
const barracks = require('./game/barracks');
const bank = require('./game/bank');
const market = require('./game/market');
const missions = require('./game/missions');
const { GameError } = require('./game/errors');
const { TRAINING } = require('./game/balance');

const router = express.Router();

// Error handler for async route errors (Express 4)
const wrap = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

// ---------------- auth ----------------
router.post('/auth/register', wrap((req, res) => {
  const { email, password } = req.body || {};
  const { id } = register(email, password);
  req.session.userId = id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({ ok: true, user: publicUser(user) });
}));

router.post('/auth/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const user = login(email, password);
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
}));

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

// ---------------- heroes ----------------
router.get('/heroes', requireAuth, (req, res) => {
  const list = heroes.list(req.user.id).map((h) => ({ ...h, ...heroes.modifier(h) }));
  res.json({ ok: true, heroes: list });
});

// ---------------- barracks ----------------
router.get('/barracks', requireAuth, (req, res) => {
  const { points, last_update } = barracks.refreshPoints(req.user.id, req.user.level);
  const cap = TRAINING.baseCap + req.user.level * TRAINING.capPerLevel;
  res.json({ ok: true, army: barracks.army(req.user.id), training_points: points, cap, last_update });
});

router.post('/barracks/train', requireAuth, wrap((req, res) => {
  const { type, stat, count } = req.body || {};
  const row = barracks.train(req.user.id, type, stat, count);
  missions.refresh(req.user.id); // training may complete missions
  res.json({ ok: true, soldier: row });
}));

router.post('/barracks/recruit', requireAuth, wrap((req, res) => {
  const { type, count } = req.body || {};
  const row = barracks.recruit(req.user.id, type, count);
  res.json({ ok: true, soldier: row });
}));

// ---------------- bank ----------------
router.get('/bank/ledger', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json({ ok: true, ledger: bank.ledger(req.user.id, limit) });
});

router.get('/bank/balance', requireAuth, (req, res) => {
  res.json({ ok: true, gold: req.user.gold, diamonds: req.user.diamonds });
});

// ---------------- market ----------------
router.get('/market/listings', requireAuth, (req, res) => {
  const { type, mine } = req.query;
  res.json({ ok: true, listings: market.listListings(req.user.id, { type, mineOnly: mine === '1' }) });
});

router.post('/market/list', requireAuth, wrap((req, res) => {
  const { item_type, qty, price_gold } = req.body || {};
  const listing = market.createListing(req.user.id, item_type, qty, price_gold);
  res.status(201).json({ ok: true, listing });
}));

router.post('/market/cancel', requireAuth, wrap((req, res) => {
  const { listing_id } = req.body || {};
  const l = market.cancelListing(req.user.id, listing_id);
  res.json({ ok: true, listing: l });
}));

router.post('/market/buy', requireAuth, wrap((req, res) => {
  const { listing_id } = req.body || {};
  const result = market.buyListing(req.user.id, listing_id);
  missions.refresh(req.user.id); // buying may complete the market mission
  res.json({ ok: true, ...result });
}));

// ---------------- missions ----------------
router.get('/missions', requireAuth, (req, res) => {
  missions.syncUserMissions(req.user.id);
  res.json({ ok: true, missions: missions.userMissions(req.user.id) });
});

router.post('/missions/accept', requireAuth, wrap((req, res) => {
  const { mission_id } = req.body || {};
  missions.accept(req.user.id, mission_id);
  res.json({ ok: true });
}));

router.post('/missions/refresh', requireAuth, wrap((req, res) => {
  const completed = missions.refresh(req.user.id);
  res.json({ ok: true, completed: completed.map((c) => c.mission) });
}));

router.post('/missions/claim', requireAuth, wrap((req, res) => {
  const { mission_id } = req.body || {};
  const result = missions.claim(req.user.id, mission_id);
  res.json({ ok: true, ...result });
}));

// ---------------- ranking ---------------- (W2)
const battles = require('./game/battles');
const ranking = require('./game/ranking');

// BATTLE-ROUTES-START (W2 owns battle + ranking sections)
// Global commander leaderboard (wins-weighted, close-level tie-break).
router.get('/ranking', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const rows = ranking.leaderboard({ limit });
  res.json({ ok: true, ranking: rows });
});

// Enter battle: matchmaking + full fight in one call (turn-based engine).
router.post('/battle/enter', requireAuth, wrap((req, res) => {
  const result = battles.enterBattle(req.user.id);
  res.json({ ok: true, ...result });
}));

// Open a challenge: wait for another commander to join (state='open').
router.post('/battle/open', requireAuth, wrap((req, res) => {
  const battle = battles.openChallenge(req.user.id);
  res.json({ ok: true, battle });
}));

// Battle state + full log (only participants may view).
router.get('/battle/status/:id', requireAuth, (req, res) => {
  const b = battles.battleStatus(req.params.id, req.user.id);
  res.json({ ok: true, battle: b });
});

// Recent battles involving the current commander.
router.get('/battle/history', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  res.json({ ok: true, battles: battles.battleHistory(req.user.id, limit) });
});
// BATTLE-ROUTES-END

// ---------------- health ----------------
router.get('/health', (req, res) => {
  res.json({ ok: true, name: 'gorz-reborn', status: 'running' });
});

// 404 + error handling
router.use((req, res) => res.status(404).json({ error: 'مسیر یافت نشد.' }));
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof GameError) {
    return res.status(err.status).json({ error: err.faMessage });
  }
  console.error('[routes]', err);
  res.status(500).json({ error: 'خطای داخلی سرور.' });
});

module.exports = router;
