// lib/dailyReset.js — resets a user's "today" counters (tasksCompletedToday,
// usedTaskStarts) the first time they're seen on a new Bangladesh-time day.
// Called lazily at the top of any endpoint that reads/writes those
// counters (api/user.js handleProfile, api/earn.js handleTaskComplete)
// instead of a scheduled cron — cheaper, and never misses a user just
// because a cron didn't happen to run while they were active.

import { todayBD, dailyResetFields, DAILY_FREE_SPINS } from './constants.js';

export async function ensureDailyReset(users, userId) {
    const today = todayBD();

    const user = await users.findOne({ _id: userId }, { projection: { lastResetDate: 1, spinsRemaining: 1 } });
    if (!user) return; // unknown user — nothing to do

    // ⚠️ NEW — migration safety net. Any account created BEFORE the Spin
    // Wheel feature existed has NO spinsRemaining field at all (not even a
    // 0). If that same user already opened the app earlier today,
    // lastResetDate already equals `today`, so the date-based reset below
    // would never fire — silently leaving them permanently stuck on
    // "0 spins remaining" until their date happens to roll over. Backfill
    // it once, independently of the date check, so it self-heals on the
    // very next request instead.
    if (typeof user.spinsRemaining !== 'number') {
        await users.updateOne({ _id: userId, spinsRemaining: { $exists: false } }, { $set: { spinsRemaining: DAILY_FREE_SPINS } });
    }

    if (user.lastResetDate === today) return; // already reset today — nothing else to do

    // Guarded by lastResetDate in the filter too, so two near-simultaneous
    // calls for the same user don't both reset (harmless either way here,
    // but keeps the pattern consistent with the rest of the codebase).
    await users.updateOne(
        { _id: userId, lastResetDate: { $ne: today } },
        { $set: dailyResetFields() }
    );
}
