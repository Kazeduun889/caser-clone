'use strict';

/**
 * Operation Chicken Farm - the 50-level reward track.
 *
 * The real event is a separate battle pass on chicken.caser.one; this is the
 * same idea sized for our catalogue: 50 levels, a reward on every level, and
 * every item is a cheap one that already exists in `cases_cache`.
 *
 * The track is generated from the catalogue at boot instead of being typed out
 * by hand, so the pictures and prices always match the cases the site really
 * sells. Levels that pay balance are fixed; every other level gets a skin,
 * climbing from ~10 to ~500.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = 50;

// Levels that pay money instead of an item. Kept deliberately small: coins are
// the cheapest reward to hand out and they let the track breathe between skins.
const BALANCE_LEVELS = {
  2: 5,
  5: 10,
  9: 15,
  13: 20,
  18: 25,
  23: 30,
  27: 35,
  33: 40,
  39: 50,
  45: 60
};

const RARITY_COLORS = {
  1: '#B0C3D9', 2: '#4B69FF', 3: '#8847FF', 4: '#EB4B4B', 5: '#D32CE6',
  6: '#D32CE6', 7: '#EB4B4B', 8: '#4B69FF', 9: '#8847FF', 10: '#EB4B4B',
  11: '#FFAE39', 12: '#D32CE6', 13: '#B0C3D9', 14: '#5E98D9', 15: '#4B69FF',
  16: '#8847FF'
};

/**
 * XP needed to go from `level` to `level + 1`.
 * 60, 72, 84 ... 636 -> 17 052 XP for the whole track.
 * Case opens and upgrades both give 1 XP per unit of money spent.
 */
function xpForLevel(level) {
  return 48 + 12 * Math.max(1, Number(level) || 1);
}

/** Resolves raw XP into the current level and the progress inside it. */
function levelFromXp(xp) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 1;
  let acc = 0;
  while (level < LEVELS && total >= acc + xpForLevel(level)) {
    acc += xpForLevel(level);
    level += 1;
  }
  return {
    level,
    into: total - acc,
    need: level < LEVELS ? xpForLevel(level) : 0,
    total
  };
}

function colorFor(item) {
  if (!item) return '#B0C3D9';
  if (String(item.marketName || '').includes('\u2605')) return '#FFAE39';
  const numeric = Number(item.rarity);
  if (Number.isFinite(numeric) && RARITY_COLORS[numeric]) return RARITY_COLORS[numeric];
  return '#B0C3D9';
}

/** Every unique skin in the case cache that is cheap enough for the track. */
function loadCatalogue() {
  const dir = process.env.CASES_CACHE_DIR || path.join(__dirname, 'cases_cache');
  const byName = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      continue;
    }
    for (const raw of Array.isArray(data.items) ? data.items : []) {
      if (!raw || !raw.image || !raw.marketName) continue;
      const name = String(raw.marketName);
      // Only real skins: stickers, charms and music kits are cheap but they
      // look like filler on a battle-pass card.
      if (!name.includes('|')) continue;
      if (/^(Sticker|Charm|Music Kit|Graffiti|Patch|Sealed Graffiti)\b/i.test(name)) continue;
      const price = parseFloat(raw.price);
      if (!Number.isFinite(price) || price <= 0 || price > 900) continue;
      const prev = byName.get(name);
      if (!prev || prev.price > price) {
        byName.set(name, {
          id: String(raw.id || ''),
          appId: raw.appId ?? 730,
          marketName: name,
          name,
          price,
          image: raw.image,
          weapon: raw.weapon ?? null,
          skin: raw.skin ?? null,
          exterior: raw.exterior ?? null,
          stattrak: raw.stattrak ?? false,
          type: raw.type ?? null,
          rarity: raw.rarity != null ? String(raw.rarity) : null
        });
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.price - b.price);
}

function buildRewards() {
  const pool = loadCatalogue();
  const used = new Set();
  const rewards = [];

  const itemLevels = LEVELS - Object.keys(BALANCE_LEVELS).length;
  let itemSlot = 0;

  for (let level = 1; level <= LEVELS; level += 1) {
    if (BALANCE_LEVELS[level]) {
      rewards.push({
        level,
        type: 'balance',
        amount: BALANCE_LEVELS[level],
        title: 'На баланс',
        value: '+' + BALANCE_LEVELS[level] + ' \u20BD',
        color: '#FFC24B'
      });
      continue;
    }

    // Exponential curve: the first cards are ~10, the last one ~500.
    const t = itemLevels > 1 ? itemSlot / (itemLevels - 1) : 0;
    const target = 10 * Math.pow(50, t);

    let pick = null;
    let bestDelta = Infinity;
    for (const item of pool) {
      if (used.has(item.marketName)) continue;
      const delta = Math.abs(item.price - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        pick = item;
      }
    }
    if (!pick && pool.length) pick = pool[pool.length - 1];

    itemSlot += 1;
    if (!pick) {
      rewards.push({
        level,
        type: 'balance',
        amount: 10,
        title: 'На баланс',
        value: '+10 \u20BD',
        color: '#FFC24B'
      });
      continue;
    }

    used.add(pick.marketName);
    rewards.push({
      level,
      type: 'item',
      title: 'Предмет',
      value: pick.marketName,
      color: colorFor(pick),
      item: pick
    });
  }

  return rewards;
}

const REWARDS = buildRewards();
const BY_LEVEL = new Map(REWARDS.map((reward) => [reward.level, reward]));

function getReward(level) {
  return BY_LEVEL.get(Number(level)) || null;
}

module.exports = {
  LEVELS,
  REWARDS,
  getReward,
  xpForLevel,
  levelFromXp
};
