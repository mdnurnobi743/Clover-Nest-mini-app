// api/clover.js — Clover Catch mini-game (Earn tab).
//
// The client (index.html's Clover Catch overlay) runs the actual falling-
// object gameplay entirely on-device for a smooth 60fps feel — but it is
// NEVER trusted for the reward. Security model:
//
//   1) 'start'  — atomically spends one of the user's daily plays and opens
//      a session doc in `cloverSessions` (status:'active', server-side
//      startTime). Returns a signed HMAC token binding {userId, sessionId,
//      startTime} together, the same "string key" pattern api/earn.js uses
//      for task-claim tokens — it proves the session wasn't forged, even
//      though the DB record is already the real source of truth.
//
//   2) 'finish' — the client reports only an integer clover COUNT (capped
//      at CLOVER_GAME_MAX_CLOVERS) and how the round ended. The server:
//        - verifies the signature matches the session it actually issued
//        - consumes the session exactly once (atomic findOneAndUpdate on
//          status:'active' → 'completed' — replay-proof, race-proof)
//        - rejects sessions that are expired, or whose claimed clover count
//          is faster than physically possible for the elapsed time
//          (anti-speedhack floor)
//        - ROLLS ITS OWN REWARD for that many clovers using the identical
//          weighted odds the client's UI uses (CLOVER_REWARD_TIERS), with
//          crypto-secure randomness — the client's on-screen "CN earned"
//          number is only ever a preview, never the credited amount.
//
// A DevTools user can freely lie about `cloverCount` up to the hard cap,
// or claim any reward number they like — none of it changes what actually
// gets credited, because the credited amount is never derived from
// anything the client sent except a bounded, session-gated integer.
//
//   { action: 'start',  initData }
//   { action: 'finish', initData, sessionId, startTime, signature, cloverCount, reason }

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { applyCors } from '../lib/cors.js';
import {
    CLOVER_GAME_DURATION_SECONDS, CLOVER_GAME_MAX_CLOVERS, CLOVER_GAME_SESSION_GRACE_SECONDS,
    CLOVER_GAME_MIN_MS_PER_CLOVER, CLOVER_REWARD_TIERS,
} from '../lib/constants.js';

const SECRET = process.env.TASK_SIGNING_SECRET;

// Same "flagged accounts earn nothing new until verified" gate used by
// every other reward path (api/earn.js, api/spin.js, api/gift.js).
const REWARD_ELIGIBLE_FILTER = { $or: [{ multiAccountFlag: { $ne: true } }, { channelVerified: true }] };

const signSession = (userId, sessionId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`clover:${userId}:${sessionId}:${startTime}`).digest('hex');

// One weighted draw from CLOVER_REWARD_TIERS, using crypto.randomInt so it
// can never be predicted or influenced by anything client-side.
function pickCloverReward() {
    const roll = crypto.randomInt(0, 100);
    let cumulative = 0;
    for (const tier of CLOVER_REWARD_TIERS) {
        cumulative += tier.weight;
        if (roll < cumulative) {
            const span = Math.round((tier.max - tier.min) * 1000);
            const value = tier.min + crypto.randomInt(0, span + 1) / 1000;
            return Math.round(value * 10) / 10;
        }
    }
    const last = CLOVER_REWARD_TIERS[CLOVER_REWARD_TIERS.length - 1];
    return last.max;
}

async function handleStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    // ── atomically claim a play (limit check + decrement together) ──
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            cloverGamesRemaining: { $gt: 0 },
            isBanned: { $ne: true },
            ...REWARD_ELIGIBLE_FILTER,
        },
        { $inc: { cloverGamesRemaining: -1 } },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1, cloverGamesRemaining: 1, multiAccountFlag: 1, channelVerified: 1 } });
        if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if (user.multiAccountFlag && !user.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        return res.status(200).json({ ok: false, error: 'no_plays_left', cloverGamesRemaining: user.cloverGamesRemaining || 0 });
    }

    // Server clock is the only clock that matters from here on — the
    // client never gets to supply or override its own startTime.
    const startTime = Date.now();
    const insertResult = await db.collection('cloverSessions').insertOne({
        userId,
        startTime,
        status: 'active',
        createdAt: new Date(),
    });
    const sessionId = String(insertResult.insertedId);

    return res.status(200).json({
        ok: true,
        sessionId,
        startTime,
        signature: signSession(userId, sessionId, startTime),
        durationSeconds: CLOVER_GAME_DURATION_SECONDS,
        maxClovers: CLOVER_GAME_MAX_CLOVERS,
        cloverGamesRemaining: gate.cloverGamesRemaining,
    });
}

async function handleFinish(req, res, db, userId) {
    const { sessionId, signature, reason } = req.body;
    const cloverCount = Math.floor(Number(req.body.cloverCount));

    if (!sessionId || typeof signature !== 'string') return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!Number.isInteger(cloverCount) || cloverCount < 0 || cloverCount > CLOVER_GAME_MAX_CLOVERS) {
        return res.status(400).json({ ok: false, error: 'invalid_clover_count' });
    }

    let sessionObjId;
    try { sessionObjId = new ObjectId(sessionId); } catch { return res.status(400).json({ ok: false, error: 'invalid_session' }); }

    const sessions = db.collection('cloverSessions');
    const session = await sessions.findOne({ _id: sessionObjId, userId });
    if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });
    if (session.status !== 'active') return res.status(400).json({ ok: false, error: 'session_already_used' });

    // ── verify the signature against the DB-stored startTime (never the
    // client's) — proves this exact session/time pair is the one we issued.
    const expected = signSession(userId, sessionId, session.startTime);
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    const sigValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    if (!sigValid) return res.status(400).json({ ok: false, error: 'invalid_signature' });

    // ── plausibility gates, all measured against the server's own clock ──
    const elapsedMs = Date.now() - session.startTime;
    const maxElapsedMs = (CLOVER_GAME_DURATION_SECONDS + CLOVER_GAME_SESSION_GRACE_SECONDS) * 1000;
    if (elapsedMs < 0 || elapsedMs > maxElapsedMs) {
        await sessions.updateOne({ _id: sessionObjId, status: 'active' }, { $set: { status: 'expired' } });
        return res.status(400).json({ ok: false, error: 'session_expired' });
    }
    if (elapsedMs < cloverCount * CLOVER_GAME_MIN_MS_PER_CLOVER) {
        await sessions.updateOne({ _id: sessionObjId, status: 'active' }, { $set: { status: 'rejected_speed' } });
        return res.status(400).json({ ok: false, error: 'implausible_speed' });
    }

    // ── atomically consume the session exactly once — the real defense
    // against replaying the same finished round for a second payout ──
    const claimed = await sessions.findOneAndUpdate(
        { _id: sessionObjId, userId, status: 'active' },
        { $set: { status: 'completed', completedAt: new Date(), cloverCount, reason: String(reason || '').slice(0, 32) } },
        { returnDocument: 'after' }
    );
    if (!claimed) return res.status(400).json({ ok: false, error: 'session_already_used' });

    // ── the server rolls its own reward for `cloverCount` clovers — the
    // client's displayed number during play was only ever a preview ──
    let rewardWtc = 0;
    for (let i = 0; i < cloverCount; i++) rewardWtc += pickCloverReward();
    rewardWtc = Math.round(rewardWtc * 10) / 10;

    const credited = await db.collection('users').findOneAndUpdate(
        { _id: userId, ...REWARD_ELIGIBLE_FILTER },
        { $inc: { wtcBalance: rewardWtc, lifetimeWtcEarned: rewardWtc } },
        { returnDocument: 'after' }
    );
    if (!credited) {
        // Session stays consumed either way — the multi-account review gate
        // just means this round's reward doesn't land until they verify.
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    return res.status(200).json({
        ok: true,
        cloverCount,
        rewardWtc,
        wtcBalance: credited.wtcBalance,
    });
}

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { db } = await connectToDatabase();
    switch (action) {
        case 'start':  return handleStart(req, res, db, userId);
        case 'finish': return handleFinish(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
