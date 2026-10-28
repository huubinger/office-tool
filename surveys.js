// ================= UMFRAGEN (Zu-/Absagen per oeffentlichem Link) =================
// Eine Umfrage hat Termine bzw. Punkte (in Abschnitten, z.B. "Aufführungen", "Probenwochenenden")
// und optional eine Rollenliste (z.B. die Rollen eines Musicals plus Technik). Teilnehmer
// oeffnen /u/<token> ohne Login, tragen Namen und Rolle ein und sagen je Termin zu,
// vielleicht oder ab. Ueber den eigenen Bearbeiten-Link (edit_token) laesst sich die
// Antwort spaeter aendern. Im Reiter "Umfragen" erscheint alles als Tabelle Rollen x Termine.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('./db');

const VALUES = ['yes', 'no']; // kein "vielleicht" - nur Zu- oder Absage
const MAX_RESPONSES = 500;
const MAX_OPTIONS = 200;

db.exec(`
CREATE TABLE IF NOT EXISTS sv_surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  token TEXT NOT NULL UNIQUE,
  status TEXT DEFAULT 'offen',
  allow_maybe INTEGER DEFAULT 1,
  show_results INTEGER DEFAULT 1,
  roles TEXT,
  deadline TEXT,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sv_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES sv_surveys(id) ON DELETE CASCADE,
  section TEXT,
  label TEXT,
  date TEXT,
  time TEXT,
  note TEXT,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sv_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES sv_surveys(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  comment TEXT,
  edit_token TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sv_answers (
  response_id INTEGER NOT NULL REFERENCES sv_responses(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES sv_options(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (response_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_sv_options_survey ON sv_options(survey_id);
CREATE INDEX IF NOT EXISTS idx_sv_responses_survey ON sv_responses(survey_id);
`);
// Darstellung: 'form' (Termine untereinander) oder 'table' (alle tragen sich direkt in die Tabelle ein);
// open_edit: in der Tabelle duerfen alle alle Zeilen aendern (wie eine offene Tabellenkalkulation)
const svCols = new Set(db.prepare('PRAGMA table_info(sv_surveys)').all().map(c => c.name));
if (!svCols.has('layout')) db.exec("ALTER TABLE sv_surveys ADD COLUMN layout TEXT DEFAULT 'form'");
if (!svCols.has('open_edit')) db.exec('ALTER TABLE sv_surveys ADD COLUMN open_edit INTEGER DEFAULT 0');
// "Vielleicht" gibt es nicht mehr: einmalig ausschalten und vorhandene ?-Antworten entfernen
if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'migr_surveys_no_maybe'").get()) {
  db.exec("UPDATE sv_surveys SET allow_maybe = 0; DELETE FROM sv_answers WHERE value = 'maybe';");
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('migr_surveys_no_maybe', '1')").run();
}
// time_inherit: Uhrzeit folgt dem ersten Termin des Abschnitts (z.B. alle Shows wie die Premiere)
if (!db.prepare('PRAGMA table_info(sv_options)').all().some(c => c.name === 'time_inherit')) db.exec('ALTER TABLE sv_options ADD COLUMN time_inherit INTEGER DEFAULT 0');
// Besetzung: Rolle mit festen Personen ("SONJA: Anna / Berta") - je Termin steht in der Zelle, wer spielt
db.exec(`
CREATE TABLE IF NOT EXISTS sv_cast (
  survey_id INTEGER NOT NULL REFERENCES sv_surveys(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  option_id INTEGER NOT NULL REFERENCES sv_options(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  PRIMARY KEY (survey_id, role, option_id)
);
`);

// Einmalig: wer die Vertraege sieht, bekommt auch den neuen Reiter Umfragen
if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'migr_surveys_tab'").get()) {
  db.prepare('SELECT id, allowed_tabs FROM app_users WHERE allowed_tabs IS NOT NULL').all().forEach(u => {
    try {
      const tabs = JSON.parse(u.allowed_tabs);
      if (Array.isArray(tabs) && tabs.includes('contracts') && !tabs.includes('surveys')) {
        db.prepare('UPDATE app_users SET allowed_tabs = ? WHERE id = ?').run(JSON.stringify([...tabs, 'surveys']), u.id);
      }
    } catch (e) { /* ungueltige Freigaben ignorieren */ }
  });
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('migr_surveys_tab', '1')").run();
}

const newToken = () => crypto.randomBytes(18).toString('base64url');
const clean = (v, max = 300) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
// Zeile "SONJA: Anna / Berta" = Rolle SONJA mit Besetzung Anna und Berta (Namen mit / oder , getrennt)
function parseRoleLine(line) {
  const m = line.match(/^([^:]+?)\s*:\s*(.+)$/);
  if (!m) return { role: line, cast: [] };
  const cast = [...new Set(m[2].split(/[\/,]/).map(n => n.trim()).filter(Boolean))];
  return cast.length ? { role: m[1], cast } : { role: line, cast: [] };
}
const roleLines = (raw) => String(raw || '').split('\n').map(r => r.trim()).filter(Boolean).map(parseRoleLine);
const parseRoles = (raw) => roleLines(raw).map(l => l.role);
// Ersatztermin: "Ersatz" im Abschnitt oder in der Bezeichnung (wie in public/umfrage-table.js)
const isErsatz = (o) => /ersatz/i.test(o.section || '') || /ersatz/i.test(o.label || '');
const castPeople = (v) => String(v || '').split('/').filter(Boolean);
const parseCast = (raw) => {
  const out = {};
  roleLines(raw).forEach(l => { if (l.cast.length) out[l.role] = l.cast; });
  return out;
};

function surveyData(id, { withTokens = false } = {}) {
  const s = db.prepare('SELECT * FROM sv_surveys WHERE id = ?').get(id);
  if (!s) return null;
  ensureCastResponses(s.id, parseCast(s.roles)); // auch fuer Umfragen von vor den persoenlichen Links
  const options = db.prepare('SELECT * FROM sv_options WHERE survey_id = ? ORDER BY sort, id').all(id);
  const responses = db.prepare('SELECT * FROM sv_responses WHERE survey_id = ? ORDER BY created_at, id').all(id);
  const answers = db.prepare(`
    SELECT a.* FROM sv_answers a JOIN sv_responses r ON r.id = a.response_id WHERE r.survey_id = ?
  `).all(id);
  const byResponse = {};
  answers.forEach(a => { (byResponse[a.response_id] ||= {})[a.option_id] = a.value; });
  const cast = parseCast(s.roles);
  const castCells = {};
  db.prepare('SELECT * FROM sv_cast WHERE survey_id = ?').all(id).forEach(c => {
    if (cast[c.role] && castPeople(c.person).every(n => cast[c.role].includes(n))) (castCells[c.role] ||= {})[c.option_id] = c.person;
  });
  return {
    ...s,
    roles: parseRoles(s.roles),
    roles_text: s.roles || '',
    cast,
    cast_cells: castCells,
    options,
    responses: responses.map(r => {
      const out = { id: r.id, name: r.name, role: r.role, comment: r.comment, updated_at: r.updated_at, answers: byResponse[r.id] || {} };
      if (withTokens) out.edit_token = r.edit_token;
      return out;
    }),
  };
}

// Oeffentliche Sicht: ohne interne Felder; Antworten anderer nur, wenn freigegeben
function publicData(s, ownToken) {
  const full = surveyData(s.id, { withTokens: true });
  const own = ownToken ? full.responses.find(r => r.edit_token === ownToken) : null;
  const strip = ({ edit_token, ...r }) => r;
  return {
    title: full.title, description: full.description, status: full.status, deadline: full.deadline,
    allow_maybe: !!full.allow_maybe, show_results: !!full.show_results || full.layout === 'table', roles: full.roles,
    cast: full.cast, cast_cells: full.show_results || full.layout === 'table' ? full.cast_cells : {},
    layout: full.layout || 'form', open_edit: full.layout === 'table' && !!full.open_edit,
    options: full.options.map(({ id, section, label, date, time, note }) => ({ id, section, label, date, time, note })),
    responses: full.show_results || full.layout === 'table' ? full.responses.map(strip) : [],
    own: own ? strip(own) : null,
  };
}

function saveAnswers(responseId, surveyId, answers, allowMaybe) {
  const optionIds = new Set(db.prepare('SELECT id FROM sv_options WHERE survey_id = ?').all(surveyId).map(o => o.id));
  db.prepare('DELETE FROM sv_answers WHERE response_id = ?').run(responseId);
  const ins = db.prepare('INSERT INTO sv_answers (response_id, option_id, value) VALUES (?, ?, ?)');
  for (const [optId, value] of Object.entries(answers || {})) {
    if (!optionIds.has(+optId) || !VALUES.includes(value)) continue;
    if (value === 'maybe' && !allowMaybe) continue;
    ins.run(responseId, +optId, value);
  }
}

// Eine Zelle der Besetzung setzen (leer = wieder freigeben)
function saveCastCell(s, b) {
  const role = String(b.role || '');
  const names = parseCast(s.roles)[role];
  if (!names) return 'Diese Rolle hat keine Besetzung';
  const opt = db.prepare('SELECT id, section, label FROM sv_options WHERE id = ? AND survey_id = ?').get(b.option_id, s.id);
  if (!opt) return 'Termin nicht gefunden';
  // bei Ersatzterminen duerfen mehrere eingetragen sein (z.B. beide, wenn beide Zeit haben)
  const people = [...new Set(castPeople(clean(b.person, 300)))];
  if (people.some(n => !names.includes(n))) return 'Unbekannter Name';
  if (people.length > 1 && !isErsatz(opt)) return 'Mehrere Namen nur bei Ersatzterminen';
  const person = people.length ? names.filter(n => people.includes(n)).join('/') : null;
  if (person) db.prepare('INSERT INTO sv_cast (survey_id, role, option_id, person) VALUES (?, ?, ?, ?) ON CONFLICT(survey_id, role, option_id) DO UPDATE SET person = excluded.person').run(s.id, role, opt.id, person);
  else db.prepare('DELETE FROM sv_cast WHERE survey_id = ? AND role = ? AND option_id = ?').run(s.id, role, opt.id);
  return null;
}

// Nach dem Speichern der Rollen: umbenannte Rollen/Namen in der Besetzung mitnehmen, Verwaistes loeschen
function syncCast(id, oldRaw, newRaw, renames) {
  const oldCast = parseCast(oldRaw);
  const newCast = parseCast(newRaw);
  const back = {};
  Object.entries(renames).forEach(([from, to]) => { back[to] = from; });
  // gleiche Anzahl Namen: Namen an derselben Stelle gelten als umbenannt
  const renamed = {};
  Object.entries(newCast).forEach(([role, names]) => {
    const before = oldCast[back[role] || role];
    renamed[role] = {};
    if (before && before.length === names.length) before.forEach((n, i) => { if (n !== names[i] && !before.includes(names[i])) renamed[role][n] = names[i]; });
  });
  const upd = db.prepare('UPDATE sv_cast SET person = ? WHERE survey_id = ? AND role = ? AND option_id = ?');
  const del = db.prepare('DELETE FROM sv_cast WHERE survey_id = ? AND role = ? AND option_id = ?');
  db.prepare('SELECT * FROM sv_cast WHERE survey_id = ?').all(id).forEach(c => {
    const names = newCast[c.role];
    const people = names ? castPeople(c.person).map(n => renamed[c.role][n] || n).filter(n => names.includes(n)) : [];
    if (!people.length) del.run(id, c.role, c.option_id);
    else if (people.join('/') !== c.person) upd.run(names.filter(n => people.includes(n)).join('/'), id, c.role, c.option_id);
  });
  // Zeilen der Darsteller (Verfuegbarkeit + persoenlicher Link) mitnehmen: umbenennen bzw. entfernte loeschen
  const updName = db.prepare('UPDATE sv_responses SET name = ? WHERE survey_id = ? AND role = ? AND name = ?');
  const delResp = db.prepare('DELETE FROM sv_responses WHERE survey_id = ? AND role = ? AND name = ?');
  Object.entries(oldCast).forEach(([oldRole, before]) => {
    const role = renames[oldRole] || oldRole;
    const names = newCast[role] || [];
    before.forEach(n => {
      const to = (renamed[role] || {})[n];
      if (to) updName.run(to, id, role, n);
      else if (!names.includes(n)) delResp.run(id, role, n);
    });
  });
  ensureCastResponses(id, newCast);
}

// Jede Person einer Besetzung bekommt eine eigene Zeile (Verfuegbarkeit) mit eigenem Schluessel fuer den persoenlichen Link
function ensureCastResponses(id, cast) {
  const has = db.prepare('SELECT 1 FROM sv_responses WHERE survey_id = ? AND role = ? AND name = ?');
  const ins = db.prepare('INSERT INTO sv_responses (survey_id, name, role, edit_token) VALUES (?, ?, ?, ?)');
  Object.entries(cast).forEach(([role, names]) => names.forEach(n => { if (!has.get(id, role, n)) ins.run(id, n, role, newToken()); }));
}
const isCastMember = (s, r) => !!r && castPeople(r.name).length === 1 && (parseCast(s.roles)[r.role] || []).includes(r.name);

function responseInput(b, s) {
  const name = clean(b.name, 100);
  if (!name) return { error: 'Bitte einen Namen eingeben' };
  const roles = parseRoles(s.roles);
  const role = clean(b.role, 100);
  if (b._public && role && parseCast(s.roles)[role]) return { error: 'Für diese Rolle gibt es persönliche Links – bitte über deinen Link öffnen.' };
  return { name, role: role && (roles.length === 0 || roles.includes(role)) ? role : null, comment: clean(b.comment, 1000) };
}

// Optionen ersetzen: vorhandene (mit id) aktualisieren, neue anlegen, fehlende loeschen
function saveOptions(surveyId, options) {
  if (!Array.isArray(options)) return;
  const existing = new Set(db.prepare('SELECT id FROM sv_options WHERE survey_id = ?').all(surveyId).map(o => o.id));
  const keep = new Set();
  // time_inherit nicht mitgeschickt (z.B. aus dem Einstellungen-Dialog) = bisherigen Wert behalten
  const upd = db.prepare('UPDATE sv_options SET section = ?, label = ?, date = ?, time = ?, note = ?, sort = ?, time_inherit = COALESCE(?, time_inherit) WHERE id = ?');
  const ins = db.prepare('INSERT INTO sv_options (survey_id, section, label, date, time, note, sort, time_inherit) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0))');
  options.slice(0, MAX_OPTIONS).forEach((o, i) => {
    const inherit = o.time_inherit === undefined || o.time_inherit === null ? null : (o.time_inherit ? 1 : 0);
    const vals = [clean(o.section, 100), clean(o.label, 100), cleanDate(o.date), clean(o.time, 30), clean(o.note, 300), i, inherit];
    if (!vals[1] && !vals[2] && !o.id && !o.keep) return; // leere Zeile (im Tabellen-Editor bleiben neue Spalten erhalten)
    if (o.id && existing.has(+o.id)) { upd.run(...vals, +o.id); keep.add(+o.id); }
    else ins.run(surveyId, ...vals);
  });
  existing.forEach(id => { if (!keep.has(id)) db.prepare('DELETE FROM sv_options WHERE id = ?').run(id); });
}

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const SYMBOL = { yes: '✓', maybe: '?', no: '✗' };
const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}` : '');

// Tabelle wie die bisherige Google-Tabelle: je Abschnitt Kopfzeilen (Bezeichnung, Datum,
// Wochentag, Uhrzeit), dann eine Zeile je Rolle bzw. Teilnehmer, unten die Zusagen.
function exportWorkbook(s) {
  const sections = [];
  s.options.forEach(o => {
    const key = o.section || '';
    let sec = sections.find(x => x.name === key);
    if (!sec) sections.push(sec = { name: key, options: [] });
    sec.options.push(o);
  });
  // Ersatztermine zwischen die Aufführungen, alles chronologisch (wie auf der Seite)
  const ersatzSec = (sec) => /ersatz/i.test(sec.name);
  const main = sections.find(sec => /auff[üu]hrung|show|vorstellung/i.test(sec.name) && !ersatzSec(sec)) || sections.find(sec => !ersatzSec(sec));
  if (main) sections.filter(ersatzSec).forEach(sec => { main.options.push(...sec.options); sections.splice(sections.indexOf(sec), 1); });
  sections.forEach(sec => {
    sec.options = sec.options.map((o, i) => ({ o, i })).sort((a, b) => {
      if (a.o.date && b.o.date) return a.o.date < b.o.date ? -1 : a.o.date > b.o.date ? 1 : a.i - b.i;
      if (a.o.date || b.o.date) return a.o.date ? -1 : 1;
      return a.i - b.i;
    }).map(x => x.o);
  });
  const rows = [[s.title], []];
  const people = orderedRows(s);
  sections.forEach(sec => {
    if (sec.name) rows.push([sec.name]);
    rows.push(['', ...sec.options.map(o => o.label || '')]);
    rows.push(['', ...sec.options.map(o => fmtDate(o.date))]);
    rows.push(['', ...sec.options.map(o => (o.date ? WEEKDAYS[new Date(o.date + 'T00:00:00').getDay()].toUpperCase() : ''))]);
    if (sec.options.some(o => o.time)) rows.push(['', ...sec.options.map(o => o.time || '')]);
    people.forEach(p => rows.push([p.label, ...sec.options.map(o => (p.castRole ? castPeople((s.cast_cells[p.castRole] || {})[o.id]).join(' + ')
      : p.response ? SYMBOL[p.response.answers[o.id]] || '' : ''))]));
    rows.push(['Zusagen', ...sec.options.map(o => s.responses.filter(r => r.answers[o.id] === 'yes' && !(s.cast[r.role] || []).includes(r.name)).length
      + Object.values(s.cast_cells).reduce((n, c) => n + castPeople(c[o.id]).length, 0))]);
    rows.push([], []);
  });
  const comments = s.responses.filter(r => r.comment);
  if (comments.length) {
    rows.push(['Kommentare']);
    comments.forEach(r => rows.push([[r.name, r.role].filter(Boolean).join(' – '), r.comment]));
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 26 }, ...Array(60).fill({ wch: 11 })];
  XLSX.utils.book_append_sheet(wb, ws, 'Umfrage');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Zeilen in Rollen-Reihenfolge; Rollen ohne Antwort bleiben als leere Zeile sichtbar
function orderedRows(s) {
  const out = [];
  s.roles.forEach(role => {
    const rs = s.responses.filter(r => r.role === role);
    if (s.cast[role]) {
      // Showzahl ohne Ersatztermine
      const cells = s.cast_cells[role] || {};
      const count = (n, ersatz) => s.options.filter(o => isErsatz(o) === ersatz && castPeople(cells[o.id]).includes(n)).length;
      out.push({ label: `${role} (${s.cast[role].map(n => `${n} ${count(n, false)}×${count(n, true) ? ` +${count(n, true)} Ersatz` : ''}`).join(' / ')})`, castRole: role });
    } else if (!rs.length) out.push({ label: role, response: null });
    rs.forEach(r => out.push({ label: `${role} – ${r.name}`, response: r }));
  });
  s.responses.filter(r => !r.role || !s.roles.includes(r.role)).forEach(r => out.push({ label: r.name, response: r }));
  return out;
}

function register(app) {
  // Termine, Rollen, Einstellungen und Loeschen nur fuer Admins; alle anderen tragen nur Namen ein
  const adminOnly = (req, res, next) => (req.isAdmin ? next() : res.status(403).json({ error: 'Nur Admins können Termine, Rollen und Einstellungen ändern.' }));

  // ---- Verwaltung (Reiter "Umfragen") ----
  app.get('/api/surveys', (req, res) => {
    const list = db.prepare('SELECT * FROM sv_surveys ORDER BY created_at DESC, id DESC').all().map(s => ({
      id: s.id, title: s.title, status: s.status, layout: s.layout, token: s.token, deadline: s.deadline, created_at: s.created_at,
      options: db.prepare('SELECT COUNT(*) AS n FROM sv_options WHERE survey_id = ?').get(s.id).n,
      responses: db.prepare('SELECT COUNT(*) AS n FROM sv_responses WHERE survey_id = ?').get(s.id).n,
    }));
    res.json(list);
  });

  app.get('/api/surveys/:id', (req, res) => {
    // Admins bekommen die Schluessel, um die persoenlichen Links der Darsteller zu verschicken
    const s = surveyData(req.params.id, { withTokens: req.isAdmin });
    if (!s) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    res.json(s);
  });

  function writeSurvey(id, b, existing) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : existing ? existing[k] : f(undefined));
    const title = val('title', v => clean(v, 200));
    if (!title) throw new Error('Titel ist erforderlich');
    const fields = {
      title,
      description: val('description', v => clean(v, 4000)),
      status: val('status', v => (v === 'geschlossen' ? 'geschlossen' : 'offen')),
      allow_maybe: 0,
      show_results: val('show_results', v => (v === false || v === 0 ? 0 : 1)),
      roles: val('roles', v => clean(v, 4000)),
      deadline: val('deadline', cleanDate),
      layout: val('layout', v => (v === 'table' ? 'table' : 'form')),
      open_edit: val('open_edit', v => (v === true || v === 1 ? 1 : 0)),
    };
    const keys = Object.keys(fields);
    if (id) {
      db.prepare(`UPDATE sv_surveys SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
    } else {
      id = db.prepare(`INSERT INTO sv_surveys (${keys.join(', ')}, token, created_by) VALUES (${keys.map(() => '?').join(', ')}, ?, ?)`)
        .run(...keys.map(k => fields[k]), newToken(), b._user).lastInsertRowid;
    }
    saveOptions(id, b.options);
    // Umbenannte Rollen: bestehende Antworten und Besetzung mitnehmen
    const renames = {};
    if (b.role_renames && typeof b.role_renames === 'object') {
      const upd = db.prepare('UPDATE sv_responses SET role = ? WHERE survey_id = ? AND role = ?');
      const updCast = db.prepare('UPDATE sv_cast SET role = ? WHERE survey_id = ? AND role = ?');
      Object.entries(b.role_renames).slice(0, 100).forEach(([from, to]) => {
        if (!clean(to, 100)) return;
        upd.run(clean(to, 100), id, from);
        updCast.run(clean(to, 100), id, from);
        renames[from] = clean(to, 100);
      });
    }
    syncCast(id, existing ? existing.roles : '', fields.roles, renames);
    return id;
  }

  app.post('/api/surveys', adminOnly, (req, res) => {
    try {
      const id = db.transaction(() => writeSurvey(null, { ...req.body, _user: req.user.id }))();
      res.status(201).json(surveyData(id));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.put('/api/surveys/:id', adminOnly, (req, res) => {
    const s = db.prepare('SELECT * FROM sv_surveys WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    try {
      db.transaction(() => writeSurvey(s.id, req.body || {}, s))();
      res.json(surveyData(s.id));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/surveys/:id', adminOnly, (req, res) => {
    db.prepare('DELETE FROM sv_surveys WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // Antwort im Namen von jemandem eintragen/aendern (z.B. per WhatsApp gemeldet)
  app.post('/api/surveys/:id/responses', (req, res) => {
    const s = db.prepare('SELECT * FROM sv_surveys WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    const input = responseInput(req.body || {}, s);
    if (input.error) return res.status(400).json(input);
    db.transaction(() => {
      const rid = db.prepare('INSERT INTO sv_responses (survey_id, name, role, comment, edit_token) VALUES (?, ?, ?, ?, ?)')
        .run(s.id, input.name, input.role, input.comment, newToken()).lastInsertRowid;
      saveAnswers(rid, s.id, req.body.answers, true);
    })();
    res.status(201).json(surveyData(s.id));
  });

  app.put('/api/surveys/:id/responses/:rid', (req, res) => {
    const s = db.prepare('SELECT * FROM sv_surveys WHERE id = ?').get(req.params.id);
    const r = s && db.prepare('SELECT * FROM sv_responses WHERE id = ? AND survey_id = ?').get(req.params.rid, s.id);
    if (!r) return res.status(404).json({ error: 'Antwort nicht gefunden' });
    const input = responseInput(req.body || {}, s);
    if (input.error) return res.status(400).json(input);
    db.transaction(() => {
      db.prepare("UPDATE sv_responses SET name = ?, role = ?, comment = ?, updated_at = datetime('now') WHERE id = ?").run(input.name, input.role, input.comment, r.id);
      saveAnswers(r.id, s.id, req.body.answers, true);
    })();
    res.json(surveyData(s.id));
  });

  app.put('/api/surveys/:id/cast', adminOnly, (req, res) => {
    const s = db.prepare('SELECT * FROM sv_surveys WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    const err = saveCastCell(s, req.body || {});
    if (err) return res.status(400).json({ error: err });
    res.json(surveyData(s.id));
  });

  app.delete('/api/surveys/:id/responses/:rid', adminOnly, (req, res) => {
    db.prepare('DELETE FROM sv_responses WHERE id = ? AND survey_id = ?').run(req.params.rid, req.params.id);
    res.json(surveyData(req.params.id));
  });

  app.get('/api/surveys/:id/export.xlsx', (req, res) => {
    const s = surveyData(req.params.id);
    if (!s) return res.status(404).send('Umfrage nicht gefunden');
    const name = s.title.replace(/[^\wäöüÄÖÜß -]/g, '').trim() || 'Umfrage';
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="umfrage.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}.xlsx`);
    res.send(exportWorkbook(s));
  });

  // ---- Oeffentlich (ohne Login, nur ueber den geheimen Link) ----
  const bySurveyToken = (token) => db.prepare('SELECT * FROM sv_surveys WHERE token = ?').get(token);

  // Seite mit dem Titel der Umfrage im Kopf, damit Link-Vorschauen (WhatsApp, Mail ...) ihn zeigen
  const pageFile = path.join(__dirname, 'public', 'umfrage.html');
  const escAttr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  app.get('/u/:token', (req, res) => {
    const s = bySurveyToken(req.params.token);
    if (!s) return res.status(404).send('Diese Umfrage gibt es nicht (mehr).');
    const title = escAttr(s.title);
    const desc = escAttr((s.description || 'Bitte hier eintragen.').replace(/\s+/g, ' ').slice(0, 200));
    const html = fs.readFileSync(pageFile, 'utf8').replace('<title>Umfrage</title>', `<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta name="description" content="${desc}">`);
    res.set('Cache-Control', 'no-store').type('html').send(html);
  });

  app.get('/api/public/umfrage/:token', (req, res) => {
    const s = bySurveyToken(req.params.token);
    if (!s) return res.status(404).json({ error: 'Diese Umfrage gibt es nicht (mehr).' });
    res.json(publicData(s, req.query.e));
  });

  app.post('/api/public/umfrage/:token', (req, res) => {
    const s = bySurveyToken(req.params.token);
    if (!s) return res.status(404).json({ error: 'Diese Umfrage gibt es nicht (mehr).' });
    if (s.status !== 'offen') return res.status(403).json({ error: 'Die Umfrage ist geschlossen.' });
    const b = req.body || {};
    let r = b.edit_token ? db.prepare('SELECT * FROM sv_responses WHERE edit_token = ? AND survey_id = ?').get(String(b.edit_token), s.id) : null;
    // Darsteller behalten Name und Rolle (sie gehoeren zur Besetzung), nur Kommentar und Verfuegbarkeit aendern sich
    const input = isCastMember(s, r) ? { name: r.name, role: r.role, comment: clean(b.comment, 1000) } : responseInput({ ...b, _public: true }, s);
    if (input.error) return res.status(400).json(input);
    if (!r && db.prepare('SELECT COUNT(*) AS n FROM sv_responses WHERE survey_id = ?').get(s.id).n >= MAX_RESPONSES) {
      return res.status(400).json({ error: 'Die Umfrage hat bereits die maximale Anzahl an Antworten.' });
    }
    const token = r ? r.edit_token : newToken();
    db.transaction(() => {
      if (r) {
        db.prepare("UPDATE sv_responses SET name = ?, role = ?, comment = ?, updated_at = datetime('now') WHERE id = ?").run(input.name, input.role, input.comment, r.id);
      } else {
        r = { id: db.prepare('INSERT INTO sv_responses (survey_id, name, role, comment, edit_token) VALUES (?, ?, ?, ?, ?)')
          .run(s.id, input.name, input.role, input.comment, token).lastInsertRowid };
      }
      saveAnswers(r.id, s.id, b.answers, !!s.allow_maybe);
    })();
    res.json({ ...publicData(s, token), edit_token: token });
  });

  // Besetzung: gehoert keiner einzelnen Person, darf in der offenen Tabelle von allen gesetzt werden
  app.put('/api/public/umfrage/:token/cast', (req, res) => {
    const s = bySurveyToken(req.params.token);
    if (!s) return res.status(404).json({ error: 'Diese Umfrage gibt es nicht (mehr).' });
    if (s.status !== 'offen') return res.status(403).json({ error: 'Die Umfrage ist geschlossen.' });
    if (s.layout !== 'table') return res.status(403).json({ error: 'Nur in der Tabellen-Ansicht möglich.' });
    // nur die Darsteller dieser Rolle (erkannt am persoenlichen Schluessel) legen fest, wer spielt
    const me = req.query.e ? db.prepare('SELECT * FROM sv_responses WHERE edit_token = ? AND survey_id = ?').get(String(req.query.e), s.id) : null;
    if (!isCastMember(s, me) || me.role !== String((req.body || {}).role || '')) {
      return res.status(403).json({ error: 'Das können nur die Darsteller dieser Rolle festlegen – bitte über deinen persönlichen Link öffnen.' });
    }
    const err = saveCastCell(s, req.body || {});
    if (err) return res.status(400).json({ error: err });
    res.json(publicData(s, req.query.e));
  });

  // Offene Tabelle: fremde Zeile aendern (nur wenn die Umfrage das erlaubt)
  app.put('/api/public/umfrage/:token/:rid', (req, res) => {
    const s = bySurveyToken(req.params.token);
    if (!s) return res.status(404).json({ error: 'Diese Umfrage gibt es nicht (mehr).' });
    if (s.status !== 'offen') return res.status(403).json({ error: 'Die Umfrage ist geschlossen.' });
    if (s.layout !== 'table' || !s.open_edit) return res.status(403).json({ error: 'Nur die eigene Zeile darf geändert werden.' });
    const r = db.prepare('SELECT * FROM sv_responses WHERE id = ? AND survey_id = ?').get(req.params.rid, s.id);
    if (!r) return res.status(404).json({ error: 'Zeile nicht gefunden' });
    if (isCastMember(s, r) && r.edit_token !== String(req.query.e || '')) return res.status(403).json({ error: 'Die Zeilen der Darsteller ändern nur sie selbst.' });
    db.transaction(() => {
      db.prepare("UPDATE sv_responses SET updated_at = datetime('now') WHERE id = ?").run(r.id);
      saveAnswers(r.id, s.id, (req.body || {}).answers, !!s.allow_maybe);
    })();
    res.json(publicData(s, req.query.e));
  });
}

module.exports = { register };
