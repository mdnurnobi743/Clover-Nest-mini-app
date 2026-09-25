// lib/taskRequirement.js — the "complete N tasks before you can withdraw" gate.
//
// WHY THIS EXISTS: the requirement used to be a flat "completedTasks.length >=
// 8". If fewer than 8 tasks were actually available to a user (admin has
// published fewer, some are full/hidden/deleted), users did EVERYTHING there
// was to do and still saw "not complete" and could never withdraw — with no
// way out.
//
// RULES NOW:
//   1. Normal case — a user needs WITHDRAW_TASKS_REQUIRED (8) completed tasks.
//   2. Adaptive — the requirement can never exceed what's achievable:
//        required = min(8, tasksDone + tasksStillAvailableToThisUser)
//      "Available" = approved, not hidden, not full, not already done by them.
//      So a user who has done every task that exists is never blocked.
//   3. Sticky — once met (or waived by the admin from the user-lookup panel)
//      `tasksRequirementMet` is stored on the user and never blocks again,
//      even if the admin later publishes more tasks.
// Daily ads are NOT tasks and don't count here (they're tracked separately).

import { ObjectId } from 'mongodb';
import { WITHDRAW_TASKS_REQUIRED } from './constants.js';

// Same "not full" test api/earn.js uses when a user claims a task's slot.
export const TASK_NOT_FULL = [
    { limit: { $exists: false } },
    { limit: null },
    { limit: { $lte: 0 } },
    { $expr: { $lt: [{ $ifNull: ['$completionCount', 0] }, '$limit'] } },
];

export async function getTaskRequirement(db, user) {
    const done = user.completedTasks || [];
    const have = done.length;
    const fullRequired = WITHDRAW_TASKS_REQUIRED;

    if (user.tasksRequirementMet) {
        return { have, required: Math.min(fullRequired, have) || fullRequired, fullRequired, available: null, met: true, waived: true };
    }
    if (have >= fullRequired) {
        return { have, required: fullRequired, fullRequired, available: null, met: true, waived: false };
    }

    const doneIds = [];
    for (const id of done) { try { doneIds.push(new ObjectId(id)); } catch { /* not an ObjectId — ignore */ } }
    const available = await db.collection('tasks').countDocuments({
        isApproved: true,
        ...(doneIds.length ? { _id: { $nin: doneIds } } : {}),
        $or: TASK_NOT_FULL,
    });

    const required = Math.min(fullRequired, have + available);
    return { have, required, fullRequired, available, met: have >= required, waived: false };
}
