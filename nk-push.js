// ================= NECKARSULMER KONZERTE: PUSH-MITTEILUNGEN =================
// Web-Push fuer die Home-Bildschirm-App (iPhone ab iOS 16.4, ausserdem Mac/Android-Browser).
// Die VAPID-Schluessel erzeugt der Server beim ersten Start selbst und legt sie in app_settings ab -
// es muss nichts eingerichtet werden. Jedes Geraet meldet sich einzeln an (Tabelle nk_push_subscriptions).

const webpush = require('web-push');
const db = require('./db');

const APP_URL = (process.env.APP_URL || 'https://office.martinrenner.de').replace(/\/$/, '');

db.exec(`
CREATE TABLE IF NOT EXISTS nk_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

function vapidKeys() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'nk_vapid'").get();
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('nk_vapid', ?)").run(JSON.stringify(keys));
  return keys;
}
const keys = vapidKeys();
webpush.setVapidDetails(APP_URL, keys.publicKey, keys.privateKey);

function hasSubscriptions(userId) {
  return !!db.prepare('SELECT 1 FROM nk_push_subscriptions WHERE user_id = ?').get(userId);
}

// Schickt eine Mitteilung an alle Geraete eines Kontos; abgelaufene Anmeldungen werden entfernt
function sendToUser(userId, { title, body, path }) {
  const subs = db.prepare('SELECT * FROM nk_push_subscriptions WHERE user_id = ?').all(userId);
  const payload = JSON.stringify({ title, body: String(body || '').slice(0, 300), url: path || '/nk' });
  return Promise.all(subs.map(s =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600 })
      .catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM nk_push_subscriptions WHERE id = ?').run(s.id);
        else console.error('[NK-Push]', err.statusCode || '', err.message);
      })));
}

function register(app) {
  app.get('/api/push/key', (req, res) => {
    res.json({ publicKey: keys.publicKey, subscribed: hasSubscriptions(req.user.id) });
  });
  app.post('/api/push/subscribe', (req, res) => {
    const sub = (req.body && req.body.subscription) || {};
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: 'Ungültige Anmeldung' });
    db.prepare(`
      INSERT INTO nk_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(req.get('user-agent') || '').slice(0, 300));
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (endpoint) db.prepare('DELETE FROM nk_push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
    else db.prepare('DELETE FROM nk_push_subscriptions WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/push/test', async (req, res) => {
    if (!hasSubscriptions(req.user.id)) return res.status(400).json({ error: 'Auf diesem Konto ist noch kein Gerät für Mitteilungen angemeldet' });
    await sendToUser(req.user.id, { title: 'Neckarsulmer Konzerte', body: 'Test: Mitteilungen kommen an. 🎵', path: '/nk' });
    res.json({ ok: true });
  });
}

module.exports = { register, sendToUser, hasSubscriptions };
