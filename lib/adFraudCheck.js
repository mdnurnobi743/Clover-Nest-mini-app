// lib/adFraudCheck.js — ad-watching PATTERN detector ("is this actually a
// human tapping Watch, or a script looping adWatchStart → adWatchClaim?").
//
// Different job from lib/velocity.js: the velocity guards react to a BURST
// of events across many users (referral spam, a wave of withdrawals).  This
// looks at the SHAPE of one user's own recent claims on one network —
// timing that's too fast, too identical, or too metronome-regular to be a
// person actually sitting through an ad each time. See lib/constants.js
// "Ad-pattern fraud detector" block for the full rule list and every
// threshold used below — this file is pure plumbing around those numbers.
//
// Called from api/earn.js's handleAdWatchClaim, AFTER the reward is already
// credited and the adWatchLogs entry for THIS claim has been inserted — so
// the window below always includes the claim that just happened.
//
// Nothing here can ever cost the user their reward: every DB read is
// read-only except the optional auto-lock, and the caller wraps this whole
// call in try/catch so a bug here can never break a real ad claim.

import { tgSend } from './telegram.js';
import { adminUserTag, cleanUsername, escHtml } from './adminFormat.js';
import {
    AD_NETWORKS,
    AD_FRAUD_MIN_SAMPLE, AD_FRAUD_LOOKBACK,
    AD_FRAUD_FAST_CLAIM_SECONDS,
    AD_FRAUD_IDENTICAL_SPREAD_SECONDS,
    AD_FRAUD_SCREEN_MISMATCH_SECONDS, AD_FRAUD_SCREEN_MISMATCH_MIN_SAMPLES,
    AD_FRAUD_BURST_WINDOW_SECONDS,
    AD_FRAUD_METRONOME_SPREAD_SECONDS, AD_FRAUD_METRONOME_MAX_GAP_SECONDS,
    AD_FRAUD_HEALTHY_GAP_SPREAD_SECONDS,
    AD_FRAUD_MIN_ACCOUNT_AGE_DAYS,
    AD_FRAUD_LOCK_SCRIPT_THRESHOLD,
} from './constants.js';

const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID;

const round1 = (n) => Math.round(n * 10) / 10;
const fmtList = (arr, unit = 's') => arr.length ? arr.map((n) => (n === null || n === undefined ? '?' : `${round1(n)}${unit}`)).join(', ') : '—';
const spread = (arr) => { const vals = arr.filter((n) => typeof n === 'number'); return vals.length ? Math.max(...vals) - Math.min(...vals) : null; };

// Rule priority when more than one fires at once — the scariest-sounding
// one becomes the alert's headline "Rule X: ..." line. The score itself
// (shown separately as the Hint) already counts every rule that fired, so
// this only decides which single sentence leads the message.
const RULE_PRIORITY = ['D', 'E', 'B', 'A', 'C'];

function evaluateRules({ tapClaimSecs, screenSecs, gapSecs }) {
    const rules = {}; // letter -> { fired, label }

    // Rule A — claimed at/near the fastest possible speed, every time.
    const allFast = tapClaimSecs.every((s) => s <= AD_FRAUD_FAST_CLAIM_SECONDS);
    rules.A = {
        fired: allFast,
        label: `${tapClaimSecs.length} ads all claimed in ≤${AD_FRAUD_FAST_CLAIM_SECONDS}s (near the minimum possible)`,
    };

    // Rule B — ad SDK's own on-screen time disagrees with tap→claim time.
    // Skipped entirely (not just "not fired" — excluded from scoring) if no
    // claim in the window ever reported one, since most ad SDKs don't expose it.
    const pairedWithScreen = tapClaimSecs
        .map((t, i) => ({ t, s: screenSecs[i] }))
        .filter((p) => typeof p.s === 'number');
    const ruleBApplicable = pairedWithScreen.length > 0;
    let mismatchCount = 0;
    if (ruleBApplicable) {
        mismatchCount = pairedWithScreen.filter((p) => Math.abs(p.t - p.s) > AD_FRAUD_SCREEN_MISMATCH_SECONDS).length;
    }
    rules.B = {
        applicable: ruleBApplicable,
        fired: ruleBApplicable && mismatchCount >= AD_FRAUD_SCREEN_MISMATCH_MIN_SAMPLES,
        label: `ad-on-screen time didn't match the claim time in ${mismatchCount}/${pairedWithScreen.length} ads`,
    };

    // Rule C — tap→claim times suspiciously identical run to run.
    const tapSpread = spread(tapClaimSecs);
    const tapMin = Math.min(...tapClaimSecs);
    const tapMax = Math.max(...tapClaimSecs);
    rules.C = {
        fired: tapSpread !== null && tapSpread <= AD_FRAUD_IDENTICAL_SPREAD_SECONDS,
        label: `${tapClaimSecs.length} ads with near-identical watch time (${round1(tapMin)}–${round1(tapMax)}s)`,
    };

    // Rule D — too many claims packed into too short a total span.
    const totalSpanSecs = gapSecs.reduce((a, b) => a + b, 0);
    rules.D = {
        fired: gapSecs.length > 0 && totalSpanSecs <= AD_FRAUD_BURST_WINDOW_SECONDS,
        label: `${tapClaimSecs.length} ads claimed inside ${round1(totalSpanSecs)}s total`,
    };

    // Rule E — gaps BETWEEN claims are metronome-regular (a timer loop),
    // not just the claim duration itself.
    const gapSpreadVal = spread(gapSecs);
    const gapMin = gapSecs.length ? Math.min(...gapSecs) : null;
    const gapMax = gapSecs.length ? Math.max(...gapSecs) : null;
    const isMetronome = gapSpreadVal !== null && gapSpreadVal <= AD_FRAUD_METRONOME_SPREAD_SECONDS && gapMax <= AD_FRAUD_METRONOME_MAX_GAP_SECONDS;
    rules.E = {
        fired: isMetronome,
        label: `${gapSecs.length} ads with metronome-like pauses between them (${round1(gapMin)}–${round1(gapMax)}s)`,
    };

    return { rules, tapSpread, gapSpreadVal, gapMax };
}

// Evaluated independently of the A-E rules above — these describe a
// normal, lived-in account rather than directly rebutting any one rule.
function evaluateCounterSignals({ gapSpreadVal, gapMax, accountAgeDays, hasTrackRecord }) {
    const signals = {};
    // R1 — mutually exclusive with Rule E: a gap pattern can't be BOTH
    // "metronome-tight" and "varies naturally" at the same time.
    signals.R1 = {
        fired: gapSpreadVal !== null && (gapSpreadVal > AD_FRAUD_HEALTHY_GAP_SPREAD_SECONDS || gapMax > AD_FRAUD_METRONOME_MAX_GAP_SECONDS),
        label: 'gaps between ads vary naturally',
    };
    signals.R2 = { fired: accountAgeDays >= AD_FRAUD_MIN_ACCOUNT_AGE_DAYS, label: 'account isn\'t brand new' };
    signals.R3 = { fired: hasTrackRecord, label: 'account has a real track record (withdrawal or paid referral)' };
    return signals;
}

// Caller (api/earn.js) must insert THIS claim's adWatchLogs entry before
// calling this, so the window below always includes it.
export async function checkAdPattern(db, userId, network) {
    const logs = db.collection('adWatchLogs');
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');

    // Most-recent-first, including the claim that just happened.
    const recent = await logs
        .find({ userId, network })
        .sort({ watchedAt: -1 })
        .limit(AD_FRAUD_LOOKBACK)
        .toArray();

    if (recent.length < AD_FRAUD_MIN_SAMPLE) return { alerted: false, reason: 'not_enough_samples' };

    // Oldest → newest, for natural left-to-right reading in the alert.
    const ordered = [...recent].reverse();
    const tapClaimSecs = ordered.map((l) => (l.tapToClaimMs ?? 0) / 1000);
    const screenSecs = ordered.map((l) => (typeof l.adOnScreenMs === 'number' ? l.adOnScreenMs / 1000 : null));
    const gapSecs = [];
    for (let i = 1; i < ordered.length; i++) {
        gapSecs.push((new Date(ordered[i].watchedAt).getTime() - new Date(ordered[i - 1].watchedAt).getTime()) / 1000);
    }

    const { rules, gapSpreadVal, gapMax } = evaluateRules({ tapClaimSecs, screenSecs, gapSecs });

    const firedLetters = RULE_PRIORITY.filter((letter) => rules[letter]?.fired);
    if (!firedLetters.length) return { alerted: false, reason: 'no_rule_fired' };

    const user = await users.findOne({ _id: userId });
    if (!user) return { alerted: false, reason: 'user_not_found' };
    // Already locked (for this or any other reason) — nothing new and
    // actionable to tell the admin; they already have Unlock/Ban in front
    // of them from whatever locked it the first time.
    if (user.accountLocked) return { alerted: false, reason: 'already_locked' };

    const accountAgeDays = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86400000);
    const approvedWithdrawCount = await withdrawals.countDocuments({ userId, status: 'approved' });
    const hasTrackRecord = approvedWithdrawCount > 0 || (user.validReferralCount || 0) > 0;

    const counter = evaluateCounterSignals({ gapSpreadVal, gapMax, accountAgeDays, hasTrackRecord });

    const scriptScore = ['A', 'B', 'C', 'D', 'E'].filter((l) => rules[l]?.fired).length;
    const realScore = ['R1', 'R2', 'R3'].filter((l) => counter[l]?.fired).length;

    const headlineLetter = firedLetters[0];
    const headlineLabel = rules[headlineLetter].label;

    const shouldLock = scriptScore >= AD_FRAUD_LOCK_SCRIPT_THRESHOLD;
    const hint = scriptScore > realScore && scriptScore >= 2
        ? `🔴 Likely script (script ${scriptScore} / real ${realScore})`
        : realScore > scriptScore
            ? `🟢 Likely real user (script ${scriptScore} / real ${realScore})`
            : `🟡 Unclear — check profile (script ${scriptScore} / real ${realScore})`;

    let newlyLocked = false;
    if (shouldLock) {
        const gate = await users.updateOne(
            { _id: userId, accountLocked: { $ne: true } },
            { $set: {
                accountLocked: true, accountLockedBy: 'system', accountLockedReason: 'ad_pattern',
                accountLockedAt: new Date(), adPatternFlaggedAt: new Date(), adPatternRule: headlineLetter,
            } }
        );
        newlyLocked = gate.modifiedCount > 0; // false if a concurrent request locked it first — don't double-alert
        if (!newlyLocked) return { alerted: false, reason: 'already_locked' };
    }

    if (ADMIN_ID) {
        const netLabel = AD_NETWORKS[network]?.label || network;
        const name = escHtml(user.firstName || 'User');
        const tag = adminUserTag(user._id, cleanUsername(user.telegramUsername), user.firstName);
        const lifetimeAds = user.lifetimeAdViews || 0;
        const todayAds = Object.values(user.adViews || {}).reduce((a, b) => a + (b || 0), 0);

        const evidence =
            `<b>Evidence</b>\n` +
            `Name: ${name} (${tag})\n` +
            `Account age: ${accountAgeDays}d · Balance: ${user.wtcBalance || 0} CN · Lifetime: ${user.lifetimeWtcEarned || 0} CN\n` +
            `Withdrawals: ${approvedWithdrawCount} · Valid referrals: ${user.validReferralCount || 0} · Ads lifetime: ${lifetimeAds} (today ${todayAds})\n` +
            `Multi-account flag: ${user.multiAccountFlag ? 'Yes' : 'No'}\n` +
            `Tap → claim times (incl. loading): ${fmtList(tapClaimSecs)}\n` +
            `Ad on screen (client-reported): ${fmtList(screenSecs)}\n` +
            `Gaps between ads: ${fmtList(gapSecs)}\n` +
            `Hint: ${hint}`;

        let text;
        let buttons;
        if (newlyLocked) {
            text =
                `🤖 <b>Bot / script pattern detected (ads)</b>\n\n` +
                `User: <code>${escHtml(user._id)}</code>\n` +
                `Rule ${headlineLetter}: ${headlineLabel}\n` +
                `Network: ${escHtml(netLabel)}\n\n` +
                `${evidence}\n\n` +
                `The account is now 🔒 locked (no withdraw, no ad rewards).`;
            buttons = [
                [{ text: '🔓 Unlock', callback_data: `unlock_${user._id}` }, { text: '👤 User Profile', callback_data: `lookup_${user._id}` }],
                [{ text: '🚫 Ban User', callback_data: `ban_${user._id}` }],
            ];
        } else {
            text =
                `⚠️ <b>Suspicious ad pattern — NOT locked</b>\n\n` +
                `User: <code>${escHtml(user._id)}</code>\n` +
                `Rule ${headlineLetter}: ${headlineLabel}\n` +
                `Network: ${escHtml(netLabel)}\n\n` +
                `${evidence}\n\n` +
                `Nothing was blocked. Lock the account yourself if you think it is a script.`;
            buttons = [
                [{ text: '🔒 Lock', callback_data: `lock_${user._id}` }, { text: '👤 User Profile', callback_data: `lookup_${user._id}` }],
                [{ text: '🚫 Ban User', callback_data: `ban_${user._id}` }],
            ];
        }

        await tgSend(ADMIN_ID, text, { reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    }

    return { alerted: true, locked: newlyLocked, scriptScore, realScore, rule: headlineLetter };
}
