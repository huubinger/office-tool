// ================= NECKARSULMER KONZERTE: KONZERTABEND =================
// Ablaufplan (Aufbau, Soundcheck, Einlass, Pause …), Dienstplan zum Eintragen per Handy
// (Kasse, Einlass, Bewirtung …) und Gaesteliste mit Freikarten zum Abhaken an der Abendkasse.

const db = require('./db');
const nk = require('./nk');
const { displayForUserId } = require('./access');

const GUEST_CATEGORIES = ['Sponsor', 'Presse', 'Künstler', 'Helfer', 'Ehrengast', 'Sonstige'];
const SHIFT_ROLES = ['Aufbau', 'Kasse', 'Einlass', 'Bewirtung', 'Garderobe', 'Technik', 'Abbau'];

db.exec(`
CREATE TABLE IF NOT EXISTS nk_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  time TEXT,
  title TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nk_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  needed INTEGER DEFAULT 1,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nk_shift_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES nk_shifts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nk_guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  count INTEGER DEFAULT 1,
  note TEXT,
  checked_in_at TEXT,
  checked_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nk_run_items ON nk_run_items(concert_id);
CREATE INDEX IF NOT EXISTS idx_nk_shifts ON nk_shifts(concert_id);
CREATE INDEX IF NOT EXISTS idx_nk_shift_signups ON nk_shift_signups(shift_id);
CREATE INDEX IF NOT EXISTS idx_nk_guests ON nk_guests(concert_id);
`);

const clean = (v, max = 500) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const cleanTime = (t) => (/^\d{2}:\d{2}/.test(t || '') ? String(t).slice(0, 5) : null);
// Uhrzeit relativ zum Konzertbeginn (Minuten), fuer die Vorlagen
function shiftTime(base, minutes) {
  if (!base) return null;
  const [h, m] = base.slice(0, 5).split(':').map(Number);
  const t = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + minutes));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function evening(c, req) {
  const runItems = db.prepare('SELECT * FROM nk_run_items WHERE concert_id = ? ORDER BY time IS NULL, time, id').all(c.id);
  const shifts = db.prepare('SELECT * FROM nk_shifts WHERE concert_id = ? ORDER BY start_time IS NULL, start_time, id').all(c.id).map(s => {
    const signups = db.prepare('SELECT * FROM nk_shift_signups WHERE shift_id = ? ORDER BY id').all(s.id).map(su => ({
      id: su.id, user_id: su.user_id, name: su.user_id ? displayForUserId(db, su.user_id).name : su.name,
      person: su.user_id ? displayForUserId(db, su.user_id) : null,
      can_remove: su.user_id === req.user.id || su.created_by === req.user.id || req.isAdmin,
    }));
    return { ...s, signups, mine: signups.some(su => su.user_id === req.user.id), open: Math.max(0, (s.needed || 1) - signups.length) };
  });
  const guests = db.prepare('SELECT * FROM nk_guests WHERE concert_id = ? ORDER BY category, name COLLATE NOCASE').all(c.id)
    .map(g => ({ ...g, checked_by_display: g.checked_by ? displayForUserId(db, g.checked_by).short : null }));
  const guestTotal = guests.reduce((s, g) => s + (g.count || 1), 0);
  const guestIn = guests.filter(g => g.checked_in_at).reduce((s, g) => s + (g.count || 1), 0);
  return {
    run_items: runItems, shifts, guests,
    guest_total: guestTotal, guest_checked_in: guestIn,
    guest_categories: GUEST_CATEGORIES, shift_roles: SHIFT_ROLES,
  };
}

function register(app) {
  nk.extendDetail((c, req) => ({ evening: evening(c, req) }));
  nk.extendList((c) => ({
    guest_total: db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM nk_guests WHERE concert_id = ?').get(c.id).n,
  }));

  const concertOr404 = (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) res.status(404).json({ error: 'Projekt nicht gefunden' });
    return c;
  };
  const done = (req, res, status = 200) => res.status(status).json(nk.concertDetail(req.params.id, req));

  // ---- Ablaufplan ----
  app.post('/api/nk/concerts/:id/run', (req, res) => {
    const c = concertOr404(req, res); if (!c) return;
    const b = req.body || {};
    if (b.template) {
      // Standardablauf relativ zum Konzertbeginn
      const t = c.time || '19:30';
      const items = [
        [-240, 'Aufbau Bühne, Technik, Bestuhlung'], [-150, 'Ankunft Künstler'], [-120, 'Soundcheck'], [-60, 'Kasse und Bewirtung öffnen'],
        [-30, 'Einlass'], [0, 'Beginn, Begrüßung'], [45, 'Pause'], [65, 'zweiter Teil'], [120, 'Ende, Verabschiedung'], [135, 'Abbau'],
      ];
      const stmt = db.prepare('INSERT INTO nk_run_items (concert_id, time, title) VALUES (?, ?, ?)');
      db.transaction(() => items.forEach(([min, title]) => stmt.run(c.id, shiftTime(t, min), title)))();
      return done(req, res, 201);
    }
    if (!clean(b.title)) return res.status(400).json({ error: 'Was passiert?' });
    db.prepare('INSERT INTO nk_run_items (concert_id, time, title, note) VALUES (?, ?, ?, ?)').run(c.id, cleanTime(b.time), clean(b.title, 300), clean(b.note, 1000));
    done(req, res, 201);
  });
  app.put('/api/nk/concerts/:id/run/:itemId', (req, res) => {
    const it = db.prepare('SELECT * FROM nk_run_items WHERE id = ? AND concert_id = ?').get(req.params.itemId, req.params.id);
    if (!it) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const b = req.body || {};
    db.prepare('UPDATE nk_run_items SET time = ?, title = ?, note = ? WHERE id = ?').run(
      b.time !== undefined ? cleanTime(b.time) : it.time,
      b.title !== undefined ? (clean(b.title, 300) || it.title) : it.title,
      b.note !== undefined ? clean(b.note, 1000) : it.note, it.id);
    done(req, res);
  });
  app.delete('/api/nk/concerts/:id/run/:itemId', (req, res) => {
    db.prepare('DELETE FROM nk_run_items WHERE id = ? AND concert_id = ?').run(req.params.itemId, req.params.id);
    done(req, res);
  });

  // ---- Dienstplan ----
  app.post('/api/nk/concerts/:id/shifts', (req, res) => {
    const c = concertOr404(req, res); if (!c) return;
    const b = req.body || {};
    if (b.template) {
      const t = c.time || '19:30';
      const shifts = [
        ['Aufbau', -240, -60, 3], ['Kasse', -60, 60, 2], ['Einlass', -45, 15, 2], ['Bewirtung', -60, 120, 2], ['Abbau', 120, 180, 3],
      ];
      const stmt = db.prepare('INSERT INTO nk_shifts (concert_id, role, start_time, end_time, needed) VALUES (?, ?, ?, ?, ?)');
      db.transaction(() => shifts.forEach(([role, from, to, n]) => stmt.run(c.id, role, shiftTime(t, from), shiftTime(t, to), n)))();
      return done(req, res, 201);
    }
    if (!clean(b.role)) return res.status(400).json({ error: 'Welcher Dienst?' });
    const needed = Math.max(1, Math.min(50, Math.round(+b.needed) || 1));
    db.prepare('INSERT INTO nk_shifts (concert_id, role, start_time, end_time, needed, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, clean(b.role, 100), cleanTime(b.start_time), cleanTime(b.end_time), needed, clean(b.note, 500));
    done(req, res, 201);
  });
  app.put('/api/nk/concerts/:id/shifts/:shiftId', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_shifts WHERE id = ? AND concert_id = ?').get(req.params.shiftId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Dienst nicht gefunden' });
    const b = req.body || {};
    db.prepare('UPDATE nk_shifts SET role = ?, start_time = ?, end_time = ?, needed = ?, note = ? WHERE id = ?').run(
      b.role !== undefined ? (clean(b.role, 100) || s.role) : s.role,
      b.start_time !== undefined ? cleanTime(b.start_time) : s.start_time,
      b.end_time !== undefined ? cleanTime(b.end_time) : s.end_time,
      b.needed !== undefined ? Math.max(1, Math.min(50, Math.round(+b.needed) || 1)) : s.needed,
      b.note !== undefined ? clean(b.note, 500) : s.note, s.id);
    done(req, res);
  });
  app.delete('/api/nk/concerts/:id/shifts/:shiftId', (req, res) => {
    db.prepare('DELETE FROM nk_shifts WHERE id = ? AND concert_id = ?').run(req.params.shiftId, req.params.id);
    done(req, res);
  });
  // Eintragen: ohne Namen = ich selbst, mit Namen = externe Person (z.B. Helfer ohne Konto)
  app.post('/api/nk/concerts/:id/shifts/:shiftId/signup', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_shifts WHERE id = ? AND concert_id = ?').get(req.params.shiftId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Dienst nicht gefunden' });
    const name = clean(req.body && req.body.name, 100);
    if (!name && db.prepare('SELECT 1 FROM nk_shift_signups WHERE shift_id = ? AND user_id = ?').get(s.id, req.user.id)) return done(req, res);
    db.prepare('INSERT INTO nk_shift_signups (shift_id, user_id, name, created_by) VALUES (?, ?, ?, ?)').run(s.id, name ? null : req.user.id, name, req.user.id);
    done(req, res);
  });
  app.delete('/api/nk/concerts/:id/shifts/:shiftId/signup/:signupId', (req, res) => {
    const su = db.prepare('SELECT su.* FROM nk_shift_signups su JOIN nk_shifts s ON s.id = su.shift_id WHERE su.id = ? AND s.concert_id = ?').get(req.params.signupId, req.params.id);
    if (!su) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    if (!(su.user_id === req.user.id || su.created_by === req.user.id || req.isAdmin)) return res.status(403).json({ error: 'Nur eigene Einträge können entfernt werden' });
    db.prepare('DELETE FROM nk_shift_signups WHERE id = ?').run(su.id);
    done(req, res);
  });

  // ---- Gaesteliste ----
  app.post('/api/nk/concerts/:id/guests', (req, res) => {
    const c = concertOr404(req, res); if (!c) return;
    const b = req.body || {};
    if (!clean(b.name)) return res.status(400).json({ error: 'Name fehlt' });
    const n = Math.max(1, Math.min(100, Math.round(+b.count) || 1));
    db.prepare('INSERT INTO nk_guests (concert_id, name, category, count, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, clean(b.name, 200), GUEST_CATEGORIES.includes(b.category) ? b.category : 'Sonstige', n, clean(b.note, 500), req.user.id);
    done(req, res, 201);
  });
  app.put('/api/nk/concerts/:id/guests/:guestId', (req, res) => {
    const g = db.prepare('SELECT * FROM nk_guests WHERE id = ? AND concert_id = ?').get(req.params.guestId, req.params.id);
    if (!g) return res.status(404).json({ error: 'Gast nicht gefunden' });
    const b = req.body || {};
    const checked = b.checked_in === undefined ? g.checked_in_at : (b.checked_in ? (g.checked_in_at || new Date().toISOString().slice(0, 19).replace('T', ' ')) : null);
    db.prepare('UPDATE nk_guests SET name = ?, category = ?, count = ?, note = ?, checked_in_at = ?, checked_by = ? WHERE id = ?').run(
      b.name !== undefined ? (clean(b.name, 200) || g.name) : g.name,
      b.category !== undefined && GUEST_CATEGORIES.includes(b.category) ? b.category : g.category,
      b.count !== undefined ? Math.max(1, Math.min(100, Math.round(+b.count) || 1)) : g.count,
      b.note !== undefined ? clean(b.note, 500) : g.note,
      checked, checked ? (b.checked_in !== undefined ? req.user.id : g.checked_by) : null, g.id);
    done(req, res);
  });
  app.delete('/api/nk/concerts/:id/guests/:guestId', (req, res) => {
    db.prepare('DELETE FROM nk_guests WHERE id = ? AND concert_id = ?').run(req.params.guestId, req.params.id);
    done(req, res);
  });
}

module.exports = { register, evening };
