// api/convert.js — Convert CN (in-app currency) into the user's internal
// USDT ledger balance (usdtBalance). This is DELIBERATELY separate from
// api/withdraw.js: converting does NOT pay out to an external wallet, it
// only moves value from wtcBalance into usdtBalance so the user can see it
// building up on the Convert screen. Withdraw still pays out straight from
// wtcBalance at the same WTC_PER_USD rate and is completely untouched by
// this endpoint — the two balances are independent.
//
//   POST /api/convert   body: { initData, wtcAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { MIN_CONVERT_WTC, CONVERT_FEE_PERCENT, WTC_PER_USD } from '../lib/constants.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const wtcAmount = Math.floor(Number(req.body?.wtcAmount));
    if (!Number.isFinite(wtcAmount) || wtcAmount < MIN_CONVERT_WTC) {
        return res.status(400).json({ ok: false, error: 'below_minimum' });
    }

    const { db } = await connectToDatabase();
    const users = db.collection('users');

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (user.accountLocked) return res.status(403).json({ ok: false, error: 'account_locked', reason: user.accountLockedReason || null });
    if ((user.wtcBalance || 0) < wtcAmount) return res.status(400).json({ ok: false, error: 'insufficient_balance' });

    // ── net conversion math — mirrors index.html's calcConvertPreview() ──
    const grossUsd = wtcAmount / WTC_PER_USD;
    const netUsd = grossUsd * (1 - CONVERT_FEE_PERCENT / 100);

    // ── atomic: only succeeds if the CN balance is still there ──
    const updated = await users.findOneAndUpdate(
        { _id: userId, wtcBalance: { $gte: wtcAmount } },
        { $inc: { wtcBalance: -wtcAmount, usdtBalance: netUsd } },
        { returnDocument: 'after' }
    );
    if (!updated) return res.status(400).json({ ok: false, error: 'insufficient_balance' });

    return res.status(200).json({
        ok: true,
        wtcBalance: updated.wtcBalance,
        usdtBalance: updated.usdtBalance,
        converted: { wtcAmount, grossUsd, netUsd, feePercent: CONVERT_FEE_PERCENT },
    });
}
