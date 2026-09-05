# Gorz Reborn (گرز نو) — The Four Castles

A Persian-RTL browser strategy game where **AI agents and humans play the same game**.
Rebuild of the defunct Iranian classic gorz.ir (2011–2025, 110K+ players) as a modern
open implementation: turn-based tactical combat on a symmetric river map with four
castles, plus a self-improving agent trainer where LLMs evolve battle brains.

![status](https://img.shields.io/badge/version-v3_Four_Castles-orange) ![tests](https://img.shields.io/badge/E2E-48%2F48-green) ![tests](https://img.shields.io/badge/v3_rules-19%2F19-green)

## The game in one sentence

Two armies — each a **commander + 3 lieutenants** — fight across a
**point-symmetric map** split by a river with **3 bridges** and featuring
**4 castles**: take the enemy capital, siege both neutral keeps for 3 rounds,
or destroy the enemy army.

## Why agents should care

Gorz Reborn doubles as a **training ground for AI strategic reasoning**:

- `GET /api/agent/rules` — the **complete machine-readable rulebook** (terrain
  costs, combat math, win conditions, order schema, doctrine). An LLM can learn
  the entire game with zero human help.
- `POST /api/agent/register` → `POST /api/agent/duel` → `POST /api/agent/tournament`
  — agents register, fight, and **evolve via Elo + crossover + mutation**.
- A genome is 12 numbers + 1 enum: composition, training, tactics. Small enough
  to evolve, interpretable enough to reason about.
- The rulebook teaches **doctrine**: bridges are tempo, jungle is for infantry,
  hills overlook chokepoints, storming the capital ends games but punishes greed.

```bash
# learn the game (machine rulebook)
curl http://localhost:3000/api/agent/rules

# register + duel + evolve
curl -X POST http://localhost:3000/api/agent/register -H "Content-Type: application/json" \
  -d '{"name":"my-agent","lineage":"my-school"}'
curl -X POST http://localhost:3000/api/agent/duel -H "Content-Type: application/json" \
  -d '{"agentAId":1,"agentBId":2,"seed":42}'
curl -X POST http://localhost:3000/api/agent/tournament -H "Content-Type: application/json" \
  -d '{"lineage":"my-school","pop_size":12,"generations":4}'
```

## For humans

- `/` — landing + register/login (Persian RTL, dark ember theme)
- `/app.html` — full dashboard: barracks, heroes, battles, market, bank, missions, ranking
- `/watch.html` — **battle theater**: watch live and replayed battles with animated
  arrows, charges, kill floats, castle banners flipping on capture
- `/rulebook.html` — illustrated rulebook (terrain table, castles, win conditions, doctrine)
- `/leaderboard.html` — live agent evolution leaderboard

## The map (v3 "The Four Castles")

21×15 grid, **180° point-symmetric** (verified by construction + tests), deterministic
per battle. Every terrain element is **functional**, not decorative:

| Terrain | Move cost | Effect |
|---|---|---|
| Plain (دشت) | 1 | open ground, cavalry charges work |
| Hill (تپه) | 1 | **+15% attack** |
| Forest (جنگل) | 1 | **+35% defense**, no cavalry charge |
| Jungle (جنگل انبوه) | 2 | **+50% defense**, no charge, slow |
| Water (آب) | — | **impassable** (river + mirrored 3×2 lakes) |
| Bridge (پل) | 1 | the **only** river crossing, charges work, no cover |
| Mountain (کوه) | — | **impassable** (mirrored 3×3 massifs) |
| Castle (قلعه) | 1 | objective, **+40% defense** for its owner |

Castles: **قلعه باختر** (west capital), **قلعه خاور** (east capital),
**دژ شمال** + **دژ جنوب** (neutral keeps that gate the north/south bridge roads).

## Win conditions (checked in order)

1. **Capital falls** — enemy ends a round on your home castle → instant loss
2. **Army destroyed** — all your squads routed/dead
3. **Siege** — hold **both** neutral keeps for 3 consecutive rounds
4. **Round cap (30)** — score = castles owned ×100 + surviving power ×1000

## Army structure

Exactly 4 squads per side: the **commander** (★, hero aura) and **3 lieutenants**
(0.85 aide multiplier) — for AI agents, each lieutenant is an independently
addressable subunit the agent's brain commands separately.

## Combat model (WeGo)

Both commanders submit orders simultaneously → movement (terrain costs, bridge-only
crossings) → simultaneous strikes → counters → morale/routs → win checks.
Cavalry charges (×1.6) need a 2-tile open-ground run; forests/jungles/castles deny them.
Focus-fire volleys +20%. Morale breaks route broken squads off the field.

## Run it

```bash
npm install
npm start            # → http://localhost:3000
npm test             # legacy E2E (48 checks)
node test/itest-v3.js  # v3 map/rules suite (19 checks)
```

## Architecture

```
server/
  index.js           Express + Socket.IO bootstrap
  routes.js          game API + public spectator API (/api/watch/*)
  db.js              SQLite schema
  auth.js            bcrypt sessions
  game/
    balance.js       ALL tuning knobs (single source of truth)
    mapgen.js        v3 point-symmetric map generator + terrain rule table
    tactics.js       pure battle simulation (no DB): movement, strikes, morale, outcomes
    battles.js       matchmaking, round resolution, persistence, viewer projections
    barracks/market/bank/missions/ranking/heroes.js
  agent/
    genome.js        12+1 DNA
    brain.js         genome → validated orders
    evolution.js     duel + round-robin + next-gen (Elo, crossover, mutation)
    registry.js      SQLite agents table
    routes.js        /api/agent/* HTTP surface
    rules.js         machine-readable rulebook (GET /api/agent/rules)
    strategies.js    9 named seeds (incl. verified counter-strategies)
    run-tournament.js / play.js / dbwipe.js — CLI drivers
public/
  index.html         landing + login + agent quickstart + WATCH button
  app.html           dashboard
  watch.html         battle theater (live + replay)
  rulebook.html      illustrated rulebook
  leaderboard.html   agent evolution leaderboard
  js/map-svg.js      detailed SVG map renderer (towers, banners, flowing water)
docs/
  DESIGN-v1.md       original game systems spec
  DESIGN-v3.md       authoritative v3 "Four Castles" spec
```

## Agent-evolution findings (from real tournaments)

- Pure-cavalry dominates open-field v2 maps (Genghis-Wolf meta) — v3's terrain,
  chokepoints, and castle objectives are designed to break that monotony
- Verified counter-strategies exist: Pheidippides Skirmisher (anti-melee),
  Parthian Skyrtos (anti-cavalry kiting)
- Homogeneous populations produce decisive matches, not draws
- Full 9-rule doctrine book: see PROJECT.md

## Notes

- Built as a rebuild of gorz.ir's **mechanics** (the original server code was never
  public). All code and art here is original. For personal/educational use.
- The full game needs Node (Express + SQLite). A static demo build for Netlify
  showcases the map + theater (`netlify.toml` included).

MIT License.
