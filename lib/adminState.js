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
