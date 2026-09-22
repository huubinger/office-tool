const { getAccessToken, isConfigured: isDropboxConfigured } = require('./backup');

// Basis-Ordner in Dropbox, in dem die Vertraege bereits nach Veranstaltung sortiert
// abliegen. Fuer jede neue Veranstaltung wird darunter automatisch ein Unterordner
// angelegt (Dropbox legt Ordner implizit beim ersten Datei-Upload dort an).
const DROPBOX_CONTRACTS_FOLDER = process.env.DROPBOX_CONTRACTS_FOLDER || '/Vertraege';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

function isAiConfigured() {
  return !!ANTHROPIC_API_KEY;
}

// Macht aus einem Veranstaltungstitel einen dropbox-tauglichen Ordnernamen (keine
// Sonderzeichen, die in Pfaden Probleme machen koennten).
function sanitizeFolderName(title) {
  return String(title || 'Veranstaltung')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120) || 'Veranstaltung';
}

async function uploadContractFile(accessToken, folderName, filename, buffer) {
  const path = `${DROPBOX_CONTRACTS_FOLDER}/${folderName}/${filename}`;
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true, mute: true }),
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Dropbox-Upload-Fehler ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.path_display || path;
}

async function deleteContractFile(accessToken, dropboxPath) {
  await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dropboxPath }),
  }).catch(() => {}); // Loeschung ist "best effort" - Datei bleibt sonst halt in Dropbox liegen
}

async function downloadContractFile(accessToken, dropboxPath) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
    },
  });
  if (!res.ok) throw new Error(`Dropbox-Download-Fehler ${res.status}: ${await res.text()}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Schickt die Vertrags-PDFs direkt an Claude (so werden auch eingescannte Vertraege
// gelesen und nichts wird abgeschnitten) und bittet um eine vollstaendige Liste von
// Aufgaben. Zu jedem Punkt liefert Claude die woertliche Vertragspassage und die Frist-
// Regel; das konkrete Datum rechnet der Server selbst aus (siehe resolveSuggestionDate),
// weil Claude beim Umrechnen in Tage-Abstaende immer wieder danebenlag.
const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          quote: { type: 'string' },
          source_file: { type: 'string' },
          rule: { type: 'string' },
          date_kind: { type: 'string', enum: ['absolut', 'relativ'] },
          absolute_date: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
          amount: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          unit: { anyOf: [{ type: 'string', enum: ['tage', 'wochen', 'monate'] }, { type: 'null' }] },
          direction: { anyOf: [{ type: 'string', enum: ['vor', 'nach'] }, { type: 'null' }] },
        },
        required: ['title', 'quote', 'source_file', 'rule', 'date_kind', 'absolute_date', 'amount', 'unit', 'direction'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `Du hilfst einem Kulturverein, aus Vertraegen fuer eine Veranstaltung (Mietvertrag, Gastspielvertrag o.ae.) alle Aufgaben und Fristen abzuleiten, um die sich das Team vor und nach der Veranstaltung kuemmern muss (z.B. Anzahlung leisten, Technik-Rider abgleichen, Versicherungsnachweis schicken, GEMA anmelden, Endabrechnung senden, Kaution zurueckfordern).

Geh die Vertraege vollstaendig Abschnitt fuer Abschnitt durch und nimm jede Pflicht und jede Frist auf, die das Team betrifft - lieber ein Punkt zu viel als einer zu wenig. Pflichten der Gegenseite nur, wenn das Team sie nachhalten muss (z.B. "Rechnung vom Vermieter pruefen").

Zu jedem Punkt:
- title: kurzer Aufgabentitel.
- quote: die Vertragspassage, aus der sich der Punkt ergibt, woertlich zitiert (mit Paragraph/Abschnitt, falls vorhanden). Nur wenn ein Punkt reine Standard-Praxis ist und im Vertrag nicht steht, quote leer lassen.
- source_file: der Dateiname des Vertrags, aus dem das Zitat stammt (wie im Titel des Dokuments angegeben).
- rule: die Frist in eigenen Worten, so wie sie im Vertrag steht, z.B. "spaetestens 14 Tage vor der Veranstaltung" oder "bis 01.03.2027".
- Datum: Rechne selbst KEINE Daten um.
  - Nennt der Vertrag ein festes Datum: date_kind "absolut", absolute_date im Format JJJJ-MM-TT, amount/unit/direction null.
  - Ist die Frist relativ zur Veranstaltung: date_kind "relativ", absolute_date null, amount/unit/direction so wie im Vertrag (z.B. 14 / "tage" / "vor"; am Veranstaltungstag selbst: 0 / "tage" / "vor").
  - Bei "spaetestens"/"bis"-Fristen ist das die letzte Moeglichkeit - gib genau diese Frist an, nicht einen fruehen Wunschtermin.
  - Ohne Frist im Vertrag: eine sinnvolle relative Frist nach Standard-Praxis waehlen und in rule "keine Frist im Vertrag - Vorschlag" schreiben.`;

async function analyzeContracts(files, eventDate) {
  if (!isAiConfigured()) throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt.');

  const content = files.map(f => ({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') },
    title: `${f.category}: ${f.filename}`,
  }));
  content.push({ type: 'text', text: `Veranstaltungsdatum: ${eventDate}\n\nBitte leite aus den Vertraegen oben alle Aufgaben und Fristen ab.` });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } },
      fallbacks: 'default',
    }),
  });
  if (!res.ok) throw new Error(`Anthropic-API-Fehler ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude hat die Analyse abgelehnt.');
  if (data.stop_reason === 'max_tokens') throw new Error('Antwort von Claude war zu lang und wurde abgeschnitten.');
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Keine Textantwort von Claude erhalten.');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error('Antwort von Claude konnte nicht als JSON gelesen werden.');
  }

  return (parsed.items || [])
    .filter(it => it && it.title)
    .map(it => ({
      title: String(it.title).slice(0, 200),
      quote: String(it.quote || '').slice(0, 1500),
      source_file: String(it.source_file || '').slice(0, 200),
      rule: String(it.rule || '').slice(0, 300),
      date: resolveSuggestionDate(it, eventDate),
    }));
}

// Rechnet die von Claude gelieferte Frist-Regel in ein konkretes Datum (JJJJ-MM-TT) um.
function resolveSuggestionDate(it, eventDate) {
  if (it.date_kind === 'absolut' && /^\d{4}-\d{2}-\d{2}$/.test(it.absolute_date || '')) return it.absolute_date;
  const [y, m, d] = eventDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const sign = it.direction === 'nach' ? 1 : -1;
  const amount = Number.isInteger(it.amount) ? it.amount : 0;
  if (it.unit === 'monate') date.setMonth(date.getMonth() + sign * amount);
  else date.setDate(date.getDate() + sign * amount * (it.unit === 'wochen' ? 7 : 1));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

module.exports = {
  DROPBOX_CONTRACTS_FOLDER,
  isDropboxConfigured,
  isAiConfigured,
  getAccessToken,
  sanitizeFolderName,
  uploadContractFile,
  deleteContractFile,
  downloadContractFile,
  analyzeContracts,
};
