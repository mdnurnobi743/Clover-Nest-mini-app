// lib/paymentProof.js — auto-posts a payment proof to the public proof
// channel (PROOF_CHANNEL in lib/telegram.js) the moment the admin APPROVES a
// withdrawal (bot.js → finalizeWithdrawal).
//
// The post is: one photo + a caption with the user's @username, the amount,
// the payout method, the date, and "✅ APPROVED" as the last line. If the
// admin attached a transaction hash/link when approving, it's added as a
// "🔗 Transaction Hash" button under the post as extra proof.
//
// Never throws — a failed channel post must NEVER block or undo the actual
// approval. It returns { ok, messageId?, error? } so the caller can warn the
// admin (e.g. "bot is not an admin of the channel").

import { tgSendPhoto, tgSend, PROOF_CHANNEL } from './telegram.js';
import { WITHDRAW_METHODS } from './constants.js';

const APP_URL = process.env.APP_URL || 'https://clover-nest-t5mz.vercel.app';
// Static branded "PAYMENT PROOF ✓ APPROVED" banner, served from /assets.
// Swap it any time by setting PROOF_PHOTO_URL (any public JPG/PNG URL, or a
// Telegram file_id).
const PROOF_PHOTO = process.env.PROOF_PHOTO_URL || `${APP_URL}/assets/payment-proof.png`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Users without a Telegram @username are stored as 'N/A' (api/user.js), so
// fall back to their first name instead of printing "@N/A".
function displayName(w, user) {
    const uname = w.username && w.username !== 'N/A' ? String(w.username).replace(/^@/, '') : '';
    if (uname) return `@${esc(uname)}`;
    const first = user?.firstName ? esc(user.firstName) : 'User';
    return `${first}`;
}

export async function postPaymentProof(w, { txHash = null, user = null } = {}) {
    try {
        const method = WITHDRAW_METHODS[w.method]?.label || w.method || '—';
        const when = new Date(w.processedAt || Date.now()).toLocaleString('en-GB', {
            timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const caption =
            `💸 <b>PAYMENT PROOF</b>\n\n` +
            `👤 User: <b>${displayName(w, user)}</b>\n` +
            `💰 Amount: <b>${Number(w.cashAmount || 0).toFixed(4)} ${esc(w.currency || 'USDT')}</b>\n` +
            `📤 Method: <b>${esc(method)}</b>\n` +
            `📅 ${esc(when)} (BD time)\n\n` +
            `✅ <b>APPROVED</b>`;

        let explorerUrl = null;
        if (txHash) explorerUrl = /^https?:\/\//i.test(txHash) ? txHash : `https://tonviewer.com/transaction/${encodeURIComponent(txHash)}`;
        const extra = explorerUrl ? { reply_markup: { inline_keyboard: [[{ text: '🔗 Transaction Hash', url: explorerUrl }]] } } : {};

        let sent;
        try {
            sent = await tgSendPhoto(PROOF_CHANNEL, PROOF_PHOTO, caption, extra);
        } catch (photoErr) {
            // Photo couldn't be fetched/sent (bad URL, not deployed yet…) —
            // still publish the proof as text so the record is never lost.
            sent = await tgSend(PROOF_CHANNEL, caption, extra);
        }
        return { ok: true, messageId: sent?.message_id ?? null };
    } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
    }
}
