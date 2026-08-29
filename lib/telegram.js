// lib/telegram.js — thin wrapper around the Telegram Bot API, shared by
// every endpoint that needs to send a message or check channel/group
// membership.
//
// RECONSTRUCTED FILE: this file was missing from the project (referenced by
// almost every api/*.js and lib/*.js file but never actually present in
// this snapshot — the root cause of the FUNCTION_INVOCATION_FAILED errors).
//
// Channel/group handles below mirror index.html's own copies of the same
// constants (search index.html for "mirrors lib/telegram.js"). Update
// PAYMENT_CHANNEL / PAYMENT_PROOF_PHOTO to your real payment-proof channel
// and a real photo file_id or URL — placeholders won't work until you do.

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Public channel/community every user is asked to join (api/bot.js /start,
// index.html's join-gate screen, api/user.js checkJoin).
export const OFFICIAL_CHANNEL = '@clover_nest_official';
export const COMMUNITY_GROUP = '@clover_nest_community';

// Where approved withdrawals get posted as public proof (api/bot.js
// finalizeWithdrawal). Set these to your real channel + a real photo
// file_id/URL, or withdrawal approvals will log a harmless warning to the
// admin instead of failing the approval itself.
export const PAYMENT_CHANNEL = process.env.PAYMENT_CHANNEL || '@clover_nest_payments';
export const PAYMENT_PROOF_PHOTO = process.env.PAYMENT_PROOF_PHOTO || 'https://i.postimg.cc/Gtp63QQV/file-000000007fa87207ae71dda1cde1426b.png';

// ── low-level call — every helper below goes through this ──
export async function tgApi(method, payload) {
    if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable is not set');
    const res = await fetch(`${API_BASE}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
        const desc = data?.description || res.statusText;
        throw new Error(`Telegram ${method} failed: ${desc}`);
    }
    return data.result;
}

export async function tgSend(chatId, text, extra = {}) {
    return tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

export async function tgEdit(chatId, messageId, text, extra = {}) {
    return tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

export async function tgSendPhoto(chatId, photo, caption, extra = {}) {
    return tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });
}

export async function tgAnswerCallback(callbackQueryId, text = '', showAlert = false) {
    return tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

// Returns true if `userId` is currently a member/admin/creator of `chatId`
// (a @username or numeric chat id). Any Telegram-side error (bot not in the
// chat, user never started the bot, etc.) is treated as "not a member"
// rather than throwing, so a transient API hiccup never wrongly blocks a
// legit user forever — callers can retry the check on the next app open.
export async function isMember(userId, chatId) {
    try {
        const member = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch {
        return false;
    }
}
