# Gorz Reborn (گرز نو)

**Status:** 🔨 In progress (kanban pipeline W1→W2→W3)
**Last updated:** 2026-08-25

## What is this?
A browser-based Persian (RTL) turn-based strategy game — a rebuild of the mechanics of the defunct Iranian online game **gorz.ir (گرز)** by Ewalk Studio (2011–2025, 110K+ users). Original game shut down; source is proprietary and not public. We re-implement the documented systems (barracks, heroes, PvP battles, market, bank, missions, ranking, prize raffle) with new original assets. For personal use by capit.

## Tech stack
Node.js + Express + Socket.IO + SQLite (better-sqlite3) · vanilla JS frontend · Vazirmatn font · Persian RTL.

## Key features
- Commander registration/login (bcrypt sessions)
- Barracks: soldier training (swordsman/archer/cavalry), training points, knowledge caps
- Heroes: XP, leveling, battle modifiers
- Turn-based PvP battles with live battle log (Socket.IO), matchmaking by level
- Market: trade listings with 5% fee
- Bank: gold + diamonds ledger
- Missions: 10+ seeded with rewards
- Global commander ranking
- Monthly prize raffle (gold-only in v1)

## Structure
- `docs/DESIGN-v1.md` — authoritative design spec (mechanics from archived gorz.ir wiki + tech + acceptance criteria + file ownership map)
- `server/` — Express app: index.js, db.js, auth.js, game/{heroes,barracks,battles,market,bank,missions,ranking}.js, balance.js, routes.js
- `public/` — landing (index.html), dashboard (app.html), css/app.css, js/{app,battle}.js, fonts/
- `archive/` — reference material pulled from Wayback Machine (wiki dumps, screenshots)
- `PROJECT.md` — this brief

## Commands
- install: `npm install`
- run: `npm start` → http://localhost:3000
- test: `npm test` (scripted E2E: register → train → battle → mission → market)

## Progress log
- 2026-08-25 — Research done: gorz.ir fully mapped (game systems, tech stack, wiki manual, 510 Wayback captures). Verdict: no public source; rebuild feasible. Kanban board `gorz-reborn` created; spec `docs/DESIGN-v1.md` written from archived docs. Pipeline: W1 backend → W2 battle/realtime → W3 frontend → ROOT verify.
- 2026-08-25 — W1 backend core DONE: server/ (index.js, db.js, auth.js, routes.js, game/{balance,heroes,barracks,bank,market,missions,errors}.js), package.json, 9 SQLite tables, 12 Persian missions, admin seed (admin@gorz.ir / gorz1234). Battle stubs in routes.js for W2. E2E (npm test, 24 checks) green: register→train→mission→market→bank. Server boots :3000 zero errors.
- 2026-08-25 — W2 battle engine + realtime DONE: server/game/battles.js (matchmaking via open challenges + close-level fresh match, turn-based combat engine with rout/draw, battle power formula, rewards gold/XP/knowledge, battle persistence with log_json), server/game/ranking.js (wins-weighted score, leaderboard), routes.js battle/ranking sections (enter/open/status/history/ranking), socket.io wiring in index.js (per-user + per-battle rooms, session-auth, battle:join/leave/enter, live battle:finished to both players), public/js/battle.js (battle UI: enter, result render, turn log, history, socket live updates). E2E extended to 48 checks including two-user battle → winner → ranking delta (+20/-5) → socket events for both players. Server boots :3000 zero errors.
- 2026-08-25 — W3 frontend + RTL theme DONE: public/index.html (Persian landing: گرز نو title, register/login tabs, dark fantasy hero), public/app.html (dashboard shell: top nav سربازخانه/قهرمانها/نبرد/بازارچه/بانک/ماموریتها/رتبهبندی + نمای کلی, stats bar, 8 panels), public/css/app.css (tinted-charcoal dark theme, ONE ember/copper accent, semantic status colors, Vazirmatn display + mono numbers, RTL-correct), public/js/app.js (landing auth, nav switching, all panels wired to real API routes, socket battle:finished → stats refresh, toasts, deep-link ?panel=), public/fonts/ (Vazirmatn woff2 4 weights + OFL vendored locally — no runtime CDN). Every panel verified against live API; visual QA in Firefox (landing + all 8 panels, RTL + theme confirmed). E2E 48/48 still green. Committed [W3].

## Next steps
- [x] W2 battle engine + realtime (server/game/battles.js, ranking.js, socket wiring, battle UI)
- [x] W3 frontend + RTL theme (public/**)
- [ ] ROOT: full verification + E2E
