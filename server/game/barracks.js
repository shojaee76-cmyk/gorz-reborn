'use strict';
// ============================================================
// Gorz Reborn — barracks.js
// Soldier training: swordsman/archer/cavalry.
// Training points regenerate over time (cap by level).
// Knowledge caps max trained stat level per knowledge level.
// ============================================================
const { db } = require('../db');
const { SOLDIERS, TRAINING, KNOWLEDGE, PLAYER } = require('./balance');
const { GameError } = require('./errors');
const { adjust } = require('./bank');

const TYPES = Object.keys(SOLDIERS);

function row(userId, type) {
  return db.prepare('SELECT * FROM soldiers WHERE user_id = ? AND type = ?').get(userId, type);
}

function ensureRow(userId, type) {
  let s = row(userId, type);
  if (!s) {
    db.prepare('INSERT INTO soldiers (user_id, type, count, attack, defense, knowledge) VALUES (?,?,?,?,?,?)').run(
      userId,
      type,
      0,
      SOLDIERS[type].attack,
      SOLDIERS[type].defense,
      0
    );
    s = row(userId, type);
  }
  return s;
}

// --- training points ---
function refreshPoints(userId, level) {
  const tp = db.prepare('SELECT * FROM training_points WHERE user_id = ?').get(userId);
  const now = Math.floor(Date.now() / 1000);
  if (!tp) {
    db.prepare('INSERT INTO training_points (user_id, points, last_update) VALUES (?,?,?)').run(userId, 0, now);
    return { points: 0, last_update: now };
  }
  const cap = TRAINING.baseCap + level * TRAINING.capPerLevel;
  const elapsed = Math.max(0, now - tp.last_update);
  const gained = Math.floor(elapsed / TRAINING.regenIntervalSec);
  if (gained > 0) {
    const points = Math.min(cap, tp.points + gained);
    // keep the remainder of the elapsed interval so time isn't lost
    const last_update = now - (elapsed % TRAINING.regenIntervalSec);
    db.prepare('UPDATE training_points SET points = ?, last_update = ? WHERE user_id = ?').run(points, last_update, userId);
    return { points, last_update };
  }
  return { points: tp.points, last_update: tp.last_update };
}

function spendPoints(userId, amount, level) {
  const { points } = refreshPoints(userId, level);
  if (points < amount) throw new GameError(400, 'امتیاز آموزش کافی ندارید.');
  db.prepare('UPDATE training_points SET points = points - ?, last_update = ? WHERE user_id = ?').run(
    amount,
    Math.floor(Date.now() / 1000),
    userId
  );
}

// --- knowledge levels ---
function knowledgeLevel(knowledgeXp) {
  return Math.min(KNOWLEDGE.maxLevel, Math.floor(knowledgeXp / KNOWLEDGE.xpPerLevel));
}

// Max trained stat level allowed at a given knowledge level.
function maxStatLevel(knowledgeLvl) {
  const caps = KNOWLEDGE.maxKnowledgePerLevel;
  // A brand-new soldier (knowledge 0) may still train to stat level 1.
  return Math.max(1, caps[knowledgeLvl] ?? 0);
}

// Stat level of a soldier row: base + trained points per stat.
function statLevel(soldier, stat) {
  const base = SOLDIERS[soldier.type][stat];
  return Math.floor((soldier[stat] - base) / 1);
}

// --- training ---
// Train `stat` ('attack' or 'defense') for `count` units.
// Cost: gold + training points per unit per point of stat.
function train(userId, type, stat, count) {
  if (!TYPES.includes(type)) throw new GameError(400, 'نوع سرباز نامعتبر است.');
  if (!['attack', 'defense'].includes(stat)) throw new GameError(400, 'آمار نامعتبر است.');
  count = Math.floor(Number(count) || 0);
  if (count <= 0) throw new GameError(400, 'تعداد باید بیشتر از صفر باشد.');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const s = ensureRow(userId, type);
  const spec = SOLDIERS[type];
  const kLvl = knowledgeLevel(s.knowledge);
  const cap = maxStatLevel(kLvl);
  const curLevel = statLevel(s, stat);
  if (curLevel >= cap) {
    throw new GameError(400, `سطح دانش کافی نیست؛ حداکثر آموزش در دانش ${kLvl} تا سطح ${cap} است.`);
  }

  const unitCostGold = spec.trainCostGold;
  const unitCostPoints = spec.trainCostPoints;
  const totalGold = unitCostGold * count;
  const totalPoints = unitCostPoints * count;

  // cap count so we don't overshoot the knowledge cap
  const maxCount = (cap - curLevel) * Math.max(1, s.count || 1);
  const affordable = Math.max(1, maxCount);
  if (count > affordable) count = affordable;

  const tx = db.transaction(() => {
    // charge gold first (bank validates balance)
    adjust(userId, { gold: -totalGold, kind: 'train', note: `آموزش ${count} ${spec.name} (${stat})` });
    spendPoints(userId, totalPoints, user.level);
    db.prepare(
      `UPDATE soldiers SET ${stat} = ${stat} + ? WHERE user_id = ? AND type = ?`
    ).run(count, userId, type);
    return row(userId, type);
  });

  return tx();
}

// Recruit more soldiers of a type (gold-only; units get base stats).
function recruit(userId, type, count) {
  if (!TYPES.includes(type)) throw new GameError(400, 'نوع سرباز نامعتبر است.');
  count = Math.floor(Number(count) || 0);
  if (count <= 0) throw new GameError(400, 'تعداد باید بیشتر از صفر باشد.');

  const spec = SOLDIERS[type];
  const costPer = Math.round(spec.trainCostGold * 4); // recruiting is costlier than training a point
  const total = costPer * count;

  adjust(userId, { gold: -total, kind: 'recruit', note: `سربازگیری ${count} ${spec.name}` });
  const s = ensureRow(userId, type);
  db.prepare('UPDATE soldiers SET count = count + ? WHERE user_id = ? AND type = ?').run(count, userId, type);
  return row(userId, type);
}

// Add knowledge XP to a soldier group (from battles).
function addKnowledge(userId, type, amount) {
  const s = ensureRow(userId, type);
  const kLvlBefore = knowledgeLevel(s.knowledge);
  const knowledge = Math.min(s.knowledge + Math.max(0, Math.floor(amount)), KNOWLEDGE.maxLevel * KNOWLEDGE.xpPerLevel);
  db.prepare('UPDATE soldiers SET knowledge = ? WHERE user_id = ? AND type = ?').run(knowledge, userId, type);
  const kLvlAfter = knowledgeLevel(knowledge);
  return { type, knowledge, levelBefore: kLvlBefore, levelAfter: kLvlAfter };
}

function army(userId) {
  const rows = db.prepare('SELECT * FROM soldiers WHERE user_id = ?').all(userId);
  return TYPES.map((t) => {
    const r = rows.find((x) => x.type === t) || { type: t, count: 0, attack: SOLDIERS[t].attack, defense: SOLDIERS[t].defense, knowledge: 0 };
    return { ...r, knowledge_level: knowledgeLevel(r.knowledge) };
  });
}

module.exports = {
  TYPES,
  train,
  recruit,
  addKnowledge,
  army,
  row,
  ensureRow,
  refreshPoints,
  knowledgeLevel,
  maxStatLevel,
  statLevel,
};
