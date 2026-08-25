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
  heroName: 'گرز', // default first hero name
  trainingPoints: 20, // starting training points (new player can train immediately)
};

// ----- Soldier types (v1) ------------------------------------
// Base stats per unit. Training raises attack/defense;
// knowledge level adds a multiplier (see KNOWLEDGE).
const SOLDIERS = {
  swordsman: {
    name: 'شمشیرزن',
    attack: 10,
    defense: 8,
    speed: 5,
    trainCostGold: 5, // per point of stat gain
    trainCostPoints: 2, // training points per stat point
  },
  archer: {
    name: 'کمان‌دار',
    attack: 8,
    defense: 5,
    speed: 8,
    trainCostGold: 7,
    trainCostPoints: 2,
  },
  cavalry: {
    name: 'سوار',
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

// ----- Knowledge (دانش) ---------------------------------------
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
  MARKET,
  MISSIONS,
  RAFFLE,
};
