// lib/dailyReset.js — resets a user's "today" counters (tasksCompletedToday,
// usedTaskStarts) the first time they're seen on a new Bangladesh-time day.
// Called lazily at the top of any endpoint that reads/writes those
// counters (api/user.js handleProfile, api/earn.js handleTaskComplete)
// instead of a scheduled cron — cheaper, and never misses a user just
// because a cron didn't happen to run while they were active.

import { todayBD, dailyResetFields } from './constants.js';

export async function ensureDailyReset(users, userId) {
    const today = todayBD();

    const user = await users.findOne({ _id: userId }, { projection: { lastResetDate: 1 } });
    if (!user || user.lastResetDate === today) return; // nothing to do (unknown user, or already reset today)

    // Guarded by lastResetDate in the filter too, so two near-simultaneous
    // calls for the same user don't both reset (harmless either way here,
    // but keeps the pattern consistent with the rest of the codebase).
    await users.updateOne(
        { _id: userId, lastResetDate: { $ne: today } },
        { $set: dailyResetFields() }
    );
}
