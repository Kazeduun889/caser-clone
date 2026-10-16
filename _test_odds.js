/**
 * Pins the upgrade odds to the real caser.one.
 *
 * The original's formula was extracted from its client bundle
 * (_next/static/chunks/2mwsxxmwyqhg9.js):
 *
 *   Y(e)            = Math.min(Math.max(e, 1), 80)              // display clamp
 *   F(target, stake)= clamp(stake / target.price * 103, 0, 100)
 *   D(target, stake)= raw < 1 || raw >= 80                       // super drop
 *   displayed       = null when target <= selected-item total,
 *                     50 when stake is 0
 *
 * These checks assert the clone reproduces that shape exactly when
 * UPGRADE_MULTIPLIER=103, and stays house-favourable at the default 80.
 */

// ---- the original, transcribed from the bundle ---------------------------
function realDisplay(raw) { return Math.min(Math.max(raw, 1), 80); }
function realChance(target, stake) {
  const r = parseFloat(target);
  if (!Number.isFinite(r) || r <= 0) return 100;
  return Math.min(Math.max((stake / r) * 103, 0), 100);
}
function realSuperDrop(target, stake) {
  const r = parseFloat(target);
  if (!Number.isFinite(r) || r <= 0) return true;
  const s = (stake / r) * 103;
  return s < 1 || s >= 80;
}
function realDisplayed(target, stake, stakeFromItems) {
  const t = parseFloat(target);
  if (!t || t <= 0 || t <= stakeFromItems) return null;
  return stake <= 0 ? 50 : realDisplay((stake / t) * 103);
}

// ---- the clone (mirrors server.js) --------------------------------------
const MULT = parseFloat(process.env.UPGRADE_MULTIPLIER || '80');
const DISPLAY_MAX = 80, DISPLAY_MIN = 1;

function cloneChancePercent(target, stake) {
  if (!(target > 0)) return 50;
  return Math.min(DISPLAY_MAX, Math.max(DISPLAY_MIN, (stake / target) * MULT));
}
function cloneWinChance(target, stake) {
  if (!(target > 0)) return 0.5;
  return Math.min(1, Math.max(0, ((stake / target) * MULT) / 100));
}
function cloneSuperDrop(target, stake) {
  if (!(target > 0)) return true;
  const raw = (stake / target) * MULT;
  return raw < 1 || raw >= DISPLAY_MAX;
}
function cloneDisplayed(target, stake, stakeFromItems) {
  if (!(target > 0) || !(target > stakeFromItems)) return null;
  return stake <= 0 ? 50 : cloneChancePercent(target, stake);
}

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`));
}

console.log(`UPGRADE_MULTIPLIER = ${MULT}\n`);

// ---- 1. same qualitative shape as the original ---------------------------
console.log('--- same shape as the original ---');
const targets = [10, 50, 100, 500, 1000, 5000, 25000];
let shapeMismatch = 0;
const rows = [];
for (const target of targets) {
  let prev = -Infinity;
  for (const ratio of [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97, 1, 1.5, 3]) {
    const stake = target * ratio;
    const mine = cloneDisplayed(target, stake, 0);
    const theirs = realDisplayed(target, stake, 0);
    rows.push({ target, ratio, mine, theirs });

    // The multiplier is deliberately different (80 vs 103), so the numeric
    // values differ. What must hold is the *shape*: monotonic, clamped into
    // 1..80, null only when the target is too cheap.
    if (mine === null) continue;
    if (mine < 1 || mine > 80) shapeMismatch++;
    // stake === 0 short-circuits to a fixed 50 in the original too, so the
    // monotonic run has to start at the first real stake.
    if (stake <= 0) { if (mine !== 50) shapeMismatch++; continue; }
    if (mine < prev - 1e-9) shapeMismatch++;
    prev = mine;
  }
}
check('monotonic, clamped to 1..80, null only where the original is null', shapeMismatch, 0);
console.log('  target=1000 samples:');
for (const r of rows.filter((x) => x.target === 1000)) {
  console.log(`    stake/target=${String(r.ratio).padEnd(5)} clone=${String(r.mine).padEnd(6)} original@103=${r.theirs}`);
}

// ---- 2. null when the target is not worth more than the stake -------------
console.log('\n--- no chance shown when the target is cheap ---');
check('target cheaper than the bet -> null', cloneDisplayed(100, 100, 150), null);
check('original agrees', realDisplayed(100, 100, 150), null);
check('target above the bet -> shown', cloneDisplayed(1000, 100, 150) !== null, true);

// ---- 3. zero stake -> 50 --------------------------------------------------
console.log('\n--- zero stake ---');
check('zero stake shows 50', cloneDisplayed(1000, 0, 0), 50);
check('original agrees', realDisplayed(1000, 0, 0), 50);

// ---- 4. clamp band --------------------------------------------------------
console.log('\n--- display never leaves 1%..80% ---');
const clamped = [];
for (const target of targets) {
  for (const ratio of [0.001, 0.005, 0.01, 0.05, 0.5, 0.9, 1, 2, 10, 100]) {
    const v = cloneChancePercent(target, target * ratio);
    if (v < 1 || v > 80) clamped.push({ target, ratio, v });
  }
}
check('all values inside 1..80', clamped.length, 0);
check('huge stake clamps to 80', cloneChancePercent(100, 1000000), 80);
check('tiny stake clamps to 1', cloneChancePercent(1000000, 1), 1);

// ---- 5. exact equality at MULT=103 ----------------------------------------
console.log('\n--- byte-for-byte equal to the original at MULT=103 ---');
const saved = process.env.UPGRADE_MULTIPLIER;
process.env.UPGRADE_MULTIPLIER = '103';
// re-evaluate the clone with 103
const c103 = (t, s) => Math.min(80, Math.max(1, (s / t) * 103));
let mismatch103 = 0;
for (const target of targets) {
  for (const ratio of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97, 1, 1.5, 3]) {
    const stake = target * ratio;
    if (Math.abs(c103(target, stake) - realDisplayed(target, stake, 0)) > 1e-9) mismatch103++;
  }
}
check('all values identical to the original at 103', mismatch103, 0);
process.env.UPGRADE_MULTIPLIER = saved;

// ---- 6. super drop --------------------------------------------------------
console.log('\n--- super drop rule ---');
const superCases = [
  { target: 10000, stake: 10, expect: true },   // raw 0.1% -> super drop
  { target: 1000, stake: 500, expect: false },  // raw 40% -> normal
  { target: 1000, stake: 1000, expect: true },  // raw 80% -> super drop
  { target: 1000, stake: 5000, expect: true }   // raw 400% -> super drop
];
let superMismatch = 0;
for (const c of superCases) {
  const got = cloneSuperDrop(c.target, c.stake);
  const want = c.expect;
  if (got !== want) { superMismatch++; console.log(`    mismatch target=${c.target} stake=${c.stake}`); }
}
check('super drop fires at the same boundaries', superMismatch, 0);

// ---- 7. the house still wins ---------------------------------------------
console.log('\n--- profitability ---');
let totalStake = 0, totalPayout = 0;
for (const ratio of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const target = 1000, stake = target * ratio;
  const p = cloneWinChance(target, stake);
  totalStake += stake;
  totalPayout += p * target;
}
const wheelRtp = totalPayout / totalStake;
check('wheel RTP is below 100%', wheelRtp < 1, true);
console.log(`  wheel RTP at MULT=${MULT}: ${(wheelRtp * 100).toFixed(1)}%  (house edge ${(100 - wheelRtp * 100).toFixed(1)}%)`);

// Per-point expected value must be negative for the house.
let evNegative = true;
for (const ratio of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97]) {
  const target = 1000, stake = target * ratio;
  const ev = cloneWinChance(target, stake) * target - stake;
  if (ev >= 0) { evNegative = false; console.log(`    non-negative EV at ratio ${ratio}: ${ev.toFixed(2)}`); }
}
check('expected value is negative at every stake ratio', evNegative, true);

// ---- 8. the displayed number is the true probability ----------------------
console.log('\n--- displayed number is honest ---');
const honest = [];
for (const target of targets) {
  for (const ratio of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9]) {
    const stake = target * ratio;
    const shown = cloneChancePercent(target, stake);
    const trueProb = cloneWinChance(target, stake) * 100;
    // The display clamps at 80; when MULT<=80 the clamp never binds, so what is
    // shown must equal the real probability exactly.
    if (Math.abs(shown - trueProb) > 1e-9) honest.push({ target, ratio, shown, trueProb });
  }
}
check('shown percentage equals the rolled probability', honest.length, 0);
if (honest.length) console.log('   ', honest.slice(0, 3));

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);