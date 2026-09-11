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
    MIN_WITHDRAW_USDT, FIRST_WITHDRAW_MAX_USDT, WTC_PER_USD,
    WITHDRAWALS_OPEN, todayBD,
} from '../lib/constants.js';
import { applyCors } from '../lib/cors.js';

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
            firstWithdrawMaxUsdt: FIRST_WITHDRAW_MAX_USDT, // ⚠️ NEW — same cap, in already-converted USDT terms
            validReferralsAvailable,
        },
        minWithdrawUsdt: MIN_WITHDRAW_USDT, // ⚠️ NEW — lets the frontend validate the USDT-source amount without duplicating the constant
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
    // ⚠️ NEW — which balance is paying for this withdrawal. Defaults to the
    // original CN(wtcBalance)-direct path for backward compatibility;
    // 'usdt' pays out of the ledger that api/convert.js builds up (which,
    // before this, had no way to ever be spent).
    const source = req.body.source === 'usdt' ? 'usdt' : 'cn';

    if (!WITHDRAW_METHODS[method]) return res.status(400).json({ ok: false, error: 'invalid_method' });
    if (!details || !String(details).trim()) return res.status(400).json({ ok: false, error: 'missing_details' });

    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (user.accountLocked) return res.status(403).json({ ok: false, error: 'account_locked', reason: user.accountLockedReason || null });
    if (user.withdrawPending) return res.status(400).json({ ok: false, error: 'withdraw_pending' });

    const tasksHave = (user.completedTasks || []).length;
    if (tasksHave < WITHDRAW_TASKS_REQUIRED) return res.status(400).json({ ok: false, error: 'tasks_required' });

    // These anti-abuse gates apply the same way regardless of which balance
    // is paying out — they're about the ACCOUNT, not the currency.
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    if (!isFirstWithdraw) {
        const validReferralsAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
        if (validReferralsAvailable < WITHDRAW_VALID_REFERRALS_PER_WITHDRAW) {
            return res.status(400).json({ ok: false, error: 'no_valid_referral' });
        }
    }

    const methodInfo = WITHDRAW_METHODS[method];
    let wtcAmount, netUsd, balanceField, deductAmount;

    if (source === 'usdt') {
        // ── Already-converted USDT ledger — CONVERT_FEE_PERCENT was already
        // taken once at conversion time (api/convert.js), so it is NOT
        // charged again here; the ledger value goes out 1:1.
        const usdtAmount = Number(req.body.usdtAmount);
        if (!Number.isFinite(usdtAmount) || usdtAmount < MIN_WITHDRAW_USDT) return res.status(400).json({ ok: false, error: 'below_minimum' });
        if ((user.usdtBalance || 0) < usdtAmount) return res.status(400).json({ ok: false, error: 'insufficient_balance' });
        if (isFirstWithdraw && usdtAmount > FIRST_WITHDRAW_MAX_USDT) return res.status(400).json({ ok: false, error: 'first_withdraw_capped' });

        netUsd = usdtAmount;
        wtcAmount = Math.round(usdtAmount * WTC_PER_USD); // CN-equivalent, kept only for history/admin display consistency
        balanceField = 'usdtBalance';
        deductAmount = usdtAmount;
    } else {
        wtcAmount = Math.floor(Number(req.body.wtcAmount));
        if (!Number.isFinite(wtcAmount) || wtcAmount < MIN_WITHDRAW_WTC) return res.status(400).json({ ok: false, error: 'below_minimum' });
        if ((user.wtcBalance || 0) < wtcAmount) return res.status(400).json({ ok: false, error: 'insufficient_balance' });
        if (isFirstWithdraw && wtcAmount > FIRST_WITHDRAW_MAX_WTC) return res.status(400).json({ ok: false, error: 'first_withdraw_capped' });

        // ── net payout math — mirrors index.html's calcNetUsdDisplay() exactly ──
        const gross = methodInfo.wtcToCurrency(wtcAmount); // gross USD-equivalent
        const afterFirstFee = gross * (1 - WITHDRAW_FEE_PERCENT / 100);
        netUsd = afterFirstFee * (1 - WITHDRAW_SECOND_FEE_PERCENT / 100);
        balanceField = 'wtcBalance';
        deductAmount = wtcAmount;
    }

    // ── atomically deduct balance + lock (one withdraw at a time) ──
    const inc = { [balanceField]: -deductAmount, withdrawalCount: 1 };
    if (!isFirstWithdraw) inc.usedValidReferrals = 1;
    const claimed = await users.findOneAndUpdate(
        { _id: userId, [balanceField]: { $gte: deductAmount }, withdrawPending: { $ne: true } },
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
        source, // 'cn' or 'usdt' — which balance actually paid for this
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
            `🪙 Source: <b>${source === 'usdt' ? 'Converted USDT ledger' : 'CN balance'}</b>\n` +
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
    if (applyCors(req, res)) return;
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
