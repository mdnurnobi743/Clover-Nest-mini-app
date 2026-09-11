// lib/cors.js — shared CORS handling for every browser-facing API route.
//
// None of api/*.js previously set any CORS headers at all, so any request
// whose origin didn't happen to exactly match the deployment (Telegram's
// WebView host, a custom domain, a Vercel preview URL, local dev, etc.)
// was silently blocked by the browser's preflight before it ever reached
// the function. This centralizes the fix so every route behaves the same
// way instead of each file growing its own copy.
//
// Security note: the actual auth boundary for every endpoint is the signed
// Telegram `initData` string (see lib/telegramAuth.js) — that's what proves
// who the caller is, and it can't be forged without the bot token. CORS
// here is just about which *browsers* are allowed to read the response; it
// intentionally stays permissive by default so the Mini App keeps working
// across Telegram's various WebView hosts and preview/staging URLs. Set
// ALLOWED_ORIGINS (comma-separated) in the environment to lock it down to
// specific origins once the production domain is finalized.
//
// Usage — first line of every exported handler:
//   export default async function handler(req, res) {
//       if (applyCors(req, res)) return; // preflight already answered
//       ...
//   }

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const TELEGRAM_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*telegram\.org$/i;

// Returns true if the caller already got a full response (OPTIONS
// preflight) and the handler should stop immediately.
export function applyCors(req, res) {
    const origin = req.headers.origin;

    if (origin) {
        const allowed =
            ALLOWED_ORIGINS.length === 0 || // no allowlist configured → reflect any origin
            ALLOWED_ORIGINS.includes(origin) ||
            TELEGRAM_ORIGIN_RE.test(origin);

        if (allowed) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return true;
    }
    return false;
}
