// ================= DIKTAT: AUFGABEN PER SPRACHE =================
// Handy-Seite /diktat (als App auf den Home-Bildschirm) und Siri-Kurzbefehl: Ein diktierter
// Satz wird von Claude in eine oder mehrere Aufgaben zerlegt (Titel, Faelligkeit, Prioritaet,
// Projekt, Personen). Die Seite zeigt eine Vorschau zum Korrigieren, der Kurzbefehl legt direkt an.
// Projekt- und Personennamen loest immer der Server auf - die KI waehlt nur aus den Listen.

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const MODEL = 'claude-opus-5-5';
const PRIORITIES = ['hoch', 'mittel', 'niedrig'];
const MAX_TEXT = 4000;
const nullable = type => ({ type: [type, 'null'] });

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: nullable('string'),
          due_date: nullable('string'),
          due_time: nullable('string'),
          priority: { type: 'string', enum: PRIORITIES },
          project: nullable('string'),
          persons: { type: 'array', items: { type: 'string' } },
          estimated_minutes: nullable('integer'),
        },
        required: ['title', 'description', 'due_date', 'due_time', 'priority', 'project', 'persons', 'estimated_minutes'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Die KI ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).');
  if (!client) client = new Anthropic.default({ timeout: 2 * 60 * 1000 });
  return client;
}

function berlinToday() {
  const now = new Date();
  const iso = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now);
  const label = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  return { iso, label };
}

function lists() {
  const projects = db.prepare('SELECT id, name FROM projects ORDER BY name').all();
  const people = db.prepare('SELECT id, name, short_code FROM people WHERE active = 1 ORDER BY name').all();
  return { projects, people };
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function matchProject(name, projects) {
  const n = norm(name);
  if (!n) return null;
  const hit = projects.find(p => norm(p.name) === n) || projects.find(p => norm(p.name).includes(n) || n.includes(norm(p.name)));
  return hit ? hit.id : null;
}

function matchPerson(name, people) {
  const n = norm(name);
  if (!n) return null;
  const hit = people.find(p => norm(p.name) === n)
    || people.find(p => p.short_code && norm(p.short_code) === n)
    || people.find(p => norm(p.name).startsWith(n))
    || people.find(p => String(p.name).toLowerCase().split(/\s+/).some(part => norm(part) === n));
  return hit ? hit.id : null;
}

const validDate = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d)) ? d : null);
const validTime = t => (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null);

async function parseDictation(text, selfPersonId) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error('Es wurde nichts diktiert.');
  const { projects, people } = lists();
  const today = berlinToday();
  const self = people.find(p => p.id === selfPersonId);

  const system = `Du verwandelst diktierte Notizen in Aufgaben für den Büro-Aufgabenplaner eines Kulturvereins.
Heute ist ${today.label} (${today.iso}), Zeitzone Europa/Berlin.
Regeln:
- Meist ist es eine Aufgabe. Nur wenn klar mehrere verschiedene Dinge genannt werden ("und außerdem", Aufzählung), lege mehrere an.
- title: kurz und klar als Tätigkeit formuliert (z. B. "Plakatierungsantrag Weihnachtsmarkt abgeben"), ohne Datum, Person oder Füllwörter wie "ich muss". Rechtschreibung und Diktierfehler korrigieren.
- description: nur wenn das Diktat zusätzliche Einzelheiten enthält, sonst null.
- due_date als YYYY-MM-DD. Relative Angaben ("morgen", "Freitag", "nächste Woche" = Montag der nächsten Woche, "Ende des Monats") vom heutigen Datum aus auflösen. Wochentage meinen immer den nächsten kommenden, nie heute. Ohne Zeitangabe null.
- due_time als HH:MM nur bei genannter Uhrzeit, sonst null.
- priority: "hoch" bei dringend/wichtig/sofort/asap, "niedrig" bei irgendwann/kein Stress, sonst "mittel".
- project: nur ein Name exakt aus dieser Liste, wenn er genannt oder eindeutig gemeint ist, sonst null: ${projects.map(p => p.name).join(' | ') || '(keine Projekte)'}.
- persons: Namen exakt aus dieser Liste, wenn die Aufgabe ausdrücklich jemandem zugewiesen wird ("für Anna", "Anna soll"): ${people.map(p => p.name + (p.short_code ? ` (${p.short_code})` : '')).join(' | ') || '(keine Personen)'}. ${self ? `"ich", "mir", "mich" ist ${self.name}.` : ''} Sonst leere Liste.
- estimated_minutes nur, wenn eine Dauer genannt wird, sonst null.`;

  const response = await getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PARSE_SCHEMA } },
    system,
    messages: [{ role: 'user', content: clean }],
  }).finalMessage();

  if (response.stop_reason === 'refusal') throw new Error('Die KI hat die Auswertung abgelehnt.');
  const block = response.content.find(b => b.type === 'text');
  if (!block) throw new Error('Die KI hat kein Ergebnis geliefert.');
  const out = JSON.parse(block.text);

  const tasks = (out.tasks || []).filter(t => t && String(t.title || '').trim()).slice(0, 10).map(t => {
    const personIds = [...new Set((t.persons || []).map(n => matchPerson(n, people)).filter(Boolean))];
    return {
      title: String(t.title).trim().slice(0, 200),
      description: t.description ? String(t.description).trim() : null,
      due_date: validDate(t.due_date),
      due_time: validTime(t.due_time),
      priority: PRIORITIES.includes(t.priority) ? t.priority : 'mittel',
      project_id: matchProject(t.project, projects),
      // Ohne genannte Person landet die Aufgabe bei der diktierenden Person
      person_ids: personIds.length ? personIds : (selfPersonId ? [selfPersonId] : []),
      estimated_minutes: Number.isInteger(t.estimated_minutes) && t.estimated_minutes > 0 ? Math.min(t.estimated_minutes, 24 * 60) : null,
    };
  });
  if (!tasks.length) throw new Error('Aus dem Diktat ließ sich keine Aufgabe erkennen.');
  return { tasks, projects, people };
}

function createTask(t) {
  const info = db.prepare(`
    INSERT INTO tasks (title, description, estimated_minutes, priority, due_date, due_time, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(t.title, t.description || null, t.estimated_minutes || 60, t.priority || 'mittel', t.due_date || null, t.due_time || null, t.project_id || null);
  const assign = db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, person_id) VALUES (?, ?)');
  for (const pid of t.person_ids || []) assign.run(info.lastInsertRowid, pid);
  return info.lastInsertRowid;
}

function spokenSummary(tasks, projects, people) {
  const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
  return tasks.map(t => {
    const parts = [t.title];
    if (t.due_date) parts.push('fällig ' + fmt(t.due_date) + (t.due_time ? ' ' + t.due_time + ' Uhr' : ''));
    const project = projects.find(p => p.id === t.project_id);
    if (project) parts.push('Projekt ' + project.name);
    const names = t.person_ids.map(id => (people.find(p => p.id === id) || {}).name).filter(Boolean);
    if (names.length) parts.push('für ' + names.join(', '));
    if (t.priority === 'hoch') parts.push('dringend');
    return parts.join(', ');
  }).join('. ');
}

function register(app) {
  app.get('/diktat', (req, res) => {
    res.sendFile(require('path').join(__dirname, 'public', 'diktat.html'));
  });

  // Diktat auswerten (Vorschau, noch nichts gespeichert)
  app.post('/api/diktat/parse', async (req, res) => {
    try {
      const { tasks } = await parseDictation(req.body.text, req.personId);
      res.json({ tasks });
    } catch (err) {
      console.error('Diktat:', err.message);
      res.status(err.status ? 502 : 400).json({ error: err.status ? 'Die KI ist gerade nicht erreichbar – bitte gleich nochmal versuchen.' : err.message });
    }
  });

  // Persoenlicher Schluessel fuer den Siri-Kurzbefehl
  app.get('/api/diktat/token', (req, res) => {
    res.json({ token: req.user.diktat_token || null });
  });
  app.post('/api/diktat/token', (req, res) => {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE app_users SET diktat_token = ? WHERE id = ?').run(token, req.user.id);
    res.json({ token });
  });

  // Siri-Kurzbefehl: Text rein, Aufgabe(n) direkt anlegen, gesprochene Bestaetigung zurueck.
  // Oeffentlich erreichbar (siehe PUBLIC_PATHS), geschuetzt durch den persoenlichen Schluessel.
  app.post('/api/diktat/siri', async (req, res) => {
    const auth = String(req.get('authorization') || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.body.token || '');
    const user = /^[a-f0-9]{48}$/.test(token) ? db.prepare('SELECT * FROM app_users WHERE diktat_token = ?').get(token) : null;
    if (!user) return res.status(401).type('text').send('Der Schlüssel des Kurzbefehls ist ungültig. Bitte in der Diktat-App neu einrichten.');
    try {
      const { tasks, projects, people } = await parseDictation(req.body.text, user.person_id || null);
      tasks.forEach(createTask);
      res.type('text').send((tasks.length > 1 ? `${tasks.length} Aufgaben angelegt: ` : 'Angelegt: ') + spokenSummary(tasks, projects, people));
    } catch (err) {
      console.error('Diktat (Siri):', err.message);
      res.status(err.status ? 502 : 400).type('text').send(err.status ? 'Die KI ist gerade nicht erreichbar. Bitte gleich nochmal versuchen.' : err.message);
    }
  });
}

module.exports = { register, parseDictation };
