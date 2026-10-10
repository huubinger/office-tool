// ================= NECKARSULMER KONZERTE: KONTAKTE =================
// Kuenstler, Agenturen, Technik, Saele, Presse … mit Kontaktdaten und Technik-Anforderungen.
// Je Konzert lassen sich Kontakte als "Beteiligte" mit Rolle und Gage verknuepfen -
// daraus ergibt sich die Gagen-Historie ("mit wem haben wir schon gearbeitet, was hat es gekostet").

const db = require('./db');
const nk = require('./nk');
const { displayForUserId } = require('./access');

const KINDS = ['Künstler/Ensemble', 'Agentur', 'Technik', 'Saal/Location', 'Presse', 'Dienstleister', 'Sonstige'];
const FIELDS = ['name', 'kind', 'contact_person', 'email', 'phone', 'website', 'address', 'rider', 'notes'];

db.exec(`
CREATE TABLE IF NOT EXISTS nk_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  rider TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nk_concert_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES nk_contacts(id) ON DELETE CASCADE,
  role TEXT,
  fee REAL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nk_concert_contacts ON nk_concert_contacts(concert_id);
CREATE INDEX IF NOT EXISTS idx_nk_contact_concerts ON nk_concert_contacts(contact_id);
`);

// Einmalig: wer die Projekte sieht, bekommt auch den neuen Reiter Kontakte
if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'migr_nk_contacts_tab'").get()) {
  db.prepare('SELECT id, allowed_tabs FROM app_users WHERE allowed_tabs IS NOT NULL').all().forEach(u => {
    try {
      const tabs = JSON.parse(u.allowed_tabs);
      if (Array.isArray(tabs) && tabs.includes('nk_projects') && !tabs.includes('nk_contacts')) {
        db.prepare('UPDATE app_users SET allowed_tabs = ? WHERE id = ?').run(JSON.stringify([...tabs, 'nk_contacts']), u.id);
      }
    } catch (e) { /* ungueltige Freigaben ignorieren */ }
  });
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('migr_nk_contacts_tab', '1')").run();
}

const clean = (v, max = 2000) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const cleanFee = (v) => {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).replace(/[€\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.200 = Tausenderpunkt
  else if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

function contactDetail(k, req) {
  const concerts = db.prepare(`
    SELECT cc.*, c.title AS concert_title, c.date AS concert_date, c.status AS concert_status
    FROM nk_concert_contacts cc JOIN nk_concerts c ON c.id = cc.concert_id
    WHERE cc.contact_id = ? ORDER BY c.date IS NULL, c.date DESC
  `).all(k.id);
  const fees = concerts.filter(x => x.fee !== null);
  return {
    ...k,
    created_by_display: displayForUserId(db, k.created_by),
    can_manage: nk.canManage(req, k.created_by),
    concerts,
    fee_total: Math.round(fees.reduce((s, x) => s + x.fee, 0) * 100) / 100,
    fee_avg: fees.length ? Math.round(fees.reduce((s, x) => s + x.fee, 0) / fees.length * 100) / 100 : null,
  };
}

function participants(concertId) {
  return db.prepare(`
    SELECT cc.*, k.name, k.kind, k.contact_person, k.email, k.phone, k.rider
    FROM nk_concert_contacts cc JOIN nk_contacts k ON k.id = cc.contact_id
    WHERE cc.concert_id = ? ORDER BY cc.id
  `).all(concertId);
}

function register(app) {
  nk.extendDetail((c, req) => ({
    participants: participants(c.id),
    contact_kinds: KINDS,
    // Auswahl fuer "Beteiligte hinzufuegen" (nur Namen, Detaildaten im Reiter Kontakte)
    contact_choices: db.prepare('SELECT id, name, kind FROM nk_contacts ORDER BY name COLLATE NOCASE').all(),
  }));

  app.get('/api/nk/contacts', (req, res) => {
    const contacts = db.prepare('SELECT * FROM nk_contacts ORDER BY name COLLATE NOCASE').all().map(k => contactDetail(k, req));
    res.json({ contacts, kinds: KINDS });
  });

  app.post('/api/nk/contacts', (req, res) => {
    const b = req.body || {};
    if (!clean(b.name)) return res.status(400).json({ error: 'Name ist erforderlich' });
    const values = FIELDS.map(f => (f === 'kind' ? (KINDS.includes(b.kind) ? b.kind : 'Sonstige') : clean(b[f], f === 'name' ? 200 : 4000)));
    const info = db.prepare(`INSERT INTO nk_contacts (${FIELDS.join(', ')}, created_by) VALUES (${FIELDS.map(() => '?').join(', ')}, ?)`).run(...values, req.user.id);
    res.status(201).json(contactDetail(db.prepare('SELECT * FROM nk_contacts WHERE id = ?').get(info.lastInsertRowid), req));
  });

  app.put('/api/nk/contacts/:id', (req, res) => {
    const k = db.prepare('SELECT * FROM nk_contacts WHERE id = ?').get(req.params.id);
    if (!k) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
    const b = req.body || {};
    const values = FIELDS.map(f => {
      if (b[f] === undefined) return k[f];
      return f === 'kind' ? (KINDS.includes(b.kind) ? b.kind : k.kind) : clean(b[f], f === 'name' ? 200 : 4000);
    });
    if (!values[0]) return res.status(400).json({ error: 'Name ist erforderlich' });
    db.prepare(`UPDATE nk_contacts SET ${FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...values, k.id);
    res.json(contactDetail(db.prepare('SELECT * FROM nk_contacts WHERE id = ?').get(k.id), req));
  });

  app.delete('/api/nk/contacts/:id', (req, res) => {
    const k = db.prepare('SELECT * FROM nk_contacts WHERE id = ?').get(req.params.id);
    if (!k) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
    if (!nk.canManage(req, k.created_by)) return res.status(403).json({ error: 'Nur wer den Kontakt angelegt hat oder ein Admin darf ihn löschen' });
    db.prepare('DELETE FROM nk_contacts WHERE id = ?').run(k.id);
    res.status(204).end();
  });

  // ---- Beteiligte je Konzert (Rechte: Reiter Projekte) ----
  app.post('/api/nk/concerts/:id/participants', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const b = req.body || {};
    let contactId = b.contact_id ? +b.contact_id : null;
    // Neuen Kontakt direkt mit anlegen
    if (!contactId && clean(b.new_name)) {
      contactId = db.prepare('INSERT INTO nk_contacts (name, kind, email, phone, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(clean(b.new_name, 200), KINDS.includes(b.new_kind) ? b.new_kind : 'Sonstige', clean(b.new_email, 200), clean(b.new_phone, 100), req.user.id).lastInsertRowid;
    }
    if (!contactId || !db.prepare('SELECT 1 FROM nk_contacts WHERE id = ?').get(contactId)) return res.status(400).json({ error: 'Bitte einen Kontakt auswählen oder einen Namen eingeben' });
    db.prepare('INSERT INTO nk_concert_contacts (concert_id, contact_id, role, fee, note) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, contactId, clean(b.role, 200), cleanFee(b.fee), clean(b.note, 500));
    res.status(201).json(nk.concertDetail(c.id, req));
  });

  app.put('/api/nk/concerts/:id/participants/:pid', (req, res) => {
    const p = db.prepare('SELECT * FROM nk_concert_contacts WHERE id = ? AND concert_id = ?').get(req.params.pid, req.params.id);
    if (!p) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const b = req.body || {};
    db.prepare('UPDATE nk_concert_contacts SET role = ?, fee = ?, note = ? WHERE id = ?').run(
      b.role !== undefined ? clean(b.role, 200) : p.role,
      b.fee !== undefined ? cleanFee(b.fee) : p.fee,
      b.note !== undefined ? clean(b.note, 500) : p.note, p.id);
    res.json(nk.concertDetail(req.params.id, req));
  });

  app.delete('/api/nk/concerts/:id/participants/:pid', (req, res) => {
    db.prepare('DELETE FROM nk_concert_contacts WHERE id = ? AND concert_id = ?').run(req.params.pid, req.params.id);
    res.json(nk.concertDetail(req.params.id, req));
  });
}

module.exports = { register, participants, KINDS };
