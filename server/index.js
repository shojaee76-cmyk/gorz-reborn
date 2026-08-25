'use strict';
// ============================================================
// Gorz Reborn — index.js
// Express + express-session + static public/ + Socket.IO bootstrap.
// Battle sockets are W2's job; the io instance is exported so W2
// can attach its handlers (server/game/battles.js).
// ============================================================
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { Server } = require('socket.io');

const { db } = require('./db'); // init schema + seed on boot
const routes = require('./routes');
const battles = require('./game/battles');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// session store: MemoryStore is fine for v1 single-process dev.
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'gorz-reborn-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
});
app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', routes);

// ---- Socket.IO bootstrap ----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

// Let the battle engine emit live updates into battle rooms.
battles.setIo(io);

// Share the session with socket.io so we can authenticate the user.
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Battle rooms: a socket joins `user:<id>` (personal) and may join
// `battle:<id>` (live turn events). Emitted events:
//   - battle:joined   { battleId, state }  (battle state for the joining player)
//   - battle:finished { full result }      (from server/game/battles.js)
io.on('connection', (socket) => {
  socket.emit('hello', { game: 'gorz-reborn', msg: 'به گرز نو خوش آمدید' });

  const session = socket.request.session;
  const userId = session && session.userId;

  // Authenticated sockets get their personal room.
  if (userId) {
    socket.join(`user:${userId}`);
  }

  // Client may ask to join a battle room for live updates.
  socket.on('battle:join', (data, ack) => {
    const battleId = Number((data && data.battleId) || NaN);
    if (!Number.isInteger(battleId)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'شناسه نبرد نامعتبر است.' });
      return;
    }
    const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(battleId);
    if (!b || (b.attacker_id !== userId && b.defender_id !== userId)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'شما در این نبرد شرکت ندارید.' });
      return;
    }
    socket.join(`battle:${battleId}`);
    if (typeof ack === 'function') ack({ ok: true, battleId });
    socket.emit('battle:joined', { battleId, state: b.state });
  });

  // Leave a battle room (dashboard navigation).
  socket.on('battle:leave', (data) => {
    const battleId = Number((data && data.battleId) || NaN);
    if (Number.isInteger(battleId)) socket.leave(`battle:${battleId}`);
  });

  // User-level convenience: enter battle directly from socket (same as API).
  socket.on('battle:enter', (data, ack) => {
    try {
      if (!userId) throw new Error('unauthorized');
      const result = battles.enterBattle(userId);
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.faMessage || err.message || 'خطای نبرد.' });
    }
  });
});

// Expire stale open challenges on a timer (they clog matchmaking).
const OPEN_CLEANUP_MS = 60 * 1000;
setInterval(() => {
  try {
    battles.expireStaleOpens();
  } catch (err) {
    console.error('[battles] open-challenge cleanup failed:', err.message);
  }
}, OPEN_CLEANUP_MS).unref();

server.listen(PORT, () => {
  console.log(`گرز نو (Gorz Reborn) running on http://localhost:${PORT}`);
});

module.exports = { app, server, io, db };
