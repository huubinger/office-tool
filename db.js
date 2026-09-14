const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Auf Railway kann per Volume ein persistenter Pfad gesetzt werden, z.B. /data
const dbDir = process.env.DB_DIR && process.env.DB_DIR.trim() ? process.env.DB_DIR.trim() : __dirname;
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const dbPath = process.env.DB_PATH || path.join(dbDir, 'data.db');

// Sehr sichtbare Warnung, falls im Produktivbetrieb kein DB_DIR gesetzt ist: ohne echtes
// Volume dahinter wird die Datenbank sonst bei jedem Deploy/Neustart stillschweigend
// zurueckgesetzt, da der App-Ordner selbst nicht dauerhaft ist.
if (process.env.NODE_ENV === 'production' && (!process.env.DB_DIR || !process.env.DB_DIR.trim())) {
  console.warn(
    '\n' + '!'.repeat(70) + '\n' +
    '! WARNUNG: DB_DIR ist nicht gesetzt (Produktivbetrieb)!\n' +
    '! Die Datenbank liegt dadurch im Anwendungsordner, NICHT auf einem\n' +
    '! dauerhaften Volume - bei jedem Deploy/Neustart gehen alle Daten\n' +
    '! (Personen, Aufgaben, Zeiterfassungen) verloren!\n' +
    '! Bitte DB_DIR (z.B. "/data") als Umgebungsvariable setzen und ein\n' +
    '! Volume auf diesen Pfad mounten.\n' +
    '!'.repeat(70) + '\n'
  );
}
console.log(`[DB] Verwende Datenbankpfad: ${dbPath}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT,
  color TEXT DEFAULT '#4f46e5',
  active INTEGER DEFAULT 1,
  email TEXT,
  pin_hash TEXT,
  weekly_target_minutes INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#4f46e5',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  estimated_minutes INTEGER DEFAULT 60,
  status TEXT DEFAULT 'offen',
  priority TEXT DEFAULT 'mittel',
  due_date TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  UNIQUE(task_id, person_id)
);

CREATE TABLE IF NOT EXISTS calendar_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  duration_minutes INTEGER,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  type TEXT DEFAULT 'Urlaub',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_time_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(person_id, date)
);

CREATE TABLE IF NOT EXISTS app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT DEFAULT (datetime('now')),
  success INTEGER NOT NULL,
  message TEXT
);

CREATE TABLE IF NOT EXISTS time_off_compensation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_date ON calendar_entries(date);
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(date);
CREATE INDEX IF NOT EXISTS idx_time_entries_person ON time_entries(person_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_absences_person ON absences(person_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_warnings_person_date ON work_time_warnings(person_id, date);
`);

// ---- Migrationen: neue Spalten per PRAGMA-Check ergaenzen ----
// (SQLite kennt kein ALTER TABLE ... ADD COLUMN IF NOT EXISTS)
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('time_entries', 'running', 'INTEGER DEFAULT 0');
ensureColumn('tasks', 'priority', "TEXT DEFAULT 'mittel'");
ensureColumn('tasks', 'due_date', 'TEXT');
ensureColumn('people', 'email', 'TEXT');
ensureColumn('people', 'pin_hash', 'TEXT');
ensureColumn('people', 'weekly_target_minutes', 'INTEGER');
ensureColumn('time_entries', 'break_start', 'TEXT');
ensureColumn('time_entries', 'break_end', 'TEXT');
ensureColumn('time_entries', 'break_minutes', 'INTEGER');
ensureColumn('people', 'contract_type', 'TEXT');
ensureColumn('people', 'vacation_days_total', 'INTEGER');
ensureColumn('people', 'probation_weeks', 'INTEGER');
ensureColumn('people', 'contract_start', 'TEXT');
ensureColumn('people', 'contract_end', 'TEXT');
ensureColumn('people', 'seminar_days_total', 'INTEGER');
ensureColumn('tasks', 'due_time', 'TEXT');
ensureColumn('tasks', 'project_id', 'INTEGER REFERENCES projects(id)');
ensureColumn('tasks', 'start_date', 'TEXT');
ensureColumn('app_users', 'person_id', 'INTEGER REFERENCES people(id)');

// ---- Erstbenutzer anlegen bzw. mit gesetzten Umgebungsvariablen synchronisieren ----
// Sind ADMIN_USERNAME und ADMIN_PASSWORD gesetzt, werden sie bei JEDEM Start durchgesetzt
// (legt das Konto an, falls es fehlt, oder aktualisiert das Passwort, falls es sich geaendert hat).
// So wirkt eine Passwortaenderung in Railway/den Umgebungsvariablen zuverlaessig nach einem Redeploy,
// auch wenn zuvor schon ein Konto mit dem Standardpasswort angelegt wurde.
const userCount = db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c;
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  const bcrypt = require('bcryptjs');
  const username = process.env.ADMIN_USERNAME;
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
  const existing = db.prepare('SELECT * FROM app_users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE app_users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  } else {
    db.prepare('INSERT INTO app_users (username, password_hash) VALUES (?, ?)').run(username, hash);
  }
} else if (userCount === 0) {
  const bcrypt = require('bcryptjs');
  const username = 'admin';
  const password = 'changeme128';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO app_users (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.warn(
    `\n[Hinweis] Kein ADMIN_USERNAME/ADMIN_PASSWORD gesetzt - Standard-Login angelegt: Benutzername "${username}", Passwort "${password}".\n` +
    `Bitte vor dem Online-Gehen unbedingt ADMIN_USERNAME/ADMIN_PASSWORD als Umgebungsvariablen setzen.\n`
  );
}

module.exports = db;
module.exports.dbPath = dbPath;
