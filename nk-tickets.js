// ================= NECKARSULMER KONZERTE: TICKETVERKAUF & KULTURKALENDER =================
// Verkaufte Tickets je Konzert aus mehreren Quellen:
//  - Kreatief-Homepage: oeffentliche Veranstaltungsliste (api.kreatief-neckarsulm.de) liefert die
//    freien Plaetze ("remainingTickets"); verkauft = Kontingent - frei. Abgleich stuendlich.
//  - Reservix und sonstige: Zahl von Hand eintragen (Reservix-Schnittstelle folgt spaeter).
// Ausserdem: Steht das Konzert schon im Neckarsulmer Kulturkalender?

const cron = require('node-cron');
const db = require('./db');
const nk = require('./nk');

const KREATIEF_API = 'https://api.kreatief-neckarsulm.de/frontend/veranstaltung/list-items';
const KREATIEF_EVENT_URL = 'https://www.kreatief-neckarsulm.de/veranstaltungen/';
const KULTURKALENDER = 'https://www.neckarsulmer-kulturkalender.de';
const SOURCES = { kreatief: 'Kreatief-Homepage', reservix: 'Reservix', manuell: 'Sonstige / Abendkasse' };

db.exec(`
CREATE TABLE IF NOT EXISTS nk_ticket_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT,
  label TEXT,
  capacity INTEGER,
  sold INTEGER,
  remaining INTEGER,
  last_checked_at TEXT,
  error TEXT,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nk_ticket_snapshots (
  source_id INTEGER NOT NULL REFERENCES nk_ticket_sources(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sold INTEGER,
  PRIMARY KEY (source_id, day)
);
CREATE INDEX IF NOT EXISTS idx_nk_ticket_sources ON nk_ticket_sources(concert_id);
`);

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(+v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// ---------- Kreatief-Homepage ----------
let kreatiefCache = { at: 0, events: [] };
async function kreatiefEvents(force) {
  if (!force && Date.now() - kreatiefCache.at < 10 * 60 * 1000) return kreatiefCache.events;
  const res = await fetch(KREATIEF_API, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Kreatief-Homepage antwortet nicht (${res.status})`);
  const list = await res.json();
  const events = (Array.isArray(list) ? list : []).map(e => ({
    id: String(e.id),
    name: e.name,
    date: e.date ? new Date(e.date).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }) : null,
    time: e.date ? new Date(e.date).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }) : null,
    location: e.locationTextname || null,
    organizer: e.organizerName || null,
    remaining: Number.isFinite(e.remainingTickets) ? e.remainingTickets : null,
    online: !!e.onlinePresale,
    cancelled: !!e.cancelledReason,
    url: KREATIEF_EVENT_URL + e.id,
  }));
  kreatiefCache = { at: Date.now(), events };
  return events;
}

function saveSnapshot(sourceId, sold) {
  if (sold === null || sold === undefined) return;
  db.prepare('INSERT INTO nk_ticket_snapshots (source_id, day, sold) VALUES (?, ?, ?) ON CONFLICT(source_id, day) DO UPDATE SET sold = excluded.sold')
    .run(sourceId, today(), sold);
}

// Alle verknuepften Kreatief-Quellen aktualisieren (Veranstaltungen, die nicht mehr in der
// Liste stehen - z.B. weil vorbei -, behalten ihren letzten Stand)
async function refreshKreatief(onlyConcertId) {
  const sources = db.prepare(`SELECT * FROM nk_ticket_sources WHERE source = 'kreatief'${onlyConcertId ? ' AND concert_id = ?' : ''}`)
    .all(...(onlyConcertId ? [onlyConcertId] : []));
  if (!sources.length) return 0;
  let events;
  try {
    events = await kreatiefEvents(true);
  } catch (err) {
    sources.forEach(s => db.prepare('UPDATE nk_ticket_sources SET error = ? WHERE id = ?').run(err.message, s.id));
    throw err;
  }
  let updated = 0;
  for (const s of sources) {
    const e = events.find(x => x.id === String(s.external_id));
    if (!e) {
      db.prepare("UPDATE nk_ticket_sources SET error = ?, last_checked_at = datetime('now') WHERE id = ?")
        .run('Veranstaltung steht nicht (mehr) auf der Homepage – letzter Stand bleibt erhalten', s.id);
      continue;
    }
    const sold = s.capacity && e.remaining !== null ? Math.max(0, s.capacity - e.remaining) : null;
    db.prepare("UPDATE nk_ticket_sources SET remaining = ?, sold = ?, label = COALESCE(label, ?), error = NULL, last_checked_at = datetime('now') WHERE id = ?")
      .run(e.remaining, sold, e.name, s.id);
    saveSnapshot(s.id, sold);
    updated++;
  }
  return updated;
}

function ticketInfo(concert) {
  const sources = db.prepare('SELECT * FROM nk_ticket_sources WHERE concert_id = ? ORDER BY id').all(concert.id).map(s => ({
    ...s, source_label: SOURCES[s.source] || s.source,
    url: s.source === 'kreatief' && s.external_id ? KREATIEF_EVENT_URL + s.external_id : null,
  }));
  if (!sources.length) return null;
  const sold = sources.reduce((sum, s) => sum + (s.sold || 0), 0);
  const capacity = sources.every(s => s.capacity) ? sources.reduce((sum, s) => sum + s.capacity, 0) : (concert.capacity || null);
  // Verlauf: verkaufte Tickets je Tag (Summe aller Quellen; fehlende Tage mit dem letzten Stand fuellen)
  const snaps = db.prepare(`SELECT s.source_id, s.day, s.sold FROM nk_ticket_snapshots s JOIN nk_ticket_sources t ON t.id = s.source_id
    WHERE t.concert_id = ? ORDER BY s.day`).all(concert.id);
  const days = [...new Set(snaps.map(s => s.day))].sort();
  const last = new Map();
  const history = days.map(day => {
    snaps.filter(s => s.day === day).forEach(s => last.set(s.source_id, s.sold || 0));
    return { day, sold: [...last.values()].reduce((a, b) => a + b, 0) };
  });
  return { sources, sold, capacity, history };
}

// ---------- Kulturkalender ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
function titleMatch(a, b) {
  const wa = norm(a), wb = new Set(norm(b));
  if (!wa.length || !wb.size) return 0;
  return wa.filter(w => wb.has(w)).length / Math.min(wa.length, wb.size);
}
const kkCache = new Map();
async function kulturkalenderLookup(concert) {
  if (!concert.date) return { checked: false, reason: 'Noch kein Datum' };
  const month = concert.date.slice(0, 7);
  let list = kkCache.get(month);
  if (!list || Date.now() - list.at > 10 * 60 * 1000) {
    const res = await fetch(`${KULTURKALENDER}/api/termine?monat=${month}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Kulturkalender antwortet nicht (${res.status})`);
    list = { at: Date.now(), items: await res.json() };
    kkCache.set(month, list);
  }
  const sameDay = list.items.filter(t => t.datum_von === concert.date || (t.datum_bis && t.datum_von <= concert.date && t.datum_bis >= concert.date));
  const scored = sameDay.map(t => ({ t, score: titleMatch(concert.title, t.titel) })).sort((a, b) => b.score - a.score);
  const hit = scored.find(x => x.score >= 0.5);
  const toItem = (t) => ({ id: t.id, title: t.titel, verein: t.verein_name, time: t.beginn, url: `${KULTURKALENDER}/termin/${t.id}` });
  return {
    checked: true,
    found: hit ? toItem(hit.t) : null,
    same_day: sameDay.filter(t => !hit || t.id !== hit.t.id).map(toItem),
    submit_url: `${KULTURKALENDER}/verein/`,
  };
}

function register(app) {
  nk.extendDetail((c) => ({ tickets: ticketInfo(c), ticket_source_types: SOURCES }));
  nk.extendList((c) => {
    const row = db.prepare('SELECT SUM(sold) AS sold, COUNT(*) AS n, SUM(CASE WHEN capacity IS NULL THEN 1 ELSE 0 END) AS nocap, SUM(capacity) AS cap FROM nk_ticket_sources WHERE concert_id = ?').get(c.id);
    return { tickets_sold: row.n ? (row.sold || 0) : null, tickets_capacity: row.n ? (row.nocap ? c.capacity : row.cap) : null };
  });

  app.get('/api/nk/tickets/kreatief-events', async (req, res) => {
    try { res.json(await kreatiefEvents(!!req.query.refresh)); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/nk/concerts/:id/tickets', async (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const b = req.body || {};
    if (!SOURCES[b.source]) return res.status(400).json({ error: 'Unbekannte Quelle' });
    if (b.source === 'kreatief' && !b.external_id) return res.status(400).json({ error: 'Bitte die Veranstaltung auf der Homepage auswählen' });
    const info = db.prepare('INSERT INTO nk_ticket_sources (concert_id, source, external_id, label, capacity, sold, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, b.source, b.external_id ? String(b.external_id).slice(0, 50) : null, b.label ? String(b.label).slice(0, 200) : null,
        intOrNull(b.capacity) || (b.source === 'kreatief' ? c.capacity : null), b.source === 'kreatief' ? null : intOrNull(b.sold), req.user.id);
    if (b.source === 'kreatief') await refreshKreatief(c.id).catch(() => {});
    else saveSnapshot(info.lastInsertRowid, intOrNull(b.sold));
    res.status(201).json(nk.concertDetail(c.id, req));
  });

  app.put('/api/nk/concerts/:id/tickets/:sid', async (req, res) => {
    const s = db.prepare('SELECT * FROM nk_ticket_sources WHERE id = ? AND concert_id = ?').get(req.params.sid, req.params.id);
    if (!s) return res.status(404).json({ error: 'Ticketquelle nicht gefunden' });
    const b = req.body || {};
    const capacity = b.capacity !== undefined ? intOrNull(b.capacity) : s.capacity;
    let sold = s.sold;
    if (s.source === 'kreatief') sold = capacity && s.remaining !== null ? Math.max(0, capacity - s.remaining) : null;
    else if (b.sold !== undefined) sold = intOrNull(b.sold);
    db.prepare("UPDATE nk_ticket_sources SET capacity = ?, sold = ?, label = ?, updated_at = datetime('now') WHERE id = ?")
      .run(capacity, sold, b.label !== undefined ? (String(b.label || '').slice(0, 200) || null) : s.label, s.id);
    saveSnapshot(s.id, sold);
    res.json(nk.concertDetail(req.params.id, req));
  });

  app.delete('/api/nk/concerts/:id/tickets/:sid', (req, res) => {
    db.prepare('DELETE FROM nk_ticket_sources WHERE id = ? AND concert_id = ?').run(req.params.sid, req.params.id);
    res.json(nk.concertDetail(req.params.id, req));
  });

  app.post('/api/nk/concerts/:id/tickets/refresh', async (req, res) => {
    try { await refreshKreatief(+req.params.id); } catch (err) { return res.status(502).json({ error: err.message }); }
    res.json(nk.concertDetail(req.params.id, req));
  });

  app.get('/api/nk/concerts/:id/kulturkalender', async (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    try { res.json(await kulturkalenderLookup(c)); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Stuendlich (zur vollen Stunde + 5) die Homepage abfragen
  cron.schedule('5 * * * *', () => {
    refreshKreatief().catch(err => console.error('[NK-Tickets]', err.message));
  }, { timezone: 'Europe/Berlin' });
}

module.exports = { register, refreshKreatief, kreatiefEvents, kulturkalenderLookup, ticketInfo, titleMatch };
