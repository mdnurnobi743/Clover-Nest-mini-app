// lib/telegramAuth.js — verifies Telegram's signed `initData` string, per
// Telegram's official Mini App validation algorithm:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Every API endpoint that trusts a userId MUST run it through this first —
// it's the only thing that stops someone opening DevTools and calling the
// API directly with an arbitrary Telegram ID (see api/user.js's top
// comment for the exact vulnerability this closes).

import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;

// initData is considered stale after this long — Telegram re-issues it
// every time the Mini App is (re)opened, so 24h is generous, not tight.
const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

// Returns either { ok: true, user, startParam, authDate }
// or         { ok: false, error: '<reason>' }
export function verifyTelegramInitData(initData, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS) {
    if (!initData || typeof initData !== 'string') return { ok: false, error: 'missing_init_data' };
    if (!BOT_TOKEN) return { ok: false, error: 'server_misconfigured' };

    let params;
    try {
        params = new URLSearchParams(initData);
    } catch {
        return { ok: false, error: 'malformed_init_data' };
    }

    const hash = params.get('hash');
    if (!hash) return { ok: false, error: 'missing_hash' };
    params.delete('hash');

    // Telegram's spec: sort remaining key=value pairs alphabetically by
    // key, join with \n, HMAC-SHA256 it twice (once to derive a secret key
    // from the bot token, once to sign the data-check-string with that key).
    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const providedHashBuf = Buffer.from(hash, 'hex');
    const computedHashBuf = Buffer.from(computedHash, 'hex');
    const signatureValid =
        providedHashBuf.length === computedHashBuf.length &&
        crypto.timingSafeEqual(providedHashBuf, computedHashBuf);
    if (!signatureValid) return { ok: false, error: 'bad_signature' };

    const authDate = Number(params.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
        return { ok: false, error: 'expired' };
    }

    let user;
    try {
        user = JSON.parse(params.get('user') || 'null');
    } catch {
        user = null;
    }
    if (!user || !user.id) return { ok: false, error: 'missing_user' };

    return { ok: true, user, startParam: params.get('start_param') || null, authDate };
}
