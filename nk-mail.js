// ================= NECKARSULMER KONZERTE: E-MAIL-BENACHRICHTIGUNGEN =================
// Neue Terminumfragen, Dateien, Kommentare, zugewiesene 2Dos und festgelegte Termine werden
// per E-Mail gemeldet. Versand ueber die HTTP-API von Resend (SMTP ist auf Railway erst ab dem
// Pro-Plan erlaubt). Ohne RESEND_API_KEY + MAIL_FROM passiert nichts.
// Pro Konto einstellbar: sofort / einmal taeglich als Zusammenfassung (7 Uhr) / aus.

const cron = require('node-cron');
const db = require('./db');
const { effectiveTabs } = require('./access');

const APP_URL = (process.env.APP_URL || 'https://office.martinrenner.de').replace(/\/$/, '');
const NOTIFY_MODES = ['instant', 'daily', 'off'];

db.exec(`
CREATE TABLE IF NOT EXISTS nk_mail_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nk_mail_queue_open ON nk_mail_queue(sent_at, user_id);
`);

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

// E-Mail eines Kontos: eigene Angabe, sonst die der verknuepften Person
function emailForUser(user) {
  if (user.email && user.email.trim()) return user.email.trim();
  if (!user.person_id) return null;
  const p = db.prepare('SELECT email FROM people WHERE id = ?').get(user.person_id);
  return p && p.email && p.email.trim() ? p.email.trim() : null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendMail(to, subject, text, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Mail-Versand fehlgeschlagen (${res.status}): ${await res.text()}`);
}

function mailHtml(items) {
  const rows = items.map(i => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #eee">
      <div style="font-size:15px;color:#2a2620">${escapeHtml(i.body)}</div>
      ${i.link ? `<a href="${escapeHtml(i.link)}" style="font-size:13px;color:#6d4bd8">Im Office-Tool öffnen →</a>` : ''}
    </td></tr>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px">
    <h2 style="font-size:17px;color:#2a2620">Neckarsulmer Konzerte</h2>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="font-size:12px;color:#a3977f;margin-top:18px">Benachrichtigungen lassen sich im Office-Tool unter Konto › E-Mail-Benachrichtigungen ändern oder abschalten.</p>
  </div>`;
}

function mailText(items) {
  return items.map(i => `• ${i.body}${i.link ? `\n  ${i.link}` : ''}`).join('\n\n')
    + '\n\n—\nBenachrichtigungen lassen sich im Office-Tool unter Konto › E-Mail-Benachrichtigungen ändern.';
}

// Meldet ein Ereignis an alle Konten mit dem Reiter `tab` (ausser dem Ausloeser).
// onlyUserIds: nur an diese Konten (z.B. die Person, der ein 2Do zugewiesen wurde).
function notify({ tab, actorId, subject, body, path, onlyUserIds }) {
  if (!isConfigured()) return;
  const link = path ? APP_URL + path : null;
  const users = db.prepare('SELECT * FROM app_users').all()
    .filter(u => u.id !== actorId)
    .filter(u => !onlyUserIds || onlyUserIds.includes(u.id))
    .filter(u => effectiveTabs(u).includes(tab))
    .filter(u => (u.nk_notify || 'instant') !== 'off' && emailForUser(u));
  for (const u of users) {
    const info = db.prepare('INSERT INTO nk_mail_queue (user_id, subject, body, link) VALUES (?, ?, ?, ?)').run(u.id, subject, body, link);
    if ((u.nk_notify || 'instant') === 'instant') {
      const item = { body, link };
      sendMail(emailForUser(u), subject, mailText([item]), mailHtml([item]))
        .then(() => db.prepare("UPDATE nk_mail_queue SET sent_at = datetime('now') WHERE id = ?").run(info.lastInsertRowid))
        .catch(err => console.error('[NK-Mail]', err.message));
    }
  }
}

// Taegliche Zusammenfassung fuer alle Konten mit "daily" (und liegengebliebene Sofort-Mails)
async function sendDigests() {
  if (!isConfigured()) return;
  const open = db.prepare('SELECT * FROM nk_mail_queue WHERE sent_at IS NULL ORDER BY id').all();
  const byUser = new Map();
  open.forEach(m => { if (!byUser.has(m.user_id)) byUser.set(m.user_id, []); byUser.get(m.user_id).push(m); });
  for (const [userId, items] of byUser) {
    const user = db.prepare('SELECT * FROM app_users WHERE id = ?').get(userId);
    const to = user && emailForUser(user);
    const ids = items.map(i => i.id);
    if (!to || (user.nk_notify || 'instant') === 'off') {
      db.prepare(`UPDATE nk_mail_queue SET sent_at = datetime('now') WHERE id IN (${ids.join(',')})`).run();
      continue;
    }
    // Sofort-Mails, die gerade erst angelegt wurden, nicht doppelt schicken
    const due = items.filter(i => (user.nk_notify || 'instant') === 'daily' || Date.now() - new Date(i.created_at.replace(' ', 'T') + 'Z').getTime() > 3600000);
    if (!due.length) continue;
    try {
      const subject = due.length === 1 ? due[0].subject : `Neckarsulmer Konzerte: ${due.length} Neuigkeiten`;
      await sendMail(to, subject, mailText(due), mailHtml(due));
      db.prepare(`UPDATE nk_mail_queue SET sent_at = datetime('now') WHERE id IN (${due.map(i => i.id).join(',')})`).run();
    } catch (err) {
      console.error('[NK-Mail] Zusammenfassung fehlgeschlagen:', err.message);
    }
  }
  db.prepare("DELETE FROM nk_mail_queue WHERE sent_at IS NOT NULL AND sent_at < datetime('now', '-30 days')").run();
}

function register(app) {
  // Eigene Einstellungen (jedes Konto selbst)
  app.get('/api/account/notifications', (req, res) => {
    res.json({
      email: req.user.email || '',
      fallback_email: req.user.email ? null : emailForUser({ ...req.user, email: null }),
      mode: req.user.nk_notify || 'instant',
      configured: isConfigured(),
    });
  });
  app.put('/api/account/notifications', (req, res) => {
    const email = String((req.body && req.body.email) || '').trim();
    const mode = NOTIFY_MODES.includes(req.body && req.body.mode) ? req.body.mode : 'instant';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben' });
    db.prepare('UPDATE app_users SET email = ?, nk_notify = ? WHERE id = ?').run(email || null, mode, req.user.id);
    res.json({ ok: true });
  });

  cron.schedule('0 7 * * *', () => { sendDigests().catch(err => console.error('[NK-Mail]', err)); }, { timezone: 'Europe/Berlin' });
}

module.exports = { register, notify, isConfigured, sendDigests };
