// lib/fingerprintCheck.js — secondary, defense-in-depth multi-account check
// that runs right after a brand-new user document is inserted (see
// api/user.js handleInit).
//
// lib/ipRegistry.js is the PRIMARY door-gate: it blocks a second account
// from ever being created on a device that's already claimed. This file
// catches a narrower gap that gate can miss — a case where the device key
// ipRegistry ended up using fell back to IP (no usable fingerprint at that
// moment) while a full fingerprint WAS actually available and matches an
// existing account's stored fingerprint exactly (e.g. two accounts opened
// moments apart behind the same shared/NAT IP, where the IP-only key alone
// wouldn't have caught it, but the canvas+screen+timezone fingerprint
// does).
//
// ⚠️ Unlike ipRegistry (blocks BEFORE an account is created), this fires
// AFTER creation and auto-suspends the new account outright — an exact
// fingerprint match is treated as conclusive, not just flagged for later
// review. The original (first) account tied to that fingerprint is never
// touched by this.

import { markBanned } from './banRegistry.js';

export async function checkAndRecordFingerprint(db, userId, fingerprint) {
    if (typeof fingerprint !== 'string' || fingerprint.length < 16) {
        return { flagged: false }; // no usable fingerprint — nothing to check against
    }

    const users = db.collection('users');
    const existingMatch = await users.findOne(
        { _id: { $ne: userId }, multiAccountFingerprint: fingerprint },
        { projection: { _id: 1 } }
    );

    // Record this account's fingerprint either way, so it's available for
    // future signups to match against.
    await users.updateOne({ _id: userId }, { $set: { multiAccountFingerprint: fingerprint } });

    if (!existingMatch) return { flagged: false };

    // Cross-link both accounts (useful in the admin lookup panel), flag the
    // original account for review, and auto-suspend the new one.
    await users.updateOne({ _id: userId }, { $addToSet: { multiAccountSiblings: existingMatch._id } });
    await users.updateOne(
        { _id: existingMatch._id },
        { $addToSet: { multiAccountSiblings: userId }, $set: { multiAccountFlag: true } }
    );
    await markBanned(db, userId, 'multi_account_fingerprint');

    return { flagged: true };
}
