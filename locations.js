// ================= LOCATIONS =================
// Räume/Säle sammeln und Tourtermine planen. Jede Gruppe (z. B. "voctails") hat eigene
// Locations und eigene Termine. Erster Reiter: Locations › Voctails › Tourplanung.
// Regel für die Voctails-Tour 2027 (Martin, 20.11.2026): nur Räume, die wir selbst mieten
// können – keine externen Veranstalter, Konzertreihen oder Kulturämter.

const db = require('./db');
const { displayForUserId } = require('./access');

const GROUPS = ['voctails'];
const VENUE_STATUSES = ['Kandidat', 'angefragt', 'Zusage', 'Absage', 'schon bespielt', 'verworfen'];
const RENTABLE = ['ja', 'unklar', 'nein'];
const DATE_STATUSES = ['offen', 'Vorschlag', 'angefragt', 'reserviert', 'gebucht', 'abgesagt', 'Probentag'];
const NUM_FIELDS = ['lat', 'lng'];
const VENUE_FIELDS = ['place', 'name', 'seats', 'costs', 'km', 'rentable', 'rating', 'status',
  'contact_person', 'phone', 'email', 'booking_url', 'website', 'source_url', 'notes', 'lat', 'lng'];
const DATE_FIELDS = ['date', 'time', 'label', 'venue_id', 'status', 'note'];

db.exec(`
CREATE TABLE IF NOT EXISTS loc_venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key TEXT NOT NULL,
  place TEXT,
  name TEXT,
  seats TEXT,
  costs TEXT,
  km TEXT,
  rentable TEXT DEFAULT 'unklar',
  rating TEXT,
  status TEXT DEFAULT 'Kandidat',
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  booking_url TEXT,
  website TEXT,
  source_url TEXT,
  notes TEXT,
  updated_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS loc_tour_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key TEXT NOT NULL,
  date TEXT,
  time TEXT,
  label TEXT,
  venue_id INTEGER REFERENCES loc_venues(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'offen',
  note TEXT,
  updated_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loc_venues_group ON loc_venues(group_key);
CREATE INDEX IF NOT EXISTS idx_loc_dates_group ON loc_tour_dates(group_key);
`);

{
  const cols = db.prepare('PRAGMA table_info(loc_venues)').all().map(c => c.name);
  if (!cols.includes('lat')) db.exec('ALTER TABLE loc_venues ADD COLUMN lat REAL');
  if (!cols.includes('lng')) db.exec('ALTER TABLE loc_venues ADD COLUMN lng REAL');
}

// Mittelpunkt der Tourplanung (Neckarsulm, Marktplatz)
const HOME = { name: 'Neckarsulm', lat: 49.1913, lng: 9.2246 };

// ---- Koordinaten über OpenStreetMap (Nominatim, max. 1 Anfrage/Sekunde) ----
let lastGeo = 0;
async function geocode(place, name) {
  const queries = [[name, place].filter(Boolean).join(', '), place].filter(Boolean);
  for (const q of queries) {
    const wait = lastGeo + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeo = Date.now();
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de&q=' + encodeURIComponent(q + ', Baden-Württemberg');
      const res = await fetch(url, { headers: { 'User-Agent': 'office-tool/1.0 (Vereinsverwaltung)', 'Accept-Language': 'de' } });
      if (!res.ok) continue;
      const arr = await res.json();
      if (arr && arr[0]) return { lat: +arr[0].lat, lng: +arr[0].lon };
    } catch (e) { /* nächste Variante */ }
  }
  return null;
}

// ---- Startdaten (einmalig je Version; vorhandene Einträge werden nie überschrieben) ----
function seed() {
  let data;
  try { data = require('./locations-seed.json'); } catch (e) { return; }
  const key = 'loc_seed_' + data.version;
  if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(key)) return;
  const tx = db.transaction(() => {
    const exists = db.prepare('SELECT id FROM loc_venues WHERE group_key = ? AND lower(place) = lower(?) AND lower(name) = lower(?)');
    const cols = VENUE_FIELDS.join(', ');
    const ins = db.prepare(`INSERT INTO loc_venues (group_key, ${cols}) VALUES (?, ${VENUE_FIELDS.map(() => '?').join(', ')})`);
    const upd = db.prepare(`UPDATE loc_venues SET ${VENUE_FIELDS.map(f => `${f} = COALESCE(${f}, ?)`).join(', ')} WHERE id = ?`);
    (data.venues || []).forEach(v => {
      const vals = VENUE_FIELDS.map(f => (v[f] === undefined || v[f] === '' || v[f] === null ? null : NUM_FIELDS.includes(f) ? +v[f] : String(v[f])));
      const row = exists.get(v.group || 'voctails', v.place || '', v.name || '');
      if (row) upd.run(...vals, row.id); // nur leere Felder ergänzen
      else ins.run(v.group || 'voctails', ...vals);
    });
    (data.dates || []).forEach(d => {
      const g = d.group || 'voctails';
      if (db.prepare('SELECT 1 FROM loc_tour_dates WHERE group_key = ? AND date IS ? AND label IS ?').get(g, d.date || null, d.label || null)) return;
      let venueId = null;
      if (d.venue_place) {
        const v = exists.get(g, d.venue_place, d.venue_name || '');
        if (v) venueId = v.id;
      }
      db.prepare('INSERT INTO loc_tour_dates (group_key, date, time, label, venue_id, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(g, d.date || null, d.time || null, d.label || null, venueId, d.status || 'offen', d.note || null);
    });
    // Tourvorschlag: nur Termine ohne Location bekommen den vorgeschlagenen Raum (Status „Vorschlag“)
    (data.proposal || []).forEach(x => {
      const g = x.group || 'voctails';
      const v = exists.get(g, x.venue_place, x.venue_name);
      if (!v) return;
      const row = x.date
        ? db.prepare('SELECT * FROM loc_tour_dates WHERE group_key = ? AND date = ? AND venue_id IS NULL').get(g, x.date)
        : db.prepare("SELECT * FROM loc_tour_dates WHERE group_key = ? AND date IS NULL AND venue_id IS NULL AND label LIKE 'Tourabschluss%'").get(g);
      if (!row) return;
      db.prepare("UPDATE loc_tour_dates SET venue_id = ?, status = CASE WHEN status = 'offen' THEN 'Vorschlag' ELSE status END, note = ? WHERE id = ?")
        .run(v.id, [x.note, row.note].filter(Boolean).join('\n'), row.id);
    });
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, '1');
  });
  tx();
}
seed();

const clean = (v, max = 4000) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

function venueOut(v) {
  return { ...v, updated_by_name: v.updated_by ? displayForUserId(db, v.updated_by).name : null };
}

function register(app) {
  app.get('/api/locations/:group', (req, res) => {
    const g = req.params.group;
    if (!GROUPS.includes(g)) return res.status(404).json({ error: 'Unbekannte Gruppe' });
    const venues = db.prepare('SELECT * FROM loc_venues WHERE group_key = ? ORDER BY place COLLATE NOCASE, name COLLATE NOCASE').all(g).map(venueOut);
    const dates = db.prepare("SELECT * FROM loc_tour_dates WHERE group_key = ? ORDER BY CASE WHEN date IS NULL THEN 1 ELSE 0 END, date, time").all(g);
    res.json({ venues, dates, home: HOME, venue_statuses: VENUE_STATUSES, rentable: RENTABLE, date_statuses: DATE_STATUSES });
  });

  app.post('/api/locations/:group/venues', (req, res) => {
    const g = req.params.group;
    if (!GROUPS.includes(g)) return res.status(404).json({ error: 'Unbekannte Gruppe' });
    const b = req.body || {};
    const r = db.prepare("INSERT INTO loc_venues (group_key, place, name, status, rentable, updated_by) VALUES (?, ?, ?, 'Kandidat', 'unklar', ?)")
      .run(g, clean(b.place, 200), clean(b.name, 300) || 'Neue Location', req.user.id);
    res.json(venueOut(db.prepare('SELECT * FROM loc_venues WHERE id = ?').get(r.lastInsertRowid)));
  });

  app.put('/api/locations/venues/:id', async (req, res) => {
    const { field, value } = req.body || {};
    if (!VENUE_FIELDS.includes(field)) return res.status(400).json({ error: 'Unbekanntes Feld' });
    let v = clean(value);
    if (NUM_FIELDS.includes(field)) {
      v = v === null ? null : parseFloat(String(v).replace(',', '.'));
      if (v !== null && !Number.isFinite(v)) return res.status(400).json({ error: 'Ungültige Koordinate' });
    }
    if (field === 'status' && !VENUE_STATUSES.includes(v)) return res.status(400).json({ error: 'Ungültiger Status' });
    if (field === 'rentable' && !RENTABLE.includes(v)) return res.status(400).json({ error: 'Ungültiger Wert' });
    const id = +req.params.id;
    const r = db.prepare(`UPDATE loc_venues SET ${field} = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(v, req.user.id, id);
    if (!r.changes) return res.status(404).json({ error: 'Nicht gefunden' });
    // Ort geändert: Kartenposition neu bestimmen (wartet, damit die Karte gleich stimmt)
    if (field === 'place' && v) {
      const row = db.prepare('SELECT place, name FROM loc_venues WHERE id = ?').get(id);
      const g = await geocode(row.place, row.name);
      if (g) db.prepare('UPDATE loc_venues SET lat = ?, lng = ? WHERE id = ?').run(g.lat, g.lng, id);
    }
    res.json(venueOut(db.prepare('SELECT * FROM loc_venues WHERE id = ?').get(id)));
  });

  // Koordinaten für eine Location (neu) suchen
  app.post('/api/locations/venues/:id/geocode', async (req, res) => {
    const v = db.prepare('SELECT * FROM loc_venues WHERE id = ?').get(+req.params.id);
    if (!v) return res.status(404).json({ error: 'Nicht gefunden' });
    const g = await geocode(v.place, v.name);
    if (!g) return res.status(404).json({ error: `Für „${v.place || v.name}“ keine Koordinaten gefunden – bitte Ort prüfen` });
    db.prepare("UPDATE loc_venues SET lat = ?, lng = ?, updated_at = datetime('now') WHERE id = ?").run(g.lat, g.lng, v.id);
    res.json(venueOut(db.prepare('SELECT * FROM loc_venues WHERE id = ?').get(v.id)));
  });

  app.delete('/api/locations/venues/:id', (req, res) => {
    db.prepare('DELETE FROM loc_venues WHERE id = ?').run(+req.params.id);
    res.status(204).end();
  });

  app.post('/api/locations/:group/dates', (req, res) => {
    const g = req.params.group;
    if (!GROUPS.includes(g)) return res.status(404).json({ error: 'Unbekannte Gruppe' });
    const b = req.body || {};
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null;
    const r = db.prepare("INSERT INTO loc_tour_dates (group_key, date, label, status, updated_by) VALUES (?, ?, ?, 'offen', ?)")
      .run(g, date, clean(b.label, 200) || 'Konzert', req.user.id);
    res.json(db.prepare('SELECT * FROM loc_tour_dates WHERE id = ?').get(r.lastInsertRowid));
  });

  app.put('/api/locations/dates/:id', (req, res) => {
    const { field, value } = req.body || {};
    if (!DATE_FIELDS.includes(field)) return res.status(400).json({ error: 'Unbekanntes Feld' });
    let v = clean(value, 2000);
    if (field === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: 'Ungültiges Datum' });
    if (field === 'time' && v && !/^\d{1,2}:\d{2}$/.test(v)) return res.status(400).json({ error: 'Ungültige Uhrzeit' });
    if (field === 'status' && !DATE_STATUSES.includes(v)) return res.status(400).json({ error: 'Ungültiger Status' });
    if (field === 'venue_id') {
      v = v ? parseInt(v, 10) : null;
      if (v !== null && !Number.isInteger(v)) return res.status(400).json({ error: 'Ungültige Location' });
      const own = db.prepare('SELECT group_key FROM loc_tour_dates WHERE id = ?').get(+req.params.id);
      if (v && !db.prepare('SELECT 1 FROM loc_venues WHERE id = ? AND group_key = ?').get(v, own ? own.group_key : '')) return res.status(400).json({ error: 'Location nicht gefunden' });
    }
    const r = db.prepare(`UPDATE loc_tour_dates SET ${field} = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(v, req.user.id, +req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(db.prepare('SELECT * FROM loc_tour_dates WHERE id = ?').get(+req.params.id));
  });

  app.delete('/api/locations/dates/:id', (req, res) => {
    db.prepare('DELETE FROM loc_tour_dates WHERE id = ?').run(+req.params.id);
    res.status(204).end();
  });
}

module.exports = { register };
