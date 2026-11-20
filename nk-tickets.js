// ================= NECKARSULMER KONZERTE: TICKETVERKAUF & KULTURKALENDER =================
// Verkaufte Tickets je Konzert aus mehreren Quellen:
//  - Kreatief-Homepage: oeffentliche Veranstaltungsliste (api.kreatief-neckarsulm.de) liefert die
//    freien Plaetze ("remainingTickets"); verkauft = Kontingent - frei. Abgleich alle 30 Minuten; neue Konzerte werden automatisch
//    verknuepft (gleiches Datum + passender Titel).
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
-- Zurueckgelegte Kontingente (z.B. Schuelerkarten in der Musikschule, Papierkarten in der Buchhandlung):
-- auf der Homepage schon blockiert, aber noch nicht verkauft. Werden von "verkauft" abgezogen und in Klammern gezeigt;
-- was daraus verkauft wurde, zaehlt wieder dazu.
CREATE TABLE IF NOT EXISTS nk_ticket_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  sold INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nk_ticket_holds ON nk_ticket_holds(concert_id);
-- Von Hand entfernte Homepage-Verknuepfungen nicht automatisch wieder anlegen
CREATE TABLE IF NOT EXISTS nk_ticket_dismissed (
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  PRIMARY KEY (concert_id, external_id)
);
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
    location_id: e.location || null,
    seating: !!e.seating,
    organizer_id: e.organizer || null,
    musical: !!e.musical,
    online: !!e.onlinePresale,
    cancelled: !!e.cancelledReason,
    url: KREATIEF_EVENT_URL + e.id,
  }));
  kreatiefCache = { at: Date.now(), events };
  return events;
}

// ---------- Konzerte der Reihe direkt von der Homepage (auch ohne angelegtes Konzert im Tool) ----------
// Zur Reihe zaehlen Kreatief-Veranstaltungen mit Online-Vorverkauf in der Musikschule Neckarsulm oder der Ballei
// ab Beginn der Reihe (Weihnachts- und Musicalabende davor gehoeren nicht dazu).
const NK_SERIES_FROM = process.env.NK_SERIES_FROM || '2027-01-01';
const NK_SERIES_PLACES = /musikschule|ballei/i;
const locationCache = new Map();
async function locationCapacity(id, seating) {
  if (!id) return null;
  let loc = locationCache.get(id);
  if (!loc || Date.now() - loc.at > 6 * 3600 * 1000) {
    const res = await fetch(`https://api.kreatief-neckarsulm.de/common/location/${id}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Ort ${id} nicht abrufbar (${res.status})`);
    loc = { at: Date.now(), data: await res.json() };
    locationCache.set(id, loc);
  }
  return (seating ? loc.data.numTicketsSeats : loc.data.numTicketsNoSeats) || null;
}
async function homepageSeries() {
  const events = await kreatiefEvents();
  const linked = new Set(db.prepare("SELECT external_id FROM nk_ticket_sources WHERE source = 'kreatief'").all().map(r => String(r.external_id)));
  const list = events.filter(e => e.date && e.date >= today() && e.date >= NK_SERIES_FROM && !e.cancelled && e.online && !e.musical
    && e.organizer_id === 1 && NK_SERIES_PLACES.test(e.location || '') && !linked.has(e.id));
  const out = [];
  for (const e of list) {
    const capacity = await locationCapacity(e.location_id, e.seating).catch(() => null);
    out.push({ id: e.id, title: e.name, date: e.date, time: e.time, location: e.location, url: e.url, remaining: e.remaining,
      capacity, sold: capacity && e.remaining !== null ? Math.max(0, capacity - e.remaining) : null });
  }
  return out;
}

function saveSnapshot(sourceId, sold) {
  if (sold === null || sold === undefined) return;
  db.prepare('INSERT INTO nk_ticket_snapshots (source_id, day, sold) VALUES (?, ?, ?) ON CONFLICT(source_id, day) DO UPDATE SET sold = excluded.sold')
    .run(sourceId, today(), sold);
}

// Alle verknuepften Kreatief-Quellen aktualisieren (Veranstaltungen, die nicht mehr in der
// Liste stehen - z.B. weil vorbei -, behalten ihren letzten Stand)
async function refreshKreatief(onlyConcertId) {
  const sources = db.prepare(`SELECT t.*, c.capacity AS concert_capacity FROM nk_ticket_sources t JOIN nk_concerts c ON c.id = t.concert_id
    WHERE t.source = 'kreatief'${onlyConcertId ? ' AND t.concert_id = ?' : ''}`)
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
    // Ohne eigenes Kontingent gilt die Kapazitaet des Konzerts (sofern es die einzige Quelle mit Homepage-Zahl ist);
    // fehlt auch die, wird die Platzzahl des Orts von der Homepage als Kapazitaet des Konzerts eingetragen
    let cap = s.capacity || s.concert_capacity;
    if (!cap) {
      cap = await locationCapacity(e.location_id, e.seating).catch(() => null);
      if (cap) db.prepare('UPDATE nk_concerts SET capacity = ? WHERE id = ? AND capacity IS NULL').run(cap, s.concert_id);
    }
    const sold = cap && e.remaining !== null ? Math.max(0, cap - e.remaining) : null;
    db.prepare("UPDATE nk_ticket_sources SET remaining = ?, sold = ?, label = COALESCE(label, ?), error = NULL, last_checked_at = datetime('now') WHERE id = ?")
      .run(e.remaining, sold, e.name, s.id);
    saveSnapshot(s.id, sold);
    updated++;
  }
  return updated;
}

// Konzerte der Reihe automatisch mit ihrer Veranstaltung auf der Kreatief-Homepage verknuepfen
// (gleiches Datum + passender Titel), damit verkaufte und freie Tickets immer da sind.
let autoLinkRunning = null;
function autoLinkKreatief() {
  // Nur ein Lauf gleichzeitig (Start-Abgleich, Zeitplan und Knopf koennen sich sonst ueberschneiden)
  if (!autoLinkRunning) autoLinkRunning = autoLinkOnce().finally(() => { autoLinkRunning = null; });
  return autoLinkRunning;
}
async function autoLinkOnce() {
  const concerts = db.prepare(`SELECT * FROM nk_concerts WHERE date IS NOT NULL AND date >= ? AND status NOT IN ('Abgeschlossen', 'Abgesagt')
    AND NOT EXISTS (SELECT 1 FROM nk_ticket_sources t WHERE t.concert_id = nk_concerts.id AND t.source = 'kreatief')`).all(today());
  if (!concerts.length) return 0;
  const events = await kreatiefEvents();
  const linkedNow = db.prepare("SELECT 1 FROM nk_ticket_sources WHERE concert_id = ? AND source = 'kreatief'");
  const taken = new Set(db.prepare("SELECT external_id FROM nk_ticket_sources WHERE source = 'kreatief'").all().map(r => String(r.external_id)));
  const dismissed = new Set(db.prepare('SELECT concert_id, external_id FROM nk_ticket_dismissed').all().map(r => r.concert_id + ':' + r.external_id));
  let linked = 0;
  for (const c of concerts) {
    const hits = events
      .filter(e => e.date === c.date && !e.cancelled && !taken.has(e.id) && !dismissed.has(c.id + ':' + e.id))
      .map(e => ({ e, score: titleMatch(c.title, e.name) }))
      .filter(x => x.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    const hit = hits[0] && (!hits[1] || hits[1].score < hits[0].score) ? hits[0] : null;
    if (!hit || linkedNow.get(c.id)) continue;
    // Kein Kontingent mitkopieren: ohne eigenes Kontingent gilt immer die aktuelle Kapazitaet des Konzerts
    db.prepare('INSERT INTO nk_ticket_sources (concert_id, source, external_id, label) VALUES (?, ?, ?, ?)')
      .run(c.id, 'kreatief', hit.e.id, hit.e.name);
    taken.add(hit.e.id);
    linked++;
  }
  return linked;
}

// Kurzfassung fuer Listen: verkauft, Kontingent, frei.
// Homepage-Quellen ohne Kontingent nutzen die Kapazitaet des Konzerts (wird jedes Mal frisch gelesen).
// Frei = je Quelle (Homepage: freie Plaetze laut Homepage, sonst Kontingent - verkauft) aufsummiert;
// fehlt das bei einer Quelle, ersatzweise Kapazitaet - verkauft.
function ticketHolds(concertId) {
  const rows = db.prepare('SELECT * FROM nk_ticket_holds WHERE concert_id = ? ORDER BY id').all(concertId);
  const count = rows.reduce((a, r) => a + r.count, 0);
  const sold = rows.reduce((a, r) => a + Math.min(r.sold, r.count), 0);
  return { rows, count, sold, open: count - sold };
}
// Homepage-Zahl um die zurueckgelegten Kontingente bereinigen: blockiert, aber noch nicht verkauft
function netSold(gross, holds, hasKreatief) {
  if (gross === null || gross === undefined) return null;
  return hasKreatief ? Math.max(0, gross - holds.count) + holds.sold : gross + holds.sold;
}

function ticketSummary(concert) {
  const rows = db.prepare('SELECT * FROM nk_ticket_sources WHERE concert_id = ?').all(concert.id);
  if (!rows.length) return null;
  const holds = ticketHolds(concert.id);
  const has = (v) => v !== null && v !== undefined;
  const sold = netSold(rows.every(r => has(r.sold)) ? rows.reduce((s, r) => s + r.sold, 0) : null, holds, rows.some(r => r.source === 'kreatief'));
  const capacity = rows.every(r => r.capacity) ? rows.reduce((s, r) => s + r.capacity, 0) : (concert.capacity || null);
  const free = rows.map(r => r.source === 'kreatief' ? (has(r.remaining) ? r.remaining : null)
    : (r.capacity && has(r.sold) ? Math.max(0, r.capacity - r.sold) : null));
  let available = null;
  // Je Quelle aufsummieren nur, wenn jede Quelle ein eigenes Kontingent hat (oder es nur eine gibt) -
  // sonst teilen sich die Quellen die Kapazitaet des Konzerts
  if (free.every(has) && (rows.length === 1 || rows.every(r => r.capacity))) {
    available = free.reduce((a, b) => a + b, 0);
    // Ohne Homepage sind Kontingente nirgends blockiert - hier selbst abziehen
    if (!rows.some(r => r.source === 'kreatief')) available = Math.max(0, available - holds.count);
  }
  else if (capacity && sold !== null) available = Math.max(0, capacity - sold - holds.open);
  return { sold, capacity, available, reserved: holds.open, reserved_detail: holds.rows.filter(r => r.count > r.sold).map(r => `${r.count - Math.min(r.sold, r.count)} ${r.label}`).join(', ') };
}

function ticketInfo(concert) {
  const sources = db.prepare('SELECT * FROM nk_ticket_sources WHERE concert_id = ? ORDER BY id').all(concert.id).map(s => ({
    ...s, source_label: SOURCES[s.source] || s.source,
    url: s.source === 'kreatief' && s.external_id ? KREATIEF_EVENT_URL + s.external_id : null,
  }));
  if (!sources.length) return null;
  const holds = ticketHolds(concert.id);
  const hasKreatief = sources.some(s => s.source === 'kreatief');
  const sold = netSold(sources.reduce((sum, s) => sum + (s.sold || 0), 0), holds, hasKreatief); // fuer Verlauf/Balken; ob die Zahl vollstaendig ist, sagt sold_known
  const capacity = sources.every(s => s.capacity) ? sources.reduce((sum, s) => sum + s.capacity, 0) : (concert.capacity || null);
  // Verlauf: verkaufte Tickets je Tag (Summe aller Quellen; fehlende Tage mit dem letzten Stand fuellen)
  const snaps = db.prepare(`SELECT s.source_id, s.day, s.sold FROM nk_ticket_snapshots s JOIN nk_ticket_sources t ON t.id = s.source_id
    WHERE t.concert_id = ? ORDER BY s.day`).all(concert.id);
  const days = [...new Set(snaps.map(s => s.day))].sort();
  const last = new Map();
  const history = days.map(day => {
    snaps.filter(s => s.day === day).forEach(s => last.set(s.source_id, s.sold || 0));
    return { day, sold: netSold([...last.values()].reduce((a, b) => a + b, 0), holds, hasKreatief) };
  });
  const summary = ticketSummary(concert);
  return { sources, sold, capacity, available: summary.available, sold_known: summary.sold !== null, history,
    holds: holds.rows, reserved: holds.open };
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

// Einmalig: Stand 19.11.2026 - je 30 Schuelerkarten in der Musikschule, 10 Karten Buchhandlung am Markt (Freudenthaler)
function seedHolds() {
  if (db.prepare("SELECT 1 FROM app_settings WHERE key = 'migr_nk_ticket_holds_seed'").get()) return;
  db.transaction(() => {
    const SEED_HOLDS = [
      ['2027-03-06', 'Freudenthaler Zitronenbaum', [['Schülerkarten Musikschule', 30], ['Buchhandlung am Markt (lokaler VVK)', 10]]],
      ['2027-04-03', 'Wendrsonn', [['Schülerkarten Musikschule', 30]]],
      ['2027-05-02', 'Claudia Sofia Trio', [['Schülerkarten Musikschule', 30]]],
    ];
    let missing = 0;
    for (const [date, title, holds] of SEED_HOLDS) {
      const c = db.prepare('SELECT id, title FROM nk_concerts WHERE date = ? ORDER BY id').all(date).find(x => titleMatch(x.title, title) >= 0.5);
      if (!c) { missing++; console.log(`[NK-Tickets] Kontingente: kein Konzert am ${date} (${title})`); continue; }
      // Je Konzert nur einmal - sonst kaemen von Hand geloeschte Kontingente beim naechsten Start zurueck
      const key = 'migr_nk_ticket_holds_seed_' + c.id;
      if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(key)) continue;
      db.prepare("INSERT INTO app_settings (key, value) VALUES (?, '1')").run(key);
      if (db.prepare('SELECT 1 FROM nk_ticket_holds WHERE concert_id = ?').get(c.id)) continue;
      holds.forEach(([label, count]) => db.prepare('INSERT INTO nk_ticket_holds (concert_id, label, count) VALUES (?, ?, ?)').run(c.id, label, count));
      console.log(`[NK-Tickets] Kontingente eingetragen: #${c.id} ${c.title}`);
    }
    // Erst als erledigt merken, wenn alle drei Konzerte gefunden wurden
    if (!missing) db.prepare("INSERT INTO app_settings (key, value) VALUES ('migr_nk_ticket_holds_seed', '1')").run();
  })();
}

// Einmalig: Stand 20.11.2026 - After-Match-Party: die Homepage blockiert 128 Tribuenenplaetze beim Handballspiel
// (800 Plaetze Ballei, 672 frei). Die sind nicht verkauft, bisher 0 Kombitickets.
function seedTribuene() {
  const key = 'migr_nk_ticket_holds_tribuene';
  if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(key)) return;
  const c = db.prepare('SELECT id, title FROM nk_concerts WHERE date = ? ORDER BY id').all('2027-03-13').find(x => titleMatch(x.title, 'After-Match-Party SNOW') >= 0.5);
  if (!c) { console.log('[NK-Tickets] Tribuenenplaetze: After-Match-Party nicht gefunden'); return; }
  db.transaction(() => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, '1')").run(key);
    if (!db.prepare("SELECT 1 FROM nk_ticket_holds WHERE concert_id = ? AND label LIKE 'Tribüne%'").get(c.id))
      db.prepare('INSERT INTO nk_ticket_holds (concert_id, label, count, sold) VALUES (?, ?, 128, 0)').run(c.id, 'Tribünenplätze beim Spiel (Kombitickets)');
  })();
  console.log(`[NK-Tickets] Tribuenenplaetze eingetragen: #${c.id} ${c.title}`);
}

function register(app) {
  seedHolds(); // erst hier, damit die Konzerte aus dem Programm-Import schon angelegt sind
  seedTribuene();
  nk.extendDetail((c) => ({ tickets: ticketInfo(c), ticket_source_types: SOURCES }));
  nk.extendList((c) => {
    const t = ticketSummary(c);
    return { tickets_linked: !!t, tickets_sold: t ? t.sold : null, tickets_capacity: t ? t.capacity : null, tickets_available: t ? t.available : null,
      tickets_reserved: t ? t.reserved : 0, tickets_reserved_detail: t ? t.reserved_detail : '' };
  });

  app.get('/api/nk/tickets/kreatief-events', async (req, res) => {
    try { res.json(await kreatiefEvents(!!req.query.refresh)); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.get('/api/nk/tickets/homepage', async (req, res) => {
    try { res.json(await homepageSeries()); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/nk/concerts/:id/tickets', async (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Event nicht gefunden' });
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
    const concertCap = (db.prepare('SELECT capacity FROM nk_concerts WHERE id = ?').get(s.concert_id) || {}).capacity;
    if (s.source === 'kreatief') sold = (capacity || concertCap) && s.remaining !== null ? Math.max(0, (capacity || concertCap) - s.remaining) : null;
    else if (b.sold !== undefined) sold = intOrNull(b.sold);
    db.prepare("UPDATE nk_ticket_sources SET capacity = ?, sold = ?, label = ?, updated_at = datetime('now') WHERE id = ?")
      .run(capacity, sold, b.label !== undefined ? (String(b.label || '').slice(0, 200) || null) : s.label, s.id);
    saveSnapshot(s.id, sold);
    res.json(nk.concertDetail(req.params.id, req));
  });

  app.delete('/api/nk/concerts/:id/tickets/:sid', (req, res) => {
    const s = db.prepare('SELECT * FROM nk_ticket_sources WHERE id = ? AND concert_id = ?').get(req.params.sid, req.params.id);
    if (s && s.source === 'kreatief' && s.external_id) {
      db.prepare('INSERT OR IGNORE INTO nk_ticket_dismissed (concert_id, external_id) VALUES (?, ?)').run(s.concert_id, String(s.external_id));
    }
    db.prepare('DELETE FROM nk_ticket_sources WHERE id = ? AND concert_id = ?').run(req.params.sid, req.params.id);
    res.json(nk.concertDetail(req.params.id, req));
  });

  // Zurueckgelegte Kontingente
  app.post('/api/nk/concerts/:id/ticket-holds', (req, res) => {
    const c = db.prepare('SELECT id FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Event nicht gefunden' });
    const b = req.body || {};
    const label = String(b.label || '').trim().slice(0, 200);
    const count = intOrNull(b.count);
    if (!label || !count) return res.status(400).json({ error: 'Bitte Bezeichnung und Anzahl eintragen' });
    db.prepare('INSERT INTO nk_ticket_holds (concert_id, label, count, sold, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, label, count, Math.min(intOrNull(b.sold) || 0, count), req.user.id);
    res.status(201).json(nk.concertDetail(c.id, req));
  });
  app.put('/api/nk/concerts/:id/ticket-holds/:hid', (req, res) => {
    const h = db.prepare('SELECT * FROM nk_ticket_holds WHERE id = ? AND concert_id = ?').get(req.params.hid, req.params.id);
    if (!h) return res.status(404).json({ error: 'Kontingent nicht gefunden' });
    const b = req.body || {};
    const count = b.count !== undefined ? (intOrNull(b.count) || 0) : h.count;
    const sold = Math.min(b.sold !== undefined ? (intOrNull(b.sold) || 0) : h.sold, count);
    const label = b.label !== undefined ? (String(b.label || '').trim().slice(0, 200) || h.label) : h.label;
    db.prepare("UPDATE nk_ticket_holds SET label = ?, count = ?, sold = ?, updated_at = datetime('now') WHERE id = ?").run(label, count, sold, h.id);
    res.json(nk.concertDetail(req.params.id, req));
  });
  app.delete('/api/nk/concerts/:id/ticket-holds/:hid', (req, res) => {
    db.prepare('DELETE FROM nk_ticket_holds WHERE id = ? AND concert_id = ?').run(req.params.hid, req.params.id);
    res.json(nk.concertDetail(req.params.id, req));
  });

  app.post('/api/nk/concerts/:id/tickets/refresh', async (req, res) => {
    try { await autoLinkKreatief(); await refreshKreatief(+req.params.id); } catch (err) { return res.status(502).json({ error: err.message }); }
    res.json(nk.concertDetail(req.params.id, req));
  });

  app.get('/api/nk/concerts/:id/kulturkalender', async (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Event nicht gefunden' });
    try { res.json(await kulturkalenderLookup(c)); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Alle 30 Minuten: neue Konzerte mit der Homepage verknuepfen und Zahlen abfragen
  const sync = () => autoLinkKreatief().catch(err => console.error('[NK-Tickets] Verknuepfen:', err.message))
    .then(() => refreshKreatief()).catch(err => console.error('[NK-Tickets]', err.message));
  cron.schedule('5,35 * * * *', sync, { timezone: 'Europe/Berlin' });
  if (process.env.NODE_ENV !== 'test') setTimeout(sync, 20 * 1000);
}

module.exports = { register, homepageSeries, refreshKreatief, autoLinkKreatief, ticketSummary, kreatiefEvents, kulturkalenderLookup, ticketInfo, titleMatch };
