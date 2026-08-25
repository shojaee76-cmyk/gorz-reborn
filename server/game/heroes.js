'use strict';
// ============================================================
// Gorz Reborn — heroes.js
// Hero model: creation on registration, XP gain, leveling.
// Hero level applies attack/defense modifiers to the army.
// ============================================================
const { db } = require('../db');
const { HERO, PLAYER } = require('./balance');
const { GameError } = require('./errors');
const { adjust } = require('./bank');

function list(userId) {
  return db.prepare('SELECT * FROM heroes WHERE user_id = ? ORDER BY level DESC, xp DESC').all(userId);
}

function get(userId, heroId) {
  const hero = db.prepare('SELECT * FROM heroes WHERE id = ? AND user_id = ?').get(heroId, userId);
  if (!hero) throw new GameError(404, 'قهرمان یافت نشد.');
  return hero;
}

// Add XP to a hero; handle level-ups (level capped at HERO.maxLevel).
// Diamonds granted per hero level-up.
function addXp(userId, heroId, amount) {
  const hero = get(userId, heroId);
  let xp = hero.xp + Math.max(0, Math.floor(amount));
  let level = hero.level;
  let levelUps = 0;

  while (level < HERO.maxLevel && xp >= level * HERO.xpPerLevel) {
    xp -= level * HERO.xpPerLevel;
    level += 1;
    levelUps += 1;
  }
  if (level >= HERO.maxLevel) xp = 0; // max level: XP stops accumulating

  db.prepare('UPDATE heroes SET xp = ?, level = ? WHERE id = ?').run(xp, level, heroId);
  if (levelUps > 0) {
    // hero level-up bonus (diamonds); also commander xp flows via caller
    adjust(userId, { diamonds: levelUps * HERO.levelUpDiamonds, kind: 'hero_levelup', note: `ارتقای قهرمان به سطح ${level}` });
  }
  return { ...hero, xp, level, levelUps };
}

// Recompute the hero's attack/defense modifiers from level.
function modifier(hero) {
  return {
    attack_mod: +(hero.attack_mod + (hero.level - 1) * HERO.attackModPerLevel).toFixed(4),
    defense_mod: +(hero.defense_mod + (hero.level - 1) * HERO.defenseModPerLevel).toFixed(4),
  };
}

module.exports = { list, get, addXp, modifier };
