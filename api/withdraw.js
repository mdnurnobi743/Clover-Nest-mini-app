// api/withdraw.js — Season 4 single-step withdraw/convert: a user types a
// WTC (CN) amount (minimum MIN_WITHDRAW_WTC) and submits directly. A single
// WITHDRAW_FEE_PERCENT convert fee is taken (WITHDRAW_SECOND_FEE_PERCENT is
// kept at 0 — see lib/constants.js for the full spec and the exact math). The first
// withdrawal a user ever makes is free (no referral needed, capped at
// FIRST_WITHDRAW_MAX_WTC); every one after that spends exactly one "valid"
// referral (lib/referral.js).
//
//   GET  /api/withdraw?action=status&initData=...
//   GET  /api/withdraw?action=history&initData=...
//   POST /api/withdraw   body: { initData, method, details, wtcAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { tgSend } from '../lib/telegram.js';
import {
    WITHDRAW_METHODS, MIN_WITHDRAW_WTC, WITHDRAW_TASKS_REQUIRED,
    WITHDRAW_VALID_REFERRALS_PER_WITHDRAW, FIRST_WITHDRAW_MAX_WTC,
    WITHDRAW_FEE_PERCENT, WITHDRAW_SECOND_FEE_PERCENT,
    WITHDRAWALS_OPEN, todayBD,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID;

async function handleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const user = await db.collection('users').findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const tasksHave = (user.completedTasks || []).length;
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const validReferralsAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    const referralMet = isFirstWithdraw || validReferralsAvailable >= WITHDRAW_VALID_REFERRALS_PER_WITHDRAW;

    return res.status(200).json({
        ok: true,
        withdrawalsOpen: WITHDRAWALS_OPEN,
        withdrawRequirements: {
            tasksRequired: WITHDRAW_TASKS_REQUIRED,
            tasksHave,
            tasksMet: tasksHave >= WITHDRAW_TASKS_REQUIRED,
        },
        referralRequirement: {
            met: referralMet,
            isFirstWithdrawFree: isFirstWithdraw,
            firstWithdrawMaxWtc: FIRST_WITHDRAW_MAX_WTC,
            validReferralsAvailable,
        },
    });
}

async function handleHistory(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const history = await db.collection('withdrawals')
        .find({ userId })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

    return res.status(200).json({
        ok: true,
        history: history.map((h) => ({
            status: h.status, cashAmount: h.cashAmount, currency: h.currency,
            method: h.method, createdAt: h.createdAt,
        })),
    });
}

async function handleCreate(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    if (!WITHDRAWALS_OPEN) return res.status(200).json({ ok: false, error: 'withdrawals_closed' });

    const { method, details } = req.body;
    const wtcAmount = Math.floor(Number(req.body.wtcAmount));

    if (!WITHDRAW_METHODS[method]) return res.status(400).json({ ok: false, error: 'invalid_method' });
    if (!details || !String(details).trim()) return res.status(400).json({ ok: false, error: 'missing_details' });
    if (!Number.isFinite(wtcAmount) || wtcAmount < MIN_WITHDRAW_WTC) return res.status(400).json({ ok: false, error: 'below_minimum' });

    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (user.accountLocked) return res.status(403).json({ ok: false, error: 'account_locked', reason: user.accountLockedReason || null });
    if (user.withdrawPending) return res.status(400).json({ ok: false, error: 'withdraw_pending' });
    if ((user.wtcBalance || 0) < wtcAmount) return res.status(400).json({ ok: false, error: 'insufficient_balance' });

    const tasksHave = (user.completedTasks || []).length;
    if (tasksHave < WITHDRAW_TASKS_REQUIRED) return res.status(400).json({ ok: false, error: 'tasks_required' });

    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    if (isFirstWithdraw) {
        if (wtcAmount > FIRST_WITHDRAW_MAX_WTC) return res.status(400).json({ ok: false, error: 'first_withdraw_capped' });
    } else {
        const validReferralsAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
        if (validReferralsAvailable < WITHDRAW_VALID_REFERRALS_PER_WITHDRAW) {
            return res.status(400).json({ ok: false, error: 'no_valid_referral' });
        }
    }

    // ── net payout math — mirrors index.html's calcNetUsdDisplay() exactly ──
    const methodInfo = WITHDRAW_METHODS[method];
    const gross = methodInfo.wtcToCurrency(wtcAmount); // gross USD-equivalent
    const afterFirstFee = gross * (1 - WITHDRAW_FEE_PERCENT / 100);
    const netUsd = afterFirstFee * (1 - WITHDRAW_SECOND_FEE_PERCENT / 100);

    // ── atomically deduct balance + lock (one withdraw at a time) ──
    const inc = { wtcBalance: -wtcAmount, withdrawalCount: 1 };
    if (!isFirstWithdraw) inc.usedValidReferrals = 1;
    const claimed = await users.findOneAndUpdate(
        { _id: userId, wtcBalance: { $gte: wtcAmount }, withdrawPending: { $ne: true } },
        { $inc: inc, $set: { withdrawPending: true, lastWithdrawDate: todayBD() } },
        { returnDocument: 'after' }
    );
    if (!claimed) return res.status(400).json({ ok: false, error: 'insufficient_balance' });

    const withdrawal = {
        userId,
        username: user.telegramUsername,
        method,
        details: String(details).trim(),
        wtcAmount,
        cashAmount: netUsd,
        currency: methodInfo.currency,
        status: 'pending',
        referrerId: user.referredBy || null,
        referralConsumed: !isFirstWithdraw,
        createdAt: new Date(),
    };
    const inserted = await db.collection('withdrawals').insertOne(withdrawal);
    const wid = String(inserted.insertedId);

    if (ADMIN_ID) {
        const text =
            `💸 <b>New Withdrawal Request</b>\n\n` +
            `👤 <code>${userId}</code> (@${user.telegramUsername || '?'})\n` +
            `🪙 WTC: <b>${wtcAmount.toLocaleString()}</b>\n` +
            `💰 Amount: <b>${netUsd.toFixed(4)} ${methodInfo.currency}</b>\n` +
            `📤 Method: <b>${methodInfo.label}</b>\n` +
            `📍 Address: <code>${withdrawal.details}</code>\n` +
            `📊 Total withdrawals so far: <b>${(user.withdrawalCount || 0) + 1}</b>\n` +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            `📅 ${withdrawal.createdAt.toLocaleString()}`;
        await tgSend(ADMIN_ID, text, {
            reply_markup: { inline_keyboard: [[
                { text: '✅ Approve', callback_data: `wdapprove_${wid}` },
                { text: '❌ Reject', callback_data: `wdreject_${wid}` },
            ]] },
        }).catch(() => {});
    }

    return res.status(200).json({ ok: true, netUsd });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return handleStatus(req, res, db);
        if (action === 'history') return handleHistory(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        return handleCreate(req, res, db);
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
            }
