// api/bot.js — Clover Nest Admin Panel Bot

import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { tgApi, tgSend, tgEdit, tgSendPhoto, tgAnswerCallback, isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP } from '../lib/telegram.js';
import { getAdminState, setAdminState, clearAdminState, claimAdminState } from '../lib/adminState.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { createBroadcastJob } from '../lib/broadcastJob.js';
import { waitUntil } from '@vercel/functions';
import { WEEKLY_REFERRAL_MIN_COUNT, WEEKLY_REFERRAL_MAX_WINNERS, WITHDRAW_REFERRAL_COMMISSION_PERCENT } from '../lib/constants.js';
import { markBanned, markUnbanned } from '../lib/banRegistry.js';
import { postPaymentProof } from '../lib/paymentProof.js';
import { referralCatchUp } from '../lib/referral.js';

// Small formatter shared by the Manage Tasks listings — daily tasks priced
// in USDT show both the USDT figure and its converted CN amount, everything
// else just shows plain CN.
function taskRewardLine(t) {
    return t.rewardCurrency === 'usdt' ? `${t.rewardUsdt} USDT (≈${t.rewardWtc} CN)` : `${t.rewardWtc} CN`;
}


// signup using the exact same registry logic as a manual admin ban here.

// var saved as ADMIN_ID, so ADMIN_ID here was always undefined and the
const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID;

const APP_URL = 'https://clover-nest-t5mz.vercel.app';                   // your Mini App's Vercel URL
const MINI_APP_URL = 'https://t.me/Clover_nest_bot/OpenApp';                // ⚠️ FIX — was '/CloverNest', a short name that was never actually registered with BotFather (the real one is '/OpenApp', confirmed working). Every referral link generated from this constant was opening to a dead/non-existent Mini App short name instead of launching the app.
const BOT_USERNAME = 'Clover_nest_bot';                                     // must match MINI_APP_URL
const COVER_PHOTO = 'https://i.postimg.cc/0yZxJ2bk/file-00000000da8082089e0dbda0a05b43c1.png';

const adminKb = {
    inline_keyboard: [
        [{ text: '📊 Dashboard', callback_data: 'a_stats' }, { text: '💸 Withdrawals', callback_data: 'a_pending' }],
        [{ text: '👤 User Lookup', callback_data: 'a_user' }, { text: '👥 All Users', callback_data: 'a_allusers_0' }],
        [{ text: '🏆 Top Referrers', callback_data: 'a_toprefer' }, { text: '📅 Weekly Refer', callback_data: 'a_weekly' }],
        [{ text: '📜 Weekly Report', callback_data: 'a_weekly_history' }],
        [{ text: '📋 Add Task', callback_data: 'a_addtask' }, { text: '🗑 Manage Tasks', callback_data: 'a_managetasks_0' }],
        [{ text: '🎟 Add Promo', callback_data: 'a_addpromo' }, { text: '📋 View Promos', callback_data: 'a_viewpromos_0' }],
        [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }, { text: '🎯 Referral Catch-up', callback_data: 'a_refcatchup' }],
        [{ text: '💰 Send CN', callback_data: 'a_sendwtc' }, { text: '🎁 Send Gift', callback_data: 'a_sendgift' }],
    ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

// database is clean, the pasted (polluted) string won't match, and
function obscureCode(code) {
    return code.split('').join('\u2060');
}
const cancelKb = { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };

// Promo codes are now always machine-generated (6 random digits) instead of
// admin-typed, so two admins/fingers can't collide on something guessable
// like "SAVE10". Re-rolls a few times against the DB on the off chance of a
// duplicate before giving up (999,000 possible codes, so this basically
// never loops more than once).
async function generatePromoCode(promos) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        // eslint-disable-next-line no-await-in-loop
        const clash = await promos.findOne({ code });
        if (!clash) return code;
    }
    throw new Error('Could not generate a unique promo code, try again.');
}

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
        `💰 Balance: <b>${u.wtcBalance || 0} CN</b>\n` +
        `💎 Lifetime Earned: <b>${u.lifetimeWtcEarned || 0} CN</b>\n` +
        `✅ Tasks Completed: <b>${(u.completedTasks || []).length}</b>\n` +
        `👥 Referrals: <b>${u.referralCount || 0}</b>\n` +
        `📤 Withdrawals: <b>${wCount}</b> (${pendingWithdrawCount} pending) — <b>${totalWithdrawnWtc.toLocaleString()} CN</b> approved lifetime\n` +
        `📺 Ads Watched (lifetime): <b>${u.lifetimeAdsWatched || 0}</b> · today: <b>${u.adsWatchedToday || 0}</b>\n` +
        `✅ Channel/Community Verified: <b>${u.channelVerified ? 'Yes' : 'No'}</b>\n` +
        `🚫 Banned: <b>${u.isBanned ? 'YES ⛔' : 'No ✅'}</b>\n` +
        `🔒 Locked: <b>${u.accountLocked ? `YES 🔒 (${u.accountLockedReason || 'unknown'})` : 'No ✅'}</b>\n` +
        // api/user.js) and don't auto-lock, so surface them here too —
        (u.velocityFlaggedAt ? `🚩 Velocity flagged: <b>YES</b> (${new Date(u.velocityFlaggedAt).toLocaleString()})\n` : '') +
        `📅 Joined: ${new Date(u.createdAt).toLocaleDateString()} (${accountAgeDays} day${accountAgeDays === 1 ? '' : 's'} ago)`;

    const options = { reply_markup: { inline_keyboard: [
        [u.isBanned ? { text: '✅ Unban User', callback_data: `unban_${u._id}` } : { text: '🚫 Ban User', callback_data: `ban_${u._id}` }],
        // (velocity alerts no longer auto-lock), so both directions are
        [u.accountLocked ? { text: '🔓 Unlock Account', callback_data: `unlock_${u._id}` } : { text: '🔒 Lock Account', callback_data: `lock_${u._id}` }],
        [{ text: '💸 Confiscate Balance', callback_data: `zerobal_${u._id}` }, { text: '🔄 Reset Referrals', callback_data: `resetrefs_${u._id}` }],
        [{ text: '👥 View Their Referrals', callback_data: `a_refslist_${u._id}_0` }, { text: '💰 Send CN', callback_data: `quickwtc_${u._id}` }],
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

    // ── Webhook authenticity check ──
    // Without this, ANYONE (curl/Postman/Termux) could POST a forged
    // Telegram "update" straight to this URL — no real Telegram client
    // needed — and set from.id to the admin's ID to unlock every admin
    // action below (approve withdrawals, sendwtc, broadcast, etc.).
    // Telegram signs every real webhook call with this header once
    // setWebhook was called with a matching secret_token (see deploy notes).
    const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET;
    if (!WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Everything below can throw (DB hiccup, a Telegram API call failing,
    // a bad assumption about update shape, etc.). This whole function used
    // to have NO top-level try/catch at all, so any such error crashed the
    // invocation outright: Vercel logs a FUNCTION_INVOCATION_FAILED entry,
    // but the admin's Telegram chat gets nothing — no error message, no
    // "something went wrong", just silence, and a non-200 response also
    // makes Telegram retry the same update later (sometimes replaying a
    // half-finished admin action). Routing everything through handleUpdate
    // and catching here fixes both: the admin is told what broke, and we
    // still ack Telegram with 200 so it doesn't keep retrying a request
    // that's already failed.
    try {
        return await handleUpdate(req, res);
    } catch (err) {
        console.error('api/bot.js: unhandled error while processing update', err);
        const adminId = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID;
        if (adminId) {
            await tgSend(adminId, `⚠️ <b>Bot error</b>\n\nSomething broke while handling the last action:\n<code>${(err && err.message) || String(err)}</code>\n\nCheck Vercel's function logs for the full trace.`).catch(() => {});
        }
        if (!res.headersSent) return res.status(200).json({ ok: true });
    }
}

async function handleUpdate(req, res) {
    const update = req.body;
    const { db } = await connectToDatabase();
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');
    const tasks = db.collection('tasks');
    const promos = db.collection('promos');
    const gifts = db.collection('gifts');

    // "skipped" paths so approve/reject only has one place that actually
    async function finalizeWithdrawal({ w, approve, txHash, chatId, msgId }) {
        const wid = String(w._id);
        if (!approve) {
            // (no more convert-first usdtBalance step) — a rejected
            // Withdrawals are paid out of the converted-USDT ledger (api/withdraw.js
            // deducts usdtBalance, source:'usdt'), so a rejection must refund THAT
            // ledger — not CN. Old CN-source requests (source !== 'usdt') still
            // get their CN back exactly as before.
            const refundUpdate = { $inc: { withdrawalCount: -1 }, $set: { lastWithdrawDate: '', withdrawPending: false } };
            if (w.source === 'usdt') refundUpdate.$inc.usdtBalance = Number(w.cashAmount || 0);
            else refundUpdate.$inc.wtcBalance = w.wtcAmount || 0;
            if (w.referralConsumed) refundUpdate.$inc.usedValidReferrals = -1;
            await users.updateOne({ _id: w.userId }, refundUpdate);
        } else {
            // withdrawPending:false — same lock release as the reject branch
            // above, just without the balance refund since the withdrawal
            // actually went through.
            await users.updateOne({ _id: w.userId }, { $set: { withdrawPending: false } });
        }

        // to be paid the instant a withdrawal was REQUESTED, in
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
                            `💰 <b>Referral Commission!</b>\n\nOne of your referrals just withdrew ${(w.wtcAmount || 0).toLocaleString()} CN.\nYou earned <b>${referrerCommission.toLocaleString()} CN</b> (10% commission) 🎉`
                        ).catch(() => {});
                    }
                } catch (e) { /* non-blocking — commission failure never blocks the approval itself */ }
            }
        }

        await withdrawals.updateOne({ _id: new ObjectId(wid) }, { $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date(), txHash: txHash || null, referrerCommissionPaid: referrerCommission } });

        // URL, use it as-is; if they pasted a bare hash, assume it's a TON
        const explorerUrl = txHash ? (txHash.startsWith('http') ? txHash : `https://tonviewer.com/transaction/${txHash}`) : null;

        const notif = approve
            ? `🎉 <b>Congratulations!</b>\n\n` +
              `You've received <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
              `📍 <code>${w.details}</code>\n\n` +
              `💪 Keep up the great work! Watch more ads, complete tasks, and refer your friends to earn even more CN every day. 🚀`
            : `❌ <b>Withdrawal Not Approved.</b>\n${w.source === 'usdt' ? `${Number(w.cashAmount || 0).toFixed(4)} USDT` : `${(w.wtcAmount || 0).toLocaleString()} CN`} has been refunded to your balance.`;
        const notifButtons = [];
        if (approve && explorerUrl) notifButtons.push([{ text: '🔗 Transaction Hash', url: explorerUrl }]);
        const notifExtra = notifButtons.length ? { reply_markup: { inline_keyboard: notifButtons } } : {};
        await tgSend(w.userId, notif, notifExtra);

        // The original withdrawal request message in the admin's chat (with the
        // Approve/Reject buttons) is edited to remove the buttons and show the
        // final status, including the tx hash if one was attached.
        const u = await users.findOne({ _id: w.userId }, { projection: { referralCount: 1, withdrawalCount: 1 } });
        const processedText =
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${w.userId}</code> (@${w.username || '?'})\n` +
            (w.wtcAmount ? `🪙 CN: <b>${w.wtcAmount.toLocaleString()}</b>\n` : '') +
            `💰 Amount: <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
            `📤 Method: <b>${w.method}</b>\n` +
            `📍 Address: <code>${w.details}</code>\n` +
            `📊 Total withdrawals so far: <b>${u?.withdrawalCount ?? '?'}</b>\n` +
            `👥 Total referrals: <b>${u?.referralCount || 0}</b>\n` +
            `📅 ${new Date(w.createdAt).toLocaleString()}\n\n` +
            (txHash ? `🔗 TX: <code>${txHash}</code>\n\n` : '') +
            (approve ? `✅ <b>APPROVED</b> — ${new Date().toLocaleString()}` : `❌ <b>REJECTED (refunded)</b> — ${new Date().toLocaleString()}`);
        // we send an empty inline_keyboard to remove the buttons outright.
        await tgEdit(chatId, msgId, processedText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});

        // ── Payment proof → public proof channel (approved withdrawals only) ──
        // Photo + @username + amount + method, with "✅ APPROVED" at the bottom.
        // Failure here never affects the approval itself; the admin is just told.
        if (approve) {
            const fullUser = await users.findOne({ _id: w.userId }, { projection: { firstName: 1 } });
            const proof = await postPaymentProof({ ...w, processedAt: new Date() }, { txHash, user: fullUser });
            if (proof.ok) {
                await withdrawals.updateOne({ _id: new ObjectId(wid) }, { $set: { proofPostedAt: new Date(), proofMessageId: proof.messageId } }).catch(() => {});
            } else {
                await tgSend(chatId,
                    `⚠️ <b>Approved, but the payment proof was NOT posted to the proof channel.</b>\n\n` +
                    `<code>${String(proof.error || 'unknown error').replace(/</g, '&lt;')}</code>\n\n` +
                    `Make sure the bot is an <b>admin</b> of @clovernestpaymentproof with “Post messages” permission.`
                ).catch(() => {});
            }
        }
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
                `You're all set — start growing your clover garden into real rewards. 🌿\n\n` +
                `💰 Earn <b>Clover Coin (CN)</b> by completing tasks\n` +
                `📅 Watch daily ads for extra CN\n` +
                `👥 Invite friends & earn together\n` +
                `🎉 New events & bonuses every week\n\n` +
                `👇 Tap below to open the app!`,
                { reply_markup: { inline_keyboard: [
                    [{ text: '🚀 Open Clover Nest', web_app: { url: APP_URL } }],
                    [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL + '?startapp=' + userId)}&text=${encodeURIComponent('🍀 Join Clover Nest! Earn free CN!')}` }],
                ] } }
            );
            return res.status(200).json({ ok: true });
        }

        // anyway?" step) was referenced here in the version this file was
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

        // ── Referral catch-up: pay every referral bonus friends already earned ──
        // Step 1 = preview only (nothing is paid), step 2 = confirm & pay. Safe to
        // repeat: each milestone is paid once per friend (lib/referral.js).
        if (data === 'a_refcatchup') {
            const p = await referralCatchUp(db, { dryRun: true });
            await tgSend(chatId,
                `🎯 <b>Referral Catch-up — preview</b>\n\n` +
                `👥 Referred users checked: <b>${p.friendsChecked.toLocaleString()}</b>\n` +
                `🎁 Friends with unpaid bonuses: <b>${p.friendsWithRewards.toLocaleString()}</b>\n` +
                `💰 Bonuses to pay: <b>${p.bonuses.toLocaleString()}</b> = <b>${p.paidCn.toLocaleString()} CN</b>\n` +
                `✅ Referrals that become valid: <b>${p.validAdded.toLocaleString()}</b>\n\n` +
                `Bonuses: +30 join · +100 (5 tasks) · +180 (20 ads). Nothing has been paid yet.` +
                (p.bonuses === 0 ? `\n\n✅ Everything is already up to date.` : ''),
                { reply_markup: { inline_keyboard: p.bonuses > 0 || p.validAdded > 0
                    ? [[{ text: `✅ Pay ${p.paidCn.toLocaleString()} CN now`, callback_data: 'a_refcatchup_go' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]]
                    : [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            return res.status(200).json({ ok: true });
        }
        if (data === 'a_refcatchup_go') {
            await tgEdit(chatId, msgId, '⏳ <b>Paying referral bonuses…</b>', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
            const r = await referralCatchUp(db, { dryRun: false });
            await tgSend(chatId,
                `✅ <b>Referral Catch-up done</b>\n\n` +
                `🎁 Friends rewarded: <b>${r.friendsWithRewards.toLocaleString()}</b>\n` +
                `💰 Paid: <b>${r.bonuses.toLocaleString()}</b> bonuses = <b>${r.paidCn.toLocaleString()} CN</b>\n` +
                `✅ Newly valid referrals: <b>${r.validAdded.toLocaleString()}</b>` +
                (r.partial ? `\n\n⚠️ Ran out of time — tap <b>🎯 Referral Catch-up</b> again to continue.` : `\n\nReferrers were notified.`),
                { reply_markup: backKb });
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
                `✅ Approved Lifetime: <b>${approved.wtc.toLocaleString()} CN</b> (≈$${(approved.usd || 0).toFixed(2)})`;
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
                    `🪙 CN: <b>${(w.wtcAmount || 0).toLocaleString()}</b>\n` +
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
            const lines = list.map((u) => `<code>${u._id}</code> — ${u.firstName} (@${u.telegramUsername || 'none'}) — ${(u.wtcBalance || 0).toLocaleString()} CN${u.isBanned ? ' 🚫' : ''}`).join('\n') || 'No users.';
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
        // ⚠️ UPDATED — description step removed per request. Wizard is now
        // 5 steps: title → type → url → category → reward.
        if (data === 'a_addtask') {
            await setAdminState(db, fromId, { step: 'addtask_title', task: {} });
            await tgSend(chatId, '📋 <b>Add Task — Step 1/5</b>\n\nSend the task title.', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        // ── Task Type step — this is THE verification method (independent of
        // category, which is just the reward-tier badge shown in the app).
        // 'api'  → Telegram channel/group join, verified server-side via
        //          getChatMember (no fake-claiming possible).
        // 'link' → bot / website / any external link — can't be verified
        //          server-side, so it uses the sign-token + wait-then-claim flow.
        if (data.startsWith('addtask_type_')) {
            const st = await getAdminState(db, fromId);
            if (!st || st.step !== 'addtask_type') return res.status(200).json({ ok: true });
            const verifyType = data.replace('addtask_type_', ''); // 'api' | 'link'
            st.task.verifyType = verifyType;
            await setAdminState(db, fromId, { step: 'addtask_url', task: st.task });
            const prompt = verifyType === 'api'
                ? '📋 <b>Add Task — Step 3/5</b>\n\nSend the channel/group @username (e.g. <code>@channelname</code>) that users must join. This will be checked automatically by the bot.'
                : '📋 <b>Add Task — Step 3/5</b>\n\nSend the task link/URL (bot or website).';
            await tgSend(chatId, prompt, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('addtask_cat_')) {
            const st = await getAdminState(db, fromId);
            if (!st || st.step !== 'addtask_category') return res.status(200).json({ ok: true });
            st.task.category = data.replace('addtask_cat_', '');
            // ⚠️ Reward currency is always CN now (USDT reward option removed
            // per admin request) — straight to the amount step, no currency pick.
            st.task.rewardCurrency = 'wtc';
            await setAdminState(db, fromId, { step: 'addtask_reward', task: st.task });
            await tgSend(chatId, '📋 <b>Add Task — Step 5/5</b>\n\nSend the reward amount (in CN).', { reply_markup: cancelKb });
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

        // ── Add Promo wizard ── admin picks how many codes to generate first,
        // then reward/maxuses apply to the whole batch — the codes themselves
        // are only rolled at the very end, once all 3 answers are in.
        if (data === 'a_addpromo') {
            await setAdminState(db, fromId, { step: 'addpromo_count', promo: {} });
            await tgSend(chatId, '🎟 <b>Add Promo — Step 1/3</b>\n\nকয়টি promo code generate করতে চান? একটা সংখ্যা পাঠান (যেমন 1, 5, 10)।', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('a_viewpromos_')) {
            const page = parseInt(data.replace('a_viewpromos_', ''), 10) || 0;
            const pageSize = 10;
            const list = await promos.find({}).sort({ createdAt: -1 }).skip(page * pageSize).limit(pageSize).toArray();
            const total = await promos.countDocuments({});
            const lines = list.map((p) => `<code>${p.code}</code> — ${p.reward} CN — ${p.usedCount || 0}/${p.maxUses || '∞'} used`).join('\n') || 'No promos yet.';
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
            // Bug: this used to clearAdminState() here, deleting the
            // broadcast draft from the DB right before showing the preview.
            // bc_confirm ("✅ Confirm & Send") then looked the state up
            // again, found nothing, and silently did nothing (just a small
            // "Nothing to send" toast on the button — easy to miss, looks
            // exactly like the button "not working"). The draft has to stay
            // saved (step moved to 'broadcast_preview') until Confirm/Cancel
            // is actually pressed.
            await setAdminState(db, fromId, { step: 'broadcast_preview', broadcast: st.broadcast });
            await sendBroadcastPreview(chatId, st.broadcast);
            return res.status(200).json({ ok: true });
        }
        if (data === 'bc_confirm') {
            // Atomic claim (findOneAndDelete) instead of getAdminState +
            // clearAdminState: only ONE invocation of this handler can ever
            // win the state document. This matters because we now AWAIT the
            // full send below rather than firing it and returning instantly
            // (see note further down on why), so if Telegram doesn't get a
            // response quickly enough and redelivers the same update, this
            // guard is what stops the broadcast from going out twice instead
            // of once.
            const st = await claimAdminState(db, fromId);
            if (!st || !st.broadcast) { await tgAnswerCallback(cb.id, 'Nothing to send', true); return res.status(200).json({ ok: true }); }
            const allUserIds = (await users.find({}, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
            const bs = st.broadcast;
            const extra = (bs.buttonText && bs.buttonUrl) ? { reply_markup: { inline_keyboard: [[{ text: bs.buttonText, url: bs.buttonUrl }]] } } : {};
            await tgSend(chatId, `📢 Broadcasting to ${allUserIds.length} users now — I'll message you when it's done.`);

            // Previously this only did `waitUntil(createBroadcastJob(...))`
            // without awaiting it, on the assumption that the function would
            // keep running in the background after this handler's response
            // was sent. That background-continuation behavior is a Vercel
            // "Fluid Compute" feature — on a project without Fluid Compute
            // enabled, the container can freeze the instant the response
            // goes out, silently killing the job before a single message is
            // sent (no error is thrown anywhere, which is why it looked like
            // a total, silent failure rather than a crash). `waitUntil` is
            // still called too, so nothing is lost when Fluid Compute IS
            // available, but the actual delivery no longer depends on it:
            // we await the job directly, so the messages are provably sent
            // before this request ever completes. api/bot.js's maxDuration
            // was raised (see vercel.json) to give this room to run.
            const jobPromise = createBroadcastJob(db, { userIds: allUserIds, text: bs.text, photoFileId: bs.photoFileId, extra, adminId: fromId });
            waitUntil(jobPromise);
            await jobPromise;
            return res.status(200).json({ ok: true });
        }

        // ── Send CN wizard ──
        if (data === 'a_sendwtc' || data.startsWith('quickwtc_')) {
            const targetId = data.startsWith('quickwtc_') ? data.replace('quickwtc_', '') : null;
            await setAdminState(db, fromId, { step: targetId ? 'sendwtc_amount' : 'sendwtc_userid', targetUserId: targetId });
            await tgSend(chatId, targetId ? `💰 Send how much CN to <code>${targetId}</code>?` : '💰 <b>Send CN — Step 1/2</b>\n\nSend the user\'s numeric Telegram ID.', { reply_markup: cancelKb });
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
        // ⚠️ FIX — the admin panel / wizards / user flows below are PRIVATE-CHAT ONLY.
        // The bot is an admin in the community group and receives every message
        // there; previously a message from the admin's own account in the group was
        // treated as an admin-panel input ("User not found.", the Admin Panel menu
        // popping up, …). Anything that isn't a private chat with the bot is now ignored.
        if (msg.chat?.type !== 'private' || !msg.from) return res.status(200).json({ ok: true });

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
                    await setAdminState(db, fromId, { step: 'addtask_type', task: st.task });
                    await tgSend(chatId, '📋 <b>Add Task — Step 2/5</b>\n\nTask type?\n\n🔗 <b>Api Task</b> — Telegram channel/group join, auto-verified by the bot.\n🌐 <b>None Api Task</b> — Telegram bot or website link, user just taps Claim after visiting.', {
                        reply_markup: { inline_keyboard: [[{ text: '🔗 Api Task', callback_data: 'addtask_type_api' }, { text: '🌐 None Api Task', callback_data: 'addtask_type_link' }]] },
                    });
                    return res.status(200).json({ ok: true });
                case 'addtask_url': {
                    if (st.task.verifyType === 'api') {
                        // must be a @username (also accepts a raw numeric chat id)
                        const handle = text.startsWith('@') ? text : (/^-?\d+$/.test(text) ? text : `@${text}`);
                        st.task.channelId = handle;
                        st.task.url = handle.startsWith('@') ? `https://t.me/${handle.slice(1)}` : st.task.url || '';
                    } else {
                        st.task.url = text;
                    }
                    await setAdminState(db, fromId, { step: 'addtask_category', task: st.task });
                    // ⚠️ "Daily" removed from this picker — the Daily sub-tab in the
                    // mini app is now the dedicated ad-network reward hub (Monetag/
                    // GigaPub), not a manually-created task list, so a task saved
                    // with category:'daily' would never actually be shown to anyone.
                    await tgSend(chatId, '📋 <b>Add Task — Step 4/5</b>\n\nCategory?', {
                        reply_markup: { inline_keyboard: [
                            [{ text: 'Channel', callback_data: 'addtask_cat_channel' }, { text: 'Exclusive', callback_data: 'addtask_cat_exclusive' }],
                            [{ text: 'Partner', callback_data: 'addtask_cat_partner' }, { text: 'Earning', callback_data: 'addtask_cat_earning' }],
                        ] },
                    });
                    return res.status(200).json({ ok: true });
                }
                case 'addtask_reward': {
                    const amount = parseFloat(text);
                    if (isNaN(amount) || amount <= 0) { await tgSend(chatId, 'Send a valid positive number.'); return res.status(200).json({ ok: true }); }
                    // ⚠️ Reward is always CN now — USDT reward option removed.
                    st.task.rewardWtc = Math.round(amount);
                    delete st.task.rewardUsdt;
                    await clearAdminState(db, fromId);
                    const inserted = await tasks.insertOne({ ...st.task, isApproved: true, completionCount: 0, createdAt: new Date() });
                    await tgSend(chatId, `✅ Task added (<code>${inserted.insertedId}</code>).\n\nType: ${st.task.verifyType === 'api' ? '🔗 Api Task' : '🌐 None Api Task'}\nCategory: ${st.task.category}\nReward: ${st.task.rewardWtc} CN`, { reply_markup: backKb });
                    return res.status(200).json({ ok: true });
                }

                // ── Add Promo wizard — how-many-codes was asked in the
                // a_addpromo callback above; the actual codes are only
                // rolled at the very end, once amount + max-uses are known. ──
                case 'addpromo_count': {
                    const count = parseInt(text, 10);
                    if (isNaN(count) || count <= 0 || count > 100) { await tgSend(chatId, 'Send a valid whole number between 1 and 100.'); return res.status(200).json({ ok: true }); }
                    st.promo.count = count;
                    await setAdminState(db, fromId, { step: 'addpromo_amount', promo: st.promo });
                    await tgSend(chatId, '🎟 <b>Add Promo — Step 2/3</b>\n\nSend the reward amount (CN).', { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                }
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
                    const codes = [];
                    try {
                        for (let i = 0; i < st.promo.count; i++) {
                            // eslint-disable-next-line no-await-in-loop
                            const code = await generatePromoCode(promos);
                            // eslint-disable-next-line no-await-in-loop
                            await promos.insertOne({ code, reward: st.promo.reward, maxUses: maxUses || 9999, usedCount: 0, redeemedBy: [], createdAt: new Date() });
                            codes.push(code);
                        }
                        // ⚠️ FIXED — these were being run through obscureCode(),
                        // which sneaks an invisible U+2060 word-joiner between
                        // every digit (built for the old hand-typed codes, to
                        // discourage copy-paste). A random 6-digit code is too
                        // easy to mistype though, so admins naturally copy it —
                        // the hidden characters came along for the ride, the
                        // stored code didn't match, and redemption failed with
                        // "Invalid code". Plain text now, so copy-paste works.
                        const list = codes.map((c) => `<code>${c}</code>`).join('\n');
                        await tgSend(chatId, `✅ ${codes.length} promo code${codes.length > 1 ? 's' : ''} added — ${st.promo.reward} CN each:\n\n${list}`, { reply_markup: backKb });
                    } catch (e) {
                        const madeSoFar = codes.length ? `\n\n(${codes.length} code${codes.length > 1 ? 's' : ''} were already added before this error: ${codes.join(', ')})` : '';
                        await tgSend(chatId, `❌ Error: ${e.message}${madeSoFar}`, { reply_markup: backKb });
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
                    // Same bug as bc_skip_button above: keep the draft saved
                    // (as 'broadcast_preview') instead of clearing it here —
                    // otherwise bc_confirm finds nothing and the Confirm &
                    // Send button does nothing.
                    await setAdminState(db, fromId, { step: 'broadcast_preview', broadcast: st.broadcast });
                    await sendBroadcastPreview(chatId, st.broadcast);
                    return res.status(200).json({ ok: true });

                // ── Send CN wizard ──
                case 'sendwtc_userid': {
                    const u = await users.findOne({ _id: text });
                    if (!u) { await tgSend(chatId, 'User not found. Send a valid numeric ID.'); return res.status(200).json({ ok: true }); }
                    await setAdminState(db, fromId, { step: 'sendwtc_amount', targetUserId: text });
                    await tgSend(chatId, `💰 <b>Send CN — Step 2/2</b>\n\nHow much CN to send to ${u.firstName} (<code>${text}</code>)?`, { reply_markup: cancelKb });
                    return res.status(200).json({ ok: true });
                }
                case 'sendwtc_amount': {
                    const amount = parseFloat(text);
                    if (isNaN(amount) || amount <= 0) { await tgSend(chatId, 'Send a valid positive number.'); return res.status(200).json({ ok: true }); }
                    await clearAdminState(db, fromId);
                    const result = await users.updateOne({ _id: st.targetUserId }, { $inc: { wtcBalance: amount, lifetimeWtcEarned: amount } });
                    if (result.matchedCount === 0) { await tgSend(chatId, 'User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
                    await tgSend(chatId, `✅ Sent ${amount.toLocaleString()} CN to <code>${st.targetUserId}</code>.`, { reply_markup: backKb });
                    await tgSend(st.targetUserId, `🎉 The admin just sent you <b>${amount.toLocaleString()} CN</b>!`).catch(() => {});
                    return res.status(200).json({ ok: true });
                }

                // ── Send Gift wizard ──
                case 'sendgift_userid': {
                    const u = await users.findOne({ _id: text });
                    if (!u) { await tgSend(chatId, 'User not found. Send a valid numeric ID.'); return res.status(200).json({ ok: true }); }
                    await setAdminState(db, fromId, { step: 'sendgift_amount', targetUserId: text });
                    await tgSend(chatId, `🎁 <b>Send Gift — Step 2/3</b>\n\nHow much CN?`, { reply_markup: cancelKb });
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
                    await tgSend(chatId, `✅ Gift of ${st.giftAmount.toLocaleString()} CN queued for <code>${st.targetUserId}</code> — they'll see it next time they open the app.`, { reply_markup: backKb });
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
                `Grow your own clover garden and turn it into real rewards. 🌿\n\n` +
                `💰 Earn <b>Clover Coin (CN)</b> by completing simple tasks\n` +
                `📅 Watch daily ads for extra CN — resets every day\n` +
                `🎡 Spin the wheel & play mini-games for bonus CN\n` +
                `👥 Invite friends and earn together, forever\n` +
                `🔄 Convert CN to USDT and withdraw your earnings\n\n` +
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
