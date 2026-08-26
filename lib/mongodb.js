// lib/mongodb.js — shared MongoDB connection, cached across serverless
// invocations (Vercel reuses the same warm container often enough that a
// fresh MongoClient per request would exhaust connection limits fast).
//
// Also runs one-time index setup (TTL cleanups referenced elsewhere in the
// codebase's comments as "models/schema.js" — that file never actually
// existed in this snapshot, so those TTL indexes are created here instead):
//   • users.lastActiveAt        → 90-day dead-account auto-delete
//     (see api/user.js handleInit's "stillBanned"/dead-account comment)
//   • bannedTelegramIds.bannedAt → 60-day ban-registry auto-expiry
//     (see api/user.js's stillBanned check)

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'clovernest';

// `global` survives across warm invocations of the same serverless
// container (but not across cold starts) — the standard Vercel+Mongo
// caching pattern.
let cached = global._cloverNestMongo;
if (!cached) cached = global._cloverNestMongo = { client: null, db: null, indexesReady: false };

export async function connectToDatabase() {
    if (cached.db) return { client: cached.client, db: cached.db };

    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI environment variable is not set');
    }

    const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
    await client.connect();
    const db = client.db(MONGODB_DB);

    cached.client = client;
    cached.db = db;

    if (!cached.indexesReady) {
        cached.indexesReady = true;
        // Fire-and-forget — never block a request on index creation, and
        // never crash a request if it fails (e.g. insufficient Atlas tier
        // permissions). Logged so it's visible in Vercel's function logs.
        ensureIndexes(db).catch((err) => console.error('lib/mongodb.js ensureIndexes failed:', err.message));
    }

    return { client, db };
}

async function ensureIndexes(db) {
    await Promise.all([
        db.collection('users').createIndex(
            { lastActiveAt: 1 },
            { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
        ),
        db.collection('bannedTelegramIds').createIndex(
            { bannedAt: 1 },
            { expireAfterSeconds: 60 * 24 * 60 * 60 } // 60 days
        ),
        db.collection('deviceRegistry').createIndex({ claimedAt: 1 }),
        db.collection('tasks').createIndex({ isApproved: 1, createdAt: -1 }),
        db.collection('promos').createIndex({ code: 1 }, { unique: true }),
        db.collection('withdrawals').createIndex({ status: 1, processedAt: -1 }),
        db.collection('withdrawals').createIndex({ userId: 1 }),
        db.collection('users').createIndex({ referralCount: -1 }),
        db.collection('users').createIndex({ weeklyReferralCount: -1 }),
    ]);
}
