// lib/broadcastJob.js — sends a broadcast to every user in small batches
// with a short pause between them, to stay under Telegram's outbound rate
// limit (roughly 30 messages/second, and only when sending to DIFFERENT
// chats, which is exactly this case).
//
// Meant to be scheduled with `waitUntil()` from @vercel/functions right
// after the webhook handler responds to Telegram (see api/bot.js's
// 'bc_confirm' callback) — Telegram expects a fast ack on the webhook
// response, and broadcasting to potentially thousands of users can take
// far longer than that, so it runs as a background continuation instead of
// blocking the response.

import { tgSend, tgSendPhoto } from './telegram.js';

const BATCH_SIZE = 25;
const BATCH_DELAY_MS = 1000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// userIds: string[]. extra: Telegram sendMessage/sendPhoto options (e.g. reply_markup).
export async function createBroadcastJob(db, { userIds, text, photoFileId, extra, adminId }) {
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
        const batch = userIds.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map((id) => (photoFileId ? tgSendPhoto(id, photoFileId, text, extra) : tgSend(id, text, extra)))
        );
        for (const r of results) (r.status === 'fulfilled' ? sent++ : failed++);
        if (i + BATCH_SIZE < userIds.length) await sleep(BATCH_DELAY_MS);
    }

    if (adminId) {
        await tgSend(adminId, `📢 <b>Broadcast finished.</b>\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`).catch(() => {});
    }

    return { sent, failed };
}
