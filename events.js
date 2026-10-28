// ================= EVENTS (Veranstaltungsplanung) =================
// Veranstaltungen mit Location, Zeiten, Technik, Hospitality und Tickets. Je Event:
// Bands/Kuenstler (Gage, Zeiten, Technik-Bedarf), Team & Dienstleister, Ablaufplan,
// Budget (Einnahmen/Ausgaben) und Checkliste. Rechte: Reiter "events".

const XLSX = require('xlsx');
const db = require('./db');
const { displayForUserId } = require('./access');

const STATUSES = ['Idee', 'In Planung', 'Bestätigt', 'Abgeschlossen', 'Abgesagt'];
const ACT_STATUSES = ['Angefragt', 'Zugesagt', 'Vertrag unterschrieben', 'Abgesagt'];
const FEE_TYPES = ['Festgage', 'Türdeal', 'Gage + Beteiligung', 'Ohne Gage'];
const BUDGET_CATEGORIES = {
  expense: ['Miete', 'Technik', 'Werbung', 'GEMA', 'KSK', 'Catering', 'Personal', 'Übernachtung', 'Versicherung', 'Sonstiges'],
  income: ['Tickets', 'Sponsoring', 'Förderung', 'Gastro', 'Sonstiges'],
};

// Feldtypen: text (kurz), long (Freitext), date, time, int, money, bool
const EVENT_FIELDS = {
  title: 'text', subtitle: 'text', status: 'text', date: 'date', end_date: 'date', organizer: 'text', description: 'long', notes: 'long',
  venue_name: 'text', venue_address: 'long', venue_contact: 'text', venue_phone: 'text', venue_email: 'text', venue_capacity: 'int',
  venue_stage: 'long', venue_power: 'long', venue_access: 'long', venue_backstage: 'long', venue_notes: 'long',
  time_load_in: 'time', time_soundcheck: 'time', time_doors: 'time', time_start: 'time', time_end: 'time', time_curfew: 'time', time_load_out: 'time',
  tech_pa: 'long', tech_light: 'long', tech_backline: 'long', tech_staff: 'long', tech_notes: 'long',
  hosp_catering: 'long', hosp_drinks: 'long', hosp_accommodation: 'long', hosp_notes: 'long',
  ticket_presale: 'money', ticket_box: 'money', ticket_reduced: 'money', ticket_contingent: 'int', expected_visitors: 'int', sold_tickets: 'int', ticket_link: 'text',
};

const SUBS = {
  acts: {
    table: 'ev_acts', label: 'Band/Künstler', required: 'name',
    fields: {
      name: 'text', genre: 'text', stage: 'text', status: 'text', contact_person: 'text', phone: 'text', email: 'text', members: 'int',
      fee: 'money', fee_type: 'text', fee_paid: 'bool', travel_costs: 'money', invoice: 'text',
      arrival_time: 'time', soundcheck_time: 'time', set_start: 'time', set_end: 'time',
      channels: 'text', tech_needs: 'long', backline: 'long', hospitality: 'long', accommodation: 'long', notes: 'long',
    },
  },
  crew: {
    table: 'ev_crew', label: 'Team-Eintrag', required: 'name',
    fields: { name: 'text', role: 'text', phone: 'text', email: 'text', time_from: 'time', time_to: 'time', fee: 'money', fee_paid: 'bool', notes: 'long' },
  },
  schedule: {
    table: 'ev_schedule', label: 'Programmpunkt', required: 'title',
    fields: { time: 'time', end_time: 'time', title: 'text', who: 'text', notes: 'long' },
  },
  budget: {
    table: 'ev_budget', label: 'Posten', required: 'label',
    fields: { type: 'text', category: 'text', label: 'text', amount: 'money', paid: 'bool', notes: 'long' },
  },
  tasks: {
    table: 'ev_tasks', label: 'Aufgabe', required: 'text',
    fields: { text: 'text', who: 'text', due_date: 'date', done: 'bool' },
  },
  // Freie Tabellen (Gesamtuebersicht Zeit x Raum, Materialliste …): Spalten, Zeilen und Zellen als JSON
  tables: {
    table: 'ev_tables', label: 'Tabelle', required: 'title',
    fields: { title: 'text', data: 'json' },
  },
};

const SQL_TYPE = { int: 'INTEGER', money: 'REAL', bool: 'INTEGER DEFAULT 0', json: 'TEXT' };
const cols = (fields) => Object.entries(fields).map(([k, t]) => `${k} ${SQL_TYPE[t] || 'TEXT'}`).join(',\n  ');

db.exec(`
CREATE TABLE IF NOT EXISTS ev_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${cols(EVENT_FIELDS)},
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
${Object.values(SUBS).map(s => `
CREATE TABLE IF NOT EXISTS ${s.table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES ev_events(id) ON DELETE CASCADE,
  ${cols(s.fields)},
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_${s.table}_event ON ${s.table}(event_id);`).join('\n')}
`);

// Spaeter ergaenzte Felder automatisch nachziehen
function ensureColumns(table, fields) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [k, t] of Object.entries(fields)) {
    if (!have.has(k)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${k} ${SQL_TYPE[t] || 'TEXT'}`);
  }
}
ensureColumns('ev_events', EVENT_FIELDS);
Object.values(SUBS).forEach(s => ensureColumns(s.table, s.fields));

// Einmalig: wer die Vertraege sieht, bekommt auch den neuen Reiter Events
if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'migr_events_tab'").get()) {
  db.prepare('SELECT id, allowed_tabs FROM app_users WHERE allowed_tabs IS NOT NULL').all().forEach(u => {
    try {
      const tabs = JSON.parse(u.allowed_tabs);
      if (Array.isArray(tabs) && tabs.includes('contracts') && !tabs.includes('events')) {
        db.prepare('UPDATE app_users SET allowed_tabs = ? WHERE id = ?').run(JSON.stringify([...tabs, 'events']), u.id);
      }
    } catch (e) { /* ungueltige Freigaben ignorieren */ }
  });
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('migr_events_tab', '1')").run();
}

const DEFAULT_TASKS = [
  'Location gebucht / Mietvertrag unterschrieben',
  'Bands angefragt und bestätigt',
  'Verträge mit Bands verschickt und unterschrieben',
  'Technik-Rider und Stageplan der Bands eingeholt',
  'Ton- und Lichttechnik gebucht',
  'Kanalbelegung und Ablauf an die Technik geschickt',
  'Ablaufplan an alle Beteiligten verschickt',
  'Ticketverkauf eingerichtet',
  'Plakate, Flyer und Social Media',
  'Pressemitteilung verschickt',
  'GEMA angemeldet, Setlisten eingesammelt',
  'Veranstaltungsversicherung geprüft',
  'Genehmigungen (Ordnungsamt, Ausschank) eingeholt',
  'Catering und Getränke organisiert',
  'Übernachtungen gebucht',
  'Helfer für Kasse, Einlass und Bar eingeteilt',
  'Wechselgeld und Kasse vorbereitet',
  'Gagen ausgezahlt / Rechnungen erhalten',
  'KSK-Abgabe auf Künstlergagen gemeldet',
  'Abrechnung erstellt',
];

const clean = (v, max = 4000) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const cleanMoney = (v) => {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).replace(/[€\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.200 = Tausenderpunkt
  else if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
function cleanValue(type, v) {
  if (type === 'money') return cleanMoney(v);
  if (type === 'int') { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  if (type === 'bool') return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
  if (type === 'time') return /^\d{2}:\d{2}$/.test(String(v || '')) ? v : null;
  if (type === 'json') return cleanTable(v);
  return clean(v, type === 'text' ? 300 : 8000);
}

// Tabelle: { columns: [{ name }], rows: [{ label, cells: [{ t, c, s }] }] } - t Text, c Farbe, s Zeilen-Spanne
const TABLE_COLORS = ['', 'yellow', 'green', 'blue', 'red', 'violet', 'grey'];
function cleanTable(v) {
  let d = v;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
  if (!d || typeof d !== 'object') d = {};
  const columns = (Array.isArray(d.columns) ? d.columns : []).slice(0, 30).map(c => ({ name: String((c && c.name) || '').slice(0, 120) }));
  const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 300).map(r => ({
    label: String((r && r.label) || '').slice(0, 120),
    cells: columns.map((_, i) => {
      const c = (r && Array.isArray(r.cells) && r.cells[i]) || {};
      const out = { t: String(c.t || '').slice(0, 1000) };
      if (TABLE_COLORS.includes(c.c) && c.c) out.c = c.c;
      const span = parseInt(c.s, 10);
      if (span > 1) out.s = Math.min(span, 300);
      return out;
    }),
  }));
  return JSON.stringify({ label_header: String(d.label_header || '').slice(0, 60), columns, rows });
}

const round2 = (n) => Math.round(n * 100) / 100;

function finance(e, acts, crew, budget) {
  const sum = (arr, f) => round2(arr.reduce((s, x) => s + (x[f] || 0), 0));
  const liveActs = acts.filter(a => a.status !== 'Abgesagt');
  const fees = sum(liveActs, 'fee');
  const travel = sum(liveActs, 'travel_costs');
  const crewFees = sum(crew, 'fee');
  const otherExpenses = sum(budget.filter(b => b.type === 'expense'), 'amount');
  const income = sum(budget.filter(b => b.type === 'income'), 'amount');
  const expenses = round2(fees + travel + crewFees + otherExpenses);
  // Ticket-Prognose aus Besucherzahl x Preis (nur zur Orientierung, nicht in der Bilanz)
  const price = e.ticket_presale ?? e.ticket_box;
  const visitors = e.sold_tickets || e.expected_visitors;
  const ticketForecast = price && visitors ? round2(price * visitors) : null;
  const unpaid = round2(liveActs.filter(a => !a.fee_paid).reduce((s, a) => s + (a.fee || 0) + (a.travel_costs || 0), 0)
    + crew.filter(c => !c.fee_paid).reduce((s, c) => s + (c.fee || 0), 0)
    + budget.filter(b => b.type === 'expense' && !b.paid).reduce((s, b) => s + (b.amount || 0), 0));
  return { fees, travel, crew_fees: crewFees, other_expenses: otherExpenses, expenses, income, result: round2(income - expenses), ticket_forecast: ticketForecast, unpaid };
}

function eventDetail(id) {
  const e = db.prepare('SELECT * FROM ev_events WHERE id = ?').get(id);
  if (!e) return null;
  const rows = {};
  for (const [key, s] of Object.entries(SUBS)) {
    const order = key === 'schedule' ? 'time IS NULL, time, sort, id' : key === 'acts' ? 'set_start IS NULL, set_start, sort, id' : 'sort, id';
    rows[key] = db.prepare(`SELECT * FROM ${s.table} WHERE event_id = ? ORDER BY ${order}`).all(id);
  }
  rows.tables = rows.tables.map(t => ({ ...t, data: JSON.parse(t.data || '{}') }));
  return {
    ...e,
    ...rows,
    created_by_display: displayForUserId(db, e.created_by),
    finance: finance(e, rows.acts, rows.crew, rows.budget),
  };
}

function eventSummary(e) {
  const acts = db.prepare('SELECT name, status, fee, travel_costs, fee_paid FROM ev_acts WHERE event_id = ? ORDER BY set_start IS NULL, set_start, sort, id').all(e.id);
  const tasks = db.prepare('SELECT done FROM ev_tasks WHERE event_id = ?').all(e.id);
  return {
    id: e.id, title: e.title, subtitle: e.subtitle, status: e.status, date: e.date, end_date: e.end_date,
    venue_name: e.venue_name, time_doors: e.time_doors, time_start: e.time_start,
    acts: acts.filter(a => a.status !== 'Abgesagt').map(a => a.name),
    fees: round2(acts.filter(a => a.status !== 'Abgesagt').reduce((s, a) => s + (a.fee || 0), 0)),
    tasks_total: tasks.length, tasks_done: tasks.filter(t => t.done).length,
  };
}

function insertRow(table, fields, eventId, values) {
  const keys = Object.keys(fields);
  return db.prepare(`INSERT INTO ${table} (event_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`)
    .run(eventId, ...keys.map(k => values[k] ?? null)).lastInsertRowid;
}

function register(app) {
  app.get('/api/events', (req, res) => {
    const events = db.prepare('SELECT * FROM ev_events ORDER BY date IS NULL, date, time_start').all().map(eventSummary);
    res.json({
      events, statuses: STATUSES, act_statuses: ACT_STATUSES, fee_types: FEE_TYPES, budget_categories: BUDGET_CATEGORIES,
    });
  });

  app.get('/api/events/:id', (req, res) => {
    const e = eventDetail(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden' });
    res.json(e);
  });

  app.post('/api/events', (req, res) => {
    const b = req.body || {};
    if (!clean(b.title)) return res.status(400).json({ error: 'Titel ist erforderlich' });
    const keys = Object.keys(EVENT_FIELDS).filter(k => b[k] !== undefined);
    const values = keys.map(k => cleanValue(EVENT_FIELDS[k], b[k]));
    if (!keys.includes('status')) { keys.push('status'); values.push('In Planung'); }
    const info = db.prepare(`INSERT INTO ev_events (${[...keys, 'created_by'].join(', ')}) VALUES (${[...keys, 'x'].map(() => '?').join(', ')})`)
      .run(...values, req.user.id);
    res.status(201).json(eventDetail(info.lastInsertRowid));
  });

  app.put('/api/events/:id', (req, res) => {
    const e = db.prepare('SELECT * FROM ev_events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden' });
    const b = req.body || {};
    const keys = Object.keys(EVENT_FIELDS).filter(k => b[k] !== undefined);
    if (keys.includes('title') && !clean(b.title)) return res.status(400).json({ error: 'Titel ist erforderlich' });
    if (keys.includes('status') && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unbekannter Status' });
    if (keys.length) {
      db.prepare(`UPDATE ev_events SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...keys.map(k => cleanValue(EVENT_FIELDS[k], b[k])), e.id);
    }
    res.json(eventDetail(e.id));
  });

  app.delete('/api/events/:id', (req, res) => {
    db.prepare('DELETE FROM ev_events WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // Event als Vorlage kopieren: alle Angaben, Bands, Team, Ablauf, Budget und Checkliste
  // (Datum leer, Zahlungen und Haken zurueckgesetzt)
  app.post('/api/events/:id/duplicate', (req, res) => {
    const e = db.prepare('SELECT * FROM ev_events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden' });
    const newId = db.transaction(() => {
      const keys = Object.keys(EVENT_FIELDS);
      const values = keys.map(k => {
        if (k === 'title') return `${e.title} (Kopie)`;
        if (k === 'status') return 'Idee';
        if (['date', 'end_date', 'sold_tickets'].includes(k)) return null;
        return e[k];
      });
      const id = db.prepare(`INSERT INTO ev_events (${[...keys, 'created_by'].join(', ')}) VALUES (${[...keys, 'x'].map(() => '?').join(', ')})`)
        .run(...values, req.user.id).lastInsertRowid;
      for (const s of Object.values(SUBS)) {
        db.prepare(`SELECT * FROM ${s.table} WHERE event_id = ? ORDER BY sort, id`).all(e.id).forEach(r => {
          ['fee_paid', 'paid', 'done'].forEach(f => { if (f in s.fields) r[f] = 0; });
          insertRow(s.table, s.fields, id, r);
        });
      }
      return id;
    })();
    res.status(201).json(eventDetail(newId));
  });

  // Standard-Checkliste einfuegen (nur Punkte, die es noch nicht gibt)
  app.post('/api/events/:id/tasks/defaults', (req, res) => {
    const e = db.prepare('SELECT id FROM ev_events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden' });
    const have = new Set(db.prepare('SELECT text FROM ev_tasks WHERE event_id = ?').all(e.id).map(t => t.text));
    let sort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM ev_tasks WHERE event_id = ?').get(e.id).m;
    const ins = db.prepare('INSERT INTO ev_tasks (event_id, text, done, sort) VALUES (?, ?, 0, ?)');
    db.transaction(() => DEFAULT_TASKS.filter(t => !have.has(t)).forEach(t => ins.run(e.id, t, ++sort)))();
    res.json(eventDetail(e.id));
  });

  app.get('/api/events/:id/tables/:tid/export.xlsx', (req, res) => {
    const e = db.prepare('SELECT title, date FROM ev_events WHERE id = ?').get(req.params.id);
    const t = e && db.prepare('SELECT * FROM ev_tables WHERE id = ? AND event_id = ?').get(req.params.tid, req.params.id);
    if (!t) return res.status(404).send('Tabelle nicht gefunden');
    const d = JSON.parse(t.data || '{}');
    const aoa = [[`${e.title} – ${t.title}`, ...d.columns.map(() => '')], [d.label_header || '', ...d.columns.map(c => c.name)],
      ...d.rows.map(r => [r.label, ...r.cells.map(c => c.t)])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [];
    d.rows.forEach((r, ri) => r.cells.forEach((c, ci) => {
      if (c.s > 1) ws['!merges'].push({ s: { r: ri + 2, c: ci + 1 }, e: { r: Math.min(ri + c.s, d.rows.length) + 1, c: ci + 1 } });
    }));
    ws['!cols'] = [{ wch: 14 }, ...d.columns.map(() => ({ wch: 24 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t.title.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Tabelle');
    const name = `${e.title} - ${t.title}`.replace(/[^\wäöüÄÖÜß -]/g, '').trim() || 'Tabelle';
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="tabelle.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}.xlsx`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  });

  // ---- Unterlisten: Bands, Team, Ablauf, Budget, Checkliste, Tabellen ----
  app.post('/api/events/:id/:sub', (req, res) => {
    const s = SUBS[req.params.sub];
    if (!s) return res.status(404).json({ error: 'Unbekannter Bereich' });
    const e = db.prepare('SELECT id FROM ev_events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden' });
    const b = req.body || {};
    const values = {};
    for (const [k, t] of Object.entries(s.fields)) values[k] = cleanValue(t, b[k]);
    if (!values[s.required]) return res.status(400).json({ error: `${s.label}: Angabe fehlt` });
    if (req.params.sub === 'budget' && !['income', 'expense'].includes(values.type)) values.type = 'expense';
    const id = insertRow(s.table, s.fields, e.id, values);
    const max = db.prepare(`SELECT COALESCE(MAX(sort), 0) AS m FROM ${s.table} WHERE event_id = ?`).get(e.id).m;
    db.prepare(`UPDATE ${s.table} SET sort = ? WHERE id = ?`).run(max + 1, id);
    res.status(201).json(eventDetail(e.id));
  });

  app.put('/api/events/:id/:sub/:sid', (req, res) => {
    const s = SUBS[req.params.sub];
    if (!s) return res.status(404).json({ error: 'Unbekannter Bereich' });
    const row = db.prepare(`SELECT * FROM ${s.table} WHERE id = ? AND event_id = ?`).get(req.params.sid, req.params.id);
    if (!row) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const b = req.body || {};
    const keys = Object.keys(s.fields).filter(k => b[k] !== undefined);
    const values = keys.map(k => cleanValue(s.fields[k], b[k]));
    if (keys.includes(s.required) && !values[keys.indexOf(s.required)]) return res.status(400).json({ error: `${s.label}: Angabe fehlt` });
    if (keys.length) db.prepare(`UPDATE ${s.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, row.id);
    res.json(eventDetail(req.params.id));
  });

  app.delete('/api/events/:id/:sub/:sid', (req, res) => {
    const s = SUBS[req.params.sub];
    if (!s) return res.status(404).json({ error: 'Unbekannter Bereich' });
    db.prepare(`DELETE FROM ${s.table} WHERE id = ? AND event_id = ?`).run(req.params.sid, req.params.id);
    res.json(eventDetail(req.params.id));
  });
}

module.exports = { register };
