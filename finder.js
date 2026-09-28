// ================= FINDER (Kreatief) =================
// Fördergeld-, Pressekontakt- und Sponsoren-Finder: auf Knopfdruck durchsucht Claude mit der
// Websuche das Internet und liefert eine strukturierte Liste, die hier gespeichert wird.
// Eine Suche dauert gut ein bis drei Minuten und laeuft deshalb im Hintergrund; das Frontend
// fragt den Stand per GET /api/finder/searches/:id ab.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const MODEL = 'claude-opus-5';
const KINDS = ['foerder', 'presse', 'sponsor'];
const STATUSES = ['new', 'interesting', 'contacted', 'success', 'declined'];
const MAX_CONTINUATIONS = 6;

const VEREIN = 'Kreatief – Kultur im Unterland e.V., Marktstraße 42, 74172 Neckarsulm (Landkreis Heilbronn, Baden-Württemberg). '
  + 'Gemeinnütziger Kulturverein: Konzerte und Veranstaltungen im eigenen Kulturkeller, Konzertprojekte ("Neckarsulmer Konzerte"), '
  + 'Herausgeber des Neckarsulmer Kulturkalenders; getragen von Ehrenamtlichen.';

db.exec(`
CREATE TABLE IF NOT EXISTS finder_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT,
  error TEXT,
  result_count INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS finder_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER REFERENCES finder_searches(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  description TEXT,
  reason TEXT,
  amount TEXT,
  deadline TEXT,
  location TEXT,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  other_contact TEXT,
  website TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_finder_results_kind ON finder_results(kind);
CREATE INDEX IF NOT EXISTS idx_finder_results_search ON finder_results(search_id);
`);

// Suchen, die bei einem Neustart/Deploy mitten drin abgebrochen wurden, sauber beenden
db.prepare(`UPDATE finder_searches SET status = 'error', error = 'Suche wurde durch einen Neustart des Servers abgebrochen – bitte neu starten.', finished_at = datetime('now') WHERE status = 'running'`).run();

const RESULT_FIELDS = ['name', 'type', 'description', 'reason', 'amount', 'deadline', 'location',
  'contact_person', 'email', 'phone', 'other_contact', 'website', 'source_url'];

const SAVE_TOOL = {
  name: 'ergebnisse_speichern',
  description: 'Speichert die fertige Ergebnisliste. Genau einmal am Ende der Recherche aufrufen.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Zwei bis vier Sätze Fazit zur Recherche (was gefunden wurde, Tipps zum Vorgehen).' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: Object.fromEntries(RESULT_FIELDS.map(f => [f, { type: 'string' }])),
          required: RESULT_FIELDS,
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'results'],
    additionalProperties: false,
  },
};

const FIELD_GUIDE = `Felder je Eintrag (unbekannt = leerer String, nichts erfinden):
- name, type, description, reason, amount, deadline, location: siehe Aufgabe
- contact_person: Ansprechpartner/in mit Funktion, falls öffentlich genannt
- email: E-Mail-Adresse genau wie auf der Quelle angegeben (mehrere mit Komma trennen)
- phone: Telefonnummer
- other_contact: weitere Kontaktwege (Webformular-URL, Link zum Veranstaltungs-Eintrag, Instagram/Facebook …)
- website: Hauptseite der Organisation bzw. des Programms
- source_url: Seite, auf der die Angaben stehen (Beleg)`;

function buildPrompt(kind, p, knownNames) {
  const known = knownNames.length
    ? `\n\nDiese Einträge stehen schon in unserer Liste – nimm sie nicht noch einmal auf, such stattdessen weitere:\n${knownNames.map(n => `- ${n}`).join('\n')}`
    : '';
  const extra = p.notes ? `\n\nZusätzliche Hinweise von uns: ${p.notes}` : '';

  if (kind === 'foerder') {
    return `Wir sind: ${VEREIN}

Aufgabe: Recherchiere aktuelle Fördermöglichkeiten für uns in der Förderrichtung „${p.category}“. Berücksichtige alle Ebenen: Stadt Neckarsulm, Landkreis Heilbronn, Region, Land Baden-Württemberg (z.B. Ministerien, Landesverbände), Bund (z.B. Förderprogramme für Musik, Soziokultur), EU sowie Stiftungen und Förderfonds von Banken, Sparkassen, Unternehmen und Verbänden. Nur Programme, auf die sich ein gemeinnütziger Verein wie wir tatsächlich bewerben kann und die aktuell laufen oder wiederkehrend ausgeschrieben werden. Prüfe Fristen auf der offiziellen Seite. Ziel: 8 bis 20 gute Treffer, die besten zuerst.

Bedeutung der Felder hier:
- name: Name des Förderprogramms
- type: Fördergeber (Institution) und Ebene, z.B. „Land BW – Ministerium für Wissenschaft, Forschung und Kunst“
- description: was gefördert wird, Bedingungen (Eigenanteil etc.) in 1–3 Sätzen
- reason: warum es zu uns passt
- amount: Förderhöhe/-quote
- deadline: Antragsfrist bzw. „laufend“ / „jährlich zum …“
- location: Reichweite/Gebiet
${FIELD_GUIDE}${extra}${known}`;
  }

  if (kind === 'presse') {
    return `Wir sind: ${VEREIN}

Aufgabe: Wir planen eine Aufführung in „${p.place}“. Finde alle Möglichkeiten, im Umkreis von ${p.radius} km um diesen Ort dafür Werbung zu machen bzw. Presse zu bekommen: Tageszeitungen und Lokalredaktionen, Anzeigen-/Wochenblätter, Amts- und Gemeindeblätter, Lokalradio und regionales Fernsehen, Stadt- und Kulturmagazine, Online-Veranstaltungskalender und Kulturportale (auch zum Selbst-Eintragen), Stadtmarketing/Tourist-Info, Plakatierungsmöglichkeiten sowie relevante Blogs/Social-Media-Kanäle. Bei Zeitungen möglichst die zuständige Lokal- oder Kulturredaktion mit direkter Redaktions-E-Mail. Ziel: 15 bis 30 Kontakte, die wichtigsten zuerst.

Bedeutung der Felder hier:
- name: Name des Mediums/Angebots (bei Zeitungen inkl. Lokalredaktion)
- type: Art, z.B. „Tageszeitung“, „Amtsblatt“, „Lokalradio“, „Online-Kalender“, „Stadtmagazin“, „Plakatierung“
- description: was man dort platzieren kann (Pressemitteilung, Terminhinweis, Anzeige, Interview …) und wie
- reason: warum es sich lohnt (Reichweite, Zielgruppe)
- amount: Kosten, falls bekannt (z.B. „kostenlos“, Anzeigenpreise)
- deadline: Redaktionsschluss/Vorlauf, falls bekannt
- location: Ort und ungefähre Entfernung zu ${p.place}
${FIELD_GUIDE}${extra}${known}`;
  }

  return `Wir sind: ${VEREIN}

Aufgabe: Finde mögliche Sponsoren im Umkreis von ${p.radius} km um „${p.place}“${p.category ? ` (Schwerpunkt/Branche: ${p.category})` : ''}. Such gezielt nach Unternehmen, Banken/Sparkassen, Stadtwerken, Stiftungen und Institutionen, die nachweislich schon andere Veranstaltungen, Festivals, Vereine, Kultur- oder Sozialinitiativen in der Region unterstützt haben – z.B. über Sponsorenseiten von Festivals und Vereinen, Pressemitteilungen, Spendenberichte, Engagement-Seiten der Firmen. Nenne zu jedem Eintrag den konkreten Beleg. Firmen mit eigener Sponsoring-/Spendenanfrage (Formular, Ansprechpartner Marketing/Unternehmenskommunikation) sind besonders wertvoll. Ziel: 15 bis 30 Treffer, die vielversprechendsten zuerst.

Bedeutung der Felder hier:
- name: Name des Unternehmens/der Institution
- type: Branche
- description: kurze Beschreibung und Art ihres Engagements (Sponsoring, Spenden, Stiftung …)
- reason: wen/was sie schon unterstützt haben (konkrete Events/Initiativen, Jahr) – der Beleg
- amount: typische Höhe, falls bekannt
- deadline: Bewerbungsfristen/Vergaberunden, falls bekannt
- location: Sitz und ungefähre Entfernung zu ${p.place}
${FIELD_GUIDE}${extra}${known}`;
}

const SYSTEM = `Du recherchierst im Internet für einen gemeinnützigen Kulturverein. Nutze die Websuche gründlich (auch mehrere Suchen und Unterseiten), prüfe Angaben auf den Originalseiten und übernimm Kontaktdaten nur so, wie sie öffentlich angegeben sind – niemals raten oder E-Mail-Adressen nach Schema bilden. Antworte auf Deutsch. Wenn die Recherche fertig ist, rufe das Werkzeug "ergebnisse_speichern" genau einmal mit der vollständigen Liste auf.`;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt.');
  if (!client) client = new Anthropic.default({ timeout: 15 * 60 * 1000 });
  return client;
}

async function runResearch(prompt) {
  const messages = [{ role: 'user', content: prompt }];
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const response = await getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 25, user_location: { type: 'approximate', city: 'Neckarsulm', region: 'Baden-Württemberg', country: 'DE', timezone: 'Europe/Berlin' } },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 25 },
        SAVE_TOOL,
      ],
      messages,
    }).finalMessage();

    const save = response.content.find(b => b.type === 'tool_use' && b.name === SAVE_TOOL.name);
    if (save) return save.input;
    if (response.stop_reason === 'refusal') throw new Error('Die KI hat diese Anfrage abgelehnt.');
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    // Recherche beendet, aber Werkzeug nicht aufgerufen: einmal ausdruecklich daran erinnern
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: 'Bitte rufe jetzt das Werkzeug "ergebnisse_speichern" mit deiner vollständigen Ergebnisliste auf.' });
  }
  throw new Error('Die Recherche wurde nicht abgeschlossen – bitte erneut versuchen.');
}

const clean = (v, max = 2000) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

async function executeSearch(searchId, kind, params) {
  try {
    const knownNames = db.prepare('SELECT name FROM finder_results WHERE kind = ? ORDER BY id DESC LIMIT 150').all(kind).map(r => r.name);
    const data = await runResearch(buildPrompt(kind, params, knownNames));
    const known = new Set(knownNames.map(n => n.toLowerCase()));
    const insert = db.prepare(`INSERT INTO finder_results (search_id, kind, ${RESULT_FIELDS.join(', ')}) VALUES (?, ?, ${RESULT_FIELDS.map(() => '?').join(', ')})`);
    let count = 0;
    db.transaction(() => {
      for (const r of data.results || []) {
        const name = clean(r.name, 300);
        if (!name || known.has(name.toLowerCase())) continue;
        known.add(name.toLowerCase());
        insert.run(searchId, kind, ...RESULT_FIELDS.map(f => (f === 'name' ? name : clean(r[f]))));
        count++;
      }
      db.prepare(`UPDATE finder_searches SET status = 'done', summary = ?, result_count = ?, finished_at = datetime('now') WHERE id = ?`)
        .run(clean(data.summary, 4000), count, searchId);
    })();
  } catch (err) {
    console.error('[Finder] Suche fehlgeschlagen:', err);
    const msg = err instanceof Anthropic.APIError ? `KI-Dienst meldet Fehler ${err.status || ''}: ${err.message}` : err.message;
    db.prepare(`UPDATE finder_searches SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?`).run(String(msg).slice(0, 1000), searchId);
  }
}

function searchRow(s) {
  return s && { ...s, params: JSON.parse(s.params) };
}

function register(app) {
  app.get('/api/finder/searches', (req, res) => {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    const rows = kind
      ? db.prepare('SELECT * FROM finder_searches WHERE kind = ? ORDER BY id DESC LIMIT 50').all(kind)
      : db.prepare('SELECT * FROM finder_searches ORDER BY id DESC LIMIT 50').all();
    res.json(rows.map(searchRow));
  });

  app.get('/api/finder/searches/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM finder_searches WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Suche nicht gefunden' });
    res.json(searchRow(s));
  });

  app.post('/api/finder/searches', (req, res) => {
    const b = req.body || {};
    const kind = b.kind;
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Unbekannte Suchart' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Die KI-Suche ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
    const params = {
      category: clean(b.category, 200),
      place: clean(b.place, 200),
      radius: Math.min(Math.max(Math.round(+b.radius) || 25, 1), 300),
      notes: clean(b.notes, 1000),
    };
    if (kind === 'foerder' && !params.category) return res.status(400).json({ error: 'Bitte eine Förderrichtung angeben' });
    if (kind !== 'foerder' && !params.place) return res.status(400).json({ error: 'Bitte einen Ort angeben' });
    if (kind === 'foerder') { delete params.place; delete params.radius; }
    if (db.prepare(`SELECT 1 FROM finder_searches WHERE status = 'running' AND kind = ?`).get(kind)) {
      return res.status(409).json({ error: 'Für diesen Bereich läuft schon eine Suche – bitte kurz warten.' });
    }
    const info = db.prepare('INSERT INTO finder_searches (kind, params, created_by) VALUES (?, ?, ?)')
      .run(kind, JSON.stringify(params), req.user.id);
    executeSearch(info.lastInsertRowid, kind, params);
    res.status(202).json(searchRow(db.prepare('SELECT * FROM finder_searches WHERE id = ?').get(info.lastInsertRowid)));
  });

  app.delete('/api/finder/searches/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM finder_searches WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Suche nicht gefunden' });
    if (s.status === 'running') return res.status(409).json({ error: 'Die Suche läuft noch' });
    // Ergebnisse bleiben erhalten (search_id wird NULL), nur der Suchverlauf-Eintrag verschwindet
    db.prepare('DELETE FROM finder_searches WHERE id = ?').run(s.id);
    res.status(204).end();
  });

  app.get('/api/finder/results', (req, res) => {
    if (!KINDS.includes(req.query.kind)) return res.status(400).json({ error: 'Unbekannte Suchart' });
    res.json(db.prepare('SELECT * FROM finder_results WHERE kind = ? ORDER BY id DESC').all(req.query.kind));
  });

  app.put('/api/finder/results/:id', (req, res) => {
    const r = db.prepare('SELECT * FROM finder_results WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const b = req.body || {};
    const status = STATUSES.includes(b.status) ? b.status : r.status;
    const notes = b.notes !== undefined ? clean(b.notes, 5000) : r.notes;
    db.prepare(`UPDATE finder_results SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`).run(status, notes, r.id);
    res.json(db.prepare('SELECT * FROM finder_results WHERE id = ?').get(r.id));
  });

  app.delete('/api/finder/results/:id', (req, res) => {
    const info = db.prepare('DELETE FROM finder_results WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    res.status(204).end();
  });
}

module.exports = { register };
