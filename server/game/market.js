'use strict';
// ============================================================
// Gorz Reborn — market.js
// Trade listings: sell soldiers or diamonds for gold; buy them.
// 5% transaction fee on sales (fee taken from seller's proceeds).
// ============================================================
const { db } = require('../db');
const { MARKET, SOLDIERS } = require('./balance');
const { GameError } = require('./errors');
const { adjust } = require('./bank');
const barracks = require('./barracks');

const ITEM_TYPES = ['swordsman', 'archer', 'cavalry', 'diamond'];

function validateItem(itemType) {
  if (!ITEM_TYPES.includes(itemType)) throw new GameError(400, 'نوع کالا نامعتبر است.');
}

// --- listings ---
function createListing(userId, itemType, qty, priceGold) {
  validateItem(itemType);
  qty = Math.floor(Number(qty) || 0);
  priceGold = Math.floor(Number(priceGold) || 0);
  if (qty <= 0) throw new GameError(400, 'تعداد باید بیشتر از صفر باشد.');
  if (priceGold <= 0) throw new GameError(400, 'قیمت باید بیشتر از صفر باشد.');

  const count = db.prepare('SELECT COUNT(*) AS n FROM market_listings WHERE seller_id = ?').get(userId).n;
  if (count >= MARKET.maxListingsPerUser) throw new GameError(400, 'به حداکثر تعداد آگهی رسیده‌اید.');

  const tx = db.transaction(() => {
    if (itemType === 'diamond') {
      adjust(userId, { diamonds: -qty, kind: 'list', note: `ثبت آگهی ${qty} الماس` });
    } else {
      const s = barracks.row(userId, itemType);
      if (!s || s.count < qty) throw new GameError(400, 'تعداد سرباز کافی ندارید.');
      db.prepare('UPDATE soldiers SET count = count - ? WHERE user_id = ? AND type = ?').run(qty, userId, itemType);
    }
    const info = db
      .prepare('INSERT INTO market_listings (seller_id, item_type, item_id, qty, price_gold) VALUES (?,?,?,?,?)')
      .run(userId, itemType, null, qty, priceGold);
    return db.prepare('SELECT * FROM market_listings WHERE id = ?').get(info.lastInsertRowid);
  });
  return tx();
}

function listListings(userId, { type, mineOnly } = {}) {
  let rows;
  if (mineOnly) {
    rows = db.prepare('SELECT * FROM market_listings WHERE seller_id = ? ORDER BY id DESC').all(userId);
  } else {
    rows = db.prepare('SELECT * FROM market_listings WHERE seller_id != ? ORDER BY id DESC').all(userId);
  }
  if (type) rows = rows.filter((r) => r.item_type === type);
  return rows.map((r) => ({
    ...r,
    seller_email: db.prepare('SELECT email FROM users WHERE id = ?').get(r.seller_id)?.email || null,
  }));
}

function cancelListing(userId, listingId) {
  const tx = db.transaction(() => {
    const l = db.prepare('SELECT * FROM market_listings WHERE id = ?').get(listingId);
    if (!l) throw new GameError(404, 'آگهی یافت نشد.');
    if (l.seller_id !== userId) throw new GameError(403, 'این آگهی متعلق به شما نیست.');
    if (l.item_type === 'diamond') {
      adjust(userId, { diamonds: l.qty, kind: 'cancel_listing', note: 'بازگشت الماس از آگهی لغو شده' });
    } else {
      const s = barracks.ensureRow(userId, l.item_type);
      db.prepare('UPDATE soldiers SET count = count + ? WHERE user_id = ? AND type = ?').run(l.qty, userId, l.item_type);
    }
    db.prepare('DELETE FROM market_listings WHERE id = ?').run(listingId);
    return l;
  });
  return tx();
}

// Buy a listing. Buyer pays price_gold; seller receives
// price_gold * (1 - feePercent/100). Fee goes to the void (system).
function buyListing(userId, listingId) {
  const tx = db.transaction(() => {
    const l = db.prepare('SELECT * FROM market_listings WHERE id = ?').get(listingId);
    if (!l) throw new GameError(404, 'آگهی یافت نشد.');
    if (l.seller_id === userId) throw new GameError(400, 'نمی‌توانید آگهی خودتان را بخرید.');

    adjust(userId, { gold: -l.price_gold, kind: 'buy', note: `خرید ${l.qty} ${l.item_type}` });

    if (l.item_type === 'diamond') {
      adjust(userId, { diamonds: l.qty, kind: 'buy_diamond', note: `خرید ${l.qty} الماس از بازار` });
    } else {
      const s = barracks.ensureRow(userId, l.item_type);
      db.prepare('UPDATE soldiers SET count = count + ? WHERE user_id = ? AND type = ?').run(l.qty, userId, l.item_type);
    }

    const fee = Math.floor((l.price_gold * MARKET.feePercent) / 100);
    const sellerProceeds = l.price_gold - fee;
    adjust(l.seller_id, { gold: sellerProceeds, kind: 'sell', note: `فروش ${l.qty} ${l.item_type} (کسر ۵٪ کارمزد)` });

    db.prepare('DELETE FROM market_listings WHERE id = ?').run(listingId);
    return { sold: l, proceeds: sellerProceeds, fee };
  });
  return tx();
}

module.exports = {
  createListing,
  listListings,
  cancelListing,
  buyListing,
  ITEM_TYPES,
};
