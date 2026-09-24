// ================= ENSEMBLE (privat) =================
// Persoenliche Ensemble-Liste: Namen, Stimmumfang (als MIDI-Notennummern, z.B. 60 = C4),
// Kommentare zu Tanz, Schauspiel und Sonstigem. Nur fuer Admins sichtbar (siehe server.js);
// jeder Eintrag gehoert dem Konto, das ihn angelegt hat - andere sehen ihn nie.

const db = require('./db');

const MIN_NOTE = 24; // C1
const MAX_NOTE = 96; // C7

function cleanNote(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Math.round(+n);
  return Number.isFinite(v) && v >= MIN_NOTE && v <= MAX_NOTE ? v : null;
}

function cleanText(t, max = 5000) {
  const s = String(t || '').trim();
  return s ? s.slice(0, max) : null;
}

function register(app) {
  const getOwn = (id, userId) => db.prepare('SELECT * FROM nk_ensemble WHERE id = ? AND owner_id = ?').get(id, userId);

  app.get('/api/nk/ensemble', (req, res) => {
    res.json(db.prepare('SELECT * FROM nk_ensemble WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id));
  });

  app.post('/api/nk/ensemble', (req, res) => {
    const b = req.body || {};
    const name = cleanText(b.name, 200);
    if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });
    let low = cleanNote(b.range_low);
    let high = cleanNote(b.range_high);
    if (low !== null && high !== null && low > high) [low, high] = [high, low];
    const info = db.prepare(`
      INSERT INTO nk_ensemble (owner_id, name, range_low, range_high, dance_notes, acting_notes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, name, low, high, cleanText(b.dance_notes), cleanText(b.acting_notes), cleanText(b.notes));
    res.status(201).json(getOwn(info.lastInsertRowid, req.user.id));
  });

  app.put('/api/nk/ensemble/:id', (req, res) => {
    const m = getOwn(req.params.id, req.user.id);
    if (!m) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const b = req.body || {};
    let low = b.range_low !== undefined ? cleanNote(b.range_low) : m.range_low;
    let high = b.range_high !== undefined ? cleanNote(b.range_high) : m.range_high;
    if (low !== null && high !== null && low > high) [low, high] = [high, low];
    db.prepare(`
      UPDATE nk_ensemble SET name = ?, range_low = ?, range_high = ?, dance_notes = ?, acting_notes = ?, notes = ?,
        updated_at = datetime('now') WHERE id = ?
    `).run(
      b.name !== undefined ? (cleanText(b.name, 200) || m.name) : m.name,
      low, high,
      b.dance_notes !== undefined ? cleanText(b.dance_notes) : m.dance_notes,
      b.acting_notes !== undefined ? cleanText(b.acting_notes) : m.acting_notes,
      b.notes !== undefined ? cleanText(b.notes) : m.notes,
      m.id
    );
    res.json(getOwn(m.id, req.user.id));
  });

  app.delete('/api/nk/ensemble/:id', (req, res) => {
    const m = getOwn(req.params.id, req.user.id);
    if (!m) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    db.prepare('DELETE FROM nk_ensemble WHERE id = ?').run(m.id);
    res.status(204).end();
  });
}

module.exports = { register };
