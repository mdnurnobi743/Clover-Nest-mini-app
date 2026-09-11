// lib/ipRegistry.js — Season 4 device gate: ONE Telegram account per
// physical device.
//
// ⚠️ REWORKED — the old version keyed this off the client's canvas/screen/
// timezone FINGERPRINT, falling back to raw IP when no fingerprint came
// through. Both of those turned out to cause real false-positive blocks:
//   • Fingerprint collisions: two DIFFERENT physical phones of the same
//     popular model (very common — many people in the same area buy the
//     same budget handset) render an near-identical canvas, share the same
//     screen size / CPU core count / timezone / language, and so hash to
//     the SAME fingerprint even though they're two separate devices.
//   • IP collisions: the old fallback keyed on raw IP when no fingerprint
//     was available, which blocked completely different people/devices
//     sharing one home/office WiFi (same public IP behind NAT).
//
// The fix: the client now also generates a random, per-install `deviceId`
// (a UUID persisted in localStorage — see index.html's getOrCreateDeviceId())
// which is unique per physical install regardless of hardware model, and is
// NOT derivable from hardware characteristics. That becomes the PRIMARY
// gating key. The hardware fingerprint is kept only as a secondary,
// corroborating signal (see lib/fingerprintCheck.js) — it's still useful for
// catching someone who clears their storage to reset deviceId, but a match
// on fingerprint ALONE is no longer enough by itself to block or ban
// anyone, since we now know it can happen between two honest, unrelated
// devices.
//
// Raw client IP is kept ONLY for admin-facing logging/context — it is never
// used as a key that can block or ban an account. A shared household/office
// WiFi should never be able to cause a false "device already in use" block.
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

const MIN_DEVICE_ID_LENGTH = 16; // shorter than this isn't a real UUID/hash — treat as absent
const MIN_FINGERPRINT_LENGTH = 16;

// Picks the gating key: persisted deviceId first (unique per install, not
// tied to hardware model), hardware fingerprint second. Raw IP is
// deliberately NEVER used here — see file header.
function registryKey(deviceId, fingerprint) {
    if (typeof deviceId === 'string' && deviceId.length >= MIN_DEVICE_ID_LENGTH) {
        return `device:${deviceId}`;
    }
    if (typeof fingerprint === 'string' && fingerprint.length >= MIN_FINGERPRINT_LENGTH) {
        return `fp:${fingerprint}`;
    }
    return null; // no usable signal — see checkDevice's noSignal branch
}

// Vercel forwards the real client IP via x-forwarded-for (first entry in
// the list is the original client, later entries are proxies). Falls back
// to the raw socket address for local/dev environments.
// Kept for admin-facing context/logging ONLY — never used to gate or block.
export function getClientIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

// Returns { blocked, key, unclaimed, ownerId?, noSignal? }
export async function checkDevice(db, deviceId, fingerprint, userId) {
    const key = registryKey(deviceId, fingerprint);

    // Neither signal came through (very old WebView, storage blocked, hash
    // failed, etc.) — too unreliable to gate on. Let the request through
    // rather than risk blocking an innocent person on a shaky guess; the
    // fingerprint-corroboration check in fingerprintCheck.js still runs
    // separately as a post-creation safety net where possible.
    if (!key) return { blocked: false, key: null, unclaimed: true, noSignal: true };

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
    if (!key) return; // noSignal case — nothing to claim
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
    if (key) {
        await db.collection('deviceRegistry').updateOne(
            { _id: key },
            { $set: { ownerId: userId, claimedAt: new Date() } },
            { upsert: true }
        );
    }
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
