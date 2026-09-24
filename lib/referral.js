// lib/referral.js — Friends & Earn rewards.
//
// WHAT THIS PAYS (mirrors the "How the bonus works" card in index.html):
//   +30  CN  friend joined channel + community and verified
//   +100 CN  friend completed 5 tasks
//   +180 CN  friend watched 20 ads
//   +10% of every withdrawal the friend makes (bot.js finalizeWithdrawal)
// The CN goes to the REFERRER (the person whose link the friend used).
// A referral also becomes "valid" (validReferralCount +1 — what unlocks the
// referrer's own 2nd+ withdrawal) once the friend has done BOTH the 5 tasks
// AND the 20 ads, in any order.
//
// WHY THIS FILE WAS REWRITTEN: the previous version only ever bumped
// validReferralCount (with different thresholds: 3 + 7 tasks, no ads) and
// never credited any CN, so referrers saw "Referral Earnings 0 CN" no matter
// how many friends they brought in. Ad views were never counted at all.
//
// HOW IT STAYS SAFE:
//   • Every decision is re-derived from the FRIEND's real DB state, so it
//     doesn't matter which event triggered the call (join / task / ad /
//     app-open) — the result is the same, and calling it twice is harmless.
//   • Each bonus is claimed atomically with a per-friend "paid" flag
//     (refBonusJoinPaid / refBonusTasksPaid / refBonusAdsPaid) BEFORE the
//     referrer is credited, so concurrent requests can never double-pay.
//   • Banned friends never earn their referrer anything; banned/locked
//     referrers aren't credited (the flag is rolled back so it can still be
//     paid if they're unlocked later).
//   • Old friends are paid retroactively: automatically the next time they
//     open the app (api/user.js handleInit) or via the admin "Referral
//     Catch-up" button (bot.js) which runs referralCatchUp() below.

import { REFERRAL_BONUS, REFERRAL_TASKS_REQUIRED, REFERRAL_ADS_REQUIRED } from './constants.js';

const MILESTONES = [
    { key: 'join',  flag: 'refBonusJoinPaid',  label: 'joined the channel & community',           reached: (f) => f.channelVerified === true },
    { key: 'tasks', flag: 'refBonusTasksPaid', label: `completed ${REFERRAL_TASKS_REQUIRED} tasks`, reached: (f) => (f.completedTasks || []).length >= REFERRAL_TASKS_REQUIRED },
    { key: 'ads',   flag: 'refBonusAdsPaid',   label: `watched ${REFERRAL_ADS_REQUIRED} ads`,       reached: (f) => (f.lifetimeAdViews || 0) >= REFERRAL_ADS_REQUIRED },
];

const FRIEND_PROJECTION = {
    referredBy: 1, firstName: 1, isBanned: 1, channelVerified: 1, completedTasks: 1, lifetimeAdViews: 1,
    refBonusJoinPaid: 1, refBonusTasksPaid: 1, refBonusAdsPaid: 1, refValidCounted: 1, referralMilestonesAwarded: 1,
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const docOf = (r) => (r?.value !== undefined ? r.value : r); // mongodb driver v5/v6 return-shape safety

// Evaluates ONE referred friend. dryRun=true only reports what would be paid.
async function awardFriend(db, friend, { dryRun = false, notify = true } = {}) {
    const result = { paidCn: 0, bonuses: 0, validAdded: false };
    if (!friend || !friend.referredBy || friend.isBanned) return result;

    const users = db.collection('users');
    const referrerId = friend.referredBy;
    const paid = { join: !!friend.refBonusJoinPaid, tasks: !!friend.refBonusTasksPaid, ads: !!friend.refBonusAdsPaid };
    const lines = [];

    for (const m of MILESTONES) {
        if (paid[m.key] || !m.reached(friend)) continue;
        const amount = REFERRAL_BONUS[m.key];

        if (dryRun) { paid[m.key] = true; result.paidCn += amount; result.bonuses++; continue; }

        // 1) claim the milestone for this friend (only one caller can win)
        const claim = await users.updateOne({ _id: friend._id, [m.flag]: { $ne: true } }, { $set: { [m.flag]: true } });
        if (claim.modifiedCount === 0) { paid[m.key] = true; continue; } // someone else just paid it

        // 2) credit the referrer
        const credited = docOf(await users.findOneAndUpdate(
            { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
            { $inc: { wtcBalance: amount, lifetimeWtcEarned: amount, referralWtcEarned: amount } },
            { returnDocument: 'after' }
        ));
        if (!credited) { // referrer missing / banned / locked → undo the claim so it can be paid later
            await users.updateOne({ _id: friend._id }, { $set: { [m.flag]: false } });
            continue;
        }
        paid[m.key] = true; result.paidCn += amount; result.bonuses++;
        lines.push(`• Friend ${m.label}: <b>+${amount} CN</b>`);
    }

    // "Valid referral" — friend did BOTH the tasks and the ads.
    // referralMilestonesAwarded = legacy flag from the old logic (already counted once).
    const alreadyCounted = friend.refValidCounted || friend.referralMilestonesAwarded;
    if (!alreadyCounted && paid.tasks && paid.ads) {
        if (dryRun) {
            result.validAdded = true;
        } else {
            const claim = await users.updateOne({ _id: friend._id, refValidCounted: { $ne: true } }, { $set: { refValidCounted: true } });
            if (claim.modifiedCount > 0) {
                await users.updateOne({ _id: referrerId }, { $inc: { validReferralCount: 1 } });
                result.validAdded = true;
            }
        }
    }

    if (!dryRun && notify && (lines.length || result.validAdded)) {
        try {
            const { tgSend } = await import('./telegram.js'); // lazy — keeps this module import-cheap
            const name = esc(friend.firstName || 'Your friend');
            let text = `🎉 <b>Referral reward!</b>\n\n<b>${name}</b> (your friend) made progress:\n${lines.join('\n')}`;
            if (lines.length > 1) text += `\n\n💰 Total: <b>+${result.paidCn} CN</b>`;
            if (result.validAdded) text += `\n\n✅ This referral is now <b>valid</b> — it counts toward unlocking your next withdrawal.`;
            tgSend(referrerId, text).catch(() => {});
        } catch { /* notification is best-effort only */ }
    }
    return result;
}

// Called after: channel verify, task claim, ad claim, app open. The 3rd
// argument (the old "signal" object) is accepted but no longer needed —
// everything is re-read from the DB.
export async function maybeAwardReferralMilestones(db, userId /*, _signal */) {
    const users = db.collection('users');
    const friend = await users.findOne({ _id: userId }, { projection: FRIEND_PROJECTION });
    return awardFriend(db, friend);
}

// Admin catch-up over EVERY referred user. dryRun=true (default) just totals
// what would be paid so the admin can review before confirming.
// Stops at `deadlineMs` and reports partial:true — run it again to continue
// (already-paid milestones are skipped, so re-running is always safe).
export async function referralCatchUp(db, { dryRun = true, deadlineMs = 240000 } = {}) {
    const started = Date.now();
    const summary = { friendsChecked: 0, friendsWithRewards: 0, bonuses: 0, paidCn: 0, validAdded: 0, partial: false };
    const cursor = db.collection('users')
        .find({ referredBy: { $exists: true, $nin: [null, ''] }, isBanned: { $ne: true } }, { projection: FRIEND_PROJECTION });
    for await (const friend of cursor) {
        if (!dryRun && Date.now() - started > deadlineMs) { summary.partial = true; break; }
        summary.friendsChecked++;
        const r = await awardFriend(db, friend, { dryRun, notify: !dryRun });
        if (r.bonuses > 0 || r.validAdded) summary.friendsWithRewards++;
        summary.bonuses += r.bonuses;
        summary.paidCn += r.paidCn;
        if (r.validAdded) summary.validAdded++;
    }
    return summary;
}
