// ================= NECKARSULMER KONZERTE: PROGRAMM =================
// Arbeitsübersicht aller Events der Reihe als Tabelle (Datum, Beginn/Einlass, Status,
// Künstler- und Mietvertrag, Preise, Zuständig, offene Punkte) plus gemeinsame Notizen zur Reihe.
// Jede Zelle wird einzeln gespeichert; die Zeilen sind die normalen Konzerte (nk_concerts).

const db = require('./db');
const nk = require('./nk');
const { displayForUserId } = require('./access');
const { titleMatch } = require('./nk-tickets');

db.ensureColumn('nk_concerts', 'doors', 'TEXT');
db.ensureColumn('nk_concerts', 'prices', 'TEXT');
db.ensureColumn('nk_concerts', 'owner', 'TEXT');
db.ensureColumn('nk_concerts', 'artist_contract', 'TEXT');
db.ensureColumn('nk_concerts', 'venue_contract', 'TEXT');
db.ensureColumn('nk_concerts', 'open_points', 'TEXT');

const STATUSES = ['Idee', 'Planung', 'Bestätigt', 'Abgeschlossen', 'Abgesagt'];
const CONTRACT_STATES = ['offen', 'angefragt', 'zugesagt', 'liegt vor', 'unterschrieben', 'nicht nötig'];
const TEXT_FIELDS = { title: 200, location: 200, prices: 500, owner: 100, open_points: 4000 };
const NOTES_KEY = 'nk_program_notes';

const cleanTime = (v) => {
  const m = String(v || '').trim().match(/^(\d{1,2})[:.](\d{2})/);
  return m && +m[1] <= 23 && +m[2] <= 59 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};
const cleanDate = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? v : null;
};

function getNotes() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(NOTES_KEY);
  return row ? JSON.parse(row.value) : { text: '', updated_at: null, updated_by: null };
}

const ROW_FIELDS = 'id, title, date, time, doors, location, status, prices, owner, artist_contract, venue_contract, open_points';
const getRow = (id) => db.prepare(`SELECT ${ROW_FIELDS} FROM nk_concerts WHERE id = ?`).get(id);

// ---------- Einmalig: Stand 18.11.2026 aus Mails + WhatsApp einspielen ----------
const MS = 'Städtische Musikschule Neckarsulm';
const BALLEI = 'Kultursaal Ballei';
const SEED = [
  { date: '2027-03-06', time: '19:00', doors: '18:00', title: 'Peter Freudenthaler – Mein Leben als Zitronenbaum', location: MS, status: 'Bestätigt',
    prices: 'VVK 15 € (Frühbucher 13,50 €) · AK 17 oder 18 €', owner: 'Franz', artist_contract: 'zugesagt', venue_contract: 'unterschrieben',
    open_points: 'AK 17 € (Preisliste 04.09.) oder 18 € (Franz 02.09., Website)?\n20 Papierkarten bei der Buchhandlung am Markt. 30 Schülerkarten à 5 € + Meet & Greet.' },
  { date: '2027-03-13', time: '20:00', doors: '19:30', title: 'After-Match-Party mit der Partyband SNOW', location: BALLEI, status: 'Bestätigt',
    prices: 'Kombi Spiel + Party 20 € (Frühbucher 18 €) · nur Party 15 € (Frühbucher 13,50 €) · AK 15 €, ab 22 Uhr günstiger', owner: 'Franz, Markus',
    artist_contract: 'angefragt', venue_contract: 'offen',
    open_points: 'Handball 18 Uhr (SU gegen BSV Sachsen Zwickau). SNOW-Vertrag (Backline-Paket 3.900 € netto) angefordert 22.10., nicht gesehen. Ballei-Mietvertrag nicht belegt.\nMax. 300 Kombitickets, 50 Freibändchen für SU-Helfer. Block/Reihe/Platz von der SU noch offen.' },
  { date: '2027-04-03', time: '19:00', doors: '18:00', title: 'Wendrsonn – schwäbischer Folkrock', location: MS, status: 'Bestätigt',
    prices: 'VVK 25 € (Frühbucher 22,50 €) · AK 28 €', owner: 'Franz', artist_contract: 'zugesagt', venue_contract: 'unterschrieben',
    open_points: 'Bandvertrag angekündigt – da? Band bringt Technik, Techniker und Licht mit. Bewirtung (Besen Berthold) offen. Sitzkonzert.' },
  { date: '2027-05-02', time: '19:00', doors: '18:00', title: 'Cláudia Sofia Trio', location: MS, status: 'Bestätigt',
    prices: 'VVK 20 € (Frühbucher 18 €) · AK 23 €', owner: 'Markus', artist_contract: 'zugesagt', venue_contract: 'unterschrieben',
    open_points: 'Vertrag über O-Tone Music. Projekt „Schüler singen mit dem Trio“ wohl gescheitert (keine Noten).' },
  { date: '2027-10-01', time: '19:30', doors: '18:30', title: 'Runrig Experience – Multi-Media-Show Highlands', location: BALLEI, status: 'Bestätigt',
    prices: 'VVK 29 € · AK 33 €', owner: 'Franz', artist_contract: 'liegt vor', venue_contract: 'angefragt',
    open_points: 'DocuSign-Vertrag Artist Republic (UK) muss Martin unterschreiben (Erinnerung 15.11.). Wird teurer (Ausländersteuer, Reise, KSK).\nDrums & Pipes (Hohenlohe Highlanders angefragt), Whisky Club. Ballei nur Anfrageformular.' },
  { date: '2027-11-05', time: '19:30', doors: '18:30', title: 'Strange Kind of Women – Deep-Purple-Tribute', location: BALLEI, status: 'Bestätigt',
    prices: 'VVK 29 € · AK 33 €', owner: 'Franz', artist_contract: 'unterschrieben', venue_contract: 'unterschrieben',
    open_points: 'Support Rocks Off (nur mündlich). Garantie 7.500 € netto, über 17.000 € Netto-Tickets 50/50. Anzahlungen 15.12.26 + 31.03.27, Rest 05.10.27.' },
  { date: '2027-12-01', time: '19:30', doors: '18:30', title: 'Danceperados of Ireland – The Spirit of Irish Christmas', location: BALLEI, status: 'Bestätigt',
    prices: '3 Kategorien 34 / 39 / 45 € · AK +3 €', owner: 'Franz, Markus', artist_contract: 'zugesagt', venue_contract: 'angefragt',
    open_points: 'Beginn 19:30 (Datenblatt 13.10.) oder 19:00 (Franz 11.10.)? Preise von 39/45/49 auf 34/39/45 € gesenkt – bestätigen.\nZusätzlich über Reservix. Ballei-Vertrag widersprüchlich (Vertrag 03.09. vs. Pasch 02.11.: nur Anfrage).' },
  { date: '2028-01-15', time: null, doors: null, title: 'wine & songs mit Tom & Maria (Tom Keller, Maria Blatz)', location: MS, status: 'Planung',
    prices: null, owner: 'Markus', artist_contract: 'offen', venue_contract: 'angefragt',
    open_points: 'Termin 15.01. ODER 22.01.2028 – Regine Kurzweil prüft (Anfrage 11.11.).' },
  { date: '2028-02-17', time: '19:30', doors: '18:30', title: 'Pasión de Buena Vista – kubanische Tanzshow', location: BALLEI, status: 'Bestätigt',
    prices: '3 Kategorien 39 / 45 / 49 € · AK +3 €', owner: 'Franz', artist_contract: 'unterschrieben', venue_contract: 'angefragt',
    open_points: 'Künstlervertrag unterschrieben 12.10. (New Star Management). Ballei nur Anfrageformular. Ab 300 Besuchern mit 2.000 € Sponsoring kostendeckend.' },
  { date: '2028-03-24', time: null, doors: null, title: 'Ray Wilson (ex Genesis) – Genesis Classic', location: BALLEI, status: 'Planung',
    prices: null, owner: 'Franz', artist_contract: 'zugesagt', venue_contract: 'offen',
    open_points: 'Per Mail zugesagt („lock the date“, 29.10.), kein Vertrag. Konditionen Juli (6.000 € + 7 %, ab 401 Tickets 50/50) für 2028 unbestätigt.' },
  { date: '2028-10-13', time: '20:00', doors: '19:00', title: 'BOUNCE – Bon-Jovi-Tribute', location: BALLEI, status: 'Bestätigt',
    prices: 'VVK 28 € · AK 30 €', owner: 'Franz', artist_contract: 'liegt vor', venue_contract: 'offen',
    open_points: 'Vertrag kam 15.11., Franz ändert Zeiten von Hand – unterschreiben. Gage 5.500 € netto + 9 EZ. Techrider vom 10.11.\nAnkunft 13 oder 16 Uhr? Vorband offen (Vorschlag Melting X oder Band von Nico Härdtner).' },
  { date: '2028-11-11', time: null, doors: null, title: 'Blues Night mit Andreas Kümmert & Band', location: MS, status: 'Planung',
    prices: null, owner: 'Franz', artist_contract: 'offen', venue_contract: 'offen', open_points: 'Nur in Franz’ Programmliste vom 15.11., nicht bestätigt.' },
  { date: null, time: null, doors: null, title: 'Tom Gäbel oder Paul Potts (Dez. 2028)', location: BALLEI, status: 'Planung',
    prices: null, owner: 'Franz', artist_contract: 'offen', venue_contract: 'offen', open_points: 'Dezember 2028 geplant, nicht bestätigt.' },
  { date: null, time: null, doors: null, title: 'LaLeLu oder anders (a cappella)', location: null, status: 'Idee',
    prices: null, owner: 'Franz', artist_contract: 'offen', venue_contract: null, open_points: 'Alternativen zu Maybebop: LaLeLu 3.800 €, anders 3.000 €. Franz prüft.' },
  { date: null, time: null, doors: null, title: 'Leslie Mandoki – musikalische Buchlesung', location: null, status: 'Idee',
    prices: null, owner: 'Franz', artist_contract: 'angefragt', venue_contract: null, open_points: 'Angefragt 26.10., Chance laut Franz „gleich null“.' },
  { date: null, time: null, doors: null, title: 'Maybebop (2028)', location: null, status: 'Abgesagt',
    prices: null, owner: 'Franz', artist_contract: null, venue_contract: null, open_points: '10.900 € plus Technik und Hotel – zu teuer (08.11.).' },
  { date: null, time: null, doors: null, title: 'die feisten (Herbst 2028)', location: null, status: 'Abgesagt',
    prices: null, owner: 'Franz', artist_contract: null, venue_contract: null, open_points: 'Agentur lehnt ab, Ballei zu klein (04.11.).' },
  { date: null, time: null, doors: null, title: 'Voices of Time (2028)', location: null, status: 'Abgesagt',
    prices: null, owner: 'Franz', artist_contract: null, venue_contract: null, open_points: 'Region schnell ausgebucht, u. a. Öhringen (02.11.).' },
];
const SEED_NOTES = `Termine rund um die Reihe
- Do 19.11.26, 11 Uhr im Kreatief: Interview Peter Klotz (Neckarsulmer Journal), danach Verträge und Sponsorenrechnungen
- Sa 21.11.26: SU-Heimspiel in der Ballei – SNOW-Flyer auslegen
- So 22.11.26, 17 Uhr: Vorstandssitzung mit Franz und Markus
- bis 30.11.26: Antworten der Sponsoren an Franz (Teilzahlungen noch 2026)
- 2027 noch vier Heimspiele vor dem 13.03. – dort die After-Match-Party bewerben
- So 23.05.27: „Eine Stadt singt“ – Regionaltag (Markus mit der Stadt, nicht Teil der Reihe)

Tickets und Werbung
- Frühbucher −10 % bis 31.12.2026 auf die vier Frühjahrstermine (Code NEU-IM-KREATIEF27), nicht auf das 5-€-Handballticket
- Musikschule: max. 198 Plätze, freie Platzwahl; 30 Schülerkarten à 5 € je Konzert (Sekretariat) + Meet & Greet; 20 Sponsorenkarten je Konzert geblockt
- Ort immer „Städtische Musikschule Neckarsulm“ nennen (Wunsch Regine Kurzweil)
- SNOW-A6-Flyer: 2.500 Stück bestellt (10.11.); Faltflyer erst im Januar verteilen (dann ohne Frühbucher-Text); Plakate nur für die After-Match-Party
- Sponsoring knapp 50.000 € (u. a. KSK-Kulturstiftung 8.000 €, Palmbräu 2.000 €, Peter Lang 1.000–2.000 €); in der Werbung nur das Logo der Kulturstiftung, Stadt ohne Logo`;

if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'migr_nk_program_seed'").get()) {
  db.transaction(() => {
    const sameDate = db.prepare('SELECT * FROM nk_concerts WHERE date = ? ORDER BY id');
    const undated = db.prepare('SELECT * FROM nk_concerts WHERE date IS NULL ORDER BY id');
    SEED.forEach(s => {
      // Gleiches Konzert = gleiches Datum (bzw. ohne Datum) UND passender Titel
      const candidates = s.date ? sameDate.all(s.date) : undated.all();
      const existing = candidates.find(c => titleMatch(c.title, s.title) >= 0.5);
      console.log(`[NK-Programm] ${existing ? 'ergänze #' + existing.id + ' ' + existing.title : 'neu'}: ${s.date || 'ohne Datum'} ${s.title}`);
      if (existing) {
        // Vorhandenes Konzert: nur leere Felder ergänzen, nichts überschreiben
        const keep = (k) => (existing[k] !== null && existing[k] !== '' ? existing[k] : s[k]);
        db.prepare(`UPDATE nk_concerts SET time = ?, doors = ?, location = ?, prices = ?, owner = ?, artist_contract = ?,
          venue_contract = ?, open_points = ? WHERE id = ?`).run(keep('time'), keep('doors'), keep('location'), keep('prices'),
          keep('owner'), keep('artist_contract'), keep('venue_contract'), keep('open_points'), existing.id);
      } else {
        db.prepare(`INSERT INTO nk_concerts (title, date, time, doors, location, status, prices, owner, artist_contract, venue_contract, open_points)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.title, s.date, s.time, s.doors, s.location, s.status, s.prices, s.owner,
          s.artist_contract, s.venue_contract, s.open_points);
      }
    });
    if (!db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(NOTES_KEY)) {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(NOTES_KEY,
        JSON.stringify({ text: SEED_NOTES, updated_at: new Date().toISOString(), updated_by: 'Stand aus Mails + WhatsApp, 18.11.2026' }));
    }
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('migr_nk_program_seed', '1')").run();
  })();
}

function register(app) {
  app.get('/api/nk/program', (req, res) => {
    const rows = db.prepare(`SELECT ${ROW_FIELDS} FROM nk_concerts ORDER BY date IS NULL, date, time, id`).all();
    res.json({ rows, notes: getNotes(), statuses: STATUSES, contract_states: CONTRACT_STATES });
  });

  app.post('/api/nk/program', (req, res) => {
    const title = String((req.body || {}).title || '').trim().slice(0, 200) || 'Neues Event';
    const info = db.prepare("INSERT INTO nk_concerts (title, status, created_by) VALUES (?, 'Idee', ?)").run(title, req.user.id);
    res.status(201).json(getRow(info.lastInsertRowid));
  });

  // Eine Zelle speichern: { field, value }
  app.put('/api/nk/program/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Event nicht gefunden' });
    const { field, value } = req.body || {};
    let v;
    if (typeof field !== 'string') return res.status(400).json({ error: 'Feld fehlt' });
    if (Object.hasOwn(TEXT_FIELDS, field)) {
      v = String(value ?? '').trim().slice(0, TEXT_FIELDS[field]) || null;
      if (field === 'title' && !v) return res.status(400).json({ error: 'Der Titel darf nicht leer sein' });
    } else if (field === 'time' || field === 'doors') {
      v = cleanTime(value);
      if (!v && String(value || '').trim()) return res.status(400).json({ error: 'Ungültige Uhrzeit' });
    } else if (field === 'date') {
      v = cleanDate(value);
      if (!v && String(value || '').trim()) return res.status(400).json({ error: 'Ungültiges Datum' });
    } else if (field === 'status') {
      if (!STATUSES.includes(value)) return res.status(400).json({ error: 'Unbekannter Status' });
      v = value;
    } else if (field === 'artist_contract' || field === 'venue_contract') {
      v = CONTRACT_STATES.includes(value) ? value : null;
    } else {
      return res.status(400).json({ error: 'Dieses Feld lässt sich hier nicht ändern' });
    }
    db.prepare(`UPDATE nk_concerts SET ${field} = ? WHERE id = ?`).run(v, c.id);
    // Fristen offener Vorlagen-2Dos wandern mit dem Datum mit (wie beim Bearbeiten des Konzerts)
    if (field === 'date' && v !== c.date && v) {
      const stmt = db.prepare('UPDATE nk_todos SET due_date = ? WHERE id = ?');
      db.prepare('SELECT id, offset_days FROM nk_todos WHERE concert_id = ? AND done = 0 AND offset_days IS NOT NULL').all(c.id)
        .forEach(t => stmt.run(nk.addDays(v, t.offset_days), t.id));
    }
    res.json(getRow(c.id));
  });

  app.put('/api/nk/program-notes', (req, res) => {
    const text = String((req.body || {}).text ?? '').slice(0, 20000);
    // Hat jemand anderes inzwischen gespeichert? Dann nicht still überschreiben.
    const current = getNotes();
    const base = (req.body || {}).base_updated_at;
    if (base !== undefined && current.updated_at && base !== current.updated_at) {
      return res.status(409).json({ error: `${current.updated_by || 'Jemand'} hat die Notizen inzwischen geändert – bitte neu laden, deine Änderung ist noch im Feld.`, current });
    }
    const value = { text, updated_at: new Date().toISOString(), updated_by: displayForUserId(db, req.user.id).name || null };
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(NOTES_KEY, JSON.stringify(value));
    res.json(value);
  });
}

module.exports = { register };
