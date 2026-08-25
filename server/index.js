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

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// session store: MemoryStore is fine for v1 single-process dev.
// (W2/W3 can swap in a persistent store if needed.)
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'gorz-reborn-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
  })
);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', routes);

// ---- Socket.IO bootstrap ----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

// W2: attach battle handlers here, e.g. io.on('connection', ...)
// The namespace is reserved for live battle updates.
io.on('connection', (socket) => {
  socket.emit('hello', { game: 'gorz-reborn', msg: 'به گرز نو خوش آمدید' });
});

server.listen(PORT, () => {
  console.log(`گرز نو (Gorz Reborn) running on http://localhost:${PORT}`);
});

module.exports = { app, server, io, db };
