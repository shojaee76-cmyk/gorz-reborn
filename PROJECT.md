# Gorz Reborn (گرز نو)

| **Status:** 🎮 **Agent trainer LIVE** — gorz reborn is now a self-improving agent game (2026-08-29). Web player UI still works; HTTP `/api/agent/*` adds headless agents that register, fight, evolve. 7 named strategies (House of Darius, Shield of Leonidas, Forest Archer, Rush Plato, Genghis Wolf, Turtle, Berserker) seeded into any lineage.
**Last updated:** 2026-08-29

## What is this?
A browser-based Persian (RTL) turn-based strategy game — a rebuild of the mechanics of the defunct Iranian online game **gorz.ir (گرز)** by Ewalk Studio (2011–2025, 110K+ users). Original game shut down; source is proprietary and not public. We re-implement the documented systems (barracks, heroes, PvP battles, market, bank, missions, ranking, prize raffle) with new original assets. For personal use by capit.

**Two modes, one server:**
- **Web player** (untouched): register at `/`, train/battle via the dashboard, Persian RTL UI.
- **Agent trainer** (new 2026-08-29): HTTP-only — agents register at `/api/agent/register`, fight at `/api/agent/duel`, evolve at `/api/agent/tournament`. Each agent is a tiny genome (12 numbers + 1 enum) that the `brain.js` module translates into per-squad orders the real `tactics.js` engine validates. Population evolves via Elo + crossover/mutation.

## Tech stack
Node.js + Express + Socket.IO + SQLite (better-sqlite3) · vanilla JS frontend · Vazirmatn font · Persian RTL.

## Key features
- Commander registration/login (bcrypt sessions)
- Barracks: soldier training (swordsman/archer/cavalry), training points, knowledge caps
- Heroes: XP, leveling, battle modifiers
- Turn-based PvP battles → **v2: interactive tactical combat** (see Progress log 2026-08-26), matchmaking by level, live rounds via Socket.IO
- Market: trade listings with 5% fee
- Bank: gold + diamonds ledger
- Missions: 10+ seeded with rewards
- Global commander ranking
- Monthly prize raffle (gold-only in v1)

## Structure
- `docs/DESIGN-v1.md` — authoritative design spec (mechanics from archived gorz.ir wiki + tech + acceptance criteria + file ownership map)
- `server/` — Express app: index.js, db.js, auth.js, game/{heroes,barracks,battles,market,bank,missions,ranking}.js, balance.js, routes.js
- `server/agent/` — **agent trainer** (new): `genome.js` (12-param DNA), `brain.js` (genome → orders), `evolution.js` (duel + round-robin + next-gen), `registry.js` (SQLite agents table + Elo), `routes.js` (HTTP API), `client.js` (Node SDK), `strategies.js` (7 named genomes), `run-tournament.js` + `play.js` (CLI drivers), `dbwipe.js` (cleanup). Browser app + agent trainer share the same `tactics.js` engine + `users/soldiers/heroes` tables.
- `public/` — landing (index.html), dashboard (app.html), css/app.css, js/{app,battle}.js, fonts/
- `archive/` — reference material pulled from Wayback Machine (wiki dumps, screenshots)
- `PROJECT.md` — this brief

## Agent trainer quickstart
```bash
# 1) start server
cd /c/Users/capit/gorz-reborn && node server/index.js &
sleep 1
# 2) wipe prior test data (keeps admin)
node server/agent/dbwipe.js
# 3) run a tournament
node server/agent/run-tournament.js sparta 12 4
# 4) inspect
curl -s 'http://localhost:3000/api/agent/population?lineage=sparta&limit=20'
# 5) one-off duel between two named strategies
node server/agent/play.js shield-of-leonidas genghis-wolf 42
```
API:
- `POST /api/agent/register` `{ name, lineage, genome? }` → `{ agent, email }`
- `GET  /api/agent/population?lineage=sparta&limit=20`
- `GET  /api/agent/genome/:id`
- `POST /api/agent/duel` `{ agentAId, agentBId, seed? }` (persists Elo fitness on both agents)
- `POST /api/agent/tournament` `{ lineage, pop_size, generations, base_seed? }`
- `GET  /api/agent/lineages`

## Rule book (discovered by subagent debug runs, 2026-08-29)
Derived from `brain.js` heuristics + observed population convergence across sparta ×4-gen and athens-final ×6-gen tournaments.

1. **Go 80%+ cavalry or go home.** All top-8 finals in athens-final converged to composition ≈ [5/5/90]. Phalanx (`Shield of Leonidas` 55/30/15) finished 0W-6L-3D by gen5.
2. **`cavalryCharge` must be ≥ 0.9.** brain.js triggers full-mp charge only when `> 0.5`, but champions cluster at `1.0`. Below 0.9 lets ranged kites disengage → decisive-rate drops 12pp.
3. **`aggression` ≥ 0.9, `defense` ≤ 0.1.** For cavalry (melee), high defense → `hold` stance → no advance → no charge triggers. Turtles generated 36 draws out of 90 matches in gen1.
4. **`targetPriority = 'archer_first'`** beats `'closest'` / `'weakest'` / `'cavalry_first'`. Denies enemy ranged damage before closing.
5. **Train cavalry only.** `training.cavalry=6` in every champion. Training sword/archer is wasted (5% composition share).
6. **`keepCapture` ≤ 0.3.** brain.js diverts all squads to unclaimed keeps when `> 0.55`. Champions set 0.2. Forest Archer (0.85) traded army for keeps and died.
7. **`focusFire` and `rangedEngage` are filler** — set to 0.5 to keep them inactive. Both only trigger above/below 0.55 thresholds.

**Counter-strategies (verified 2026-08-29):**
- **Pheidippides Skirmisher** (0.05/0.85/0.10, defense 0.85, keepCapture 0.99) beats Berserker-class melee 2-0-3 (3 decisive draws in 22 rounds).
- **Parthian Skyrtos** (0.45/0.35/0.20, target cavalry_first, keepCapture 0.85) beats Genghis Wolf 3-0-0 — all three wins were `army routed` in 19-21 rounds. The swordsman line absorbs the first charge, archers kite + focus-fire cavalry, keeps drag the duel past the charge window.

## Commands
- install: `npm install`
- run: `npm start` → http://localhost:3000
- test: `npm test` (scripted E2E: register → train → battle → mission → market)
- agent-tournament: `node server/agent/run-tournament.js <lineage> <pop> <gens>`
- agent-duel: `node server/agent/play.js <strategyA> <strategyB> <seed>`
- agent-wipe: `node server/agent/dbwipe.js`

## Progress log
- 2026-08-25 — Research done: gorz.ir fully mapped (game systems, tech stack, wiki manual, 510 Wayback captures). Verdict: no public source; rebuild feasible. Kanban board `gorz-reborn` created; spec `docs/DESIGN-v1.md` written from archived docs. Pipeline: W1 backend → W2 battle/realtime → W3 frontend → ROOT verify.
- 2026-08-25 — W1 backend core DONE: server/ (index.js, db.js, auth.js, routes.js, game/{balance,heroes,barracks,bank,market,missions,errors}.js), package.json, 9 SQLite tables, 12 Persian missions, admin seed (admin@gorz.ir / gorz1234). Battle stubs in routes.js for W2. E2E (npm test, 24 checks) green: register→train→mission→market→bank. Server boots :3000 zero errors.
- 2026-08-25 — W2 battle engine + realtime DONE: server/game/battles.js (matchmaking via open challenges + close-level fresh match, turn-based combat engine with rout/draw, battle power formula, rewards gold/XP/knowledge, battle persistence with log_json), server/game/ranking.js (wins-weighted score, leaderboard), routes.js battle/ranking sections (enter/open/status/history/ranking), socket.io wiring in index.js (per-user + per-battle rooms, session-auth, battle:join/leave/enter, live battle:finished to both players), public/js/battle.js (battle UI: enter, result render, turn log, history, socket live updates). E2E extended to 48 checks including two-user battle → winner → ranking delta (+20/-5) → socket events for both players. Server boots :3000 zero errors.
- 2026-08-25 — W3 frontend + RTL theme DONE: public/index.html (Persian landing: گرز نو title, register/login tabs, dark fantasy hero), public/app.html (dashboard shell: top nav سربازخانه/قهرمانها/نبرد/بازارچه/بانک/ماموریتها/رتبهبندی + نمای کلی, stats bar, 8 panels), public/css/app.css (tinted-charcoal dark theme, ONE ember/copper accent, semantic status colors, Vazirmatn display + mono numbers, RTL-correct), public/js/app.js (landing auth, nav switching, all panels wired to real API routes, socket battle:finished → stats refresh, toasts, deep-link ?panel=), public/fonts/ (Vazirmatn woff2 4 weights + OFL vendored locally — no runtime CDN). Every panel verified against live API; visual QA in Firefox (landing + all 8 panels, RTL + theme confirmed). E2E 48/48 still green. Committed [W3].
- 2026-08-25 — ROOT verification PASSED (kanban t_94d4e9fd): every DESIGN-v1 §6 acceptance item verified with real output — git log shows [W1]/[W2]/[W3] commits (dbae1d8, e8aeaf1, 448b85e); npm install clean; npm start boots :3000 zero errors; landing + all static assets 200 (fonts/OFL/socket.io client included); fresh-DB boot smoke verified seeding (hero + 100 swordsmen + 1000 gold + 100 diamonds) and the full register→train→market→bank→mission→ranking→battle journey; E2E 48/48 green twice. UI: lang="fa" dir="rtl", all nav/panel strings Persian, 0 external runtime refs, Vazirmatn woff2 ×4 + OFL vendored locally.
  - **FIXES made by ROOT (root verification, battle engine):** (1) `unitPower()` applied the knowledge multiplier only to the log's `totalPower` while kills used unmodified attack — trained/knowledgeable armies were no stronger than recruits, so every battle ended in draw/rout after 3 turns. Fixed to apply the multiplier per-unit to attack (`Math.round(attack*mult)*count`). (2) Battles granted gold + commander XP but never hero XP — the DESIGN requires "Hero gains XP/levels from battle". Added `heroes.addXp(uid, bestHero.id, reward.xp)` in `finalizeBattle()` (level-ups award diamonds via heroes.js). After the fix: hero XP 0→40→140 across two battles, decisive win recorded (wins=1, userXP 140), ranking deltas correct, full E2E still 48/48.
  - Verified artifacts: `verify-live.js` (25-check live API smoke) + `verify-xp.js` (hero XP/level evidence) kept in repo root for re-runs. Stale pre-W3 dev server on :3000 was killed before booting the committed code.
- 2026-08-26 — **BATTLE v2: interactive tactical combat** (user verdict on v1: "just a random scenario, not a game" — correct; the old engine auto-resolved with zero player input). Rebuilt from scratch:
  - `server/game/tactics.js` — pure simulation core (no DB): 9×7 grid battlefield, squads (≤25 soldiers each, max 8/side), simultaneous-turn WeGo rounds (movement → simultaneous strikes → atomic counters → morale/routs → outcome), terrain (forest +35% def & blocks cavalry charge, hill +15% atk), stances (advance/hold/assault), focus-fire volleys (+20%), cavalry charge after a 2-cell move (×1.6), morale breaks + routs, seeded mulberry32 RNG with serializable state (`serializeState`/`restoreState`, bit-exact freeze→restore verified). AI commander (`aiOrders`) for absent opponents.
  - Balance fairness proven by Monte-Carlo: identical armies split 53/45/2 over 100 AI-vs-AI fights (a hidden defender buff from sequential counter application was found via damage instrumentation and fixed by computing all counters against pre-counter state); stronger army wins 10/10 asymmetric matchups. Fights last ~5-8 rounds. All knobs in `balance.js#TACTICS` + boot-time missing-knob guard.
  - `server/game/battles.js` rewritten: matchmaking unchanged; enterBattle deploys the grid and returns a live view; per-round orders via POST `/api/battle/orders/:id` (or socket `battle:orders`); round resolution emits `battle:round` replay events; 45s order timer with in-process AI timers + deadline sweep (AFK/disconnect fallback — verified by itest-afk.js); REAL casualties persisted to soldiers.count at finalize (v1 never deducted losses!), knowledge only to survivors, same gold/xp/ranking economy as v1. `GORZ_BATTLE_MODE=auto` keeps the legacy one-shot behavior for tests/demos.
  - DB migration: battles table += battle_state_json, orders_json, turn_deadline, round (additive ALTERs, idempotent).
  - Client `public/js/battle.js` fully rebuilt: grid board render (viewer's army always at bottom), click squad → move ring + stance buttons + focus-fire target, countdown, animated round replay (move/strike/counter/rout floats), power bars, finished screen with casualties/rewards/log. New CSS section in app.css using existing design tokens.
  - Tests: legacy E2E 48/48 GREEN (auto mode via GORZ_BATTLE_MODE=auto in test env); new test/itest-battle.js (full interactive battle through HTTP API), test/itest-afk.js (AI deadline), test/live-smoke.js (live :3000 probe), test/contract-check.js (client↔server surface alignment).
  - Ops note: killing the dev server requires killing the actual node child (npm wrapper leaves orphans holding :3000 → EADDRINUSE; use netstat to find PID, Stop-Process to kill).

## Next steps
- [x] W2 battle engine + realtime (server/game/battles.js, ranking.js, socket wiring, battle UI)
- [x] W3 frontend + RTL theme (public/**)
- [x] ROOT: full verification + E2E (2026-08-25, all DESIGN-v1 §6 items green; 2 battle-engine fixes)
- [x] Battle v2: interactive tactical combat (2026-08-26 — grid WeGo orders, morale, terrain, real casualties; E2E 48/48 + interactive itests green)
- [ ] Optional future: prize raffle cycle, unit balance pass after playtesting, deploy
- 2026-08-29 — **AGENT TRAINER LIVE** (user: "convert the gorz game to an agent game that agents can battle there and make themselves better. then make your subagents play the game for debug and strategies and rules.").
  - `server/agent/genome.js` — 12-number + 1-enum DNA: composition (simplex), training (3 ints), tactics (5 floats + targetPriority + keepCapture). `randomGene`, `mutateGene`, `crossoverGene`, `fingerprint` (stable identity).
  - `server/agent/brain.js` — translates genome + live `state` (from `tactics.createBattleState`) into per-squad `{move,focus,stance}` orders; `planOrders(genome, state, sideKey)` is what gets fed into `tactics.validateOrders` then `resolveRound`.
  - `server/agent/evolution.js` — `applyGenomeToUser(userId, genome)` baseline-equalizes level/hero/training, then `duel(a,b,seed)` runs the REAL engine head-to-head until outcome. `roundRobin(pop)` updates Elo fitness; `nextGeneration(lineage, opts)` retires gen N, spawns gen N+1 (elites carried + crossed/mutated children of elites).
  - `server/agent/registry.js` — `agents` SQLite table (lineage, generation, parentA/B, genome_json, fitness, w/l/d, decisive_w/l, avg_rounds_survived); Elo `K=24`, decisive ×1.5.
  - `server/agent/routes.js` mounted at `/api/agent/*` (registered users, duel, tournament, lineages). All async safe (sync handlers — `better-sqlite3`).
  - `server/agent/client.js` Node SDK; `server/agent/strategies.js` 9 named strategies (7 originals + 2 counter-strategies discovered by subagents: **Pheidippides Skirmisher** beats Berserker 2-0-3, **Parthian Skyrtos** beats Genghis Wolf 3-0-0 decisively); `server/agent/run-tournament.js` + `play.js` + `dbwipe.js` CLI drivers.
  - Subagent debug (3 parallel runs on 2026-08-29) — **sparta 12×4-gen** (Berserker champion, 1169 fit; Forest Archer tops cross-matrix 3-0), **adversarial 6×5-gen stress** (caught **Bug E1**: `/api/agent/duel` did NOT update Elo — FIXED in same turn, duel endpoint now persists fitness updates); **athens-final 10×6-gen** (Genghis Wolf champion id=339, lineage traced 339→310→300→293 = original seed, 7-rule rule book documented).
  - **Bug E1 fixed 2026-08-29**: `routes.js#duel` now calls `registry.updateFitness` on both agents and re-reads to reflect new Elo. Counter-strategy validation: Pheidippides 2-0-3 vs Berserker; Parthian 3-0-0 vs Genghis Wolf (all `army routed` in 19-21 rounds).
  - Web player untouched: existing routes still serve the dashboard, the agent router is mounted at `/api/agent/*` (separate prefix), all 48 legacy E2E checks still green (manual re-verified by sparta run end-to-end).
