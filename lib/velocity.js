// lib/velocity.js — automatic anti-script guards (referral burst + withdrawal
// burst). Everything here is SERVER-SIDE ONLY: nothing the client sends can
// switch a lock off, and the only code path that clears `accountLocked` is
// the admin-only `unlock_` button in api/bot.js (which is protected by the
// webhook secret + ADMIN_ID check).
//
// A "system lock" sets:
//   accountLocked: true, accountLockedBy: 'system', accountLockedReason,
//   scamSuspected: true (only for the withdrawal-burst guard)
// api/withdraw.js and api/convert.js refuse a locked account, and the
// withdraw claim itself also re-checks the lock atomically.

import { markBanned } from './banRegistry.js';
import { tgSend } from './telegram.js';
import { adminUserTag, cleanUsername, escHtml } from './adminFormat.js';
import {
    REFERRAL_VELOCITY_WINDOW_MS, REFERRAL_LOCK_THRESHOLD, REFERRAL_FAKE_BAN_THRESHOLD,
    WITHDRAW_VELOCITY_WINDOW_MS, WITHDRAW_VELOCITY_THRESHOLD,
} from './constants.js';

const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID;

// Locks every id that is not already locked. Returns the ids that were
// NEWLY locked (so the caller only alerts the admin about new ones).
async function systemLock(db, ids, reason, extraSet = {}) {
    const users = db.collection('users');
    const targets = await users
        .find({ _id: { $in: ids }, accountLocked: { $ne: true } }, { projection: { _id: 1 } })
        .toArray();
    const newIds = targets.map((u) => u._id);
    if (!newIds.length) return [];
    await users.updateMany(
        { _id: { $in: newIds }, accountLocked: { $ne: true } },
        { $set: { accountLocked: true, accountLockedBy: 'system', accountLockedReason: reason, accountLockedAt: new Date(), ...extraSet } }
    );
    return newIds;
}

// ── 1 + 2) Referral burst ───────────────────────────────────────────────
// Called from api/user.js right after a referred signup was recorded.
// `referrerDoc` is the referrer's document AFTER the signup was pushed onto
// recentReferralSignups ([{ at: Date, uid }] — older entries may be plain Dates).
export async function checkReferralVelocity(db, referrerDoc, newUserId) {
    if (!referrerDoc) return { locked: false, banned: 0 };
    const referrerId = referrerDoc._id;
    const windowStart = Date.now() - REFERRAL_VELOCITY_WINDOW_MS;

    const burst = (referrerDoc.recentReferralSignups || [])
        .map((e) => (e && e.at ? { at: new Date(e.at).getTime(), uid: e.uid } : { at: new Date(e).getTime(), uid: null }))
        .filter((e) => e.at >= windowStart);
    const count = burst.length;
    if (count < REFERRAL_LOCK_THRESHOLD) return { locked: false, banned: 0 };

    // Rule 2 — 10+ signups in 1 minute → lock the referrer.
    const newlyLocked = await systemLock(db, [referrerId], 'referral_velocity', { velocityFlaggedAt: new Date(), velocityFlaggedReason: 'referral_velocity' });

    // Rule 1 — 50+ signups in 1 minute → also ban every account in the burst.
    let bannedIds = [];
    if (count >= REFERRAL_FAKE_BAN_THRESHOLD) {
        const ids = [...new Set(burst.map((e) => e.uid).filter(Boolean).concat(newUserId ? [newUserId] : []))];
        const stillActive = await db.collection('users')
            .find({ _id: { $in: ids }, isBanned: { $ne: true } }, { projection: { _id: 1 } })
            .toArray();
        bannedIds = stillActive.map((u) => u._id);
        for (const uid of bannedIds) {
            await markBanned(db, uid, 'referral_burst_fake'); // eslint-disable-line no-await-in-loop
        }
    }

    if (ADMIN_ID && (newlyLocked.length || bannedIds.length)) {
        const mins = Math.round(REFERRAL_VELOCITY_WINDOW_MS / 60000);
        const text =
            `🚨 <b>Referral burst detected — auto action taken</b>\n\n` +
            `Referrer <code>${escHtml(referrerId)}</code> got <b>${count}</b> signups within <b>${mins} minute</b>.\n` +
            (newlyLocked.length ? `🔒 Referrer <b>locked</b> (cannot withdraw/convert until you unlock).\n` : '') +
            (bannedIds.length ? `🚫 <b>${bannedIds.length}</b> fake accounts from this burst <b>banned</b>.\n` : '') +
            `\nReview the account, then Unlock if it was a real promotion.`;
        await tgSend(ADMIN_ID, text, {
            reply_markup: { inline_keyboard: [[
                { text: '🔎 Review referrer', callback_data: `lookup_${referrerId}` },
                { text: '🔓 Unlock', callback_data: `unlock_${referrerId}` },
            ]] },
        }).catch(() => {});
    }
    return { locked: newlyLocked.length > 0, banned: bannedIds.length };
}

// ── 3) Withdrawal burst ─────────────────────────────────────────────────
// Called from api/withdraw.js BEFORE the balance is deducted. Counts the
// withdrawal requests of the last 5 minutes (+ this attempt). If that
// reaches the threshold: this attempt is refused, and every account that
// requested in the window is locked + flagged scam-suspected. Their pending
// requests are NOT auto-rejected — they are marked so the admin can review.
export async function checkWithdrawalVelocity(db, userId) {
    const since = new Date(Date.now() - WITHDRAW_VELOCITY_WINDOW_MS);
    const recent = await db.collection('withdrawals')
        .find({ createdAt: { $gte: since } }, { projection: { userId: 1 } })
        .limit(500)
        .toArray();

    if (recent.length + 1 < WITHDRAW_VELOCITY_THRESHOLD) return { triggered: false };

    const ids = [...new Set(recent.map((w) => w.userId).concat(userId))];
    const newlyLocked = await systemLock(db, ids, 'withdraw_velocity', { scamSuspected: true, scamSuspectedAt: new Date() });
    // already-locked accounts in the burst still get the scam flag
    await db.collection('users').updateMany({ _id: { $in: ids }, scamSuspected: { $ne: true } }, { $set: { scamSuspected: true, scamSuspectedAt: new Date() } });
    await db.collection('withdrawals').updateMany(
        { createdAt: { $gte: since }, status: 'pending' },
        { $set: { scamSuspected: true } }
    );

    if (ADMIN_ID && newlyLocked.length) {
        const docs = await db.collection('users')
            .find({ _id: { $in: newlyLocked } }, { projection: { firstName: 1, telegramUsername: 1 } })
            .limit(40)
            .toArray();
        const lines = docs.map((u) => `• ${adminUserTag(u._id, cleanUsername(u.telegramUsername), u.firstName)} — <code>${escHtml(u._id)}</code>`);
        const mins = Math.round(WITHDRAW_VELOCITY_WINDOW_MS / 60000);
        const text =
            `🚨 <b>SCAM ALERT — withdrawal burst</b>\n\n` +
            `<b>${recent.length + 1}+</b> withdrawal requests inside <b>${mins} minutes</b> — this looks like a script, not real users.\n\n` +
            `🔒 <b>${newlyLocked.length}</b> account(s) locked &amp; flagged as <b>scam suspected</b>:\n${lines.join('\n')}` +
            (newlyLocked.length > docs.length ? `\n…and ${newlyLocked.length - docs.length} more` : '') +
            `\n\n⚠️ Their pending requests are still in the Withdrawals list — <b>do not approve before reviewing</b>.`;
        await tgSend(ADMIN_ID, text, {
            reply_markup: { inline_keyboard: [[{ text: '💸 Open pending withdrawals', callback_data: 'a_pending' }]] },
        }).catch(() => {});
    }
    return { triggered: true, locked: newlyLocked.length };
}
