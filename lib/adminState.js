// lib/adminState.js — persists the admin's current multi-step wizard state
// (Add Task, Add Promo, Broadcast composition, Send WTC, Send Gift, User
// Lookup) across requests. See api/bot.js's file header, point 2: a plain
// in-memory object would be lost on every serverless cold start, so this
// has to live in the database instead.

export async function getAdminState(db, adminId) {
    return db.collection('adminState').findOne({ _id: String(adminId) });
}

export async function setAdminState(db, adminId, state) {
    await db.collection('adminState').updateOne(
        { _id: String(adminId) },
        { $set: { ...state, updatedAt: new Date() } },
        { upsert: true }
    );
}

export async function clearAdminState(db, adminId) {
    await db.collection('adminState').deleteOne({ _id: String(adminId) });
}

// Atomically reads AND clears the state in one DB operation (findOneAndDelete
// instead of separate findOne + deleteOne). Used for steps that trigger a
// one-time side effect that must never fire twice (e.g. bc_confirm sending a
// broadcast) — if Telegram redelivers the same webhook update (which it does
// on any slow/timed-out response, and a broadcast can legitimately take a
// while), a second, concurrent/later call will find the state already gone
// and safely no-op instead of sending the broadcast a second time.
export async function claimAdminState(db, adminId) {
    const result = await db.collection('adminState').findOneAndDelete({ _id: String(adminId) });
    // Driver-version safety: mongodb v6 returns the document directly by
    // default, older versions/options wrap it as { value: doc }.
    return result?.value !== undefined ? result.value : result;
}
