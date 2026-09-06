'use strict';
// ============================================================
// Gorz Reborn — balance.js
// ALL game balance constants live here in ONE file.
// W2 (battle engine) MUST read battle power inputs from here.
// ============================================================

const STARTING = {
  gold: 1000,
  diamonds: 100,
  army: 100, // starting swordsmen
  heroName: 'Gorz', // default first hero name
  trainingPoints: 20, // starting training points (new player can train immediately)
};

// ----- Soldier types (v1) ------------------------------------
// Base stats per unit. Training raises attack/defense;
// knowledge level adds a multiplier (see KNOWLEDGE).
const SOLDIERS = {
  swordsman: {
    name: 'Swordsman',
    attack: 10,
    defense: 8,
    speed: 5,
    trainCostGold: 5, // per point of stat gain
    trainCostPoints: 2, // training points per stat point
  },
  archer: {
    name: 'Archer',
    attack: 8,
    defense: 5,
    speed: 8,
    trainCostGold: 7,
    trainCostPoints: 2,
  },
  cavalry: {
    name: 'Cavalry',
    attack: 12,
    defense: 7,
    speed: 12,
    trainCostGold: 10,
    trainCostPoints: 3,
  },
};

// ----- Training points ----------------------------------------
// Points regenerate +1 every REGEN_SECONDS, capped at level cap.
const TRAINING = {
  regenIntervalSec: 10 * 60, // +1 per 10 minutes
  baseCap: 50,
  capPerLevel: 10, // cap = baseCap + level * capPerLevel
};

// ----- Knowledge ------------------------------------------------
// Soldiers gain knowledge in battles; each level multiplies stats.
// "Max knowledge per level" caps training (original fixes 1395-04-01).
const KNOWLEDGE = {
  xpPerLevel: 100, // knowledge XP to gain one knowledge level
  maxLevel: 10,
  perLevelMult: 0.1, // +10% attack/defense per knowledge level
  maxKnowledgePerLevel: {
    // knowledge level -> max trained soldier level (stat level)
    1: 3,
    2: 5,
    3: 8,
    4: 12,
    5: 18,
    6: 25,
    7: 35,
    8: 50,
    9: 75,
    10: 100,
  },
};

// ----- Heroes --------------------------------------------------
const HERO = {
  xpPerLevel: 250, // XP required per hero level (linear v1)
  maxLevel: 60,
  attackModPerLevel: 0.02, // +2% attack per hero level
  defenseModPerLevel: 0.02, // +2% defense per hero level
  levelUpDiamonds: 5, // diamonds granted on hero level-up
};

// ----- Commander (player) --------------------------------------
const PLAYER = {
  xpPerLevel: 500, // commander XP per level (missions/battles)
  levelUpGold: 200, // gold granted on commander level-up
  levelUpDiamonds: 10, // diamonds granted on commander level-up
  maxLevel: 100,
};

// ----- Battle power formula (W2 uses these) ---------------------
// power = Σ (soldier.attack * soldierCount * (1 + knowledgeMult))
//         * heroMult * terrainMod
const BATTLE = {
  baseDefenseFactor: 1.0, // defender gets no bonus in v1 (flat)
  maxTurns: 30, // battle ends in draw after N turns
  routThreshold: 0.25, // side routs when below 25% of starting power
  reward: {
    winGold: 150,
    winXp: 100,
    winKnowledge: 50, // knowledge XP to each surviving soldier group
    loseGold: 40,
    loseXp: 25,
    drawGold: 60,
    drawXp: 40,
  },
  ranking: {
    win: +20,
    lose: -5,
    draw: 0,
  },
  terrain: {
    plain: 1.0,
    forest: 0.9, // archers favored (for W2)
    mountain: 1.1,
  },
};

// ----- Tactical battle system (interactive grid combat) ---------
// All knobs for tactics.js live here.
const TACTICS = {
  gridW: 21,
  gridH: 15,
  squadSize: 25,        // soldiers per squad
  maxSquadsPerSide: 4,  // v3: commander + 3 lieutenants
  maxRounds: 30,        // hard round cap -> points decision/draw
  orderTimerSec: Number(process.env.GORZ_ORDER_TIMER_SEC) || 45, // per-round order window before AI kicks in

  // --- v3 map: real terrain rules (DESIGN-v3 §1.2) -------------------
  // Generation is deterministic + point-symmetric (server/game/mapgen.js);
  // the old forestChance/hillChance scatter is retired.
  forestChance: 0,      // retired: v3 forests come from mapgen, not noise
  hillChance: 0,        // retired: v3 hills come from mapgen, not noise
  terrainCfg: {         // per-tile rules; mapgen.TERRAIN_RULES mirrors this
    plain:    { cost: 1, defBonus: 0,    atkBonus: 0,    charge: true,  passable: true },
    hill:     { cost: 1, defBonus: 0,    atkBonus: 0.15, charge: true,  passable: true },
    forest:   { cost: 1, defBonus: 0.35, atkBonus: 0,    charge: false, passable: true },
    jungle:   { cost: 2, defBonus: 0.5,  atkBonus: 0,    charge: false, passable: true },
    water:    { cost: Infinity, defBonus: 0, atkBonus: 0, charge: false, passable: false },
    bridge:   { cost: 1, defBonus: 0,    atkBonus: 0,    charge: true,  passable: true },
    mountain: { cost: Infinity, defBonus: 0, atkBonus: 0, charge: false, passable: false },
    castle:   { cost: 1, defBonus: 0.4,  atkBonus: 0,    charge: false, passable: true },
  },
  jungleDefBonus: 0.5,  // +50% defense in dense jungle
  jungleCost: 2,        // jungle costs 2 MP per tile (thick canopy)
  castleDefBonus: 0.4,  // +40% defense for a squad ON a castle it owns
  siegeRoundsToWin: 3,  // hold BOTH neutral keeps this many consecutive rounds -> siege win
  castlePoints: 100,    // score per owned castle at round cap
  powerPoints: 1000,    // surviving power fraction scaled by this at round cap

  // landmarks (v2 legacy scatter — unused by v3 mapgen, kept for
  // backwards compat with persisted v2 battle states)
  lakeCount: 0,
  mountainCount: 0,
  ruinsCount: 0,
  keepCount: 0,         // v3 keeps come from mapgen castles
  keepDefBonus: 0.40,   // +40% defense while holding a keep
  keepHoldAtkBonus: 0.15, // keep garrison also hits a bit harder
  keepCaptureRadius: 0, // must stand ON the keep tile to capture

  // terrain effects
  forestDefBonus: 0.35,   // +35% defense in forest
  hillAtkBonus: 0.15,     // +15% attack from a hill
  holdDefBonus: 0.30,     // 'hold' stance: +30% defense, no movement
  assaultAtkBonus: 0.20,  // 'assault' stance: +20% attack...
  assaultDefPenalty: 0.20,// ...but -20% defense
  chargeMult: 1.6,        // cavalry charge after moving 2+ cells
  focusBonus: 0.2,        // +20% volley when archers focus-fire
  rangedAdjacentMult: 0.5,// archers shoot at half power when engaged
  knowledgePerLevel: 0.1, // +10% atk/def per soldier knowledge level

  // combat math: kills = atkScore*K/(defScore+C), jittered ±15%
  // K tuned so even matchups trade ~10-15% strength per round -> fights
  // last a satisfying 6-12 rounds where orders decide the outcome.
  killK: 2.6,
  killC: 40,
  counterMelee: 0.5,       // defender counters at 50% power
  counterAdjacentRanged: 0.3,

  // morale
  moraleHitPerFraction: 120, // losing 100% of squad = 120 morale dmg
  routMoraleThreshold: 30,   // below this, squads risk routing each round
  routChancePerPoint: 0.02,  // (threshold - morale) * 0.02 chance/round

  // outcome
  routThreshold: 0.35,  // side below 35% starting power collapses
  decisiveRatio: 1.25,  // round-cap: winner needs >= 1.25x loser's power

  // unit battlefield stats (per-soldier HP + movement/range/role)
  units: {
    swordsman: { unitHp: 30, mp: 1, range: 1, role: 'melee' },
    archer: { unitHp: 18, mp: 1, range: 3, role: 'ranged' },
    cavalry: { unitHp: 26, mp: 2, range: 1, role: 'melee' },
  },

  recruitCostGold: 20, // gold to add one soldier via /battle/recruit
};

// ----- Market ---------------------------------------------------
const MARKET = {
  feePercent: 5, // 5% transaction fee
  maxListingsPerUser: 20,
};

// ----- Missions -------------------------------------------------
const MISSIONS = {
  dailyLimit: 10, // max missions a user can have accepted at once
};

// ----- Prize raffle (v1 simplified) ------------------------------
const RAFFLE = {
  prizePointsPerWin: 1, // 1 victory = 1 prize point (1 chance)
  cycleDays: 30,
  prizeGold: 5000,
};

module.exports = {
  STARTING,
  SOLDIERS,
  TRAINING,
  KNOWLEDGE,
  HERO,
  PLAYER,
  BATTLE,
  TACTICS,
  MARKET,
  MISSIONS,
  RAFFLE,
};
