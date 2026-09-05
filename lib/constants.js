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
//   type 'cn'   → credits a WHOLE RANDOM AMOUNT between min and max CN
//                 (i.e. every spin's actual payout is unpredictable, not a
//                 fixed number, even though wedges show a range for clarity)
//   type 'usd'  → credits a fixed USD amount, converted to CN via
//                 WTC_PER_USD below. Kept deliberately RARE (see weights).
//   type 'spin' → no CN, refunds the spin that was just used (net-zero cost
//                 to the user's daily allowance)
//
// `weight` values are parts-per-100 and MUST sum to exactly 100 — that sum
// is enforced at runtime (see the assertion below) so a future edit can't
// silently break the odds without failing loudly.
export const SPIN_SEGMENTS = [
    { id: 'spin_bonus', type: 'spin', label: '+1 SPIN',      weight: 15 },
    { id: 'usd_small',  type: 'usd',  label: '$0.005', usdAmount: 0.005, weight: 2 },
    { id: 'cn_1',       type: 'cn',   label: '10–28 CN',  min: 10,  max: 28,  weight: 16.4 },
    { id: 'cn_2',       type: 'cn',   label: '29–46 CN',  min: 29,  max: 46,  weight: 16.4 },
    { id: 'cn_3',       type: 'cn',   label: '47–64 CN',  min: 47,  max: 64,  weight: 16.4 },
    { id: 'cn_4',       type: 'cn',   label: '65–82 CN',  min: 65,  max: 82,  weight: 16.4 },
    { id: 'cn_5',       type: 'cn',   label: '83–100 CN', min: 83,  max: 100, weight: 16.4 },
    { id: 'usd_big',    type: 'usd',  label: '$0.1',   usdAmount: 0.1,   weight: 1 },
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
