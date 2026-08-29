// api/gift.js — the "🎁 gift box" surprise: the admin can send an arbitrary
// user a WTC gift with a reason (see api/bot.js's a_sendgift flow), and the
// next time that user opens the app it pops up as a claimable gift box
// (see index.html's checkPendingGift/showGiftBox).
//
//   GET  /api/gift?action=check&initData=...
//   POST /api/gift   body: { initData, action: 'claim', giftId }

import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';

async function handleCheck(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    // The reason is shown BEFORE claiming, the amount only after — so this
    // intentionally never returns `amount` here.
    const gift = await db.collection('gifts').findOne(
        { userId, status: 'pending' },
        { projection: { reason: 1 }, sort: { createdAt: 1 } }
    );
    if (!gift) return res.status(200).json({ ok: true, gift: null });

    return res.status(200).json({ ok: true, gift: { id: String(gift._id), reason: gift.reason || '' } });
}

async function handleClaim(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { giftId } = req.body;
    let giftObjId;
    try { giftObjId = new ObjectId(giftId); } catch { return res.status(400).json({ ok: false, error: 'invalid_gift_id' }); }

    const gifts = db.collection('gifts');
    const claimed = await gifts.findOneAndUpdate(
        { _id: giftObjId, userId, status: 'pending' },
        { $set: { status: 'claimed', claimedAt: new Date() } },
        { returnDocument: 'after' }
    );
    if (!claimed) return res.status(400).json({ ok: false, error: 'already_claimed_or_not_found' });

    const amount = claimed.amount || 0;
    await db.collection('users').updateOne(
        { _id: userId },
        { $inc: { wtcBalance: amount, lifetimeWtcEarned: amount } }
    );

    return res.status(200).json({ ok: true, amount });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'check') return handleCheck(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'claim') return handleClaim(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
