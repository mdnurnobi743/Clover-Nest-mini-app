// lib/constants.js — shared constants used across api/*.js and lib/*.js.
//
// RECONSTRUCTED FILE: this file was missing from the project (referenced by
// almost every endpoint but never actually present in this snapshot — the
// root cause of the FUNCTION_INVOCATION_FAILED errors on every API route).
// Numeric values below were reverse-engineered from their *_DISPLAY mirrors
// in index.html (search for "mirrors lib/constants.js") and from the inline
// comments in api/*.js that reference them. Double-check these against your
// intended game economy and adjust as needed — nothing here is fetched from
// a live source, they're just plain exported constants.

// ── Bangladesh-local "today" — used for daily task-reset bookkeeping ──
export function todayBD() {
    // en-CA gives YYYY-MM-DD directly, which sorts/compares correctly as a string.
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

// Fields reset once per Bangladesh-day (lib/dailyReset.js)
export function dailyResetFields() {
    return {
        tasksCompletedToday: 0,
        usedTaskStarts: [],
        spinsRemaining: DAILY_FREE_SPINS, // ⚠️ NEW — Spin Wheel daily allowance refill
        lastResetDate: todayBD(),
    };
}

// ── Spin Wheel (api/spin.js / index.html renderSpinTab) ──────────────────
// Every user gets this many free spins per Bangladesh-day (lib/dailyReset.js
// refills it back to this number at midnight BD time). Landing on the
// "+1 SPIN" segment credits one spin back instead of consuming one.
export const DAILY_FREE_SPINS = 15;

// The 8 wedges of the wheel, in clockwise order starting from the wedge
// under the pointer at 0°/top. index.html's SPIN_SEGMENTS_UI mirrors this
// array 1:1 (same order, same ids) purely for rendering — the server is the
// only place a reward is ever decided or credited.
//
//   type 'cn'   → credits a FIXED amount of CN (min === max here — kept as
//                 a min/max pair rather than a single `amount` field so
//                 api/spin.js's existing randomInt(min, max+1) draw logic
//                 doesn't need to change; with min===max it always returns
//                 that exact number)
//   type 'usd'  → credits a fixed USD amount, converted to CN via
//                 WTC_PER_USD below.
//
// ⚠️ UPDATED — reward table replaced per request. 8 slots, weights are
// parts-per-100 and MUST sum to exactly 100 (enforced by the assertion
// below): 10 CN 60%, 20 CN 10%, 30 CN 10%, $0.001 10%, 50 CN 3%,
// $0.005 3%, 70 CN 3%, 100 CN 1%.
export const SPIN_SEGMENTS = [
    { id: 'cn_10',    type: 'cn',  label: '10 CN',  min: 10,  max: 10,  weight: 60 },
    { id: 'cn_20',    type: 'cn',  label: '20 CN',  min: 20,  max: 20,  weight: 10 },
    { id: 'cn_30',    type: 'cn',  label: '30 CN',  min: 30,  max: 30,  weight: 10 },
    { id: 'usd_001',  type: 'usd', label: '$0.001', usdAmount: 0.001, weight: 10 },
    { id: 'cn_50',    type: 'cn',  label: '50 CN',  min: 50,  max: 50,  weight: 3 },
    { id: 'usd_005',  type: 'usd', label: '$0.005', usdAmount: 0.005, weight: 3 },
    { id: 'cn_70',    type: 'cn',  label: '70 CN',  min: 70,  max: 70,  weight: 3 },
    { id: 'cn_100',   type: 'cn',  label: '100 CN', min: 100, max: 100, weight: 1 },
];
{
    const totalWeight = SPIN_SEGMENTS.reduce((sum, s) => sum + s.weight, 0);
    if (Math.abs(totalWeight - 100) > 1e-9) {
        throw new Error(`SPIN_SEGMENTS weights must sum to 100, got ${totalWeight}`);
    }
}

// ── Referral signup velocity guard (api/user.js handleInit) ──
// Flags (does NOT auto-block) a referrer whose referrals are signing up
// faster than any real promotion plausibly would.
export const REFERRAL_VELOCITY_WINDOW_MS = 2 * 60 * 1000; // 2-minute rolling window
export const REFERRAL_VELOCITY_THRESHOLD = 10;             // 10+ signups inside that window

// ── Weekly referral contest (api/bot.js a_weekly / api/data.js weeklyContest) ──
export const WEEKLY_REFERRAL_MIN_COUNT = 5;   // minimum weekly referrals to qualify
export const WEEKLY_REFERRAL_MAX_WINNERS = 10; // top N shown/snapshotted

// ── Task claim anti-bot delay (api/earn.js handleTaskComplete) ──
// Matches index.html's 10s "🎁 Claim in Ns" countdown on the task-claim UI.
export const TASK_MIN_WAIT_SECONDS = 10;

// ── Economy conversion rate — mirrors index.html's WTC_PER_USD_DISPLAY ──
export const WTC_PER_USD = 25000; // 25,000 WTC == 1 USDT

// ── Referral withdrawal commission (api/bot.js finalizeWithdrawal) ──
// Referrer earns this % of every withdrawal their referral makes, forever
// (see index.html's "+10% of everything they withdraw, forever").
export const WITHDRAW_REFERRAL_COMMISSION_PERCENT = 10;

// ── Withdrawals / Convert (api/withdraw.js) — mirrors index.html's *_DISPLAY consts ──
export const WITHDRAWALS_OPEN = true;
export const MIN_WITHDRAW_WTC = 500;                // minimum amount a user can convert
export const WITHDRAW_TASKS_REQUIRED = 8;          // lifetime completed tasks required before first withdraw
export const WITHDRAW_FEE_PERCENT = 10;             // single convert fee taken on every withdrawal
export const WITHDRAW_SECOND_FEE_PERCENT = 0;       // no second fee — kept at 0 so the math below stays a no-op
export const FIRST_WITHDRAW_MAX_WTC = 5000;         // cap on the one free first-withdrawal
export const WITHDRAW_VALID_REFERRALS_PER_WITHDRAW = 1; // "valid" referrals spent per withdraw after the first

// ── Convert CN → USDT (api/convert.js) ── moves CN out of wtcBalance into
// the user's in-app usdtBalance ledger (NOT an external payout — Withdraw
// above still pays out straight from wtcBalance and is untouched by this).
// Per request: same minimum + same fee as the existing Withdraw setup.
export const MIN_CONVERT_WTC = MIN_WITHDRAW_WTC;     // 500 CN, same as Withdraw
export const CONVERT_FEE_PERCENT = WITHDRAW_FEE_PERCENT; // 10%, same as Withdraw

// Both payout methods pay out in USDT at the same WTC_PER_USD rate — mirrors
// index.html's WITHDRAW_METHODS_UI (binance / tonkeeper).
const wtcToCurrency = (wtc) => wtc / WTC_PER_USD;
export const WITHDRAW_METHODS = {
    binance: {
        label: 'Binance UID',
        currency: 'USDT',
        wtcToCurrency,
    },
    tonkeeper: {
        label: 'Tonkeeper Address',
        currency: 'USDT',
        wtcToCurrency,
    },
};
