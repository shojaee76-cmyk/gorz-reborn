# Gorz Reborn — DESIGN v3: "The Four Castles"

Authoritative spec for the battle revamp. Everything in v3 is built against this
document. v1 (game systems) and v2 (interactive tactics) remain valid underneath;
v3 replaces the map layer, the army structure, the win conditions, and adds the
viewer theater + agent onboarding layer.

## 1. The Map

### 1.1 Geometry
- Grid: **21 wide × 15 tall** (odd × odd → exact center tile for point symmetry).
- **Point symmetry** (180° rotation): tile(x, y) === tile(20−x, 14−y) for every
  terrain cell, castle, and bridge. Guaranteed by construction: the generator
  builds the western half + center column, then mirrors it.
- Deterministic per battle: `seed = battleId` (mulberry32). Same battle → same map,
  forever (verified by hash in tests).

### 1.2 Terrain types and rules (the rule table)

| Terrain        | Enter cost (MP) | Effect                                                                                   | Impassable? |
|----------------|-----------------|------------------------------------------------------------------------------------------|-------------|
| Plain (دشت)    | 1               | Open ground: no modifiers. Cavalry charge works.                                          | no          |
| Hill (تپه)     | 1               | **+15% attack** for the squad on it (high ground). Cavalry charge works.                  | no          |
| Forest (جنگل)  | 1               | **+35% defense**; cavalry charge **impossible** into/out of it.                           | no          |
| Jungle ( moreنگل انبوه) | 2      | **+50% defense**; cavalry charge impossible; each tile costs 2 MP (slow, thick canopy).   | no          |
| Water (آب)     | —               | Lake or river. **Impassable.** Blocks movement, not archer fire.                          | YES         |
| Bridge (پل)    | 1               | The only way across water. Paved: charge **works** on bridges. No defense bonus (exposed).| no          |
| Mountain (کوه) | —               | Rock massif. **Impassable.**                                                              | YES         |
| Castle tile    | 1               | Capturable objective (see §3). Owner's squads on it get **fort bonus**.                   | no          |

Exact numbers live in `balance.js#TACTICS` (`terrainCost`, `terrainDef`, etc.).

### 1.3 Fixed geography (same every battle — mastery is possible)
- **River**: the center column x=10, full height. Splits the field into two
  landmasses. 1 tile wide, rendered with flow animation.
- **Bridges**: 3 bridges across the river at y = 3, 7, 11. Chokepoints: an army
  can only cross here. Bridge guards get no cover but can charge.
- **Lakes**: one 3×2 lake on each side, mirrored (NW area for the west side,
  SE area for the east side). Impassable, shapes the flanking routes.
- **Mountains**: one massif per side, mirrored (SW / NE). Impassable, shapes
  the lanes.
- **Jungle**: two clusters per side, mirrored (one near the north bridge
  approach, one near the south bridge approach). Ambush / defense terrain.
- **Hills**: scattered symmetric pairs, mostly overlooking the bridges and
  castle approaches.
- **Forests**: symmetric filler clusters, breaking sightlines on the lanes.

### 1.4 The Four Castles
| Castle                | Position (x,y) | Start owner | Role |
|-----------------------|----------------|-------------|------|
| West Home (قلعه باختر)| (1, 7)         | side A      | Capital. If enemy holds it at end of a round → **capital falls**, instant loss. |
| East Home (قلعه خاور) | (19, 7)        | side B      | Capital, mirrored. |
| North Keep (دژ شمال)  | (6, 3)         | neutral     | Major objective on the north bridge road. |
| South Keep (دژ جنوب)  | (14, 11)       | neutral     | Major objective on the south bridge road, mirrored. |

All four are real capturable tiles with fort bonuses. The battle revolves around
them: the two neutral keeps gate the bridge crossings, and pushing into the enemy
capital is the aggressive win line.

## 2. Armies: Commander + 3 Lieutenants

Each side fields **exactly 4 squads** (max 4/side in v3 battle mode):
- **1 Commander squad** — the agent's main force. Carries the hero (full hero
  multiplier). Largest corps by genome composition.
- **3 Lieutenant squads** — the agent's "subagents". Each lieutenant is a derived
  brain: a deterministic mutation of the commander genome (offset per lieutenant
  index), exposed in the battle state so an LLM agent can role-play each one with
  its own orders. Lieutenants get a 0.85 aide multiplier (no hero).

Composition mapping from genome: sort corps types by genome share → commander gets
the largest, lieutenants get the remaining three corps (swordsman/archer/cavalry
in share order). Squad sizes proportional to shares. Every agent therefore fields
a named staff: e.g. سپهبد شمشیر (sword lieutenant), سپهبد تیر (bow lieutenant),
سپهبد سوار (horse lieutenant).

## 3. Win conditions (checked in order each round)
1. **Capital falls**: enemy squad ends a round on your home castle tile → that
   side loses immediately ("قلعه سقوط کرد").
2. **Army destroyed**: one side has no unrouted squads.
3. **Both keeps held**: a side owning BOTH neutral keeps for 3 consecutive rounds
   wins by siege ("تسلط بر دژها").
4. **Round cap** (30): higher score wins. Score = castles owned (home=1,
   each neutral keep=2) × 100 + surviving power fraction × 1000. Ties → draw.

## 4. Combat (unchanged core, terrain-aware)
- v2 rules stand: WeGo rounds (orders → movement → simultaneous strikes →
  counters → morale → outcome), focus fire, charges, routs.
- Movement now pays terrain cost (§1.2) per tile stepped. Jungle really is slow.
- Cavalry charge requires: moved ≥2 tiles this round AND no jungle/forest on the
  landing tile AND (target on plain/hill/bridge). Charging across a bridge into
  the bridgehead is THE dramatic play.
- Castle fort bonus: defending squad on a castle tile it owns gets +40% defense;
  attacker on an enemy-owned castle tile does not get it (you are storming it).

## 5. Viewer Theater
- `/watch.html` — full-screen dark-ember theater:
  - Auto-attaches to a live battle (or the most recent one / a replay).
  - Renders the v3 map in detailed SVG: castles with towers + banners that flip
    on capture, animated river, plank bridges, snow-capped mountains, tree
    clusters, wave crests on lakes.
  - Plays each round as drama: movement glides, arrow volleys fly, charges flash
    with impact rings, kill floats, rout banners flee, castle flags flip.
  - HUD: round counter, castle ownership, power bars, live event ticker.
  - Polls + Socket.IO; works for live and archived battles.
- Login page (`/`) gets a **big "تماشای نبرد" (Watch) button** → `/watch.html`.

## 6. Agent onboarding (login page optimized for agents)
- `/` shows an **Agent Quickstart** block: 3 copy-paste curl commands
  (register → duel → tournament) with the local URL, plus a link to the
  machine rulebook.
- `GET /api/agent/rules` returns the **complete rulebook as JSON** (terrain
  table, costs, win conditions, order schema, endpoints, doctrine tips) so an
  LLM can learn the game with zero human help. Human-readable twin:
  `/rulebook.html` + `docs/RULEBOOK.md`.
- Agent registration response includes `rules_url` and `watch_url`.

## 7. Doctrine ("how to think" — taught to agents in the rulebook)
- Bridges are tempo: whoever owns the bridgehead owns the clock.
- Jungle is for swords and bows, never for horses.
- Hills overlooking bridges are worth fighting for (+15% attack).
- Storming the capital ends the game — but leaving your own capital empty is how
  you lose it. Castles bind armies; the map punishes greed.
- Archers should park on hills or in jungle with a bridge in range.
- Cavalry should live in the open center, crossing only to charge or to raid
  the enemy keep road.

## 8. Deliverables & verification
- Engine: `server/game/mapgen.js` (new), `tactics.js` (terrain-aware),
  `balance.js` (v3 knobs), `brain.js` (lieutenants + castle-aware AI).
- Tests: `test/itest-v3.js` — symmetry hash, terrain costs, bridge-only
  crossing, charge-denied-in-forest, castle capture, capital-fall instant loss,
  keep-hold siege win, 4-squads-per-side structure. Legacy 48-check E2E must
  stay green.
- Viewer + login + rulebook pages. README rewrite. GitHub push. Netlify-ready
  (`netlify.toml` + static demo of the map/theater; full game needs Node host).
