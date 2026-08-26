// lib/banRegistry.js — single shared place that bans/unbans a user, used by
// both the admin's manual ban_/unban_ callback buttons (api/bot.js) and the
// automatic multi-account suspension in lib/fingerprintCheck.js, so
// `users.isBanned` and the separate `bannedTelegramIds` registry never
// drift out of sync with each other.
//
// The separate `bannedTelegramIds` registry exists because a user's own
// document auto-deletes 90 days after their last activity (see the TTL
// index in lib/mongodb.js) — the ban itself needs to outlive that deletion,
// otherwise a banned person could just wait out the cleanup and sign up
// again as a fresh "new" user. bannedTelegramIds has its own, independent
// 60-day TTL — see api/user.js's `stillBanned` check in handleInit.

export async function markBanned(db, userId, reason = 'manual') {
    const now = new Date();
    await db.collection('users').updateOne(
        { _id: userId },
        { $set: { isBanned: true, bannedAt: now, banReason: reason } }
    );
    await db.collection('bannedTelegramIds').updateOne(
        { _id: userId },
        { $set: { bannedAt: now, reason } },
        { upsert: true }
    );
}

export async function markUnbanned(db, userId) {
    await db.collection('users').updateOne(
        { _id: userId },
        { $set: { isBanned: false }, $unset: { bannedAt: '', banReason: '' } }
    );
    await db.collection('bannedTelegramIds').deleteOne({ _id: userId });
}
