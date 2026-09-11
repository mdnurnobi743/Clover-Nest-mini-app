// lib/fingerprintCheck.js — secondary, defense-in-depth multi-account check
// that runs right after a brand-new user document is inserted (see
// api/user.js handleInit).
//
// lib/ipRegistry.js is the PRIMARY door-gate: it blocks a second account
// from ever being created on a device that's already claimed, keyed on the
// client's persisted deviceId (falling back to the hardware fingerprint —
// see that file's header for why raw IP is never used as a key anymore).
// This file catches a narrower gap that gate can miss — a case where
// ipRegistry's key fell back to fingerprint (no deviceId came through at
// that moment) while the two accounts otherwise look unrelated.
//
// ⚠️ REWORKED — this used to treat an exact fingerprint match as conclusive
// and auto-suspend the new account outright. That's no longer safe on its
// own: two DIFFERENT physical devices of the same popular phone model can
// legitimately hash to the same canvas+screen+timezone+language fingerprint
// (see lib/ipRegistry.js header), so a lone fingerprint match is real
// evidence but not proof by itself.
//
// New rule: a fingerprint match is only auto-banned when it's CORROBORATED
// by a second, independent signal that a same-model-phone coincidence can't
// produce — either the persisted deviceId also matches (near-impossible by
// chance for two separate installs), or the same fingerprint has already
// shown up across several distinct accounts (a real farm reusing one
// device, not a one-off coincidence between two honest neighbors). A single
// uncorroborated fingerprint match is flagged (multiAccountFlag) for admin
// review only — nothing is done to the account automatically.

import { markBanned } from './banRegistry.js';

// A single coincidental fingerprint collision between two honest devices is
// expected to happen occasionally; three or more distinct accounts sharing
// one fingerprint is a much stronger signal of a real farm reusing one
// device and clearing storage between signups.
const SIBLING_COUNT_AUTO_BAN_THRESHOLD = 3;

export async function checkAndRecordFingerprint(db, userId, fingerprint, deviceId) {
    if (typeof fingerprint !== 'string' || fingerprint.length < 16) {
        return { flagged: false }; // no usable fingerprint — nothing to check against
    }

    const users = db.collection('users');
    const existingMatch = await users.findOne(
        { _id: { $ne: userId }, multiAccountFingerprint: fingerprint },
        { projection: { _id: 1, multiAccountDeviceId: 1, multiAccountSiblings: 1 } }
    );

    // Record this account's fingerprint (and deviceId, if any) either way,
    // so it's available for future signups to match/corroborate against.
    await users.updateOne(
        { _id: userId },
        { $set: { multiAccountFingerprint: fingerprint, multiAccountDeviceId: deviceId || null } }
    );

    if (!existingMatch) return { flagged: false };

    // Cross-link both accounts (useful in the admin lookup panel) and flag
    // the original account for review either way.
    await users.updateOne({ _id: userId }, { $addToSet: { multiAccountSiblings: existingMatch._id } });
    await users.updateOne(
        { _id: existingMatch._id },
        { $addToSet: { multiAccountSiblings: userId }, $set: { multiAccountFlag: true } }
    );

    const deviceIdCorroborates =
        deviceId && existingMatch.multiAccountDeviceId && deviceId === existingMatch.multiAccountDeviceId;
    const siblingCount = (existingMatch.multiAccountSiblings || []).length + 1; // +1 to count this new one
    const patternCorroborates = siblingCount >= SIBLING_COUNT_AUTO_BAN_THRESHOLD;

    if (deviceIdCorroborates || patternCorroborates) {
        await markBanned(db, userId, deviceIdCorroborates ? 'multi_account_device_match' : 'multi_account_pattern');
        await users.updateOne({ _id: userId }, { $set: { multiAccountFlag: true } });
        return { flagged: true, banned: true };
    }

    // Uncorroborated single fingerprint match — could be two honest people
    // with the same phone model. Flag for a human to review, don't punish
    // automatically.
    await users.updateOne({ _id: userId }, { $set: { multiAccountFlag: true } });
    return { flagged: true, banned: false };
}
