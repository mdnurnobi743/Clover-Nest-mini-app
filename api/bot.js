// api/bot.js — Clover Nest Admin Panel Bot
//
// Adapted from the bot__4_.js reference, with a few important
// changes/fixes:
//   1) ADMIN_ID → ADMIN_TELEGRAM_ID (to match the env var name on Vercel)
//   2) Dropped in-memory state{} — now persisted in MongoDB (lib/adminState.js),
//      since in-memory state can be lost on Vercel serverless cold starts
//   3) Uses _id instead of a telegramId field (matches our users schema)
//   4) egBalance → wtcBalance, single currency
//   5) Task management (video system removed)
//   6) ⚠️ SEASON 3 — the 🚩 Multi-Account Flags admin panel (device-cluster
//      review, auto-suspend-the-rest-on-tap, "Make Main") is REMOVED.
//      Enforcement happens live at the door via lib/ipRegistry.js (Season 4:
//      keyed by device fingerprint, IP only as a fallback — see that file),
//      not via a manual admin queue — this panel was fully redundant with
//      that and is gone. Ban/unban of an individual user (ban_/unban_
//      callbacks) is untouched.
//   7) A rejected withdraw fully refunds wtcAmount (including fee — since real money was never sent)

import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { tgApi, tgSend, tgEdit, tgSendPhoto, tgAnswerCallback, isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP, PAYMENT_CHANNEL, PAYMENT_PROOF_PHOTO } from '../lib/telegram.js';
import { getAdminState, setAdminState, clearAdminState } from '../lib/adminState.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { createBroadcastJob } from '../lib/broadcastJob.js';
import { waitUntil } from '@vercel/functions';
import { WEEKLY_REFERRAL_MIN_COUNT, WEEKLY_REFERRAL_MAX_WINNERS, WTC_PER_USD, WITHDRAW_REFERRAL_COMMISSION_PERCENT } from '../lib/constants.js';
import { markBanned, markUnbanned } from '../lib/banRegistry.js';

// Small formatter shared by the Manage Tasks listings — daily tasks priced
// in USDT show both the USDT figure and its converted WTC amount, everything
// else just shows plain WTC.
function taskRewardLine(t) {
    return t.rewardCurrency === 'usdt' ? `${t.rewardUsdt} USDT (≈${t.rewardWtc} WTC)` : `${t.rewardWtc} WTC`;
}


// ⚠️ markBanned/markUnbanned moved to lib/banRegistry.js — now shared with
// lib/fingerprintCheck.js, which auto-bans a newly-detected multi-account
// signup using the exact same registry logic as a manual admin ban here.

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// ⚠️ Replace these two lines with your real values:
const APP_URL = 'https://clover-nest-t5mz.vercel.app';                   // your Mini App's Vercel URL
const MINI_APP_URL = 'https://t.me/Clover_nest_bot/CloverNest';         // ✅ updated
const BOT_USERNAME = 'Clover_nest_bot';                                    // ⚠️ must match MINI_APP_URL
const COVER_PHOTO = 'https://i.postimg.cc/Gtp63QQV/file-000000007fa87207ae71dda1cde1426b.png'; // shown only in users' /start, not to the admin

const adminKb = {
    inline_keyboard: [
        [{ text: '📊 Dashboard', callback_data: 'a_stats' }, { text: '💸 Withdrawals', callback_data: 'a_pending' }],
        [{ text: '👤 User Lookup', callback_data: 'a_user' }, { text: '👥 All Users', callback_data: 'a_allusers_0' }],
        [{ text: '🏆 Top Referrers', callback_data: 'a_toprefer' }, { text: '📅 Weekly Refer', callback_data: 'a_weekly' }],
        [{ text: '📜 Weekly Report', callback_data: 'a_weekly_history' }],
        [{ text: '📋 Add Task', callback_data: 'a_addtask' }, { text: '🗑 Manage Tasks', callback_data: 'a_managetasks_0' }],
        [{ text: '🎟 Add Promo', callback_data: 'a_addpromo' }, { text: '📋 View Promos', callback_data: 'a_viewpromos_0' }],
        [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }],
        [{ text: '💰 Send WTC', callback_data: 'a_sendwtc' }, { text: '🎁 Send Gift', callback_data: 'a_sendgift' }],
    ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

// ⚠️ NEW — weaves an invisible zero-width character (U+2060 WORD JOINER)
// between every character of a promo code. Renders identically to a human
// reading it in the broadcast, but a copy-paste of it into the redeem box
// carries those invisible characters along — since the code stored in the
// database is clean, the pasted (polluted) string won't match, and
// redemption fails until the user types the code in manually. This is a
// friction/deterrent measure, not a hard guarantee — Telegram has no way
// to truly disable text selection/copying, and a technically inclined
// person could still strip the invisible characters before pasting. It
// stops casual copy-paste-forward sharing, which is the realistic threat.
function obscureCode(code) {
    return code.split('').join('\u2060');
}
const cancelKb = { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };

// ── Shared user-detail + moderation panel — used by both numeric-ID lookup
// and the "tap a name" flow from username search / top-referrer drill-down.
// Returns [text, options] so callers can just do tgSend(chatId, ...renderUserLookup(u, withdrawalsList)).
function renderUserLookup(u, withdrawalsList = []) {
    const wCount = withdrawalsList.length;
    const totalWithdrawnWtc = withdrawalsList.filter(w => w.status === 'approved').reduce((sum, w) => sum + (w.wtcAmount || 0), 0);
    const pendingWithdrawCount = withdrawalsList.filter(w => w.status === 'pending').length;
    const accountAgeDays = Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000);

    const text =
        `👤 <b>User Info</b>\n\n` +
        `ID: <code>${u._id}</code>\n` +
        `Name: <b>${u.firstName}</b> (@${u.telegramUsername || 'none'})\n` +
        `💰 Balance: <b>${u.wtcBalance || 0} WTC</b>\n` +
        `💎 Lifetime Earned: <b>${u.lifetimeWtcEarned || 0} WTC</b>\n` +
        `✅ Tasks Completed: <b>${(u.completedTasks || []).length}</b>\n` +
        `👥 Referrals: <b>${u.referralCount || 0}</b>\n` +
        `📤 Withdrawals: <b>${wCount}</b> (${pendingWithdrawCount} pending) — <b>${totalWithdrawnWtc.toLocaleString()} WTC</b> approved lifetime\n` +
        `📺 Ads Watched (lifetime): <b>${u.lifetimeAdsWatched || 0}</b> · today: <b>${u.adsWatchedToday || 0}</b>\n` +
        `✅ Channel/Community Verified: <b>${u.channelVerified ? 'Yes' : 'No'}</b>\n` +
        `🚫 Banned: <b>${u.isBanned ? 'YES ⛔' : 'No ✅'}</b>\n` +
        `🔒 Locked: <b>${u.accountLocked ? `YES 🔒 (${u.accountLockedReason || 'unknown'})` : 'No ✅'}</b>\n` +
        // ⚠️ NEW — velocity alerts are now informational-only (see
        // api/user.js) and don't auto-lock, so surface them here too —
        // this is the "did the heuristic ever fire on this account"
        // signal, separate from whether they're actually locked right now.
        (u.velocityFlaggedAt ? `🚩 Velocity flagged: <b>YES</b> (${new Date(u.velocityFlaggedAt).toLocaleString()})\n` : '') +
        `📅 Joined: ${new Date(u.createdAt).toLocaleDateString()} (${accountAgeDays} day${accountAgeDays === 1 ? '' : 's'} ago)`;

    const options = { reply_markup: { inline_keyboard: [
        [u.isBanned ? { text: '✅ Unban User', callback_data: `unban_${u._id}` } : { text: '🚫 Ban User', callback_data: `ban_${u._id}` }],
        // ⚠️ CHANGED — Lock/Unlock is now a manual admin action either way
        // (velocity alerts no longer auto-lock), so both directions are
        // always available here instead of only showing Unlock once locked.
        [u.accountLocked ? { text: '🔓 Unlock Account', callback_data: `unlock_${u._id}` } : { text: '🔒 Lock Account', callback_data: `lock_${u._id}` }],
        [{ text: '💸 Confiscate Balance', callback_data: `zerobal_${u._id}` }, { text: '🔄 Reset Referrals', callback_data: `resetrefs_${u._id}` }],
        [{ text: '👥 View Their Referrals', callback_data: `a_refslist_${u._id}_0` }, { text: '💰 Send WTC', callback_data: `quickwtc_${u._id}` }],
        [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
    ] } };
    return [text, options];
}

// Sends a broadcast preview — lets the admin do a final check of what will be sent
async function sendBroadcastPreview(chatId, bs) {
    const extra = {};
    if (bs.buttonText && bs.buttonUrl) {
        extra.reply_markup = { inline_keyboard: [[{ text: bs.buttonText, url: bs.buttonUrl }], [{ text: '✅ Confirm & Send', callback_data: 'bc_confirm' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };
    } else {
        extra.reply_markup = { inline_keyboard: [[{ text: '✅ Confirm & Send', callback_data: 'bc_confirm' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };
    }

    await tgSend(chatId, '📢 <b>Broadcast — Step 4/4: Preview</b>\n\nThis is exactly what users will receive:');
    if (bs.photoFileId) {
        await tgSendPhoto(chatId, bs.photoFileId, bs.text, extra);
    } else {
        await tgSend(chatId, bs.text, extra);
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).json({ ok: true });

    const update = req.body;
    const { db } = await connectToDatabase();
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');
    const tasks = db.collection('tasks');
    const promos = db.collection('promos');
    const gifts = db.collection('gifts');

    // ⚠️ NEW (this update) — shared by both the "pasted a tx hash" and
    // "skipped" paths so approve/reject only has one place that actually
    // touches the DB and sends notifications. `txHash` is either a raw
    // hash/link string or null (skipped / rejection).
    async function finalizeWithdrawal({ w, approve, txHash, chatId, msgId }) {
        const wid = String(w._id);
        if (!approve) {
            // ⚠️ SEASON 4: withdrawals now deduct straight from `wtcBalance`
            // (no more convert-first usdtBalance step) — a rejected
            // withdrawal refunds that same `wtcAmount` back to wtcBalance.
            // If this withdrawal consumed one of the user's valid
            // referrals (referralConsumed:true — everything after their
            // first free withdraw), that referral is refunded too, so a
            // rejection never permanently costs them a valid referral.
            // withdrawPending:false — releases the one-at-a-time lock (see
            // api/withdraw.js) so the user can submit their next request.
            const refundUpdate = { $inc: { wtcBalance: w.wtcAmount || 0, withdrawalCount: -1 }, $set: { lastWithdrawDate: '', withdrawPending: false } };
            if (w.referralConsumed) refundUpdate.$inc.usedValidReferrals = -1;
            await users.updateOne({ _id: w.userId }, refundUpdate);
        } else {
            // withdrawPending:false — same lock release as the reject branch
            // above, just without the balance refund since the withdrawal
            // actually went through.
            await users.updateOne({ _id: w.userId }, { $set: { withdrawPending: false } });
        }

        // ⚠️ MOVED HERE (this update) — referral withdrawal commission used
        // to be paid the instant a withdrawal was REQUESTED, in
        // api/withdraw.js, before any admin review. That meant a referrer
        // kept their 10% cut even if the withdrawal was later rejected as
        // fraudulent, with no claw-back anywhere. Now it only fires on
        // actual approval, right here — a rejected withdrawal never pays a
        // commission in the first place, nothing to claw back.
        let referrerCommission = 0;
        if (approve && w.referrerId) {
            referrerCommission = Math.floor((w.wtcAmount || 0) * (WITHDRAW_REFERRAL_COMMISSION_PERCENT / 100));
            if (referrerCommission > 0) {
                try {
                    const referrerUpdate = await users.findOneAndUpdate(
                        { _id: w.referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
                        { $inc: { wtcBalance: referrerCommission, lifetimeWtcEarned: referrerCommission, referralCommissionEarned: referrerCommission } },
                        { returnDocument: 'after' }
                    );
                    if (referrerUpdate) {
                        tgSend(
                            w.referrerId,
                            `💰 <b>Referral Commission!</b>\n\nOne of your referrals just withdrew ${(w.wtcAmount || 0).toLocaleString()} WTC.\nYou earned <b>${referrerCommission.toLocaleString()} WTC</b> (10% commission) 🎉`
                        ).catch(() => {});
                    }
                } catch (e) { /* non-blocking — commission failure never blocks the approval itself */ }
            }
        }

        await withdrawals.updateOne({ _id: new ObjectId(wid) }, { $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date(), txHash: txHash || null, referrerCommissionPaid: referrerCommission } });

        // ⚠️ NEW — builds a real explorer link. If the admin pasted a full
        // URL, use it as-is; if they pasted a bare hash, assume it's a TON
        // transaction and link via tonviewer. Doesn't attempt to validate
        // the hash — that's on the admin, same as pasting an address today.
        const explorerUrl = txHash ? (txHash.startsWith('http') ? txHash : `https://tonviewer.com/transaction/${txHash}`) : null;

        const notif = approve
            ? `🎉 <b>Congratulations!</b>\n\n` +
              `You've received <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
              `📍 <code>${w.details}</code>\n\n` +
              `💪 Keep up the great work! Watch more ads, complete tasks, and refer your friends to earn even more WTC every day. 🚀`
            : `❌ <b>Withdrawal Rejected.</b>\n${(w.wtcAmount || 0).toLocaleString()} WTC has been refunded to your balance.`;
        // ⚠️ CHANGED — on approval, attach a "🔗 Transaction Hash" button
        // (when the admin provided one) alongside the existing payment-proof
        // channel button, same layout as TON Shooter Payment's channel posts.
        const notifButtons = [];
        if (approve && explorerUrl) notifButtons.push([{ text: '🔗 Transaction Hash', url: explorerUrl }]);
        if (approve) notifButtons.push([{ text: '📢 View Payment Channel', url: `https://t.me/${PAYMENT_CHANNEL.replace('@', '')}` }]);
        const notifExtra = notifButtons.length ? { reply_markup: { inline_keyboard: notifButtons } } : {};
        await tgSend(w.userId, notif, notifExtra);

        // ⚠️ Posts approved withdrawals to the public proof channel. Mirrors
        // Fruit Cut's "Withdrawal Completed" format, address masked.
        if (approve) {
            const maskAddr = (addr) => (addr && addr.length > 8) ? `${addr.slice(0, 4)}••••${addr.slice(-4)}` : addr;
            const proofText =
                `✅ <b>Withdrawal Completed</b>\n\n` +
                `👤 User: ${w.username ? '@' + w.username : '—'} (ID: <code>${w.userId}</code>)\n` +
                `💵 Amount: <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
                `📍 Address: <code>${maskAddr(w.details)}</code>`;
            const proofExtra = explorerUrl ? { reply_markup: { inline_keyboard: [[{ text: '🔗 Transaction Hash', url: explorerUrl }]] } } : {};
            await tgSendPhoto(PAYMENT_CHANNEL, PAYMENT_PROOF_PHOTO, proofText, proofExtra).catch((e) => {
                // Doesn't block the approval flow if the bot isn't an admin of
                // the channel yet, or the channel handle is wrong — but the
                // admin should know the post silently failed.
                tgSend(ADMIN_ID, `⚠️ Couldn't post approved withdrawal <code>${wid}</code> to ${PAYMENT_CHANNEL}. Make sure the bot is an admin there.\n\n${e?.message || e}`).catch(() => {});
            });
        }

        // The original withdrawal request message in the admin's chat (with the
        // Approve/Reject buttons) is edited to remove the buttons and show the
        // final status, including the tx hash if one was attached.
        const u = await users.findOne({ _id: w.userId }, { projection: { referralCount: 1, withdrawalCount: 1 } });
        const processedText =
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${w.userId}</code> (@${w.username || '?'})\n` +
            (w.wtcAmount ? `🪙 WTC: <b>${w.wtcAmount.toLocaleString()}</b>\n` : '') +
            `💰 Amount: <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
            `📤 Method: <b>${w.method}</b>\n` +
            `📍 Address: <code>${w.details}</code>\n` +
            `📊 Total withdrawals so far: <b>${u?.withdrawalCount ?? '?'}</b>\n` +
            `👥 Total referrals: <b>${u?.referralCount || 0}</b>\n` +
            `📅 ${new Date(w.createdAt).toLocaleString()}\n\n` +
            (txHash ? `🔗 TX: <code>${txHash}</code>\n\n` : '') +
            (approve ? `✅ <b>APPROVED</b> — ${new Date().toLocaleString()}` : `❌ <b>REJECTED (refunded)</b> — ${new Date().toLocaleString()}`);
        // ⚠️ Omitting reply_markup in Telegram leaves the old buttons in place — so
        // we send an empty inline_keyboard to remove the buttons outright.
        await tgEdit(chatId, msgId, processedText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════
    // CALLBACK QUERY
    // ══════════════════════════════════════════════════════════════
    if (update.callback_query) {
        const cb = update.callback_query;
        const fromId = String(cb.from.id);
        const data = cb.data;
        const chatId = cb.message.chat.id;
        const msgId = cb.message.message_id;

        await tgAnswerCallback(cb.id);

        // ── User: check channel + community join ──
        if (data.startsWith('check_join_')) {
            const userId = data.replace('check_join_', '');
            if (fromId !== userId) { await tgAnswerCallback(cb.id, '⛔ Not your button'); return res.status(200).json({ ok: true }); }
            const [ch, com] = await Promise.all([isMember(userId, OFFICIAL_CHANNEL), isMember(userId, COMMUNITY_GROUP)]);
            if (!ch || !com) {
                await tgAnswerCallback(cb.id, '❌ Join both channel & community first!', true);
                return res.status(200).json({ ok: true });
            }
            await users.updateOne({ _id: userId }, { $set: { channelVerified: true } });
            await maybeAwardReferralMilestones(db, userId, { channelVerified: true });
            await tgSendPhoto(chatId, COVER_PHOTO,
                `✅ <b>Verified! Welcome to Clover Nest!</b>\n\n🍀 Complete tasks · Earn WTC · Withdraw crypto!`,
                { reply_markup: { inline_keyboard: [
                    [{ text: '🚀 Open Clover Nest', web_app: { url: APP_URL } }],
                    [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL + '?startapp=' + userId)}&text=${encodeURIComponent('🍀 Join Clover Nest! Earn free WTC!')}` }],
                ] } }
            );
            return res.status(200).json({ ok: true });
        }

        // ── User confirms the "Wrong Address" penalty — ⚠️ NEW. NOT admin-gated
        // (the withdrawing user has to be the one pressing this) — verified by
        // matching fromId against the withdrawal's own userId, same pattern as
        // check_join_ above.
        if (data.startsWith('wd_addrconfirm_')) {
            const wid = data.replace('wd_addrconfirm_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            if (fromId !== String(w.userId)) {
                await tgAnswerCallback(cb.id, '⛔ Not your withdrawal', true);
                return res.status(200).json({ ok: true });
            }

            const wtcAmount = w
