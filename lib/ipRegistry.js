// lib/ipRegistry.js — Season 4 device gate: ONE Telegram account per
// physical device. Despite the filename (kept from an earlier IP-only
// version), the key used is the client's device FINGERPRINT whenever one
// is available — a hash of canvas rendering + screen size + timezone +
// language + hardwareConcurrency, generated client-side in index.html's
// generateDeviceFingerprint(). Raw IP is only used as a fallback key when
// no usable fingerprint came through (e.g. a very old WebView, or the hash
// failed to compute) — see registryKey() below.
//
// How it's used (api/user.js handleInit):
//   1) first account ever to open the app on a device → claimDevice()
//      claims that device key for them.
//   2) any DIFFERENT account opening the app on the SAME device afterwards
//      → checkDevice() returns blocked:true, and the client shows the
//      "Device Already In Use" screen (owner's public info via
//      getOwnerPublicInfo).
//   3) from that screen, the person can "Switch account" instead of
//      logging into the owning account — claimDeviceForUser() force-claims
//      the device for them, at the cost of wiping their own balance (the
//      anti-abuse deterrent — otherwise one device could be used to farm
//      unlimited accounts for free, just switching each time).

const MIN_FINGERPRINT_LENGTH = 16; // shorter than this isn't a real SHA-256 hex hash — treat as absent

function registryKey(fingerprint, clientIp) {
    if (typeof fingerprint === 'string' && fingerprint.length >= MIN_FINGERPRINT_LENGTH) {
        return fingerprint;
    }
    return `ip:${clientIp || 'unknown'}`;
}

// Vercel forwards the real client IP via x-forwarded-for (first entry in
// the list is the original client, later entries are proxies). Falls back
// to the raw socket address for local/dev environments.
export function getClientIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

// Returns { blocked, key, unclaimed, ownerId? }
export async function checkDevice(db, fingerprint, clientIp, userId) {
    const key = registryKey(fingerprint, clientIp);
    const entry = await db.collection('deviceRegistry').findOne({ _id: key });

    if (!entry) return { blocked: false, key, unclaimed: true };
    if (entry.ownerId === userId) return { blocked: false, key, unclaimed: false };
    return { blocked: true, key, unclaimed: false, ownerId: entry.ownerId };
}

// Claims a device key for a user ONLY if nobody owns it yet — never steals
// an existing claim. Used both for a brand-new signup's first-ever device,
// and to retroactively attach a device to a returning user who didn't have
// one on file (e.g. their fingerprint changed after clearing site data).
export async function claimDevice(db, key, userId) {
    await db.collection('deviceRegistry').updateOne(
        { _id: key },
        { $setOnInsert: { ownerId: userId, claimedAt: new Date() } },
        { upsert: true }
    );
}

// Force-claims a device key for `userId`, overwriting whoever owned it —
// this is the "Switch account" action. The claiming user's balance is
// wiped as the anti-abuse cost (see file header).
export async function claimDeviceForUser(db, key, userId) {
    await db.collection('deviceRegistry').updateOne(
        { _id: key },
        { $set: { ownerId: userId, claimedAt: new Date() } },
        { upsert: true }
    );
    await db.collection('users').updateOne(
        { _id: userId },
        { $set: { wtcBalance: 0, usdtBalance: 0 } }
    );
}

// Public (non-sensitive) info about the account that already owns a
// blocked device — shown on the "Device Already In Use" screen so the
// person can recognize whether it's really their own other account.
export async function getOwnerPublicInfo(db, ownerId) {
    if (!ownerId) return null;
    const owner = await db.collection('users').findOne(
        { _id: ownerId },
        { projection: { firstName: 1, telegramUsername: 1 } }
    );
    if (!owner) return null;
    return { id: ownerId, firstName: owner.firstName, telegramUsername: owner.telegramUsername };
}
