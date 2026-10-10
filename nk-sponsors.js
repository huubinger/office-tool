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
const letters = require('./nk-letters');

// Minimales ZIP (ohne Kompression - Logos sind ohnehin komprimiert), Dateinamen in UTF-8
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

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
// Gegenleistungen je Zusage (JSON [{text, done}]) und Rechnungsnummer
db.ensureColumn('nk_sponsorships', 'benefits', 'TEXT');
db.ensureColumn('nk_sponsorships', 'invoice_number', 'TEXT');
db.ensureColumn('nk_sponsorships', 'invoice_date', 'TEXT');

const ORG_FIELDS = ['name', 'address', 'city', 'email', 'phone', 'website', 'tax_office', 'tax_number', 'vat_id', 'exemption_date', 'exemption_year',
  'purpose', 'iban', 'bic', 'bank', 'signer', 'vat_rate', 'vat_note'];
function orgSettings() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'nk_org'").get();
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch (e) { v = {}; }
  const filled = Object.fromEntries(Object.entries(v).filter(([, val]) => val !== '' && val !== null && val !== undefined));
  return { purpose: 'Förderung von Kunst und Kultur', vat_rate: 0, ...filled };
}
function parseBenefits(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function cleanBenefits(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30)
    .map(b => ({ text: String((b && b.text) || '').trim().slice(0, 300), done: !!(b && b.done) }))
    .filter(b => b.text);
}
// Vorschlag aus dem Feld "Vereinbarung/Gegenleistung" des Sponsors
function benefitsFromConsideration(text) {
  return String(text || '').split(/\n|;|,(?![^(]*\))/).map(t => t.trim()).filter(Boolean).slice(0, 15).map(t => ({ text: t, done: false }));
}

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
  `).all(s.id).map(sh => ({ ...sh, benefits: parseBenefits(sh.benefits) }));
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
  const amount = require('./nk-budget').toAmount(b.amount);
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
    res.json({ sponsors, concerts, statuses: STATUSES, org: orgSettings(), renewals: require('./nk-plan').sponsorRenewals(new Date().getFullYear()) });
  });

  // ---- Vereinsdaten (fuer Rechnung, Zuwendungsbestaetigung, Dankesbrief) ----
  app.put('/api/nk/sponsors-org', (req, res) => {
    const b = req.body || {};
    const v = {};
    ORG_FIELDS.forEach(f => { v[f] = f === 'vat_rate' ? Math.max(0, Math.min(30, +String(b[f] ?? 0).replace(',', '.') || 0)) : String(b[f] ?? '').trim().slice(0, 1000); });
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('nk_org', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(v));
    res.json(orgSettings());
  });

  // ---- Logo-Paket als ZIP: fuer ein Konzert, ein Jahr oder alle aktiven Sponsoren ----
  app.get('/api/nk/sponsors-logos.zip', async (req, res) => {
    let sponsorIds;
    let name = 'Sponsoren-Logos';
    if (req.query.concert) {
      const c = db.prepare('SELECT title, date FROM nk_concerts WHERE id = ?').get(+req.query.concert);
      sponsorIds = db.prepare("SELECT DISTINCT sponsor_id FROM nk_sponsorships WHERE concert_id = ? AND status != 'abgelehnt'").all(+req.query.concert).map(r => r.sponsor_id);
      if (c) name += ` ${c.date || ''} ${c.title}`;
    } else if (req.query.year) {
      sponsorIds = db.prepare(`SELECT DISTINCT sh.sponsor_id FROM nk_sponsorships sh LEFT JOIN nk_concerts c ON c.id = sh.concert_id
        WHERE sh.status != 'abgelehnt' AND COALESCE(sh.year, CAST(substr(c.date, 1, 4) AS INTEGER)) = ?`).all(+req.query.year).map(r => r.sponsor_id);
      name += ` ${+req.query.year}`;
    } else {
      sponsorIds = db.prepare('SELECT id FROM nk_sponsors').all().map(r => r.id);
    }
    const entries = [];
    const used = new Set();
    for (const id of sponsorIds) {
      const sp = db.prepare('SELECT name FROM nk_sponsors WHERE id = ?').get(id);
      for (const l of db.prepare('SELECT * FROM nk_sponsor_logos WHERE sponsor_id = ? ORDER BY id').all(id)) {
        const local = l.stored_path ? path.join(FILES_DIR, l.stored_path) : null;
        let data = null;
        if (local && fs.existsSync(local)) data = fs.readFileSync(local);
        else if (l.dropbox_path && contracts.isDropboxConfigured()) {
          try {
            const r = await fetch(await contracts.getTemporaryLink(await contracts.getAccessToken(), l.dropbox_path));
            if (r.ok) data = Buffer.from(await r.arrayBuffer());
          } catch (e) { /* Logo fehlt */ }
        }
        if (!data) continue;
        let file = `${contracts.sanitizeFolderName(sp.name)}/${l.label ? safeFileName(l.label) + ' - ' : ''}${l.filename}`;
        while (used.has(file)) file = file.replace(/(\.[^.]+)?$/, ' (2)$1');
        used.add(file);
        entries.push({ name: file, data });
      }
    }
    if (!entries.length) return res.status(404).type('text').send('Keine Logos vorhanden.');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(name.trim()) + '.zip')}`);
    res.type('application/zip').send(zip(entries));
  });

  // ---- Briefe als PDF: Rechnung, Zuwendungsbestaetigung, Dankesbrief ----
  app.get('/api/nk/sponsors/:id/sponsorships/:shId/letter.pdf', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    const sh = db.prepare(`SELECT sh.*, c.title AS concert_title, c.date AS concert_date FROM nk_sponsorships sh
      LEFT JOIN nk_concerts c ON c.id = sh.concert_id WHERE sh.id = ? AND sh.sponsor_id = ?`).get(req.params.shId, req.params.id);
    if (!s || !sh) return res.status(404).send('Nicht gefunden');
    const type = ['rechnung', 'spende', 'dank'].includes(req.query.type) ? req.query.type : 'dank';
    if (type !== 'dank' && !sh.amount) return res.status(400).type('text').send('Für Rechnung bzw. Zuwendungsbestätigung fehlt der Betrag.');
    if (type === 'rechnung' && !sh.invoice_number) {
      const year = new Date().getFullYear();
      const n = db.prepare("SELECT COUNT(*) AS c FROM nk_sponsorships WHERE invoice_number LIKE ?").get(`SP-${year}-%`).c + 1;
      sh.invoice_number = `SP-${year}-${String(n).padStart(3, '0')}`;
      sh.invoice_date = new Date().toISOString().slice(0, 10);
      db.prepare('UPDATE nk_sponsorships SET invoice_number = ?, invoice_date = ? WHERE id = ?').run(sh.invoice_number, sh.invoice_date, sh.id);
    }
    const title = { rechnung: `Rechnung ${sh.invoice_number}`, spende: 'Zuwendungsbestätigung', dank: 'Dankesbrief' }[type];
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${title} ${s.name}.pdf`)}`);
    res.type('application/pdf');
    letters.render(type, { sponsor: s, sh: { ...sh, benefits: parseBenefits(sh.benefits) }, org: orgSettings() }, res);
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
    db.prepare('INSERT INTO nk_sponsorships (sponsor_id, concert_id, year, amount, status, note, benefits) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, v.concert_id, v.year, v.amount, v.status, v.note, JSON.stringify(benefitsFromConsideration(s.consideration)));
    res.status(201).json(sponsorDetail(s, req));
  });

  app.put('/api/nk/sponsors/:id/sponsorships/:shId', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    const sh = db.prepare('SELECT * FROM nk_sponsorships WHERE id = ? AND sponsor_id = ?').get(req.params.shId, req.params.id);
    if (!s || !sh) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const v = cleanSponsorship({ ...sh, ...(req.body || {}) });
    const benefits = req.body && req.body.benefits !== undefined ? JSON.stringify(cleanBenefits(req.body.benefits)) : sh.benefits;
    db.prepare('UPDATE nk_sponsorships SET concert_id = ?, year = ?, amount = ?, status = ?, note = ?, benefits = ? WHERE id = ?')
      .run(v.concert_id, v.year, v.amount, v.status, v.note, benefits, sh.id);
    res.json(sponsorDetail(s, req));
  });

  app.delete('/api/nk/sponsors/:id/sponsorships/:shId', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_sponsors WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sponsor nicht gefunden' });
    db.prepare('DELETE FROM nk_sponsorships WHERE id = ? AND sponsor_id = ?').run(req.params.shId, s.id);
    res.json(sponsorDetail(s, req));
  });
}

module.exports = { register, zip, orgSettings };
