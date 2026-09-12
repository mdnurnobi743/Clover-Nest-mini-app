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
        cloverGamesPlayedToday: 0,        // ⚠️ NEW — Clover Catch daily play-count reset
        usedCloverStarts: [],             // ⚠️ NEW — Clover Catch spent session tokens, cleared daily (tokens expire in minutes anyway, so nothing legitimate is lost)
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

// ── Clover Catch mini-game (api/clover.js / index.html Earning tab) ──────
// Falling-clover reflex game. The round itself (spawn timing, falling
// physics, tap detection) runs entirely on the client — there is no way
// to fully re-simulate that server-side without literally replaying raw
// input events, which this project does not do. What IS fully
// server-controlled, so a modified/bypassed client can never mint free
// CN, is covered in api/clover.js's top comment: signed session tokens,
// physics-plausibility bounds on the reported result, and a reward that
// the server rolls itself rather than ever trusting a client-sent amount.
export const CLOVER_GAME_DURATION_SECONDS = 60;      // one round's countdown length
export const CLOVER_GAME_MAX_CLOVERS = 50;           // hard cap on clovers collectible in one round
// Reward table the SERVER rolls from (per clover, in whole CN) — mirrors
// index.html's small/medium/large visual tiers 1:1 so the live in-round
// counter the player sees roughly matches what actually gets credited,
// but this copy — not anything the client reports — is what decides the
// real number. See rollRewardForClovers() in api/clover.js.
export const CLOVER_REWARD_TIERS = [
    { weight: 45, min: 1, max: 3 },  // small clover
    { weight: 35, min: 3, max: 6 },  // medium clover
    { weight: 20, min: 6, max: 10 }, // large clover
];
// A session token is only valid for this long after cloverStart — long
// enough for a full round (60s) plus generous network/UI slack, short
// enough that a leaked/stolen token is useless within a couple minutes.
export const CLOVER_GAME_TOKEN_MAX_AGE_SECONDS = 90;
// Anti-speed-hack floor: nobody can legitimately tap faster than this,
// so elapsedSeconds < clovers * this value is rejected outright as
// physically impossible under the real game's fastest spawn rate.
export const CLOVER_GAME_MIN_SECONDS_PER_CLOVER = 0.25; // i.e. max ~4 clovers/sec
// Max plays per Bangladesh-day — stops the mode being farmed indefinitely
// by scripting cloverStart→cloverComplete in a tight loop.
export const CLOVER_GAMES_DAILY_LIMIT = 10;
export const CLOVER_GAME_REASONS = ['bomb', 'time', 'max', 'missed'];

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

// ── Withdrawing the CONVERTED USDT ledger (api/withdraw.js, source:'usdt') ──
// ⚠️ NEW — previously the usdtBalance built up by Convert had NO way to
// ever be paid out: Withdraw only ever read/deducted wtcBalance. These
// mirror the CN-side minimum/cap in already-converted USDT terms so
// Withdraw can accept either balance. No fee is re-applied on this path —
// CONVERT_FEE_PERCENT was already taken once when the CN was converted.
export const MIN_WITHDRAW_USDT = MIN_WITHDRAW_WTC / WTC_PER_USD;
export const FIRST_WITHDRAW_MAX_USDT = FIRST_WITHDRAW_MAX_WTC / WTC_PER_USD;

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
