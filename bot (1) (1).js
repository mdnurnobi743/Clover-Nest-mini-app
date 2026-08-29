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

// ⚠️ FIXED — was reading ADMIN_TELEGRAM_ID, but the Vercel project has this
// var saved as ADMIN_ID, so ADMIN_ID here was always undefined and the
// admin panel could never trigger. Reads whichever name is actually set.
const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID;

// ⚠️ Replace these two lines with your real values:
const APP_URL = 'https://clover-nest-t5mz.vercel.app';                   // your Mini App's Vercel URL
const MINI_APP_URL = 'https://t.me/Clover_nest_bot/CloverNest';         // ✅ updated
const BOT_USERNAME = 'Clover_nest_bot';                                    // ⚠️ must match MINI_APP_URL
const COVER_PHOTO = 'https://i.postimg.cc/QMK37JPS/rsz-file-000000004780821187d7edc195953101.png';

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
                `✅ <b>Verified! Welcome to Clover Nest!</b>\n\n` +
                `🍀 <b>Collect Clover Leaves & Earn Real Cash!</b>\n\n` +
                `💰 Earn <b>$0.50 – $10</b> Daily\n` +
                `👥 Invite Friends & Earn Together\n` +
                `🎉 Enjoy Exciting New Events Every Week`,
                { reply_markup: { inline_keyboard: [
                    [{ text: '🚀 Open Clover Nest', web_app: { url: APP_URL } }],
                    [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL + '?startapp=' + userId)}&text=${encodeURIComponent('🍀 Join Clover Nest! Earn free WTC!')}` }],
                ] } }
            );
            return res.status(200).json({ ok: true });
        }

        // ⚠️ NOTE — wd_addrconfirm_ (a "this address looks malformed, confirm
        // anyway?" step) was referenced here in the version this file was
        // reconstructed from, but api/withdraw.js's actual submit flow is a
        // single-step POST with no such pre-confirmation stage, so this
        // callback_data is never produced by the current frontend. Kept as a
        // harmless no-op fallback in case it's wired up again later.
        if (data.startsWith('wd_addrconfirm_')) {
            await tgAnswerCallback(cb.id, 'Nothing to confirm — this request was already processed the normal way.', true);
            return res.status(200).json({ ok: true });
        }

        // ── ADMIN-ONLY from here down ──
        if (fromId !== ADMIN_ID) {
            await tgAnswerCallback(cb.id, '⛔ Admins only', true);
            return res.status(200).json({ ok: true });
        }

        // ── Withdrawal approve / reject ──
        if (data.startsWith('wdapprove_') || data.startsWith('wdreject_')) {
            const approve = data.startsWith('wdapprove_');
            const wid = data.replace(approve ? 'wdapprove_' : 'wdreject_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            if (!approve) {
                await finalizeWithdrawal({ w, approve: false, txHash: null, chatId, msgId });
                return res.status(200).json({ ok: true });
            }
            // Approving — ask for an optional tx hash before finalizing.
            await setAdminState(db, fromId, { step: 'awaiting_tx_hash', withdrawalId: wid, chatId, msgId });
            await tgSend(chatId, `Paste the transaction hash/link for withdrawal <code>${wid}</code>, or tap Skip.`, {
                reply_markup: { inline_keyboard: [[{ text: '⏭ Skip', callback_data: `wdskiptx_${wid}` }]] },
            });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('wdskiptx_')) {
            const wid = data.replace('wdskiptx_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') { await tgAnswerCallback(cb.id, 'Already processed', true); return res.status(200).json({ ok: true }); }
            await clearAdminState(db, fromId);
            await finalizeWithdrawal({ w, approve: true, txHash: null, chatId, msgId });
            return res.status(200).json({ ok: true });
        }

        // ── Main menu / cancel ──
        if (data === 'a_menu') {
            await clearAdminState(db, fromId);
            await tgEdit(chatId, msgId, '🛠 <b>Clover Nest Admin Panel</b>', { reply_markup: adminKb }).catch(() => tgSend(chatId, '🛠 <b>Clover Nest Admin Panel</b>', { reply_markup: adminKb }));
            return res.status(200).json({ ok: true });
        }

        // ── Dashboard ──
        if (data === 'a_stats') {
            const [totalUsers, bannedCount, lockedCount, pendingCount, approvedAgg, newTodayCount] = await Promise.all([
                users.countDocuments({}),
                users.countDocuments({ isBanned: true }),
                users.countDocuments({ accountLocked: true }),
                withdrawals.countDocuments({ status: 'pending' }),
                withdrawals.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, wtc: { $sum: '$wtcAmount' }, usd: { $sum: '$cashAmount' } } }]).toArray(),
                users.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
            ]);
            const approved = approvedAgg[0] || { wtc: 0, usd: 0 };
            const text =
                `📊 <b>Dashboard</b>\n\n` +
                `👥 Total Users: <b>${totalUsers.toLocaleString()}</b>\n` +
                `🆕 New (24h): <b>${newTodayCount.toLocaleString()}</b>\n` +
                `🚫 Banned: <b>${bannedCount.toLocaleString()}</b> · 🔒 Locked: <b>${lockedCount.toLocaleString()}</b>\n` +
                `💸 Pending Withdrawals: <b>${pendingCount.toLocaleString()}</b>\n` +
                `✅ Approved Lifetime: <b>${approved.wtc.toLocaleString()} WTC</b> (≈$${(approved.usd || 0).toFixed(2)})`;
            await tgSend(chatId, text, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Pending withdrawals ──
        if (data === 'a_pending') {
            const pending = await withdrawals.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(20).toArray();
            if (!pending.length) { await tgSend(chatId, '✅ No pending withdrawals.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            for (const w of pending) {
                const text =
                    `💸 <b>Withdrawal Request</b>\n\n` +
                    `👤 <code>${w.userId}</code> (@${w.username || '?'})\n` +
                    `🪙 WTC: <b>${(w.wtcAmount || 0).toLocaleString()}</b>\n` +
                    `💰 Amount: <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
                    `📤 Method: <b>${w.method}</b>\n` +
                    `📍 Address: <code>${w.details}</code>\n` +
                    `📅 ${new Date(w.createdAt).toLocaleString()}`;
                await tgSend(chatId, text, { reply_markup: { inline_keyboard: [[
                    { text: '✅ Approve', callback_data: `wdapprove_${w._id}` },
                    { text: '❌ Reject', callback_data: `wdreject_${w._id}` },
                ]] } });
            }
            await tgSend(chatId, `Showing ${pending.length} pending request(s).`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── User lookup (by numeric ID or @username, or direct lookup_{id} from an alert button) ──
        if (data === 'a_user') {
            await setAdminState(db, fromId, { step: 'awaiting_user_lookup' });
            await tgSend(chatId, '🔎 Send the user\'s numeric Telegram ID or @username.', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('lookup_')) {
            const uid = data.replace('lookup_', '');
            const u = await users.findOne({ _id: uid });
            if (!u) { await tgSend(chatId, 'User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            const wList = await withdrawals.find({ userId: uid }).toArray();
            await tgSend(chatId, ...renderUserLookup(u, wList));
            return res.status(200).json({ ok: true });
        }

        // ── All users (paginated, 10/page) ──
        if (data.startsWith('a_allusers_')) {
            const page = parseInt(data.replace('a_allusers_', ''), 10) || 0;
            const pageSize = 10;
            const list = await users.find({}).sort({ createdAt: -1 }).skip(page * pageSize).limit(pageSize).toArray();
            const total = await users.countDocuments({});
            const lines = list.map((u) => `<code>${u._id}</code> — ${u.firstName} (@${u.telegramUsername || 'none'}) — ${(u.wtcBalance || 0).toLocaleString()} WTC${u.isBanned ? ' 🚫' : ''}`).join('\n') || 'No users.';
            const nav = [];
            if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `a_allusers_${page - 1}` });
            if ((page + 1) * pageSize < total) nav.push({ text: 'Next ▶️', callback_data: `a_allusers_${page + 1}` });
            const kb = { inline_keyboard: [...(nav.length ? [nav] : []), backKb.inline_keyboard[0]] };
            await tgSend(chatId, `👥 <b>All Users</b> (page ${page + 1}, ${total} total)\n\n${lines}`, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }

        // ── Top referrers ──
        if (data === 'a_toprefer') {
            const top = await users.find({}).sort({ referralCount: -1 }).limit(10).toArray();
            const lines = top.map((u, i) => `${i + 1}. ${u.firstName} (@${u.telegramUsername || 'none'}) — <b>${u.referralCount || 0}</b> refs — <code>${u._id}</code>`).join('\n') || 'No users.';
            await tgSend(chatId, `🏆 <b>Top Referrers</b>\n\n${lines}`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Weekly referral competition ──
        if (data === 'a_weekly') {
            const qualifiers = await users.find({ weeklyReferralCount: { $gte: WEEKLY_REFERRAL_MIN_COUNT } })
                .sort({ weeklyReferralCount: -1 }).limit(WEEKLY_REFERRAL_MAX_WINNERS).toArray();
            const lines = qualifiers.map((u, i) => `${i + 1}. ${u.firstName} (@${u.telegramUsername || 'none'}) — <b>${u.weeklyReferralCount}</b> refs this week — <code>${u._id}</code>`).join('\n')
                || `No one has crossed ${WEEKLY_REFERRAL_MIN_COUNT} referrals this week yet.`;
            await tgSend(chatId, `📅 <b>Weekly Referral Competition</b>\n\nMin. ${WEEKLY_REFERRAL_MIN_COUNT} refs to qualify · top ${WEEKLY_REFERRAL_MAX_WINNERS} win\n\n${lines}`, {
                reply_markup: { inline_keyboard: [[{ text: '🔄 Reset week now', callback_data: 'a_weeklyreset_confirm' }], backKb.inline_keyboard[0]] },
            });
            return res.status(200).json({ ok: true });
        }
        if (data === 'a_weeklyreset_confirm') {
            await tgSend(chatId, '⚠️ This snapshots current qualifiers into the weekly report, then zeroes everyone\'s weekly count. Confirm?', {
                reply_markup: { inline_keyboard: [[{ text: '✅ Yes, reset', callback_data: 'a_weeklyreset_do' }], backKb.inline_keyboard[0]] },
            });
            return res.status(200).json({ ok: true });
        }
        if (data === 'a_weeklyreset_do') {
            const qualifiers = await users.find({ weeklyReferralCount: { $gte: WEEKLY_REFERRAL_MIN_COUNT } })
                .sort({ weeklyReferralCount: -1 }).limit(WEEKLY_REFERRAL_MAX_WINNERS).toArray();
            await db.collection('weeklyReferralReports').insertOne({
                createdAt: new Date(),
                winners: qualifiers.map((u) => ({ userId: u._id, firstName: u.firstName, telegramUsername: u.telegramUsername, weeklyReferralCount: u.weeklyReferralCount })),
            });
            await users.updateMany({}, { $set: { weeklyReferralCount: 0 } });
            await tgSend(chatId, `✅ Week reset. ${qualifiers.length} winner(s) snapshotted to the report — send their rewards manually.`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }
        if (data === 'a_weekly_history') {
            const reports = await db.collection('weeklyReferralReports').find({}).sort({ createdAt: -1 }).limit(5).toArray();
            if (!reports.length) { await tgSend(chatId, 'No weekly reports yet.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            for (const r of reports) {
                const lines = r.winners.map((w, i) => `${i + 1}. ${w.firstName} (@${w.telegramUsername || 'none'}) — ${w.weeklyReferralCount} refs`).join('\n') || 'No qualifiers that week.';
                await tgSend(chatId, `📜 <b>Weekly Report — ${new Date(r.createdAt).toLocaleDateString()}</b>\n\n${lines}`);
            }
            await tgSend(chatId, `Showing last ${reports.length} report(s).`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Add Task wizard ──
        if (data === 'a_addtask') {
            await setAdminState(db, fromId, { step: 'addtask_title', task: {} });
            await tgSend(chatId, '📋 <b>Add Task — Step 1/6</b>\n\nSend the task title.', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('addtask_cat_')) {
            const st = await getAdminState(db, fromId);
            if (!st || st.step !== 'addtask_category') return res.status(200).json({ ok: true });
            st.task.category = data.replace('addtask_cat_', '');
            await setAdminState(db, fromId, { step: 'addtask_currency', task: st.task });
            await tgSend(chatId, '📋 <b>Add Task — Step 5/6</b>\n\nReward currency?', {
                reply_markup: { inline_keyboard: [[{ text: 'WTC', callback_data: 'addtask_cur_wtc' }, { text: 'USDT', callback_data: 'addtask_cur_usdt' }]] },
            });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('addtask_cur_')) {
            const st = await getAdminState(db, fromId);
            if (!st || st.step !== 'addtask_currency') return res.status(200).json({ ok: true });
            st.task.rewardCurrency = data.replace('addtask_cur_', '');
            await setAdminState(db, fromId, { step: 'addtask_reward', task: st.task });
            await tgSend(chatId, `📋 <b>Add Task — Step 6/6</b>\n\nSend the reward amount (in ${st.task.rewardCurrency.toUpperCase()}).`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── Manage Tasks ──
        if (data.startsWith('a_managetasks_')) {
            const page = parseInt(data.replace('a_managetasks_', ''), 10) || 0;
            const pageSize = 8;
            const list = await tasks.find({}).sort({ createdAt: -1 }).skip(page * pageSize).limit(pageSize).toArray();
            const total = await tasks.countDocuments({});
            if (!list.length) { await tgSend(chatId, 'No tasks yet.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            for (const t of list) {
                await tgSend(chatId, `📋 <b>${t.title}</b>\n${taskRewardLine(t)} · ${t.category}${t.isApproved ? '' : ' · ⏸ hidden'}`, {
                    reply_markup: { inline_keyboard: [[
                        { text: t.isApproved ? '⏸ Hide' : '▶️ Show', callback_data: `tasktoggle_${t._id}` },
                        { text: '🗑 Delete', callback_data: `deltask_${t._id}` },
                    ]] },
                });
            }
            const nav = [];
            if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `a_managetasks_${page - 1}` });
            if ((page + 1) * pageSize < total) nav.push({ text: 'Next ▶️', callback_data: `a_managetasks_${page + 1}` });
            await tgSend(chatId, `Showing page ${page + 1} (${total} total).`, { reply_markup: { inline_keyboard: [...(nav.length ? [nav] : []), backKb.inline_keyboard[0]] } });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('tasktoggle_')) {
            const tid = data.replace('tasktoggle_', '');
            const t = await tasks.findOne({ _id: new ObjectId(tid) });
            if (t) await tasks.updateOne({ _id: t._id }, { $set: { isApproved: !t.isApproved } });
            await tgAnswerCallback(cb.id, t ? (t.isApproved ? 'Hidden' : 'Now visible') : 'Not found');
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('deltask_')) {
            const tid = data.replace('deltask_', '');
            await tasks.deleteOne({ _id: new ObjectId(tid) });
            await tgAnswerCallback(cb.id, '🗑 Deleted', true);
            return res.status(200).json({ ok: true });
        }

        // ── Add Promo wizard ──
        if (data === 'a_addpromo') {
            await setAdminState(db, fromId, { step: 'addpromo_code', promo: {} });
            await tgSend(chatId, '🎟 <b>Add Promo — Step 1/3</b>\n\nSend the promo code (letters/numbers, no spaces).', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('a_viewpromos_')) {
            const page = parseInt(data.replace('a_viewpromos_', ''), 10) || 0;
            const pageSize = 10;
            const list = await promos.find({}).sort({ createdAt: -1 }).skip(page * pageSize).limit(pageSize).toArray();
            const total = await promos.countDocuments({});
            const lines = list.map((p) => `<code>${p.code}</code> — ${p.reward} WTC — ${p.usedCount || 0}/${p.maxUses || '∞'} used`).join('\n') || 'No promos yet.';
            const delRow = list.map((p) => ({ text: `🗑 ${p.code}`, callback_data: `delpromo_${p._id}` }));
            const nav = [];
            if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `a_viewpromos_${page - 1}` });
            if ((page + 1) * pageSize < total) nav.push({ text: 'Next ▶️', callback_data: `a_viewpromos_${page + 1}` });
            const rows = [];
            for (let i = 0; i < delRow.length; i += 2) rows.push(delRow.slice(i, i + 2));
            if (nav.length) rows.push(nav);
            rows.push(backKb.inline_keyboard[0]);
            await tgSend(chatId, `🎟 <b>Promos</b> (page ${page + 1}, ${total} total)\n\n${lines}`, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('delpromo_')) {
            const pid = data.replace('delpromo_', '');
            await promos.deleteOne({ _id: new ObjectId(pid) });
            await tgAnswerCallback(cb.id, '🗑 Deleted', true);
            return res.status(200).json({ ok: true });
        }

        // ── Broadcast wizard ──
        if (data === 'a_broadcast') {
            await setAdminState(db, fromId, { step: 'broadcast_text', broadcast: {} });
            await tgSend(chatId, '📢 <b>Broadcast — Step 1/4</b>\n\nSend the message text (or a photo with caption).', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data === 'bc_skip_button') {
            const st = await getAdminState(db, fromId);
            if (!st || st.step !== 'broadcast_button_text') return res.status(200).json({ ok: true });
            await clearAdminState(db, fromId);
            await sendBroadcastPreview(chatId, st.broadcast);
            return res.status(200).json({ ok: true });
        }
        if (data === 'bc_confirm') {
            const st = await getAdminState(db, fromId);
            if (!st || !st.broadcast) { await tgAnswerCallback(cb.id, 'Nothing to send', true); return res.status(200).json({ ok: true }); }
            await clearAdminState(db, fromId);
            const allUserIds = (await users.find({}, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
            const bs = st.broadcast;
            const extra = (bs.buttonText && bs.buttonUrl) ? { reply_markup: { inline_keyboard: [[{ text: bs.buttonText, url: bs.buttonUrl }]] } } : {};
            await tgSend(chatId, `📢 Broadcasting to ${allUserIds.length} users in the background — I'll message you when it's done.`);
            waitUntil(createBroadcastJob(db, { userIds: allUserIds, text: bs.text, photoFileId: bs.photoFileId, extra, adminId: fromId }));
            return res.status(200).json({ ok: true });
        }

        // ── Send WTC wizard ──
        if (data === 'a_sendwtc' || data.startsWith('quickwtc_')) {
            const targetId = data.startsWith('quickwtc_') ? data.replace('quickwtc_', '') : null;
            await setAdminState(db, fromId, { step: targetId ? 'sendwtc_amount' : 'sendwtc_userid', targetUserId: targetId });
            await tgSend(chatId, targetId ? `💰 Send how much WTC to <code>${targetId}</code>?` : '💰 <b>Send WTC — Step 1/2</b>\n\nSend the user\'s numeric Telegram ID.', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── Send Gift wizard ──
        if (data === 'a_sendgift') {
            await setAdminState(db, fromId, { step: 'sendgift_userid' });
            await tgSend(chatId, '🎁 <b>Send Gift — Step 1/3</b>\n\nSend the user\'s numeric Telegram ID.', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── Moderation actions (from renderUserLookup's buttons) ──
        if (data.startsWith('ban_') || data.startsWith('unban_')) {
            const ban = data.startsWith('ban_');
            const uid = data.replace(ban ? 'ban_' : 'unban_', '');
            if (ban) await markBanned(db, uid, 'manual'); else await markUnbanned(db, uid);
            await tgAnswerCallback(cb.id, ban ? '🚫 Banned' : '✅ Unbanned', true);
            const u = await users.findOne({ _id: uid });
            if (u) { const wList = await withdrawals.find({ userId: uid }).toArray(); await tgSend(chatId, ...renderUserLookup(u, wList)); }
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('lock_') || data.startsWith('unlock_')) {
            const lock = data.startsWith('lock_') && !data.startsWith('unlock_');
            const uid = data.replace(lock ? 'lock_' : 'unlock_', '');
            await users.updateOne({ _id: uid }, lock ? { $set: { accountLocked: true, accountLockedReason: 'manual' } } : { $set: { accountLocked: false }, $unset: { accountLockedReason: '' } });
            await tgAnswerCallback(cb.id, lock ? '🔒 Locked' : '🔓 Unlocked', true);
            const u = await users.findOne({ _id: uid });
            if (u) { const wList = await withdrawals.find({ userId: uid }).toArray(); await tgSend(chatId, ...renderUserLookup(u, wList)); }
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('zerobal_')) {
            const uid = data.replace('zerobal_', '');
            await users.updateOne({ _id: uid }, { $set: { wtcBalance: 0, usdtBalance: 0 } });
            await tgAnswerCallback(cb.id, '💸 Balance confiscated', true);
            const u = await users.findOne({ _id: uid });
            if (u) { const wList = await withdrawals.find({ userId: uid }).toArray(); await tgSend(chatId, ...renderUserLookup(u, wList)); }
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('resetrefs_')) {
            const uid = data.replace('resetrefs_', '');
            await users.updateOne({ _id: uid }, { $set: { referralCount: 0, weeklyReferralCount: 0, validReferralCount: 0, usedValidReferrals: 0 } });
            await tgAnswerCallback(cb.id, '🔄 Referrals reset', true);
            const u = await users.findOne({ _id: uid });
            if (u) { const wList = await withdrawals.find({ userId: uid }).toArray(); await tgSend(chatId, ...renderUserLookup(u, wList)); }
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('a_refslist_')) {
            const rest = data.replace('a_refslist_', '');
            const lastUnderscore = rest.lastIndexOf('_');
            const uid = rest.slice(0, lastUnderscore);
            const page = parseInt(rest.slice(lastUnderscore + 1), 10) || 0;
            const pageSize = 10;
            const list = await users.find({ referredBy: uid }).sort({ createdAt: -1 }).skip(page * pageSize).limit(pageSize).toArray();
            const total = await users.countDocuments({ referredBy: uid });
            const lines = list.map((u) => `${u.firstName} (@${u.telegramUsername || 'none'}) — <code>${u._id}</code>${u.referralValidDone ? ' ✅ valid' : ''}`).join('\n') || 'No referrals.';
            await tgSend(chatId, `👥 <b>Referrals of</b> <code>${uid}</code> (page ${page + 1}, ${total} total)\n\n${lines}`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // Unknown callback — ignore quietly.
        return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    // MESSAGE (text / photo)
    // ══════════════════════════════════════════════════════════════
    if (update.message) {
        const msg = update.message;
        const chatId = msg.chat.id;
        const fromId = String(msg.from.id);
        const text = (msg.text || '').trim();
        const photoFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;

        // ── Admin ──
        if (fromId === ADMIN_ID) {
            if (text === '/start' || text === '/admin' || text === '/cancel') {
                await clearAdminState(db, fromId);
                await tgSend(chatId, text === '/cancel' ? 'Cancelled.' : '🛠 <b>Clover Nest Admin Panel</b>', { reply_markup: adminKb });
                return res.status(200).json({ ok: true });
            }

            const st = await getAdminState(db, fromId);
            if (!st) { await tgSend(chatId, '🛠 <b>Clover Nest Admin Panel</b>', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }

            switch (st.step) {
                case 'awaiting_tx_hash': {
                    const w = await withdrawals.findOne({ _id: new ObjectId(st.withdrawalId) });
                    await clearAdminState(db, fromId);
                    if (!w || w.status !== 'pending') { await tgSend(chatId, 'Already processed.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
                    await finalizeWithdrawal({ w, approve: true, txHash: text, chatId: st.chatId, msgId: st.msgId });
                    return res.status(200).json({ ok: true });
                }

                case 'awaiting_user_lookup': {
                    await clearAdminState(db, fromId);
                    let query = text.replace('@', '');
                    let u = /^\d+$/.test(query) ? await users.findOne({ _id: query }) : await users.findOne({ telegramUsername: query });
                    if (!u) { await tgSend(chatId, 'User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
                    const wList = await withdrawals.find({ userId: u._id }).toArray();
                    await tgSend(chatId, ...renderUserLookup(u, wList));
                    return res.status(200).json({ ok: true });
                }

                // ── Add Task wizard ──
                case 'addtask_title':
                    st.task.title = text;
                    await setAdminState(db, fromId, { step: 'addtask_desc', task: st.task });
                    await tgSend(chatId, '📋 <b>Add Task — Step 2/6</b>\n\nSend the task description.', { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                case 'addtask_desc':
                    st.task.description = text;
                    await setAdminState(db, fromId, { step: 'addtask_url', task: st.task });
                    await tgSend(chatId, '📋 <b>Add Task — Step 3/6</b>\n\nSend the task link/URL (or the @channel username for a Channel Join task).', { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                case 'addtask_url':
                    st.task.url = text;
                    if (text.startsWith('@')) st.task.channelId = text;
                    await setAdminState(db, fromId, { step: 'addtask_category', task: st.task });
                    await tgSend(chatId, '📋 <b>Add Task — Step 4/6</b>\n\nCategory?', {
                        reply_markup: { inline_keyboard: [
                            [{ text: 'Channel', callback_data: 'addtask_cat_channel' }, { text: 'Daily', callback_data: 'addtask_cat_daily' }],
                            [{ text: 'Exclusive', callback_data: 'addtask_cat_exclusive' }, { text: 'Partner', callback_data: 'addtask_cat_partner' }],
                            [{ text: 'Earning', callback_data: 'addtask_cat_earning' }],
                        ] },
                    });
                    return res.status(200).json({ ok: true });
                case 'addtask_reward': {
                    const amount = parseFloat(text);
                    if (isNaN(amount) || amount <= 0) { await tgSend(chatId, 'Send a valid positive number.'); return res.status(200).json({ ok: true }); }
                    if (st.task.rewardCurrency === 'usdt') { st.task.rewardUsdt = amount; st.task.rewardWtc = Math.round(amount * WTC_PER_USD); }
                    else { st.task.rewardWtc = Math.round(amount); }
                    await clearAdminState(db, fromId);
                    const inserted = await tasks.insertOne({ ...st.task, isApproved: true, completionCount: 0, createdAt: new Date() });
                    await tgSend(chatId, `✅ Task added (<code>${inserted.insertedId}</code>).`, { reply_markup: backKb });
                    return res.status(200).json({ ok: true });
                }

                // ── Add Promo wizard ──
                case 'addpromo_code':
                    st.promo.code = text.toUpperCase().replace(/\s+/g, '');
                    await setAdminState(db, fromId, { step: 'addpromo_amount', promo: st.promo });
                    await tgSend(chatId, '🎟 <b>Add Promo — Step 2/3</b>\n\nSend the reward amount (WTC).', { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                case 'addpromo_amount': {
                    const amount = parseInt(text, 10);
                    if (isNaN(amount) || amount <= 0) { await tgSend(chatId, 'Send a valid positive whole number.'); return res.status(200).json({ ok: true }); }
                    st.promo.reward = amount;
                    await setAdminState(db, fromId, { step: 'addpromo_maxuses', promo: st.promo });
                    await tgSend(chatId, '🎟 <b>Add Promo — Step 3/3</b>\n\nMax number of uses? (send 0 for unlimited)', { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                }
                case 'addpromo_maxuses': {
                    const maxUses = parseInt(text, 10);
                    if (isNaN(maxUses) || maxUses < 0) { await tgSend(chatId, 'Send a valid number (0 = unlimited).'); return res.status(200).json({ ok: true }); }
                    await clearAdminState(db, fromId);
                    try {
                        await promos.insertOne({ code: st.promo.code, reward: st.promo.reward, maxUses: maxUses || 9999, usedCount: 0, redeemedBy: [], createdAt: new Date() });
                        await tgSend(chatId, `✅ Promo <code>${obscureCode(st.promo.code)}</code> added.`, { reply_markup: backKb });
                    } catch (e) {
                        await tgSend(chatId, e.code === 11000 ? '❌ That code already exists.' : `❌ Error: ${e.message}`, { reply_markup: backKb });
                    }
                    return res.status(200).json({ ok: true });
                }

                // ── Broadcast wizard ──
                case 'broadcast_text':
                    st.broadcast.text = msg.caption || text;
                    if (photoFileId) st.broadcast.photoFileId = photoFileId;
                    await setAdminState(db, fromId, { step: 'broadcast_button_text', broadcast: st.broadcast });
                    await tgSend(chatId, '📢 <b>Broadcast — Step 2/4</b>\n\nSend a button label (optional), or tap Skip.', {
                        reply_markup: { inline_keyboard: [[{ text: '⏭ Skip', callback_data: 'bc_skip_button' }]] },
                    });
                    return res.status(200).json({ ok: true });
                case 'broadcast_button_text':
                    st.broadcast.buttonText = text;
                    await setAdminState(db, fromId, { step: 'broadcast_button_url', broadcast: st.broadcast });
                    await tgSend(chatId, '📢 <b>Broadcast — Step 3/4</b>\n\nSend the button URL.', { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                case 'broadcast_button_url':
                    st.broadcast.buttonUrl = text;
                    await clearAdminState(db, fromId);
                    await sendBroadcastPreview(chatId, st.broadcast);
                    return res.status(200).json({ ok: true });

                // ── Send WTC wizard ──
                case 'sendwtc_userid': {
                    const u = await users.findOne({ _id: text });
                    if (!u) { await tgSend(chatId, 'User not found. Send a valid numeric ID.'); return res.status(200).json({ ok: true }); }
                    await setAdminState(db, fromId, { step: 'sendwtc_amount', targetUserId: text });
                    await tgSend(chatId, `💰 <b>Send WTC — Step 2/2</b>\n\nHow much WTC to send to ${u.firstName} (<code>${text}</code>)?`, { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                }
                case 'sendwtc_amount': {
                    const amount = parseFloat(text);
                    if (isNaN(amount) || amount <= 0) { await tgSend(chatId, 'Send a valid positive number.'); return res.status(200).json({ ok: true }); }
                    await clearAdminState(db, fromId);
                    const result = await users.updateOne({ _id: st.targetUserId }, { $inc: { wtcBalance: amount, lifetimeWtcEarned: amount } });
                    if (result.matchedCount === 0) { await tgSend(chatId, 'User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
                    await tgSend(chatId, `✅ Sent ${amount.toLocaleString()} WTC to <code>${st.targetUserId}</code>.`, { reply_markup: backKb });
                    await tgSend(st.targetUserId, `🎉 The admin just sent you <b>${amount.toLocaleString()} WTC</b>!`).catch(() => {});
                    return res.status(200).json({ ok: true });
                }

                // ── Send Gift wizard ──
                case 'sendgift_userid': {
                    const u = await users.findOne({ _id: text });
                    if (!u) { await tgSend(chatId, 'User not found. Send a valid numeric ID.'); return res.status(200).json({ ok: true }); }
                    await setAdminState(db, fromId, { step: 'sendgift_amount', targetUserId: text });
                    await tgSend(chatId, `🎁 <b>Send Gift — Step 2/3</b>\n\nHow much WTC?`, { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                }
                case 'sendgift_amount': {
                    const amount = parseFloat(text);
                    if (isNaN(amount) || amount <= 0) { await tgSend(chatId, 'Send a valid positive number.'); return res.status(200).json({ ok: true }); }
                    await setAdminState(db, fromId, { step: 'sendgift_reason', targetUserId: st.targetUserId, giftAmount: amount });
                    await tgSend(chatId, `🎁 <b>Send Gift — Step 3/3</b>\n\nSend a short reason (shown to the user before they claim).`, { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                }
                case 'sendgift_reason': {
                    await clearAdminState(db, fromId);
                    await gifts.insertOne({ userId: st.targetUserId, amount: st.giftAmount, reason: text, status: 'pending', sentBy: fromId, createdAt: new Date() });
                    await tgSend(chatId, `✅ Gift of ${st.giftAmount.toLocaleString()} WTC queued for <code>${st.targetUserId}</code> — they'll see it next time they open the app.`, { reply_markup: backKb });
                    return res.status(200).json({ ok: true });
                }

                default:
                    await clearAdminState(db, fromId);
                    await tgSend(chatId, '🛠 <b>Clover Nest Admin Panel</b>', { reply_markup: adminKb });
                    return res.status(200).json({ ok: true });
            }
        }

        // ── Regular user ──
        if (text.startsWith('/start')) {
            await tgSendPhoto(chatId, COVER_PHOTO,
                `🍀 <b>Welcome to Clover Nest!</b>\n\n` +
                `🍀 <b>Collect Clover Leaves & Earn Real Cash!</b>\n\n` +
                `💰 Earn <b>$0.50 – $10</b> Daily\n` +
                `👥 Invite Friends & Earn Together\n` +
                `🎉 Enjoy Exciting New Events Every Week\n\n` +
                `👇 Tap below to get started!`,
                { reply_markup: { inline_keyboard: [
                    [{ text: '🚀 Open Clover Nest', web_app: { url: APP_URL } }],
                    [{ text: '📢 Channel', url: `https://t.me/${OFFICIAL_CHANNEL.replace('@', '')}` }, { text: '👥 Community', url: `https://t.me/${COMMUNITY_GROUP.replace('@', '')}` }],
                ] } }
            );
            return res.status(200).json({ ok: true });
        }

        return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
}
