// lib/constants.js — SEASON 2 UPDATE (FIXED RATES — live pricing removed)
//
// ⚠️ Per admin's instruction, the live TON price system was removed — it
// would sometimes overpay users in TON when the market price dipped. Now
// it's back to simple, predetermined (fixed) rates — predictable payouts,
// no dependency on an external API.
//
// Dropped the two-tier Gold + Diamond currency — now there's a single
// currency: the WTC coin. All reward/fee/withdraw numbers live here.

export const CURRENCY = 'WTC';

// ── WTC → real-money conversion rate (FIXED) ──
export const WTC_PER_USD = 25000;              // ⚠️ CHANGED — was 20,000. 25,000 WTC = 1 USD now.
export const WTC_PER_TON = WTC_PER_USD / 0.6;  // ⚠️ was hardcoded to 20000/0.6 (stale after WTC_PER_USD changed) — not currently imported/used anywhere (native TON payout was removed earlier), fixed for consistency in case it's ever wired back in

// ── WTC earned by watching videos (via the floating "lootbox" button in the video section) ──
// ⚠️ CHANGED — was 40/60 (40 WTC/hour). Now 60 WTC/hour per admin request.
export const VIDEO_WTC_PER_MINUTE = 60 / 60;    // 60 WTC/hour
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 25;         // minimum accrued amount required to claim
export const LOOTBOX_CLAIM_MAX = 500;        // max credit per network call (to prevent time-spoofing, not a daily cap)

// Daily video-watch time limit. ⚠️ CHANGED — was 6 hours/day, now 5 hours/day per admin request.
export const DAILY_VIDEO_WATCH_HOURS_MAX = 5;
export const DAILY_VIDEO_WTC_MAX = DAILY_VIDEO_WATCH_HOURS_MAX * 60 * VIDEO_WTC_PER_MINUTE; // = 300 WTC/day

// ── The Extract tab's ad-network buttons — each pays WTC directly ──
// ⚠️ CHANGED — adsgramSpecial removed entirely per admin request (was 20
// WTC/5-daily). "usl" (USL Ads / TowerAds SDK) is now LIVE — credentials
// and the loadAndShow() integration live in index.html's showUslAd() /
// getTowerAdsInstance(). See api/earn.js's handleAdStart/handleClaimAdReward,
// which check `enabled !== false` before allowing adStart/claimAdReward —
// kept in place so any network can be paused instantly by flipping its
// `enabled` flag here, without a code deploy.
export const AD_NETWORK_REWARDS = {
    adsgramDaily:   { reward: 10, dailyLimit: 10 },
    monetag:        { reward: 15, dailyLimit: 20 },
    giga:           { reward: 15, dailyLimit: 20 },
    usl:            { reward: 15, dailyLimit: 10 }, // ⚠️ CHANGED — now enabled (TowerAds SDK wired in)
};

// ⚠️ FIX — this export was MISSING, which is exactly why every /api/earn
// action (all 4 ad networks + video + tasks + promo, not just ads) was
// throwing a 500 today: api/earn.js imports this by name, and a missing
// named export fails the entire module's load, not just the one feature
// that uses it.
//
// Minimum seconds that must elapse between an `adStart` token being issued
// and `claimAdReward` accepting it — the server-side floor that makes the
// Termux replay-script attack impossible to instant-farm (it can still
// technically call claimAdReward after waiting this long with no ad
// actually watched, since this alone isn't full S2S ad-network
// verification — but it removes the "drain the daily limit in under a
// second" exploit, and rate-limits any adapted script to real wall-clock
// time). Adjust this number to match how long your ad networks' units
// actually run for — it should be at or just under the ad's real duration,
// not arbitrary.
export const AD_MIN_WATCH_SECONDS = 4;

// ⚠️ FIX — this was defined but never actually imported/used anywhere, so
// the "20-second gap between ads" it describes was NOT being enforced at
// all — pure dead code, a script could adStart→claimAdReward back-to-back
// with zero pacing. Now wired into handleClaimAdReward (see api/earn.js).
export const AD_COOLDOWN_SECONDS = 20;

// ⚠️ NEW — minimum real time a user must hold a task open before claiming
// it (daily/exclusive/partner/earning categories — 'channel' tasks skip this
// entirely since Telegram membership is independently verified). Kept
// slightly under the frontend's 10-second claim-button countdown so a
// genuine user is never blocked by their own honest usage; a script that
// skips straight from taskStart to taskComplete with no real wait gets
// rejected. See handleTaskStart/handleTaskComplete in api/earn.js.
export const TASK_MIN_WAIT_SECONDS = 8;

// ── Withdraw methods ──
// ⚠️ TON withdrawal removed — Tonkeeper is now used only as a wallet ADDRESS
// (users still paste their TON wallet/Tonkeeper address), but the actual
// payout sent to that address is USDT (USDT-on-TON), not native TON coin.
// Both methods now pay out in USDT.
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
};

// ══════════════════════════════════════════════════════════
// ⚠️ SEASON 4 — WITHDRAW SIMPLIFIED. The old convert-first + tiered-box +
// level-ladder system is gone. Now it's ONE step: a user types a WTC
// amount (minimum MIN_WITHDRAW_WTC) and submits directly — no separate
// "Convert" screen, no tier grid, no hidden level gate, no address lock.
//
// TWO fees apply, back-to-back, on that single submit:
//   1) WITHDRAW_FEE_PERCENT (25%) — this is the SAME rate the old
//      "convert" step used to take. Kept exactly as-is per admin's
//      instruction, just applied at the (now single) withdraw step
//      instead of a separate convert step.
//   2) WITHDRAW_SECOND_FEE_PERCENT (5%) — NEW, taken on what's left
//      after the 25% above.
// So a user nets wtc/WTC_PER_USD * 0.75 * 0.95 ≈ 71.25% of face value.
// See api/withdraw.js calcNetUsd().
// ══════════════════════════════════════════════════════════
export const MIN_WITHDRAW_WTC = 1500; // ⚠️ CHANGED — was 1000, raised to 1500 to reduce the volume of small withdraw requests admin has to review

// ⚠️ NEW — the very first withdrawal is free (no valid referral required —
// see isFirstWithdraw in api/withdraw.js), but that used to have NO ceiling
// on the amount, meaning a fresh/farmed account could take an unlimited
// first withdrawal with zero referral cost. Now capped at $0.15 USD
// equivalent (gross, before fees) — big enough to be a real first payout,
// small enough that it isn't worth farming fresh accounts just to abuse it.
export const FIRST_WITHDRAW_MAX_USD = 0.15;
export const FIRST_WITHDRAW_MAX_WTC = Math.floor(FIRST_WITHDRAW_MAX_USD * WTC_PER_USD); // = 3,750 WTC at the current 25,000 WTC/USD rate

export const WITHDRAW_FEE_PERCENT = 25;        // unchanged rate, moved from convert-step to withdraw-step
export const WITHDRAW_SECOND_FEE_PERCENT = 5;  // ⚠️ NEW — additional flat fee taken at withdraw time

// ⚠️ CHANGED — WITHDRAW_TASKS_REQUIRED is now a LIFETIME, one-time gate, not
// a daily one. It's checked against completedTasks.length (the lifetime
// array, never reset) instead of tasksCompletedToday (which resets daily).
// Once a user has completed 8 tasks EVER, this gate is permanently satisfied
// — they never have to redo it on later withdrawals. See api/withdraw.js.
export const WITHDRAW_TASKS_REQUIRED = 8;

// ⚠️ CHANGED — was 10, now 8. This one STAYS a daily gate — checked against
// adsWatchedToday, which resets at Bangladesh midnight (see
// todayBD()/dailyResetFields() below) — the "within 24 hours" window admin
// asked for.
export const WITHDRAW_ADS_REQUIRED = 8;

// ⚠️ NEW — referral gate: the very first withdrawal a user ever makes is
// free (no referral needed). Every withdrawal AFTER that consumes exactly
// one "valid" referral (see lib/referral.js — a referral becomes valid once
// the referred user completes all 3 referral milestones). Enforced in
// api/withdraw.js against user.validReferralCount - user.usedValidReferrals.
export const WITHDRAW_VALID_REFERRALS_PER_WITHDRAW = 1;

// ⚠️ REMOVED (Season 4) — address lock. Per admin's instruction, a
// withdraw address is never locked. Left the constant name out of the file
// entirely rather than a disabled flag, since nothing should reference it
// anymore — if address locking is ever wanted again later, it needs to be
// reintroduced deliberately, not silently reactivated by a stray import.

// ── Referral — given in 3 stages (lifetime milestone, awarded once) ──
// ⚠️ CHANGED per admin request — step2 60→100, step3 130→180. Note: the
// admin's message quoted a "300 WTC total" figure, but the three numbers
// given (30 + 100 + 180) actually sum to 310, not 300 — flagged separately,
// implemented here exactly as the per-step numbers specify (310 total).
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      100, // when the referred user completes 10 tasks
    step3_twentyAds:     180, // when the referred user completes 20 ads (key name kept as-is)
};
export const REFERRAL_STEP2_TASK_COUNT = 5; // ⚠️ CHANGED — was 10, lowered to make "valid referral" easier to reach
export const REFERRAL_STEP3_AD_COUNT = 20; // ⚠️ CHANGED — was 25, back to 20 per admin request

// ⚠️ REMOVED (this update) — a daily circuit-breaker on referral-milestone
// payouts (REFERRAL_DAILY_MILESTONE_CAP = 15/day/referrer) lived here
// briefly. Taken back out on request — it caught legitimate high-activity
// referral days too, not just abuse. The velocity lock below is the anti-
// abuse mechanism that's actually kept.

// ⚠️ NEW — referral SIGNUP velocity lock. This is a much earlier tripwire
// than the milestone cap above — it fires at the moment of SIGNUP
// attribution (before any milestone, any reward), based on a simple truth:
// no real promotion — not even a big channel post — delivers signups this
// fast. People have to see the message, tap the link, open Telegram, and
// go through onboarding; that takes minutes to hours to spread, even
// virally. REFERRAL_VELOCITY_THRESHOLD+ signups under one referrer within
// REFERRAL_VELOCITY_WINDOW_MS is not organic growth, full stop — auto-lock
// first, let the admin review and decide (unlock or ban) after the fact.
export const REFERRAL_VELOCITY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
export const REFERRAL_VELOCITY_THRESHOLD = 20;             // 20+ signups inside that window

// ⚠️ NEW — withdrawal referral commission. Every time a user withdraws, if
// they were referred by someone, the referrer is credited this % of the
// WITHDRAWN WTC AMOUNT (gross, before withdraw fees) directly to their own
// wtcBalance — e.g. a 1,000 WTC withdrawal pays the referrer 100 WTC. This
// is NOT a one-time reward — it fires on every withdrawal, indefinitely, for
// as long as the referral relationship exists. See api/withdraw.js.
export const WITHDRAW_REFERRAL_COMMISSION_PERCENT = 10;

// Today's date in the Bangladesh timezone
// ══════════════════════════════════════════════════════════
// SEASON 3 — "777" LOTTERY (Earning tab, replaces the Articles sub-tab)
//
// Spends 1 luckyTicket per spin. Tickets are NOT purchasable with WTC or
// real money — they're earned only from referrals (see lib/referral.js,
// awarded at step1_verified — the point a referral is already confirmed
// real, not just a link click) — so this is "spend what you earned
// referring people", not a pay-to-play mechanic.
//
// Outcome is picked SERVER-SIDE only (api/earn.js handleLotterySpin) via
// weighted random — the client never influences or even sees the result
// before the server responds. `reels` is what the client displays; `lose`
// entries pick a random near-miss (non-matching) reel combo at spin time
// so losing spins don't all look identical.
// ══════════════════════════════════════════════════════════
export const LOTTERY_SPIN_COST_TICKETS = 1;
export const LOTTERY_SYMBOLS = ['7', '💎', '⭐', '🔔', '🍒', '🍋'];
// ⚠️ UPDATED per admin: reward range is now 5–1000 WTC (was 5–5000). The
// jackpot (1000 WTC) is the "mega reward" — the single biggest thing a
// referral can indirectly earn someone, since tickets only come from
// referring people (see lib/referral.js — unchanged, still 1 ticket per
// verified referral).
export const LOTTERY_OUTCOMES = [
    { id: 'jackpot',        reels: ['7', '7', '7'],       reward: 1000, weight: 1   }, // 0.1% — the "mega reward"
    { id: 'triple_diamond', reels: ['💎', '💎', '💎'],    reward: 400,  weight: 4   }, // 0.4%
    { id: 'triple_star',    reels: ['⭐', '⭐', '⭐'],    reward: 150,  weight: 15  }, // 1.5%
    { id: 'triple_bell',    reels: ['🔔', '🔔', '🔔'],    reward: 60,   weight: 40  }, // 4%
    { id: 'triple_cherry',  reels: ['🍒', '🍒', '🍒'],    reward: 25,   weight: 90  }, // 9%
    { id: 'small_win',      reels: null, reward: 5,   weight: 150 }, // 15% — reels resolved to a random non-matching pair at spin time
    { id: 'lose',           reels: null, reward: 0,   weight: 700 }, // 70% — reels resolved to a random non-matching combo at spin time
];
const LOTTERY_TOTAL_WEIGHT = LOTTERY_OUTCOMES.reduce((sum, o) => sum + o.weight, 0); // = 1000

// Picks a weighted-random outcome and, for the two "reels: null" buckets,
// fills in a display-only reel combo that doesn't accidentally look like a
// win (small_win shows exactly 2 matching symbols; lose shows 0-1 matching).
export function rollLottery() {
    let roll = Math.random() * LOTTERY_TOTAL_WEIGHT;
    let picked = LOTTERY_OUTCOMES[LOTTERY_OUTCOMES.length - 1];
    for (const o of LOTTERY_OUTCOMES) {
        if (roll < o.weight) { picked = o; break; }
        roll -= o.weight;
    }
    if (picked.reels) return { id: picked.id, reward: picked.reward, reels: picked.reels };

    const pick = () => LOTTERY_SYMBOLS[Math.floor(Math.random() * LOTTERY_SYMBOLS.length)];
    let reels;
    if (picked.id === 'small_win') {
        const pair = pick();
        let third = pick();
        while (third === pair) third = pick(); // keep it visually a "2 match, 1 off" near-win, not a fluke triple
        reels = Math.random() < 0.5 ? [pair, pair, third] : [third, pair, pair];
    } else {
        do { reels = [pick(), pick(), pick()]; } while (reels[0] === reels[1] && reels[1] === reels[2]);
    }
    return { id: picked.id, reward: picked.reward, reels };
}

export function todayBD() {
    return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });
}

// Current month key in the Bangladesh timezone (e.g. "07/2026") — kept for
// anything else that still resets monthly. The tiered-withdraw counters
// below no longer use this — see currentHalfYearBD().
export function currentMonthBD() {
    return new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit' });
}

// The tiered-withdraw monthlyLimit counters reset every 6 months (per
// earlier admin decision — CONFIRMED to stay as-is, not changed to 2
// months). Returns a key like "2026-H1" (Jan–Jun) or "2026-H2" (Jul–Dec),
// Bangladesh time.
export function currentHalfYearBD() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
    const year = now.getFullYear();
    const half = now.getMonth() < 6 ? 'H1' : 'H2'; // Jan–Jun vs Jul–Dec
    return `${year}-${half}`;
}

// ⚠️ REMOVED (Season 4) — WITHDRAW_TIERS and WITHDRAW_LEVELS. Both the
// fixed-$-tier grid and the hidden referral-based level ladder are gone;
// withdraw amount is now a free-text WTC field (min MIN_WITHDRAW_WTC) and
// the only referral gate is "1 valid referral per withdraw after the
// first" — see WITHDRAW_VALID_REFERRALS_PER_WITHDRAW above.

export function dailyResetFields() {
    return {
        lastResetDate: todayBD(),
        adsWatchedToday: 0,
        tasksCompletedToday: 0,
        dailyVideoWtcMined: 0,
        adsgramDailyCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        uslCountToday: 0,
        // ⚠️ FIX — these two were never reset before (only usedVideoStarts
        // was). Since single-use ad/lootbox tokens already expire after 5
        // minutes (see AD/lootbox handlers), there's zero reason to keep
        // spent tokens from days ago — they were just growing every user's
        // document forever, unbounded, which is exactly the kind of
        // MongoDB free-tier bloat risk to avoid.
        usedAdStarts: [],
        usedLootboxStarts: [],
        // ⚠️ NEW — single-use task-claim tokens (see api/earn.js
        // handleTaskStart/handleTaskComplete). Same reasoning: 5-minute
        // expiry, no reason to keep them past the day they were issued.
        usedTaskStarts: [],
        usedVideoStarts: [], // ⚠️ replay-protection: প্রতিদিন claim করা video-session (startTime) গুলোর তালিকা, দিন শেষে খালি হয়
    };
}

// ══════════════════════════════════════════════════════════
// ⚠️ SEASON END — withdrawals closed. Set by admin decision: no new
// withdraw requests are accepted from this point on. Already-submitted
// ('pending') withdrawals are UNAFFECTED — bot.js's normal Approve/Reject
// admin flow still works exactly as before for those, so anyone who
// requested a withdraw before this flag flipped still gets paid. This only
// blocks the "create a NEW withdrawal" path (api/withdraw.js handleCreate).
// Flip back to true if withdrawals ever reopen.
// ══════════════════════════════════════════════════════════
export const WITHDRAWALS_OPEN = true; // ⚠️ SEASON 3 — reopened for the new season (was closed at Season 2's end)

// ══════════════════════════════════════════════════════════
// WEEKLY REFERRAL COMPETITION — every user's `weeklyReferralCount` climbs
// as they land referrals this week (see api/user.js handleInit). Reward
// eligibility is a THRESHOLD, not just rank: only users with AT LEAST
// WEEKLY_REFERRAL_MIN_COUNT referrals this week qualify, and of those, only
// the top WEEKLY_REFERRAL_MAX_WINNERS get rewarded. If fewer than
// WEEKLY_REFERRAL_MAX_WINNERS users cross the threshold, fewer people get
// rewarded that week (could be 0) — it's never "top 10 regardless of count".
// The admin resets manually via bot.js's a_weekly → "🔄 Reset week now",
// which snapshots the qualifying winners into a `weeklyReferralReports`
// collection (viewable later via "📜 Weekly Report") BEFORE zeroing
// everyone's weeklyReferralCount for the new week. Rewards themselves are
// sent manually by the admin — nothing here touches wtcBalance
// automatically. Lifetime `referralCount` is a separate field, untouched.
// ══════════════════════════════════════════════════════════
export const WEEKLY_REFERRAL_MIN_COUNT = 10;  // minimum refs THIS WEEK to qualify at all
export const WEEKLY_REFERRAL_MAX_WINNERS = 10; // cap on how many qualifying users get rewarded
