// ================= UMFRAGEN (Zu-/Absagen per oeffentlichem Link) =================
// Eine Umfrage hat Termine bzw. Punkte (in Abschnitten, z.B. "Aufführungen", "Probenwochenenden")
// und optional eine Rollenliste (z.B. die Rollen eines Musicals plus Technik). Teilnehmer
// oeffnen /u/<token> ohne Login, tragen Namen und Rolle ein und sagen je Termin zu,
// vielleicht oder ab. Ueber den eigenen Bearbeiten-Link (edit_token) laesst sich die
// Antwort spaeter aendern. Im Reiter "Umfragen" erscheint alles als Tabelle Rollen x Termine.

const crypto = require('crypto');
const path = require('path');
const XLSX = require('xlsx');
const db = require('./db');

const VALUES = ['yes', 'maybe', 'no'];
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
// time_inherit: Uhrzeit folgt dem ersten Termin des Abschnitts (z.B. alle Shows wie die Premiere)
if (!db.prepare('PRAGMA table_info(sv_options)').all().some(c => c.name === 'time_inherit')) db.exec('ALTER TABLE sv_options ADD COLUMN time_inherit INTEGER DEFAULT 0');

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
const parseRoles = (raw) => String(raw || '').split('\n').map(r => r.trim()).filter(Boolean);

function surveyData(id, { withTokens = false } = {}) {
  const s = db.prepare('SELECT * FROM sv_surveys WHERE id = ?').get(id);
  if (!s) return null;
  const options = db.prepare('SELECT * FROM sv_options WHERE survey_id = ? ORDER BY sort, id').all(id);
  const responses = db.prepare('SELECT * FROM sv_responses WHERE survey_id = ? ORDER BY created_at, id').all(id);
  const answers = db.prepare(`
    SELECT a.* FROM sv_answers a JOIN sv_responses r ON r.id = a.response_id WHERE r.survey_id = ?
  `).all(id);
  const byResponse = {};
  answers.forEach(a => { (byResponse[a.response_id] ||= {})[a.option_id] = a.value; });
  return {
    ...s,
    roles: parseRoles(s.roles),
    roles_text: s.roles || '',
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

function responseInput(b, s) {
  const name = clean(b.name, 100);
  if (!name) return { error: 'Bitte einen Namen eingeben' };
  const roles = parseRoles(s.roles);
  const role = clean(b.role, 100);
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
  const rows = [[s.title], []];
  const people = orderedRows(s);
  sections.forEach(sec => {
    if (sec.name) rows.push([sec.name]);
    rows.push(['', ...sec.options.map(o => o.label || '')]);
    rows.push(['', ...sec.options.map(o => fmtDate(o.date))]);
    rows.push(['', ...sec.options.map(o => (o.date ? WEEKDAYS[new Date(o.date + 'T00:00:00').getDay()].toUpperCase() : ''))]);
    if (sec.options.some(o => o.time)) rows.push(['', ...sec.options.map(o => o.time || '')]);
    people.forEach(p => rows.push([p.label, ...sec.options.map(o => (p.response ? SYMBOL[p.response.answers[o.id]] || '' : ''))]));
    rows.push(['Zusagen', ...sec.options.map(o => s.responses.filter(r => r.answers[o.id] === 'yes').length)]);
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
    if (!rs.length) out.push({ label: role, response: null });
    rs.forEach(r => out.push({ label: `${role} – ${r.name}`, response: r }));
  });
  s.responses.filter(r => !r.role || !s.roles.includes(r.role)).forEach(r => out.push({ label: r.name, response: r }));
  return out;
}

function register(app) {
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
    const s = surveyData(req.params.id);
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
      allow_maybe: val('allow_maybe', v => (v === false || v === 0 ? 0 : 1)),
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
    // Umbenannte Rollen: bestehende Antworten mitnehmen
    if (b.role_renames && typeof b.role_renames === 'object') {
      const upd = db.prepare('UPDATE sv_responses SET role = ? WHERE survey_id = ? AND role = ?');
      Object.entries(b.role_renames).slice(0, 100).forEach(([from, to]) => { if (clean(to, 100)) upd.run(clean(to, 100), id, from); });
    }
    return id;
  }

  app.post('/api/surveys', (req, res) => {
    try {
      const id = db.transaction(() => writeSurvey(null, { ...req.body, _user: req.user.id }))();
      res.status(201).json(surveyData(id));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.put('/api/surveys/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM sv_surveys WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    try {
      db.transaction(() => writeSurvey(s.id, req.body || {}, s))();
      res.json(surveyData(s.id));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/surveys/:id', (req, res) => {
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

  app.delete('/api/surveys/:id/responses/:rid', (req, res) => {
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

  app.get('/u/:token', (req, res) => {
    if (!bySurveyToken(req.params.token)) return res.status(404).send('Diese Umfrage gibt es nicht (mehr).');
    res.sendFile(path.join(__dirname, 'public', 'umfrage.html'));
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
    const input = responseInput(b, s);
    if (input.error) return res.status(400).json(input);
    let r = b.edit_token ? db.prepare('SELECT * FROM sv_responses WHERE edit_token = ? AND survey_id = ?').get(String(b.edit_token), s.id) : null;
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

  // Offene Tabelle: fremde Zeile aendern (nur wenn die Umfrage das erlaubt)
  app.put('/api/public/umfrage/:token/:rid', (req, res) => {
    const s = bySurveyToken(req.params.token);
    if (!s) return res.status(404).json({ error: 'Diese Umfrage gibt es nicht (mehr).' });
    if (s.status !== 'offen') return res.status(403).json({ error: 'Die Umfrage ist geschlossen.' });
    if (s.layout !== 'table' || !s.open_edit) return res.status(403).json({ error: 'Nur die eigene Zeile darf geändert werden.' });
    const r = db.prepare('SELECT * FROM sv_responses WHERE id = ? AND survey_id = ?').get(req.params.rid, s.id);
    if (!r) return res.status(404).json({ error: 'Zeile nicht gefunden' });
    db.transaction(() => {
      db.prepare("UPDATE sv_responses SET updated_at = datetime('now') WHERE id = ?").run(r.id);
      saveAnswers(r.id, s.id, (req.body || {}).answers, !!s.allow_maybe);
    })();
    res.json(publicData(s, req.query.e));
  });
}

module.exports = { register };
