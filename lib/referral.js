// lib/referral.js — awards the referrer a "valid referral" once the person
// they referred proves they're a real, engaged user rather than a
// signup-and-vanish farmed account (see WITHDRAW_VALID_REFERRALS_PER_WITHDRAW
// in lib/constants.js — a valid referral is what actually unlocks a
// referrer's 2nd+ withdrawal).
//
// RECONSTRUCTED FILE: this file was missing from the project (referenced by
// api/user.js, api/earn.js, api/bot.js but never actually present in this
// snapshot — one of the root causes of the FUNCTION_INVOCATION_FAILED
// errors on every API route, since importing a nonexistent module crashes
// the function before any request handling even starts).
//
// Milestone definition (three steps, all required — see api/user.js's
// newUser doc comment: "validReferralCount +1 when a referral completes
// all 3 steps"):
//   Step 1 — channel + community verified (signal: { channelVerified: true },
//            fired from api/user.js checkJoin and api/bot.js check_join_)
//   Step 2 — completed at least 3 tasks (signal: { completedTasksCount },
//            fired from api/earn.js handleTaskComplete after each claim)
//   Step 3 — completed at least 7 tasks (same signal as step 2)
//
// Each step is recorded once (referralStepNDone on the REFERRED user's own
// doc) so re-firing the same signal later is a no-op. The moment all three
// flip true, the REFERRER's validReferralCount goes up by exactly one —
// guarded atomically so this can never double-fire even under concurrent
// requests.

const STEP2_TASKS_REQUIRED = 3;
const STEP3_TASKS_REQUIRED = 7;

export async function maybeAwardReferralMilestones(db, userId, signal = {}) {
    const users = db.collection('users');
    const user = await users.findOne(
        { _id: userId },
        { projection: { referredBy: 1, referralStep1Done: 1, referralStep2Done: 1, referralStep3Done: 1 } }
    );
    if (!user || !user.referredBy) return; // not a referred user — nothing to award

    const newlyDone = [];
    if (signal.channelVerified === true && !user.referralStep1Done) newlyDone.push('referralStep1Done');
    if (typeof signal.completedTasksCount === 'number') {
        if (signal.completedTasksCount >= STEP2_TASKS_REQUIRED && !user.referralStep2Done) newlyDone.push('referralStep2Done');
        if (signal.completedTasksCount >= STEP3_TASKS_REQUIRED && !user.referralStep3Done) newlyDone.push('referralStep3Done');
    }
    if (newlyDone.length === 0) return; // nothing new to record this call

    const setFields = {};
    for (const f of newlyDone) setFields[f] = true;
    await users.updateOne({ _id: userId }, { $set: setFields });

    const step1 = user.referralStep1Done || newlyDone.includes('referralStep1Done');
    const step2 = user.referralStep2Done || newlyDone.includes('referralStep2Done');
    const step3 = user.referralStep3Done || newlyDone.includes('referralStep3Done');
    if (!(step1 && step2 && step3)) return; // not all three yet

    // Atomic guard: only the request that actually flips the LAST remaining
    // step gets to award the referrer, even if two signals race each other.
    const justCompleted = await users.updateOne(
        { _id: userId, referralMilestonesAwarded: { $ne: true } },
        { $set: { referralMilestonesAwarded: true } }
    );
    if (justCompleted.modifiedCount === 0) return; // another call already awarded this

    const referrerId = user.referredBy;
    const referrerAfter = await users.findOneAndUpdate(
        { _id: referrerId },
        { $inc: { validReferralCount: 1 } },
        { returnDocument: 'after' }
    );
    const referrer = referrerAfter?.value !== undefined ? referrerAfter.value : referrerAfter;
    if (referrer) {
        // Lazy import to avoid a circular dependency (telegram.js doesn't
        // depend on this file, but keeping the import local here mirrors
        // how sparingly this module needs Telegram — only on the one
        // milestone-completion event).
        const { tgSend } = await import('./telegram.js');
        tgSend(
            referrerId,
            `✅ <b>Valid Referral Confirmed!</b>\n\nSomeone you referred just verified their account. This counts toward unlocking your next withdrawal. 🎉`
        ).catch(() => {});
    }
}
