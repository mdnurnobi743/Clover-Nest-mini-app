// api/cron-notify.js — 8 ghonta por por shob user-ke Telegram notification pathay.
//
// Call korbe: Vercel Cron  ba  cron-job.org (external cron)
// Security : CRON_SECRET env var (Authorization: Bearer <CRON_SECRET>)
//
// Test korar jonno:
//   /api/cron-notify?test=1   -> shudhu ADMIN_ID-ke pathay (guard bypass)
//   /api/cron-notify?force=1  -> shobaike pathay (8hr guard bypass)

import { connectToDatabase } from '../lib/mongodb.js';
import { createBroadcastJob } from '../lib/broadcastJob.js';
import { tgSend } from '../lib/telegram.js';

const APP_URL = 'https://clover-nest-t5mz.vercel.app'; // bot.js-er APP_URL-er moto
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const MIN_GAP_MS = 7 * 60 * 60 * 1000; // double-fire thekate: 7hr-er moddhe abar cholbe na

// Ekhane nijer message likho. Prottibar ekta kore rotate hobe.
const MESSAGES = [
    '🍀 <b>Clover Nest</b>\n\nTomar daily task ar free spin ready! Ekhoni open koro ar CN earn koro 💰',
    '🎡 <b>Free spin wait korche!</b>\n\nDaily spin ar Clover Catch game kheley bonus CN nao 🍀',
    '👥 <b>Friend invite koro, CN earn koro!</b>\n\nProti referral-e extra reward pao 🎁',
];

export default async function handler(req, res) {
    // ── 1) Auth ──
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    try {
        const { db } = await connectToDatabase();
        const adminId = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID;
        const isTest = req.query?.test === '1';
        const isForce = req.query?.force === '1';

        // ── 2) Message pick (8hr slot onujayi rotate) ──
        const slot = Math.floor(Date.now() / EIGHT_HOURS_MS);
        const text = MESSAGES[slot % MESSAGES.length];
        const extra = { reply_markup: { inline_keyboard: [[{ text: '🚀 Open Clover Nest', web_app: { url: APP_URL } }]] } };

        // ── 3) Test mode: shudhu admin ──
        if (isTest) {
            if (!adminId) return res.status(400).json({ ok: false, error: 'ADMIN_ID not set' });
            await tgSend(adminId, text, extra);
            return res.status(200).json({ ok: true, mode: 'test', sentTo: adminId });
        }

        // ── 4) Double-run guard (atomic) ──
        if (!isForce) {
            const threshold = new Date(Date.now() - MIN_GAP_MS);
            try {
                await db.collection('cronState').findOneAndUpdate(
                    { _id: 'notify8h', $or: [{ lastRunAt: { $lt: threshold } }, { lastRunAt: { $exists: false } }] },
                    { $set: { lastRunAt: new Date() } },
                    { upsert: true }
                );
            } catch (err) {
                if (err?.code === 11000) {
                    return res.status(200).json({ ok: true, skipped: 'already ran recently' });
                }
                throw err;
            }
        }

        // ── 5) Recipient list: banned / locked user bad ──
        const userIds = (
            await db
                .collection('users')
                .find({ isBanned: { $ne: true }, accountLocked: { $ne: true } }, { projection: { _id: 1 } })
                .toArray()
        ).map((u) => u._id);

        // ── 6) Send (25 ta/batch, 1s gap — Telegram limit-er moddhe) ──
        // Admin summary chaile Vercel env-e CRON_NOTIFY_ADMIN=1 dao.
        const result = await createBroadcastJob(db, {
            userIds,
            text,
            extra,
            adminId: process.env.CRON_NOTIFY_ADMIN === '1' ? adminId : undefined,
        });

        console.log('cron-notify done', { total: userIds.length, ...result });
        return res.status(200).json({ ok: true, total: userIds.length, ...result });
    } catch (err) {
        console.error('api/cron-notify.js failed:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
