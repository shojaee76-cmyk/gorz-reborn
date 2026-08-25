# Gorz Reborn — Design Spec (v1)

**Authoritative reference for the Gorz Reborn rebuild.**
Read this FIRST. It is the single source of truth for game mechanics, tech stack, file layout, and acceptance criteria. Derived from the archived gorz.ir game manual (Wayback Machine, DokuWiki raw exports, 2016–2023 captures) + live site pages (rules/prize/howto/ads).

---

## 1. What we are building

A browser-based, Persian (RTL) turn-based strategy game — a faithful **rebuild of the mechanics** of the defunct Iranian game **gorz.ir (Gorz, گرز)**, which ran 2011–2025 and shut down. We are NOT copying assets (they are proprietary); we are re-implementing the documented game systems with new original assets.

Genre: persistent browser strategy (Travian/Ogame-like) with a turn-based PvP battle engine.

## 2. Original game systems (from archived gorz.ir docs) — the spec of record

From `/page/howto`, `/page/rules`, `/page/prize`, `/page/fixes`, and the DokuWiki manual (`/wiki/_export/raw/...`):

- **Registration & onboarding**: free signup → new player gets 1 hero + an army (لشگر) + starting gold + diamonds (الماس). An in-game guide hero walks the player through the first steps.
- **Goal**: progress through levels, battle other commanders, win battles, climb the global commander ranking (رتبه).
- **Missions & XP**: completing missions grants experience, gold, and prizes. XP raises level; higher level unlocks more activities/features.
- **Barracks (سربازخانه)**: train soldiers. Training costs training points. Each soldier/hero has stats; stats level up via "knowledge" (دانش) gained in battles. Max knowledge per level caps training (documented in fixes 1395-04-01).
- **Heroes (قهرمان‌ها)**: each commander has heroes; they gain XP in battle and level up.
- **Battles (نبرد)**: core loop — attack/defend vs other commanders. `/game/conquest/index/<id>` (battle IDs up to 500k+ → battle numbers grow over time). Battles matched by level/XP/timing ("most suitable battle for you").
- **Bank (بانک)**: gold + premium currency (diamonds) — monetization layer.
- **Market (بازارچه)**: trading hub between players.
- **Prize system (جایزه)**: monthly raffle — commanders earn prize points (1 point = 1 chance); real cash prizes to winners; documented anti-fraud rules (no collusion, winners checked for violations).
- **Ranks**: global commander leaderboard.
- **Tech of original**: custom PHP MVC (`/game/<module>/<action>/<id>` routing), jQuery, custom theme, Yekan font, DokuWiki manual, IP.Board forum.

## 3. Our tech stack

- **Backend**: Node.js + Express + Socket.IO (real-time for battles) + SQLite (better-sqlite3). Chosen over PHP for dev speed and zero-config local run.
- **Frontend**: vanilla JS + a single-page dashboard layout, Persian RTL. No heavy framework (keeps it simple, fast, easy to verify in a browser). Socket.IO for live battle updates.
- **Fonts**: bundle Vazirmatn (open-source Persian font, OFL) — original used Yekan; Vazirmatn is the modern equivalent and legally safe.
- **Structure** (top level):
  ```
  gorz-reborn/
    package.json
    server/
      index.js            # entry: express + socket.io + sqlite init
      db.js               # better-sqlite3 schema + seed
      auth.js             # session cookie (express-session) + bcrypt
      game/
        heroes.js         # hero model, XP, leveling
        barracks.js       # soldier training, knowledge caps
        battles.js        # battle engine (turn-based PvP)
        market.js         # trade listings
        bank.js           # gold + diamonds ledger
        missions.js       # mission definitions + rewards
        ranking.js        # commander leaderboard
      routes.js           # HTTP routes
    public/
      index.html          # landing + register/login
      app.html            # in-game dashboard (RTL)
      css/app.css         # dark fantasy theme
      js/app.js           # dashboard logic + sockets
      js/battle.js        # battle UI (live turns)
      fonts/              # Vazirmatn woff2
    docs/                 # spec + archive notes
    archive/              # pulled reference assets (images/wiki dumps)
    PROJECT.md
  ```
- **Auth**: email + password, bcrypt hashed; session cookie; one account per email.

## 4. Game mechanics to implement (v1 scope)

### 4.1 Commander (player)
- Registers → gets: 1 hero, starting army (e.g. 100 swordsmen), 1,000 gold, 100 diamonds.
- XP/level from missions + battles; level gates features.

### 4.2 Barracks & training
- Soldier types (v1): swordsman, archer, cavalry. Each has attack/defense/speed.
- Training: spend training points + gold to raise stats; points regenerate over time (e.g. +1 per 10 min, cap by level).
- Knowledge: soldiers gain battle knowledge; level up at thresholds (max knowledge per level).

### 4.3 Heroes
- Hero: name, level, XP, attack/defense modifiers. Levels via XP from battles.
- Hero leads the army into battle (modifier applied to army power).

### 4.4 Battles (turn-based PvP)
- Player clicks "ورود به نبرد" (enter battle) → matchmaking picks a suitable opponent (close in level).
- Turn-based combat: each turn, both sides' units attack; casualties computed; battle ends when one side routs (or N turns max → draw).
- Battle log rendered turn by turn (live via Socket.IO).
- Rewards: gold, XP, knowledge; win/loss affects ranking score.
- Battle power formula (v1 simple): `power = Σ units.attack * count * heroMult * terrainMod` — balance constants live in a single `game/balance.js`.

### 4.5 Market
- List resources/units for sale with price in gold; buy/sell; 5% transaction fee.

### 4.6 Bank & diamonds
- Gold earned in battles/missions. Diamonds = premium currency (v1: awarded for level-ups + missions only, no real-money purchase yet).
- Diamonds can buy: instant training, battle boosts, cosmetic hero titles.

### 4.7 Missions
- 10+ seeded missions (defeat N battles, train N soldiers, reach level N, etc.) with gold/XP/diamond rewards.

### 4.8 Ranking
- Global leaderboard by ranking score (wins-weighted), shown on dashboard + public page.

### 4.9 Prize raffle (v1 simplified)
- Monthly cycle: players accumulate prize points (1 per victory); at cycle end, weighted raffle among eligible; winner announced + gold reward. (No real-money prizes in v1 — gold-only.)

## 5. UI (Persian RTL, dark fantasy theme)

- Landing page: game title "گرز نو" (Gorz Reborn), register/login forms, Persian.
- In-game dashboard: top nav (سربازخانه, قهرمان‌ها, نبرد, بازارچه, بانک, ماموریت‌ها, رتبه‌بندی), player stats bar (gold/diamonds/level), content panels.
- Battle screen: two armies facing, turn log, live updates.
- All user-facing strings Persian; code identifiers English.
- Theme: dark, tinted-charcoal, ONE brand accent (ember/copper), semantic status colors, distinctive display font (Vazirmatn) + mono for numbers.

## 6. Acceptance criteria (root verification)

1. `npm install && npm start` boots server on port 3000 with zero errors.
2. Landing page loads; register/login works; sessions persist.
3. New player seeded with hero + army + gold + diamonds.
4. Barracks: train soldiers, training points regenerate, knowledge caps enforced.
5. Hero: gains XP/levels from battles.
6. Battle: matchmaking finds opponent, turn-based combat runs, battle log displays, rewards granted, ranking updated.
7. Market: listing + buy/sell works with fee.
8. Bank: gold/diamond ledger visible and correct.
9. Missions: complete → rewards granted.
10. Ranking: leaderboard updates after battles.
11. All UI text Persian; RTL layout correct; page has no broken assets.
12. `PROJECT.md` updated with status + progress log; commit history shows one prefixed commit per worker.
13. Manual smoke: `curl localhost:3000/` returns 200; a scripted E2E (node test) exercises register → train → battle → mission → market.

## 7. Data model (SQLite tables)

- `users` (id, email, pass_hash, gold, diamonds, level, xp, ranking_score, created_at)
- `heroes` (id, user_id, name, level, xp, attack_mod, defense_mod)
- `soldiers` (id, user_id, type, count, attack, defense, knowledge)
- `training_points` (user_id, points, last_update) — or inline on users
- `missions` (id, title_fa, desc_fa, type, target, reward_gold, reward_xp, reward_diamonds)
- `user_missions` (user_id, mission_id, progress, done)
- `battles` (id, attacker_id, defender_id, state, log_json, winner_id, created_at, ended_at)
- `market_listings` (id, seller_id, item_type, item_id, qty, price_gold, created_at)
- `transactions` (id, user_id, kind, delta_gold, delta_diamonds, note, created_at)

## 8. Worker file ownership map (IMPORTANT — do not touch other workers' files)

- **W1 (backend core)**: `server/**` (all server JS), `package.json`, `db schema + seed`. Owns: auth, game models, routes, balance.js.
- **W2 (battle + realtime)**: `server/game/battles.js`, `server/game/ranking.js`, `server/routes.js` (battle/ranking sections ONLY), socket wiring in `server/index.js`, `public/js/battle.js`. Depends on W1's models/routes.
- **W3 (frontend + polish)**: `public/**` (HTML/CSS/JS except `public/js/battle.js`), fonts, RTL layout, theme. Depends on W1+W2.
- **Root**: verifies everything; may touch docs/PROJECT.md only.

Sequential chain: W1 → W2 → W3 (shared files require ordering).

## 9. Rejected/first-round feedback (carry into all worker bodies)

- No warm-craft beige palettes; no multi-accent theme systems. ONE brand accent on cool near-white/dark charcoal neutrals.
- Persian text is required and must be properly RTL (no mixed-direction layout bugs).
- Zero-friction: game must run with `npm install && npm start` — no extra setup steps.
- Do NOT stop at first render — iterate until the UI genuinely looks good.
