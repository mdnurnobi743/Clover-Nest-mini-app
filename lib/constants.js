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
        lastResetDate: todayBD(),
    };
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

// ── Withdrawals (api/withdraw.js) — mirrors index.html's *_DISPLAY consts ──
export const WITHDRAWALS_OPEN = true;
export const MIN_WITHDRAW_WTC = 1500;
export const WITHDRAW_TASKS_REQUIRED = 8;          // lifetime completed tasks required before first withdraw
export const WITHDRAW_FEE_PERCENT = 25;             // first fee taken on every withdrawal
export const WITHDRAW_SECOND_FEE_PERCENT = 5;       // second fee taken on top of the first
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
