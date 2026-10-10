// ================= NECKARSULMER KONZERTE: SPONSOREN =================
// Sponsoren mit Kontaktdaten, Vereinbarungen, Logos (Volume + Dropbox-Kopie unter
// "<DROPBOX_NK_FOLDER>/Sponsoren/<Name>") und Sponsoring-Betraegen je Jahr bzw. Konzert.
// Einem Konzert zugeordnete Betraege tauchen in dessen Kalkulation als Vorschlag auf.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const contracts = require('./contracts');
const { displayForUserId } = require('./access');
const { safeFileName, FILES_DIR, DROPBOX_NK_FOLDER, MAX_FILE_BYTES } = require('./nk');

const LOGO_DIR = path.join(FILES_DIR, 'sponsoren');
const STATUSES = ['angefragt', 'zugesagt', 'bezahlt', 'abgelehnt'];
const SPONSOR_FIELDS = ['name', 'contact_person', 'email', 'phone', 'address', 'website', 'consideration', 'notes'];

db.exec(`
CREATE TABLE IF NOT EXISTS nk_sponsors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  website TEXT,
  consideration TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nk_sponsor_logos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sponsor_id INTEGER NOT NULL REFERENCES nk_sponsors(id) ON DELETE CASCADE,
  label TEXT,
  filename TEXT NOT NULL,
  stored_path TEXT,
  dropbox_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  uploaded_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nk_sponsorships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sponsor_id INTEGER NOT NULL REFERENCES nk_sponsors(id) ON DELETE CASCADE,
  concert_id INTEGER REFERENCES nk_concerts(id) ON DELETE SET NULL,
  year INTEGER,
  amount REAL,
  status TEXT DEFAULT 'zugesagt',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nk_sponsor_logos ON nk_sponsor_logos(sponsor_id);
CREATE INDEX IF NOT EXISTS idx_nk_sponsorships ON nk_sponsorships(sponsor_id);
`);

const clean = (v, max = 2000) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

function canManage(req, createdBy) {
  return req.isAdmin || (createdBy && createdBy === req.user.id);
}

function sponsorDetail(s, req) {
  const logos = db.prepare('SELECT * FROM nk_sponsor_logos WHERE sponsor_id = ? ORDER BY id').all(s.id).map(l => ({
    id: l.id, label: l.label, filename: l.filename, mime_type: l.mime_type, size_bytes: l.size_bytes,
    in_dropbox: !!l.dropbox_path, uploaded_at: l.uploaded_at,
    is_image: /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(l.mime_type || ''),
  }));
  const sponsorships = db.prepare(`
    SELECT sh.*, c.title AS concert_title, c.date AS concert_date
    FROM nk_sponsorships sh LEFT JOIN nk_concerts c ON c.id = sh.concert_id
    WHERE sh.sponsor_id = ? ORDER BY COALESCE(sh.year, 0) DESC, sh.id DESC
  `).all(s.id);
  const counted = sponsorships.filter(x => x.status !== 'abgelehnt');
  return {
    ...s,
    created_by_display: displayForUserId(db, s.created_by),
    can_manage: canManage(req, s.created_by),
    logos, sponsorships,
    total: Math.round(counted.reduce((sum, x) => sum + (x.amount || 0), 0) * 100) / 100,
    paid: Math.round(counted.filter(x => x.status === 'bezahlt').reduce((sum, x) => sum + (x.amount || 0), 0) * 100) / 100,
  };
}

function cleanSponsorship(b) {
  const year = b.year ? Math.round(+b.year) : null;
  const amount = b.amount === '' || b.amount === null || b.amount === undefined ? null : Math.round(+String(b.amount).replace(',', '.') * 100) / 100;
  const concertId = b.concert_id && db.prepare('SELECT id FROM nk_concerts WHERE id = ?').get(+b.concert_id) ? +b.concert_id : null;
  return {
    year: year && year > 1900 && year < 3000 ? year : null,
    amount: Number.isFinite(amount) ? amount : null,
    concert_id: concertId,
    status: STATUSES.includes(b.status) ? b.status : 'zugesagt',
    note: clean(b.note, 500),
  };
}

function register(app) {
  app.get('/api/nk/sponsors', (req, res) => {
    const sponsors = db.prepare('SELECT * FROM nk_sponsors ORDER BY name COLLATE NOCASE').all().map(s => sponsorDetail(s, req));
    const concerts = db.prepare("SELECT id, title, date FROM nk_concerts WHERE status != 'Abgesagt' ORDER BY date IS NULL, date DESC").all();
    res.json({ sponsors, concerts, statuses: STATUSES });
  });

  app.post('/api/nk/sponsors', (req, res) => {
    const b = req.body || {};
    if (!clean(b.name)) return res.status(400).json({ error: 'Name ist erforderlich' });
    const info = db.prepare(`INSERT INTO nk_sponsors (${SPONSOR_FIELDS.join(', ')}, created_by) VALUES (${SPONSOR_FIELDS.map(() => '?').join(', ')}, ?)`)
      .run(...SPONSOR_FIELDS.map(f => clean(b[f], f === 'name' ? 200 : 2000)), req.user.id);
    res.status(201).json(sponsorDetail(db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(info.lastInsertRowid), req));
  });

  app.put('/api/nk/sponsors/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sponsor nicht gefunden' });
    const b = req.body || {};
    const values = SPONSOR_FIELDS.map(f => (b[f] === undefined ? s[f] : clean(b[f], f === 'name' ? 200 : 2000)));
    if (!values[0]) return res.status(400).json({ error: 'Name ist erforderlich' });
    db.prepare(`UPDATE nk_sponsors SET ${SPONSOR_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...values, s.id);
    res.json(sponsorDetail(db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(s.id), req));
  });

  app.delete('/api/nk/sponsors/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sponsor nicht gefunden' });
    if (!canManage(req, s.created_by)) return res.status(403).json({ error: 'Nur wer den Sponsor angelegt hat oder ein Admin darf ihn löschen' });
    // Logo-Dateien bleiben als Sicherung auf dem Volume bzw. in Dropbox liegen
    db.prepare('DELETE FROM nk_sponsors WHERE id = ?').run(s.id);
    res.status(204).end();
  });

  // ---- Logos ----
  app.post('/api/nk/sponsors/:id/logos', async (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sponsor nicht gefunden' });
    const { filename, file_base64, mime_type, label } = req.body || {};
    if (!filename || !file_base64) return res.status(400).json({ error: 'Datei fehlt' });
    const buffer = Buffer.from(file_base64, 'base64');
    if (buffer.length > MAX_FILE_BYTES) return res.status(400).json({ error: 'Datei ist zu groß (max. 18 MB)' });
    const cleanName = safeFileName(filename);
    const dir = path.join(LOGO_DIR, String(s.id));
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `${Date.now()}-${cleanName}`;
    fs.writeFileSync(path.join(dir, storedName), buffer);
    let dropboxPath = null;
    if (contracts.isDropboxConfigured()) {
      try {
        const token = await contracts.getAccessToken();
        dropboxPath = await contracts.uploadFileToPath(token, `${DROPBOX_NK_FOLDER}/Sponsoren/${contracts.sanitizeFolderName(s.name)}/${cleanName}`, buffer);
      } catch (err) {
        console.error('[NK-Sponsoren] Dropbox-Kopie fehlgeschlagen:', err.message);
      }
    }
    db.prepare(`
      INSERT INTO nk_sponsor_logos (sponsor_id, label, filename, stored_path, dropbox_path, mime_type, size_bytes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.id, clean(label, 100), cleanName, path.join('sponsoren', String(s.id), storedName), dropboxPath, mime_type || null, buffer.length, req.user.id);
    res.status(201).json(sponsorDetail(s, req));
  });

  app.get('/api/nk/sponsors/:id/logos/:logoId', async (req, res) => {
    const l = db.prepare('SELECT * FROM nk_sponsor_logos WHERE id = ? AND sponsor_id = ?').get(req.params.logoId, req.params.id);
    if (!l) return res.status(404).send('Logo nicht gefunden');
    // SVGs koennen Skripte enthalten - beim direkten Oeffnen nichts ausfuehren lassen
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    const localPath = l.stored_path ? path.join(FILES_DIR, l.stored_path) : null;
    if (localPath && fs.existsSync(localPath)) {
      res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(l.filename)}`);
      if (l.mime_type) res.type(l.mime_type);
      return res.sendFile(localPath);
    }
    if (l.dropbox_path && contracts.isDropboxConfigured()) {
      try {
        const token = await contracts.getAccessToken();
        return res.redirect(await contracts.getTemporaryLink(token, l.dropbox_path));
      } catch (err) {
        return res.status(502).send('Logo konnte nicht aus Dropbox geladen werden: ' + err.message);
      }
    }
    res.status(404).send('Logo ist nicht mehr vorhanden');
  });

  app.delete('/api/nk/sponsors/:id/logos/:logoId', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    const l = db.prepare('SELECT * FROM nk_sponsor_logos WHERE id = ? AND sponsor_id = ?').get(req.params.logoId, req.params.id);
    if (!s || !l) return res.status(404).json({ error: 'Logo nicht gefunden' });
    db.prepare('DELETE FROM nk_sponsor_logos WHERE id = ?').run(l.id);
    res.json(sponsorDetail(s, req));
  });

  // ---- Sponsoring-Betraege ----
  app.post('/api/nk/sponsors/:id/sponsorships', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sponsor nicht gefunden' });
    const v = cleanSponsorship(req.body || {});
    if (v.amount === null) return res.status(400).json({ error: 'Bitte einen Betrag eintragen' });
    db.prepare('INSERT INTO nk_sponsorships (sponsor_id, concert_id, year, amount, status, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, v.concert_id, v.year, v.amount, v.status, v.note);
    res.status(201).json(sponsorDetail(s, req));
  });

  app.put('/api/nk/sponsors/:id/sponsorships/:shId', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    const sh = db.prepare('SELECT * FROM nk_sponsorships WHERE id = ? AND sponsor_id = ?').get(req.params.shId, req.params.id);
    if (!s || !sh) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const v = cleanSponsorship({ ...sh, ...(req.body || {}) });
    db.prepare('UPDATE nk_sponsorships SET concert_id = ?, year = ?, amount = ?, status = ?, note = ? WHERE id = ?')
      .run(v.concert_id, v.year, v.amount, v.status, v.note, sh.id);
    res.json(sponsorDetail(s, req));
  });

  app.delete('/api/nk/sponsors/:id/sponsorships/:shId', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sponsor nicht gefunden' });
    db.prepare('DELETE FROM nk_sponsorships WHERE id = ? AND sponsor_id = ?').run(req.params.shId, s.id);
    res.json(sponsorDetail(s, req));
  });
}

module.exports = { register };
