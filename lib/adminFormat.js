// lib/adminFormat.js — small helpers for how a user is shown to the ADMIN
// in Telegram messages (withdrawal requests, pending list, processed status).
//
// Goal: the admin must ALWAYS be able to see WHO is withdrawing. If the user
// has a public @username it is shown (tap-to-open in Telegram). If they have
// none, we say so explicitly and show a tg://user?id= link with their first
// name instead of a confusing "@N/A" or "@?".

export const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Users without a @username are stored as 'N/A' (api/user.js) — treat that,
// empty values and a bare '?' as "no username".
export function cleanUsername(username) {
    const u = String(username ?? '').trim().replace(/^@/, '');
    if (!u || u === 'N/A' || u === '?' || u.toLowerCase() === 'none') return '';
    return u;
}

// → "@username"  or  "<a href="tg://user?id=…">First Name</a> (no @username)"
export function adminUserTag(userId, username, firstName) {
    const u = cleanUsername(username);
    if (u) return `@${escHtml(u)}`;
    return `<a href="tg://user?id=${escHtml(userId)}">${escHtml(firstName || 'User')}</a> <i>(no @username)</i>`;
}
