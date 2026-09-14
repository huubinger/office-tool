// Zeitzone fest auf Europe/Berlin setzen - muss vor allen anderen Requires stehen,
// damit saemtliche Datumsberechnungen (Wochenreport, "heute", Cronjobs, etc.)
// konsequent nach deutscher Zeit statt der Server-Standardzeit (z.B. UTC auf Railway) laufen.
process.env.TZ = 'Europe/Berlin';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { runReminderCheck } = require('./reminders');
const { runBackup, getLastBackup, isConfigured: isBackupConfigured } = require('./backup');
const { getHolidaysForYear, isHoliday } = require('./holidays');

const app = express();
// Noetig hinter einem Reverse-Proxy (Railway, Heroku, etc.), damit Express erkennt,
// dass die urspruengliche Verbindung ueber HTTPS lief - sonst werden "secure"-Cookies
// (siehe unten) nicht zuverlaessig gesetzt und der Login haengt sich scheinbar auf.
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

// Verhindert, dass Browser oder ein zwischengeschalteter Proxy (z.B. bei Railway) Antworten
// der API zwischenspeichern - sonst kann z.B. ein Login-Versuch faelschlich aus dem Cache
// beantwortet werden (304 Not Modified, ohne dass der Server ihn tatsaechlich verarbeitet).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---------- Login/Session ----------
// Ohne gesetztes SESSION_SECRET wird beim Start eines generiert - das invalidiert
// bestehende Sessions bei jedem Neustart. Fuer den Produktivbetrieb SESSION_SECRET setzen.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 Tage
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.DISABLE_SECURE_COOKIE !== 'true',
  },
}));

const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/style.css', '/api/login']);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nicht angemeldet' });
  return res.redirect('/login.html');
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  const user = db.prepare('SELECT * FROM app_users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.personId = user.person_id || null;
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Nicht angemeldet' });
  let personName = null;
  if (req.session.personId) {
    const p = db.prepare('SELECT name FROM people WHERE id = ?').get(req.session.personId);
    personName = p ? p.name : null;
  }
  res.json({
    username: req.session.username,
    person_id: req.session.personId || null,
    person_name: personName,
    is_admin: !req.session.personId,
  });
});

app.post('/api/account/change-password', (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen haben' });
  }
  const user = db.prepare('SELECT * FROM app_users WHERE id = ?').get(req.session.userId);
  if (!user || !bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
  }
  const newHash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE app_users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  res.json({ ok: true });
});

// Schuetzt Zeiterfassungs-Routen: Nicht-Admin-Logins (an eine Person gebunden) duerfen
// nur mit der eigenen person_id arbeiten. Admin (kein personId in der Session) ist frei.
function enforceOwnPerson(req, res, next) {
  if (!req.session.personId) return next(); // Admin
  const bodyPersonId = req.body && req.body.person_id;
  const queryPersonId = req.query && req.query.person_id;
  if ((bodyPersonId && +bodyPersonId !== req.session.personId) || (queryPersonId && +queryPersonId !== req.session.personId)) {
    return res.status(403).json({ error: 'Nur eigene Zeiterfassung erlaubt' });
  }
  if (req.body && 'person_id' in req.body) req.body.person_id = req.session.personId;
  if (req.query && !req.query.person_id) req.query.person_id = String(req.session.personId);
  next();
}

// ---------- Benutzerverwaltung (weitere Login-Konten) ----------
app.get('/api/users', (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.created_at, u.person_id, p.name AS person_name
    FROM app_users u LEFT JOIN people p ON p.id = u.person_id
    ORDER BY u.username
  `).all());
});

app.post('/api/users', (req, res) => {
  const { username, password, person_id } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'Benutzername ist erforderlich' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'Benutzername ist bereits vergeben' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO app_users (username, password_hash, person_id) VALUES (?, ?, ?)')
    .run(username.trim(), hash, person_id || null);
  res.status(201).json({ id: info.lastInsertRowid, username: username.trim(), person_id: person_id || null });
});

app.delete('/api/users/:id', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c;
  if (totalUsers <= 1) return res.status(400).json({ error: 'Das letzte verbleibende Konto kann nicht gelöscht werden' });
  if (+req.params.id === req.session.userId) return res.status(400).json({ error: 'Das eigene, gerade angemeldete Konto kann nicht gelöscht werden' });
  db.prepare('DELETE FROM app_users WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------- Helpers ----------
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin) + (process.env.PIN_PEPPER || 'office-tool')).digest('hex');
}

function sanitizePerson(p) {
  if (!p) return p;
  const { pin_hash, ...rest } = p;
  return { ...rest, has_pin: !!pin_hash };
}

const actualMinutesStmt = db.prepare(`
  SELECT COALESCE(SUM(duration_minutes), 0) AS m
  FROM time_entries
  WHERE task_id = ? AND duration_minutes IS NOT NULL
`);

function getTaskWithAssignments(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  const people = db.prepare(`
    SELECT p.* FROM people p
    JOIN task_assignments ta ON ta.person_id = p.id
    WHERE ta.task_id = ?
    ORDER BY p.name
  `).all(taskId).map(sanitizePerson);
  const project = task.project_id ? db.prepare('SELECT id, name, color FROM projects WHERE id = ?').get(task.project_id) : null;
  return { ...task, people, project, actual_minutes: actualMinutesStmt.get(taskId).m };
}

function allTasksWithAssignments() {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  const assignStmt = db.prepare(`
    SELECT p.* FROM people p
    JOIN task_assignments ta ON ta.person_id = p.id
    WHERE ta.task_id = ?
    ORDER BY p.name
  `);
  const projects = new Map(db.prepare('SELECT id, name, color FROM projects').all().map(p => [p.id, p]));
  return tasks.map(t => ({
    ...t,
    people: assignStmt.all(t.id).map(sanitizePerson),
    project: t.project_id ? (projects.get(t.project_id) || null) : null,
    actual_minutes: actualMinutesStmt.get(t.id).m,
  }));
}

// Stoppt eine laufende Zeiterfassung einer Person (falls vorhanden) und gibt true zurueck, wenn gestoppt wurde
function autoStopRunningForPerson(personId, now) {
  const running = db.prepare('SELECT * FROM time_entries WHERE person_id = ? AND running = 1').get(personId);
  if (!running) return false;
  const durationMin = computeMinutesBetween(running.start_time, formatHMS(now));
  db.prepare('UPDATE time_entries SET end_time = ?, duration_minutes = ?, running = 0 WHERE id = ?')
    .run(formatHMS(now), durationMin, running.id);
  recomputeDailyWarning(personId, running.date);
  return true;
}

// Maximale taegliche Arbeitszeit, ab der eine Warnung protokolliert wird (Minuten).
// 600 = 10 Std, die gesetzliche Hoechstgrenze lt. ArbZG §3 - als Orientierungswert,
// keine rechtsverbindliche Pruefung. Bei Bedarf hier anpassen.
const DAILY_MAX_MINUTES = 600;

function recomputeDailyWarning(personId, date) {
  const total = db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) AS m
    FROM time_entries WHERE person_id = ? AND date = ? AND duration_minutes IS NOT NULL
  `).get(personId, date).m;
  const existing = db.prepare('SELECT * FROM work_time_warnings WHERE person_id = ? AND date = ?').get(personId, date);
  if (total > DAILY_MAX_MINUTES) {
    if (existing) db.prepare('UPDATE work_time_warnings SET minutes = ? WHERE id = ?').run(total, existing.id);
    else db.prepare('INSERT INTO work_time_warnings (person_id, date, minutes) VALUES (?, ?, ?)').run(personId, date, total);
  } else if (existing) {
    db.prepare('DELETE FROM work_time_warnings WHERE id = ?').run(existing.id);
  }
}

function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

// Rechnet Seminartage (Abwesenheitstyp 'Seminar') als 8h/Werktag in die Arbeitszeit ein
function seminarCreditMinutes(personId, from, to) {
  const rows = db.prepare(`
    SELECT date_from, date_to FROM absences
    WHERE person_id = ? AND type = 'Seminar' AND date_to >= ? AND date_from <= ?
  `).all(personId, from, to);
  let minutes = 0;
  rows.forEach(r => {
    const start = new Date(Math.max(new Date(r.date_from).getTime(), new Date(from).getTime()));
    const end = new Date(Math.min(new Date(r.date_to).getTime(), new Date(to).getTime()));
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) minutes += 480;
    }
  });
  return minutes;
}

// BFD-Zuschlag: 1 Std Freizeitausgleich pro Samstagsdienst, 2 Std pro Sonn-/Feiertagsdienst,
// halbiert bei "halben Arbeitstagen" (< 4 Std an diesem Tag gearbeitet). Nur fuer Personen
// mit Vertragsart 'BFD', da dies eine BFD-spezifische Vertragsregelung ist.
function weekendHolidayBonusMinutes(personId, from, to) {
  const rows = db.prepare(`
    SELECT date, SUM(duration_minutes) AS minutes
    FROM time_entries
    WHERE person_id = ? AND date BETWEEN ? AND ? AND duration_minutes IS NOT NULL
    GROUP BY date
  `).all(personId, from, to);

  let bonus = 0;
  rows.forEach(r => {
    const d = new Date(r.date);
    const dow = d.getDay();
    const holiday = isHoliday(r.date);
    if (dow !== 0 && dow !== 6 && !holiday) return; // normaler Werktag, kein Zuschlag

    const isHalfDay = r.minutes < 240;
    if (dow === 6 && !holiday) {
      bonus += isHalfDay ? 30 : 60; // Samstag: 1 Std, halbiert 30 Min
    } else {
      bonus += isHalfDay ? 60 : 120; // Sonntag oder Feiertag: 2 Std, halbiert 60 Min
    }
  });
  return bonus;
}

// Bereits genommener Freizeitausgleich im Zeitraum (reduziert die Ueberstunden-Bilanz)
function timeOffCompensationMinutes(personId, from, to) {
  return db.prepare(`
    SELECT COALESCE(SUM(minutes), 0) AS m FROM time_off_compensation
    WHERE person_id = ? AND date BETWEEN ? AND ?
  `).get(personId, from, to).m;
}

// BFD-Grenzwerte lt. Vereinbarung: max. 30 Ueberstunden bzw. max. 10 Minusstunden im Einzelfall
const BFD_MAX_OVERTIME_MINUTES = 30 * 60;
const BFD_MAX_UNDERTIME_MINUTES = 10 * 60;

function bfdThresholdWarning(diffMinutes) {
  if (diffMinutes === null) return null;
  if (diffMinutes > BFD_MAX_OVERTIME_MINUTES) return 'Überstunden-Grenze (30 Std) überschritten';
  if (diffMinutes < -BFD_MAX_UNDERTIME_MINUTES) return 'Minusstunden-Grenze (10 Std) überschritten';
  return null;
}

// ---- Aehnlichkeits-Schaetzung fuer Aufgabendauer ----
const STOPWORDS = new Set([
  'und', 'der', 'die', 'das', 'für', 'fuer', 'mit', 'von', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'im', 'am', 'an', 'zu', 'auf', 'bei',
  'pro', 'aus', 'ist', 'sind', 'wird', 'werden', 'oder', 'als', 'auch',
]);

function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

function formatHMS(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}
function isoDateLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function timeStrToMinutes(t) {
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + parts[1] + (parts[2] || 0) / 60;
}
// Differenz zweier "HH:MM"/"HH:MM:SS"-Zeiten in Minuten. Liegt das Ende vor dem Start,
// wird ein Tagesuebertrag angenommen (z.B. Schicht 17:00-00:00 -> 7 Std, nicht negativ).
function computeMinutesBetween(startStr, endStr) {
  const start = timeStrToMinutes(startStr);
  let end = timeStrToMinutes(endStr);
  if (end < start) end += 1440;
  return Math.round(end - start);
}

const timeEntryJoinSelect = `
  SELECT te.*, p.name AS person_name, t.title AS task_title
  FROM time_entries te
  JOIN people p ON p.id = te.person_id
  LEFT JOIN tasks t ON t.id = te.task_id
`;

// ---------- People ----------
app.get('/api/people', (req, res) => {
  const people = db.prepare('SELECT * FROM people ORDER BY active DESC, name').all();
  res.json(people.map(sanitizePerson));
});

app.post('/api/people', (req, res) => {
  const {
    name, role, color, email, pin, weekly_target_minutes,
    contract_type, vacation_days_total, probation_weeks, contract_start, contract_end, seminar_days_total,
  } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name ist erforderlich' });
  const info = db.prepare(`
    INSERT INTO people (
      name, role, color, email, pin_hash, weekly_target_minutes,
      contract_type, vacation_days_total, probation_weeks, contract_start, contract_end, seminar_days_total
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    role || null,
    color || '#4f46e5',
    email || null,
    pin ? hashPin(pin) : null,
    weekly_target_minutes || null,
    contract_type || null,
    vacation_days_total || null,
    probation_weeks || null,
    contract_start || null,
    contract_end || null,
    seminar_days_total || null
  );
  res.status(201).json(sanitizePerson(db.prepare('SELECT * FROM people WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/people/:id', (req, res) => {
  const {
    name, role, color, active, email, pin, weekly_target_minutes, clear_pin,
    contract_type, vacation_days_total, probation_weeks, contract_start, contract_end, seminar_days_total,
  } = req.body;
  const existing = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Person nicht gefunden' });

  let newPinHash = existing.pin_hash;
  if (clear_pin) newPinHash = null;
  else if (pin) newPinHash = hashPin(pin);

  db.prepare(`
    UPDATE people SET name = ?, role = ?, color = ?, active = ?, email = ?, pin_hash = ?, weekly_target_minutes = ?,
      contract_type = ?, vacation_days_total = ?, probation_weeks = ?, contract_start = ?, contract_end = ?, seminar_days_total = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    role ?? existing.role,
    color ?? existing.color,
    active === undefined ? existing.active : (active ? 1 : 0),
    email ?? existing.email,
    newPinHash,
    weekly_target_minutes === undefined ? existing.weekly_target_minutes : weekly_target_minutes,
    contract_type === undefined ? existing.contract_type : contract_type,
    vacation_days_total === undefined ? existing.vacation_days_total : vacation_days_total,
    probation_weeks === undefined ? existing.probation_weeks : probation_weeks,
    contract_start === undefined ? existing.contract_start : contract_start,
    contract_end === undefined ? existing.contract_end : contract_end,
    seminar_days_total === undefined ? existing.seminar_days_total : seminar_days_total,
    req.params.id
  );
  res.json(sanitizePerson(db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id)));
});

app.delete('/api/people/:id', (req, res) => {
  db.prepare('DELETE FROM people WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.post('/api/people/:id/verify-pin', (req, res) => {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person nicht gefunden' });
  if (!person.pin_hash) return res.json({ valid: true }); // keine PIN gesetzt -> kein Schutz noetig
  const { pin } = req.body;
  res.json({ valid: !!pin && hashPin(pin) === person.pin_hash });
});

// Standardregularien BFD, als Vorschlag zum Uebernehmen (kein Automatismus ohne Bestaetigung)
const BFD_DEFAULTS = { weekly_hours: 40, vacation_days: 28, probation_weeks: 6 };
app.get('/api/bfd-defaults', (req, res) => res.json(BFD_DEFAULTS));

// Liest eine hochgeladene BFD-Vereinbarung (PDF, als Base64) aus und extrahiert
// Dienstzeit, Urlaubstage, Probezeit, Vertragszeitraum und Seminartage per Texterkennung.
// Liefert nur Vorschlaege - die Person entscheidet im Frontend, was sie uebernimmt.
app.post('/api/people/parse-contract', async (req, res) => {
  const { file_base64 } = req.body;
  if (!file_base64) return res.status(400).json({ error: 'file_base64 ist erforderlich' });

  let text;
  try {
    const { PDFParse } = require('pdf-parse');
    const buffer = Buffer.from(file_base64, 'base64');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    text = result.text;
    await parser.destroy();
  } catch (err) {
    return res.status(400).json({ error: 'PDF konnte nicht gelesen werden: ' + err.message });
  }

  const GERMAN_NUMBER_WORDS = {
    eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6,
    sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12,
  };
  function parseGermanNumber(str) {
    if (!str) return null;
    const digit = str.match(/\d+/);
    if (digit) return Number(digit[0]);
    const word = str.trim().toLowerCase();
    return GERMAN_NUMBER_WORDS[word] ?? null;
  }

  const weeklyMatch = text.match(/wöchentlichen\s+Dienstzeit\s+von\s+(\d+)\s*Stunden/i);
  const vacationMatch = text.match(/(\d+)\s*Tage\s+Urlaub\s+zu\s+gewähren/i);
  const probationMatch = text.match(/ersten\s+(\w+)\s+Wochen[\s\S]{0,40}?Probezeit/i);
  const periodMatch = text.match(/dauert\s+vom\s+(\d{2}\.\d{2}\.\d{4})\s+bis(?:\s+zum)?\s+(\d{2}\.\d{2}\.\d{4})/i);
  const seminarMatch = text.match(/insgesamt\s+(\d+)\s+Seminartage/i);

  const toIsoDate = (deDate) => {
    if (!deDate) return null;
    const [d, m, y] = deDate.split('.');
    return `${y}-${m}-${d}`;
  };

  const result = {
    weekly_hours: weeklyMatch ? Number(weeklyMatch[1]) : null,
    vacation_days: vacationMatch ? Number(vacationMatch[1]) : null,
    probation_weeks: probationMatch ? parseGermanNumber(probationMatch[1]) : null,
    contract_start: periodMatch ? toIsoDate(periodMatch[1]) : null,
    contract_end: periodMatch ? toIsoDate(periodMatch[2]) : null,
    seminar_days_total: seminarMatch ? Number(seminarMatch[1]) : null,
  };
  result.found_count = Object.values(result).filter(v => v !== null).length;
  // Wenn kaum Text extrahiert werden konnte, ist das PDF vermutlich ein Scan/Foto ohne
  // Textebene - dafuer braeuchte es OCR, was dieses Tool nicht mitbringt.
  result.likely_scanned = text.replace(/\s|--\s*\d+\s*of\s*\d+\s*--/g, '').length < 200;
  if (result.likely_scanned) {
    result.message = 'Diese PDF-Datei enthält keinen erkennbaren Text (vermutlich ein Scan oder Foto ohne Textebene). Automatisches Auslesen ist so nicht möglich - bitte die Werte manuell eintragen.';
  }

  res.json(result);
});

// ---------- Tasks ----------
app.get('/api/tasks', (req, res) => {
  res.json(allTasksWithAssignments());
});

app.post('/api/tasks', (req, res) => {
  const { title, description, estimated_minutes, person_ids, priority, due_date, due_time, project_id } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Titel ist erforderlich' });
  const info = db.prepare(`
    INSERT INTO tasks (title, description, estimated_minutes, priority, due_date, due_time, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title.trim(), description || null, estimated_minutes || 60, priority || 'mittel', due_date || null, due_time || null, project_id || null);
  const taskId = info.lastInsertRowid;
  if (Array.isArray(person_ids)) {
    const stmt = db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, person_id) VALUES (?, ?)');
    for (const pid of person_ids) stmt.run(taskId, pid);
  }
  res.status(201).json(getTaskWithAssignments(taskId));
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden' });
  const { title, description, estimated_minutes, status, person_ids, priority, due_date, due_time, clear_due_date, project_id, clear_project } = req.body;
  db.prepare(`
    UPDATE tasks SET title = ?, description = ?, estimated_minutes = ?, status = ?, priority = ?, due_date = ?, due_time = ?, project_id = ?
    WHERE id = ?
  `).run(
    title ?? existing.title,
    description ?? existing.description,
    estimated_minutes ?? existing.estimated_minutes,
    status ?? existing.status,
    priority ?? existing.priority,
    clear_due_date ? null : (due_date ?? existing.due_date),
    clear_due_date ? null : (due_time ?? existing.due_time),
    clear_project ? null : (project_id ?? existing.project_id),
    req.params.id
  );
  if (Array.isArray(person_ids)) {
    db.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(req.params.id);
    const stmt = db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, person_id) VALUES (?, ?)');
    for (const pid of person_ids) stmt.run(req.params.id, pid);
  }
  res.json(getTaskWithAssignments(req.params.id));
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Projekte ----------
app.get('/api/projects', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects ORDER BY name').all());
});

app.post('/api/projects', (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name ist erforderlich' });
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name.trim());
  if (existing) return res.status(409).json({ error: 'Projekt existiert bereits' });
  const info = db.prepare('INSERT INTO projects (name, color) VALUES (?, ?)').run(name.trim(), color || '#4f46e5');
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/projects/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  const { name, color } = req.body || {};
  db.prepare('UPDATE projects SET name = ?, color = ? WHERE id = ?')
    .run(name ?? existing.name, color ?? existing.color, req.params.id);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Schaetzt die Dauer einer (neuen) Aufgabe anhand frueher erfasster Zeiten aehnlicher Aufgaben
app.get('/api/tasks/estimate', (req, res) => {
  const title = (req.query.title || '').trim();
  const excludeId = req.query.exclude_id ? Number(req.query.exclude_id) : null;
  if (!title) return res.json({ suggested_minutes: null, based_on_count: 0, examples: [] });

  const rows = db.prepare(`
    SELECT t.id, t.title, COALESCE(SUM(te.duration_minutes), 0) AS actual_minutes
    FROM tasks t
    LEFT JOIN time_entries te ON te.task_id = t.id AND te.duration_minutes IS NOT NULL
    WHERE t.id != COALESCE(?, -1)
    GROUP BY t.id
    HAVING actual_minutes > 0
  `).all(excludeId);

  const queryTokens = tokenize(title);
  const scored = rows
    .map(r => ({ ...r, score: jaccardSimilarity(queryTokens, tokenize(r.title)) }))
    .filter(r => r.score >= 0.34)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return res.json({ suggested_minutes: null, based_on_count: 0, examples: [] });

  const top = scored.slice(0, 5);
  const suggested = Math.round(top.reduce((sum, r) => sum + r.actual_minutes, 0) / top.length / 5) * 5;

  res.json({
    suggested_minutes: suggested,
    based_on_count: top.length,
    examples: top.slice(0, 3).map(r => ({ title: r.title, minutes: r.actual_minutes })),
  });
});

// ---------- Calendar ----------
// Query params: from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/calendar', (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to) {
    rows = db.prepare(`
      SELECT ce.*, t.title AS task_title, t.status AS task_status, p.name AS person_name, p.color AS person_color
      FROM calendar_entries ce
      JOIN tasks t ON t.id = ce.task_id
      JOIN people p ON p.id = ce.person_id
      WHERE ce.date BETWEEN ? AND ?
      ORDER BY ce.date, ce.start_time
    `).all(from, to);
  } else {
    rows = db.prepare(`
      SELECT ce.*, t.title AS task_title, t.status AS task_status, p.name AS person_name, p.color AS person_color
      FROM calendar_entries ce
      JOIN tasks t ON t.id = ce.task_id
      JOIN people p ON p.id = ce.person_id
      ORDER BY ce.date, ce.start_time
    `).all();
  }
  res.json(rows);
});

app.post('/api/calendar', (req, res) => {
  const { task_id, person_id, date, start_time, end_time } = req.body;
  if (!task_id || !person_id || !date || !start_time || !end_time) {
    return res.status(400).json({ error: 'task_id, person_id, date, start_time und end_time sind erforderlich' });
  }
  const info = db.prepare(`
    INSERT INTO calendar_entries (task_id, person_id, date, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(task_id, person_id, date, start_time, end_time);
  const row = db.prepare(`
    SELECT ce.*, t.title AS task_title, t.status AS task_status, p.name AS person_name, p.color AS person_color
    FROM calendar_entries ce
    JOIN tasks t ON t.id = ce.task_id
    JOIN people p ON p.id = ce.person_id
    WHERE ce.id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json(row);
});

app.put('/api/calendar/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM calendar_entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Termin nicht gefunden' });
  const { date, start_time, end_time, person_id } = req.body;
  db.prepare('UPDATE calendar_entries SET date = ?, start_time = ?, end_time = ?, person_id = ? WHERE id = ?')
    .run(
      date ?? existing.date,
      start_time ?? existing.start_time,
      end_time ?? existing.end_time,
      person_id ?? existing.person_id,
      req.params.id
    );
  const row = db.prepare(`
    SELECT ce.*, t.title AS task_title, t.status AS task_status, p.name AS person_name, p.color AS person_color
    FROM calendar_entries ce
    JOIN tasks t ON t.id = ce.task_id
    JOIN people p ON p.id = ce.person_id
    WHERE ce.id = ?
  `).get(req.params.id);
  res.json(row);
});

app.delete('/api/calendar/:id', (req, res) => {
  db.prepare('DELETE FROM calendar_entries WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// iCal-Export der Planung im angegebenen Zeitraum
app.get('/api/calendar/export.ics', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from und to sind erforderlich' });

  const rows = db.prepare(`
    SELECT ce.*, t.title AS task_title, t.description AS task_description, p.name AS person_name
    FROM calendar_entries ce
    JOIN tasks t ON t.id = ce.task_id
    JOIN people p ON p.id = ce.person_id
    WHERE ce.date BETWEEN ? AND ?
    ORDER BY ce.date, ce.start_time
  `).all(from, to);

  const icsEscape = (s) => String(s || '').replace(/[\\,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const toIcsDateTime = (date, time) => `${date.replace(/-/g, '')}T${time.replace(/:/g, '').padEnd(6, '0')}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Buero-Aufgabenplaner//DE',
    'CALSCALE:GREGORIAN',
  ];
  rows.forEach(r => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:calendar-entry-${r.id}@office-task-tool`,
      `DTSTART:${toIcsDateTime(r.date, r.start_time)}`,
      `DTEND:${toIcsDateTime(r.date, r.end_time)}`,
      `SUMMARY:${icsEscape(r.task_title)} (${icsEscape(r.person_name)})`,
      r.task_description ? `DESCRIPTION:${icsEscape(r.task_description)}` : null,
      'END:VEVENT'
    );
  });
  lines.push('END:VCALENDAR');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kalender_${from}_${to}.ics"`);
  res.send(lines.filter(Boolean).join('\r\n'));
});

// ---------- Time entries (Zeiterfassung) ----------
app.get('/api/time-entries', enforceOwnPerson, (req, res) => {
  const { person_id, from, to } = req.query;
  let query = `
    SELECT te.*, p.name AS person_name, t.title AS task_title
    FROM time_entries te
    JOIN people p ON p.id = te.person_id
    LEFT JOIN tasks t ON t.id = te.task_id
    WHERE 1=1
  `;
  const params = [];
  if (person_id) { query += ' AND te.person_id = ?'; params.push(person_id); }
  if (from) { query += ' AND te.date >= ?'; params.push(from); }
  if (to) { query += ' AND te.date <= ?'; params.push(to); }
  query += ' ORDER BY te.date DESC, te.start_time DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/time-entries', enforceOwnPerson, (req, res) => {
  const { person_id, task_id, date, start_time, end_time, duration_minutes, break_start, break_end, break_minutes, note } = req.body;
  if (!person_id || !date) return res.status(400).json({ error: 'person_id und date sind erforderlich' });

  let breakMin = break_minutes || null;
  if (!breakMin && break_start && break_end) breakMin = computeMinutesBetween(break_start, break_end);

  let minutes = duration_minutes;
  if (!minutes && start_time && end_time) {
    minutes = computeMinutesBetween(start_time, end_time);
    if (breakMin) minutes = Math.max(0, minutes - breakMin);
  }

  const info = db.prepare(`
    INSERT INTO time_entries (person_id, task_id, date, start_time, end_time, duration_minutes, note, break_start, break_end, break_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    person_id, task_id || null, date, start_time || null, end_time || null,
    minutes || null, note || null, break_start || null, break_end || null, breakMin || null
  );

  recomputeDailyWarning(person_id, date);

  const row = db.prepare(`${timeEntryJoinSelect} WHERE te.id = ?`).get(info.lastInsertRowid);
  res.status(201).json(row);
});

app.put('/api/time-entries/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  if (req.session.personId && existing.person_id !== req.session.personId) {
    return res.status(403).json({ error: 'Nur eigene Zeiterfassung erlaubt' });
  }
  if (req.session.personId && req.body.person_id && +req.body.person_id !== req.session.personId) {
    return res.status(403).json({ error: 'Nur eigene Zeiterfassung erlaubt' });
  }
  if (existing.running) return res.status(400).json({ error: 'Laufende Zeiterfassung kann nicht bearbeitet werden, bitte zuerst stoppen' });

  const {
    person_id, task_id, date, start_time, end_time, duration_minutes,
    break_start, break_end, break_minutes, note, clear_task, clear_break,
  } = req.body;

  const newStart = start_time !== undefined ? (start_time || null) : existing.start_time;
  const newEnd = end_time !== undefined ? (end_time || null) : existing.end_time;
  const newBreakStart = clear_break ? null : (break_start !== undefined ? (break_start || null) : existing.break_start);
  const newBreakEnd = clear_break ? null : (break_end !== undefined ? (break_end || null) : existing.break_end);

  let breakMin = clear_break ? null : (break_minutes !== undefined ? break_minutes : null);
  if (!breakMin && newBreakStart && newBreakEnd) breakMin = computeMinutesBetween(newBreakStart, newBreakEnd);

  let minutes = duration_minutes;
  if (minutes === undefined) {
    if (newStart && newEnd) {
      minutes = computeMinutesBetween(newStart, newEnd);
      if (breakMin) minutes = Math.max(0, minutes - breakMin);
    } else {
      minutes = existing.duration_minutes;
    }
  }

  const newPersonId = person_id ?? existing.person_id;
  const newDate = date ?? existing.date;

  db.prepare(`
    UPDATE time_entries SET person_id = ?, task_id = ?, date = ?, start_time = ?, end_time = ?,
      duration_minutes = ?, note = ?, break_start = ?, break_end = ?, break_minutes = ?
    WHERE id = ?
  `).run(
    newPersonId,
    clear_task ? null : (task_id !== undefined ? (task_id || null) : existing.task_id),
    newDate,
    newStart,
    newEnd,
    minutes ?? null,
    note !== undefined ? note : existing.note,
    newBreakStart,
    newBreakEnd,
    breakMin || null,
    req.params.id
  );

  recomputeDailyWarning(existing.person_id, existing.date);
  if (newPersonId !== existing.person_id || newDate !== existing.date) {
    recomputeDailyWarning(newPersonId, newDate);
  }

  res.json(db.prepare(`${timeEntryJoinSelect} WHERE te.id = ?`).get(req.params.id));
});

app.delete('/api/time-entries/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
  if (req.session.personId && existing && existing.person_id !== req.session.personId) {
    return res.status(403).json({ error: 'Nur eigene Zeiterfassung erlaubt' });
  }
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.id);
  if (existing) recomputeDailyWarning(existing.person_id, existing.date);
  res.status(204).end();
});

// ---------- Start/Stopp-Zeiterfassung pro Aufgabe ----------
app.get('/api/time-entries/active', (req, res) => {
  const rows = req.session.personId
    ? db.prepare(`${timeEntryJoinSelect} WHERE te.running = 1 AND te.person_id = ? ORDER BY te.start_time`).all(req.session.personId)
    : db.prepare(`${timeEntryJoinSelect} WHERE te.running = 1 ORDER BY te.start_time`).all();
  res.json(rows);
});

app.post('/api/time-entries/start', enforceOwnPerson, (req, res) => {
  const { person_id, task_id } = req.body;
  if (!person_id || !task_id) return res.status(400).json({ error: 'person_id und task_id sind erforderlich' });

  const now = new Date();
  autoStopRunningForPerson(person_id, now);

  const info = db.prepare(`
    INSERT INTO time_entries (person_id, task_id, date, start_time, running)
    VALUES (?, ?, ?, ?, 1)
  `).run(person_id, task_id, isoDateLocal(now), formatHMS(now));

  res.status(201).json(db.prepare(`${timeEntryJoinSelect} WHERE te.id = ?`).get(info.lastInsertRowid));
});

// Schnellstart: legt im Hintergrund eine minimale Aufgabe an und startet direkt die Zeiterfassung dafuer.
// Details (Titel, Beschreibung, Priorität, ...) koennen danach im Aufgaben-Tab nachgetragen werden.
app.post('/api/time-entries/quick-start', enforceOwnPerson, (req, res) => {
  const { person_id, title } = req.body;
  if (!person_id) return res.status(400).json({ error: 'person_id ist erforderlich' });

  const now = new Date();
  const taskTitle = (title && title.trim()) || `Schnellerfasst ${isoDateLocal(now)} ${formatHMS(now).slice(0, 5)}`;

  const taskInfo = db.prepare(`
    INSERT INTO tasks (title, estimated_minutes, status, priority)
    VALUES (?, NULL, 'offen', 'mittel')
  `).run(taskTitle);
  const taskId = taskInfo.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, person_id) VALUES (?, ?)').run(taskId, person_id);

  autoStopRunningForPerson(person_id, now);

  const entryInfo = db.prepare(`
    INSERT INTO time_entries (person_id, task_id, date, start_time, running)
    VALUES (?, ?, ?, ?, 1)
  `).run(person_id, taskId, isoDateLocal(now), formatHMS(now));

  res.status(201).json({
    task: getTaskWithAssignments(taskId),
    entry: db.prepare(`${timeEntryJoinSelect} WHERE te.id = ?`).get(entryInfo.lastInsertRowid),
  });
});

app.post('/api/time-entries/:id/stop', (req, res) => {
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  if (req.session.personId && entry.person_id !== req.session.personId) {
    return res.status(403).json({ error: 'Nur eigene Zeiterfassung erlaubt' });
  }
  if (!entry.running) return res.status(400).json({ error: 'Dieser Eintrag laeuft nicht' });

  const now = new Date();
  const durationMin = computeMinutesBetween(entry.start_time, formatHMS(now));
  db.prepare('UPDATE time_entries SET end_time = ?, duration_minutes = ?, running = 0 WHERE id = ?')
    .run(formatHMS(now), durationMin, req.params.id);
  recomputeDailyWarning(entry.person_id, entry.date);

  res.json(db.prepare(`${timeEntryJoinSelect} WHERE te.id = ?`).get(req.params.id));
});

// CSV-Export der Zeiterfassung, z.B. fuer die Lohnabrechnung
app.get('/api/time-entries/export.csv', enforceOwnPerson, (req, res) => {
  const { person_id, from, to } = req.query;
  let query = `
    SELECT te.date, p.name AS person_name, te.start_time, te.end_time, te.break_minutes, te.duration_minutes, t.title AS task_title, te.note
    FROM time_entries te
    JOIN people p ON p.id = te.person_id
    LEFT JOIN tasks t ON t.id = te.task_id
    WHERE te.duration_minutes IS NOT NULL
  `;
  const params = [];
  if (person_id) { query += ' AND te.person_id = ?'; params.push(person_id); }
  if (from) { query += ' AND te.date >= ?'; params.push(from); }
  if (to) { query += ' AND te.date <= ?'; params.push(to); }
  query += ' ORDER BY te.date, p.name';
  const rows = db.prepare(query).all(...params);

  const csvEscape = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Datum', 'Person', 'Start', 'Ende', 'Pause (Min)', 'Dauer (Min)', 'Aufgabe', 'Notiz'];
  const lines = [header.join(';')];
  rows.forEach(r => {
    lines.push([
      r.date, r.person_name, r.start_time || '', r.end_time || '', r.break_minutes ?? '',
      r.duration_minutes ?? '', r.task_title || '', r.note || '',
    ].map(csvEscape).join(';'));
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="zeiterfassung_${from || 'alle'}_${to || 'alle'}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n')); // BOM fuer korrekte Umlaute in Excel
});

// ---------- Warnungen (Tageshöchstarbeitszeit überschritten) ----------
app.get('/api/warnings', (req, res) => {
  const { person_id, from, to } = req.query;
  let query = `
    SELECT w.*, p.name AS person_name FROM work_time_warnings w
    JOIN people p ON p.id = w.person_id
    WHERE 1=1
  `;
  const params = [];
  if (person_id) { query += ' AND w.person_id = ?'; params.push(person_id); }
  if (from) { query += ' AND w.date >= ?'; params.push(from); }
  if (to) { query += ' AND w.date <= ?'; params.push(to); }
  query += ' ORDER BY w.date DESC';
  res.json({ daily_max_minutes: DAILY_MAX_MINUTES, warnings: db.prepare(query).all(...params) });
});

// ---------- Wochenreport (Soll vs. Ist) ----------
app.get('/api/reports/week', (req, res) => {
  const refDate = req.query.date ? new Date(req.query.date) : new Date();
  const day = refDate.getDay();
  const monday = new Date(refDate);
  monday.setDate(refDate.getDate() + ((day === 0 ? -6 : 1) - day));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const from = isoDateLocal(monday);
  const to = isoDateLocal(sunday);

  const people = (req.session.personId
    ? db.prepare('SELECT * FROM people WHERE active = 1 AND id = ? ORDER BY name').all(req.session.personId)
    : db.prepare('SELECT * FROM people WHERE active = 1 ORDER BY name').all()
  );
  const actualStmt = db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) AS m
    FROM time_entries
    WHERE person_id = ? AND date BETWEEN ? AND ? AND duration_minutes IS NOT NULL
  `);

  const report = people.map(p => {
    const isBfd = p.contract_type === 'BFD';
    let actual = actualStmt.get(p.id, from, to).m + seminarCreditMinutes(p.id, from, to);
    if (isBfd) {
      actual += weekendHolidayBonusMinutes(p.id, from, to);
      actual -= timeOffCompensationMinutes(p.id, from, to);
    }
    const diff = p.weekly_target_minutes ? actual - p.weekly_target_minutes : null;
    return {
      person_id: p.id,
      person_name: p.name,
      target_minutes: p.weekly_target_minutes || null,
      actual_minutes: actual,
      diff_minutes: diff,
      bfd_warning: isBfd ? bfdThresholdWarning(diff) : null,
    };
  });

  res.json({ from, to, report });
});

// Kumulierte Ueber-/Unterstunden ueber die gesamte bisher erfasste Zeit einer Person
// (seit dem ersten erfassten Zeiteintrag bis heute, inkl. Seminar-Gutschrift).
app.get('/api/reports/lifetime', (req, res) => {
  const personId = req.query.person_id;
  if (!personId) return res.status(400).json({ error: 'person_id ist erforderlich' });
  if (req.session.personId && +personId !== req.session.personId) {
    return res.status(403).json({ error: 'Nur eigene Zeiterfassung erlaubt' });
  }
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return res.status(404).json({ error: 'Person nicht gefunden' });
  if (!person.weekly_target_minutes) return res.json({ available: false });

  const firstRow = db.prepare(`
    SELECT MIN(date) AS d FROM time_entries WHERE person_id = ? AND duration_minutes IS NOT NULL
  `).get(personId);
  if (!firstRow.d) return res.json({ available: false });

  const totalActual = db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) AS m FROM time_entries WHERE person_id = ? AND duration_minutes IS NOT NULL
  `).get(personId).m;

  const firstMonday = getMondayOf(new Date(firstRow.d));
  const currentMonday = getMondayOf(new Date());
  const weeksCounted = Math.round((currentMonday - firstMonday) / (7 * 24 * 60 * 60 * 1000)) + 1;
  const rangeFrom = isoDateLocal(firstMonday);
  const rangeTo = isoDateLocal(new Date());
  const isBfd = person.contract_type === 'BFD';

  let totalActualWithCredit = totalActual + seminarCreditMinutes(personId, rangeFrom, rangeTo);
  if (isBfd) {
    totalActualWithCredit += weekendHolidayBonusMinutes(personId, rangeFrom, rangeTo);
    totalActualWithCredit -= timeOffCompensationMinutes(personId, rangeFrom, rangeTo);
  }
  const totalTarget = weeksCounted * person.weekly_target_minutes;
  const diff = totalActualWithCredit - totalTarget;

  res.json({
    available: true,
    total_actual_minutes: totalActualWithCredit,
    total_target_minutes: totalTarget,
    diff_minutes: diff,
    weeks_counted: weeksCounted,
    first_date: firstRow.d,
    bfd_warning: isBfd ? bfdThresholdWarning(diff) : null,
  });
});

// ---------- Freizeitausgleich (genommene Ausgleichszeit fuer Ueberstunden) ----------
app.get('/api/time-off', (req, res) => {
  const { person_id, from, to } = req.query;
  let query = `
    SELECT t.*, p.name AS person_name FROM time_off_compensation t
    JOIN people p ON p.id = t.person_id
    WHERE 1=1
  `;
  const params = [];
  if (person_id) { query += ' AND t.person_id = ?'; params.push(person_id); }
  if (from) { query += ' AND t.date >= ?'; params.push(from); }
  if (to) { query += ' AND t.date <= ?'; params.push(to); }
  query += ' ORDER BY t.date DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/time-off', (req, res) => {
  const { person_id, date, minutes, note } = req.body;
  if (!person_id || !date || !minutes) {
    return res.status(400).json({ error: 'person_id, date und minutes sind erforderlich' });
  }
  const info = db.prepare('INSERT INTO time_off_compensation (person_id, date, minutes, note) VALUES (?, ?, ?, ?)')
    .run(person_id, date, minutes, note || null);
  res.status(201).json(db.prepare(`
    SELECT t.*, p.name AS person_name FROM time_off_compensation t JOIN people p ON p.id = t.person_id WHERE t.id = ?
  `).get(info.lastInsertRowid));
});

app.delete('/api/time-off/:id', (req, res) => {
  db.prepare('DELETE FROM time_off_compensation WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Abwesenheiten ----------
app.get('/api/absences', (req, res) => {
  const { person_id, from, to } = req.query;
  let query = `
    SELECT a.*, p.name AS person_name, p.color AS person_color
    FROM absences a
    JOIN people p ON p.id = a.person_id
    WHERE 1=1
  `;
  const params = [];
  if (person_id) { query += ' AND a.person_id = ?'; params.push(person_id); }
  if (from) { query += ' AND a.date_to >= ?'; params.push(from); }
  if (to) { query += ' AND a.date_from <= ?'; params.push(to); }
  query += ' ORDER BY a.date_from DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/absences', (req, res) => {
  const { person_id, date_from, date_to, type, note } = req.body;
  if (!person_id || !date_from || !date_to) {
    return res.status(400).json({ error: 'person_id, date_from und date_to sind erforderlich' });
  }
  const info = db.prepare(`
    INSERT INTO absences (person_id, date_from, date_to, type, note) VALUES (?, ?, ?, ?, ?)
  `).run(person_id, date_from, date_to, type || 'Urlaub', note || null);
  res.status(201).json(db.prepare(`
    SELECT a.*, p.name AS person_name, p.color AS person_color FROM absences a JOIN people p ON p.id = a.person_id WHERE a.id = ?
  `).get(info.lastInsertRowid));
});

app.delete('/api/absences/:id', (req, res) => {
  db.prepare('DELETE FROM absences WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Faellige-Aufgaben-Erinnerung (E-Mail) ----------
app.post('/api/reminders/run', async (req, res) => {
  try {
    const results = await runReminderCheck();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Taeglich um 07:30 Uhr auf faellige Aufgaben pruefen und E-Mails verschicken
cron.schedule('30 7 * * *', () => {
  runReminderCheck().catch(err => console.error('[Erinnerung] Fehler beim geplanten Lauf:', err.message));
}, { timezone: 'Europe/Berlin' });

// ---------- Dropbox-Backup der Datenbank ----------
app.get('/api/backup/status', (req, res) => {
  res.json({ configured: isBackupConfigured(), last_backup: getLastBackup() });
});

app.post('/api/backup/run', async (req, res) => {
  const result = await runBackup();
  res.json(result);
});

// Taeglich um 03:00 Uhr sichern
cron.schedule('0 3 * * *', () => {
  runBackup().catch(err => console.error('[Backup] Fehler beim geplanten Lauf:', err.message));
}, { timezone: 'Europe/Berlin' });

// Einmalig kurz nach dem Start sichern (deckt u.a. Deploys/Updates ab, da diese einen Neustart ausloesen)
setTimeout(() => {
  runBackup().catch(err => console.error('[Backup] Fehler beim Start-Backup:', err.message));
}, 15000);

app.listen(PORT, () => {
  console.log(`Office Task Tool laeuft auf Port ${PORT}`);
});
