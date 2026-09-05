// api/spin.js — Spin Wheel.
//
// Every request still requires a verified Telegram initData, and the userId
// extracted from it is the only one ever trusted. The wheel outcome is
// picked server-side with a weighted random draw over SPIN_SEGMENTS
// (lib/constants.js) — the client only ever finds out which wedge won
// AFTER the DB has already been updated, so there is no way to observe a
// result and then bail out before it's credited.
//
//   { action: 'spin', initData }
//
// Response: { ok: true, segmentId, segmentIndex, type, amountWtc, spinsRemaining }

import crypto from 'crypto';
import { connectToDatabase } from '../lib/mongodb.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { SPIN_SEGMENTS, WTC_PER_USD } from '../lib/constants.js';

// Same "flagged accounts earn nothing new until verified" gate used by
// api/earn.js and api/gift.js — kept consistent across every reward path.
const REWARD_ELIGIBLE_FILTER = { $or: [{ multiAccountFlag: { $ne: true } }, { channelVerified: true }] };

// ── pickSegment ── weighted random draw. Weights are parts-per-100 (see
// lib/constants.js, which already asserts they sum to exactly 100), so we
// draw an integer in [0, 100000) and walk the cumulative weight*1000 —
// keeps everything in exact integer arithmetic, no floating-point drift.
function pickSegment() {
    const roll = crypto.randomInt(0, 100000);
    let cumulative = 0;
    for (let i = 0; i < SPIN_SEGMENTS.length; i++) {
        cumulative += Math.round(SPIN_SEGMENTS[i].weight * 1000);
        if (roll < cumulative) return { segment: SPIN_SEGMENTS[i], index: i };
    }
    // Floating point safety net — should be unreachable since weights sum
    // to exactly 100, but never let a rounding edge case throw.
    return { segment: SPIN_SEGMENTS[SPIN_SEGMENTS.length - 1], index: SPIN_SEGMENTS.length - 1 };
}

async function handleSpin(req, res, db, userId) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    // ── STEP 1: atomically claim a spin (limit check + decrement together) ──
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            spinsRemaining: { $gt: 0 },
            isBanned: { $ne: true },
            ...REWARD_ELIGIBLE_FILTER,
        },
        { $inc: { spinsRemaining: -1 } },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1, spinsRemaining: 1, multiAccountFlag: 1, channelVerified: 1 } });
        if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if (user.multiAccountFlag && !user.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        return res.status(200).json({ ok: false, error: 'no_spins_left', spinsRemaining: user.spinsRemaining || 0 });
    }

    // ── STEP 2: decide the outcome (server-only — never derived from anything the client sent) ──
    const { segment, index } = pickSegment();

    let amountWtc = 0;
    const inc = {};
    if (segment.type === 'cn') {
        amountWtc = crypto.randomInt(segment.min, segment.max + 1); // inclusive of max
        inc.wtcBalance = amountWtc;
        inc.lifetimeWtcEarned = amountWtc;
    } else if (segment.type === 'usd') {
        amountWtc = Math.round(segment.usdAmount * WTC_PER_USD);
        inc.wtcBalance = amountWtc;
        inc.lifetimeWtcEarned = amountWtc;
    } else if (segment.type === 'spin') {
        // Net-zero on the daily allowance — refund the spin just spent.
        inc.spinsRemaining = 1;
    }

    // ── STEP 3: credit the result. spinsRemaining is already decremented from
    // STEP 1 (and possibly incremented back here for the bonus-spin wedge),
    // so this can't be raced into double-crediting the same spin.
    const credited = await users.findOneAndUpdate(
        { _id: userId },
        { $inc: inc },
        { returnDocument: 'after' }
    );

    return res.status(200).json({
        ok: true,
        segmentId: segment.id,
        segmentIndex: index,
        type: segment.type,
        amountWtc,
        spinsRemaining: credited?.spinsRemaining ?? Math.max(0, (gate.spinsRemaining || 0)),
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { db } = await connectToDatabase();
    switch (action) {
        case 'spin': return handleSpin(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
