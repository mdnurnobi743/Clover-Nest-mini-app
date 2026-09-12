// api/clover.js — Clover Catch mini-game (falling-clover reflex game, the
// Earning tab's headline feature).
//
// ── SECURITY MODEL (read before changing anything) ──────────────────────
// The round itself — where clovers/bombs fall, whether a tap lands on one,
// exact timing — runs entirely client-side in index.html. There is no way
// to fully re-verify that server-side without literally replaying raw
// input events frame-by-frame, which this project doesn't do. Given that,
// this endpoint is built the same way every other reward path in this app
// is (see api/spin.js, api/earn.js): assume the client CAN be modified or
// bypassed entirely, and make sure nothing it says can mint free CN.
//
// Five separate layers do that:
//
//   1. SIGNED SESSION TOKEN — `cloverStart` mints a short-lived HMAC token
//      bound to (userId, startTime). `cloverComplete` without a valid,
//      unexpired, unused token is rejected outright — a client can't skip
//      straight to "cloverComplete" with an invented result and no real
//      session ever having started.
//   2. PHYSICS-PLAUSIBILITY CHECK — the reported clover count is bounds-
//      checked against the real game's fastest possible spawn/fall rate
//      (CLOVER_GAME_MIN_SECONDS_PER_CLOVER) and the round length. A claim
//      of "50 clovers in 3 seconds" or "'time' finish after 8 seconds" is
//      mathematically impossible under the real game and is rejected.
//   3. SERVER ROLLS THE REWARD — the client's `cn` estimate (shown live
//      during play, for UI feedback only) is NEVER read by this endpoint.
//      The server re-rolls its own reward from the verified clover count
//      using CLOVER_REWARD_TIERS (lib/constants.js), so a client that
//      lies about the count only lies about something bounded (see #2),
//      and lying about the reward amount directly is simply impossible —
//      there is no `cn` field in the request this handler even looks at.
//   4. SINGLE-USE TOKENS — each cloverStart token can be spent exactly
//      once (usedCloverStarts, atomically checked+added in the very same
//      update that credits the reward — same pattern as api/earn.js's
//      usedTaskStarts, closing the double-submit race).
//   5. SAME ACCOUNT-HEALTH GATES AS EVERYWHERE ELSE — isBanned and the
//      multiAccountFlag/channelVerified REWARD_ELIGIBLE_FILTER used by
//      api/earn.js and api/spin.js apply here too, plus a daily play cap
//      (CLOVER_GAMES_DAILY_LIMIT) so the mode can't be farmed indefinitely
//      even by a perfectly "legitimate-looking" sequence of requests.
//
// What this can't do: stop a genuinely fast/lucky human player, or detect
// a pixel-perfect autoclicker/aimbot driving a real browser session — no
// server can, for a reflex game, without full server-side simulation.
// What it DOES stop is the cheap, common attack — calling this API
// directly and skipping the game entirely to mint arbitrary CN.
//
//   { action: 'cloverStart',    initData }
//   { action: 'cloverComplete', initData, startTime, signature, clovers, reason }

import crypto from 'crypto';
import { connectToDatabase } from '../lib/mongodb.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    CLOVER_GAME_DURATION_SECONDS,
    CLOVER_GAME_MAX_CLOVERS,
    CLOVER_REWARD_TIERS,
    CLOVER_GAME_TOKEN_MAX_AGE_SECONDS,
    CLOVER_GAME_MIN_SECONDS_PER_CLOVER,
    CLOVER_GAMES_DAILY_LIMIT,
    CLOVER_GAME_REASONS,
} from '../lib/constants.js';
import { applyCors } from '../lib/cors.js';

// Reuses the same signing secret api/earn.js already requires — no new
// environment variable to configure. The 'clover:' namespace prefix means
// a token minted here can never be replayed against earn.js's taskStart
// tokens (or vice versa), even though both derive from the same secret.
const SECRET = process.env.TASK_SIGNING_SECRET;

const signCloverStart = (userId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`clover:${userId}:${startTime}`).digest('hex');

// Same "flagged accounts earn nothing new until verified" gate used by
// api/earn.js and api/spin.js — kept consistent across every reward path.
const REWARD_ELIGIBLE_FILTER = { $or: [{ multiAccountFlag: { $ne: true } }, { channelVerified: true }] };

// ── cloverStart ── issues the signed token the instant the player taps
// "PLAY". Also front-loads the isBanned/daily-limit/review checks so the
// player is told "no plays left today" BEFORE sitting through a round,
// rather than after (cloverComplete enforces the real, final versions of
// all of these atomically regardless — this is purely a better UX).
async function handleCloverStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const user = await users.findOne(
        { _id: userId },
        { projection: { isBanned: 1, cloverGamesPlayedToday: 1, multiAccountFlag: 1, channelVerified: 1 } }
    );
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (user.multiAccountFlag && !user.channelVerified) {
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    const playedToday = user.cloverGamesPlayedToday || 0;
    if (playedToday >= CLOVER_GAMES_DAILY_LIMIT) {
        return res.status(200).json({ ok: false, error: 'daily_limit_reached', gamesRemainingToday: 0 });
    }

    const startTime = Date.now();
    return res.status(200).json({
        ok: true,
        startTime,
        signature: signCloverStart(userId, startTime),
        durationSeconds: CLOVER_GAME_DURATION_SECONDS,
        maxClovers: CLOVER_GAME_MAX_CLOVERS,
        gamesRemainingToday: CLOVER_GAMES_DAILY_LIMIT - playedToday,
    });
}

// Server's own reward roll — see file header, layer 3. Deliberately mirrors
// the client's visual small/medium/large tiers so the live counter the
// player watches during play is a close (not exact) preview, but this is
// the ONLY roll that ever actually gets credited.
function rollRewardForClovers(cloverCount) {
    const totalWeight = CLOVER_REWARD_TIERS.reduce((s, t) => s + t.weight, 0);
    let total = 0;
    for (let i = 0; i < cloverCount; i++) {
        const roll = crypto.randomInt(0, totalWeight);
        let cumulative = 0;
        let tier = CLOVER_REWARD_TIERS[CLOVER_REWARD_TIERS.length - 1];
        for (const t of CLOVER_REWARD_TIERS) {
            cumulative += t.weight;
            if (roll < cumulative) { tier = t; break; }
        }
        total += crypto.randomInt(tier.min, tier.max + 1); // inclusive of max
    }
    return total;
}

async function handleCloverComplete(req, res, db, userId) {
    const { startTime, signature, clovers, reason } = req.body;

    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_game_token' });
    if (!CLOVER_GAME_REASONS.includes(reason)) return res.status(400).json({ ok: false, error: 'invalid_reason' });

    const cloverCount = Number(clovers);
    if (!Number.isInteger(cloverCount) || cloverCount < 0 || cloverCount > CLOVER_GAME_MAX_CLOVERS) {
        return res.status(400).json({ ok: false, error: 'invalid_clover_count' });
    }

    // ── layer 1: the session token itself must check out ──
    if (signCloverStart(userId, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_game_token' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_game_token' });
    }
    if (elapsedSeconds > CLOVER_GAME_TOKEN_MAX_AGE_SECONDS) {
        return res.status(400).json({ ok: false, error: 'game_token_expired' });
    }

    // ── layer 2: physics-plausibility check ──
    const minPlausibleSeconds = cloverCount * CLOVER_GAME_MIN_SECONDS_PER_CLOVER;
    if (elapsedSeconds < minPlausibleSeconds) {
        return res.status(400).json({ ok: false, error: 'implausible_result' });
    }
    // a genuine "ran out of time" finish can only happen once the round's
    // real clock has (almost) fully elapsed
    if (reason === 'time' && elapsedSeconds < CLOVER_GAME_DURATION_SECONDS - 4) {
        return res.status(400).json({ ok: false, error: 'implausible_result' });
    }
    // hitting the 50-clover cap stops all further spawning client-side, so
    // 'bomb'/'missed' can never legitimately co-occur with a full cap —
    // but 'time' is allowed too, for the rare case where the cap and the
    // round clock are hit on the same tick.
    if (cloverCount >= CLOVER_GAME_MAX_CLOVERS && reason !== 'max' && reason !== 'time') {
        return res.status(400).json({ ok: false, error: 'invalid_reason' });
    }

    const startKey = String(startTime);
    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    // ── layer 4 + 5: atomically spend the token, claim today's play slot,
    // and enforce ban/review gates — all in one filter so nothing can race ──
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            usedCloverStarts: { $ne: startKey },
            cloverGamesPlayedToday: { $lt: CLOVER_GAMES_DAILY_LIMIT },
            ...REWARD_ELIGIBLE_FILTER,
        },
        { $addToSet: { usedCloverStarts: startKey }, $inc: { cloverGamesPlayedToday: 1 } },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne(
            { _id: userId },
            { projection: { isBanned: 1, usedCloverStarts: 1, cloverGamesPlayedToday: 1, multiAccountFlag: 1, channelVerified: 1 } }
        );
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedCloverStarts || []).includes(startKey)) {
            return res.status(400).json({ ok: false, error: 'game_token_already_used' });
        }
        if ((exists.cloverGamesPlayedToday || 0) >= CLOVER_GAMES_DAILY_LIMIT) {
            return res.status(200).json({ ok: false, error: 'daily_limit_reached', gamesRemainingToday: 0 });
        }
        if (exists.multiAccountFlag && !exists.channelVerified) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        return res.status(400).json({ ok: false, error: 'claim_failed' });
    }

    // ── layer 3: the ONLY place a reward is ever decided ──
    const cnEarned = cloverCount > 0 ? rollRewardForClovers(cloverCount) : 0;

    const credited = cnEarned > 0
        ? await users.findOneAndUpdate(
            { _id: userId },
            { $inc: { wtcBalance: cnEarned, lifetimeWtcEarned: cnEarned } },
            { returnDocument: 'after' }
        )
        : gate;

    return res.status(200).json({
        ok: true,
        cnEarned,
        clovers: cloverCount,
        reason,
        wtcBalance: credited?.wtcBalance ?? gate.wtcBalance,
        gamesRemainingToday: Math.max(0, CLOVER_GAMES_DAILY_LIMIT - (gate.cloverGamesPlayedToday || 0)),
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
        case 'cloverStart':    return handleCloverStart(req, res, db, userId);
        case 'cloverComplete': return handleCloverComplete(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
