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

// Schickt den extrahierten Vertragstext an Claude und bittet um eine strukturierte
// Liste von Aufgaben (Titel, Datum relativ zur Veranstaltung, ggf. Zustaendigkeits-
// Hinweis) - liefert ein Array von { title, days_offset, note } zurueck.
async function analyzeContractText(contractText, eventDate, peopleNames) {
  if (!isAiConfigured()) throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt.');

  const truncated = contractText.slice(0, 15000); // Sicherheitsgrenze gegen sehr lange PDFs
  const systemPrompt = `Du hilfst einem Kulturverein, aus einem Vertragstext (Mietvertrag, Gastspielvertrag o.ae. fuer eine Veranstaltung) eine Liste konkreter Aufgaben/Fristen abzuleiten, um die sich das Team vor und nach der Veranstaltung kuemmern muss (z.B. Anzahlung leisten, Technik-Rider abgleichen, Versicherungsnachweis schicken, Endabrechnung senden, Kaution zurueckfordern).

Antworte AUSSCHLIESSLICH mit einem JSON-Array, keine Erklaerung drumherum, in diesem Format:
[{"title": "Kurzer Aufgabentitel", "days_offset": -14, "note": "kurze Begruendung/Quelle aus dem Vertrag"}]

days_offset ist die Anzahl Tage relativ zum Veranstaltungsdatum (negativ = vorher, positiv = nachher, 0 = am Veranstaltungstag). Nenne nur Punkte, die sich tatsaechlich aus dem Vertragstext ableiten lassen oder absolute Standard-Praxis sind (z.B. Endabrechnung kurz nach der Veranstaltung). Maximal 10 Punkte. Falls im Text konkrete Fristen/Daten genannt sind, nutze diese fuer days_offset.`;

  const userPrompt = `Veranstaltungsdatum: ${eventDate}\n${peopleNames && peopleNames.length ? `Verfuegbare Team-Mitglieder (nur zur Orientierung, keine Zuweisung noetig): ${peopleNames.join(', ')}\n` : ''}\nVertragstext:\n${truncated}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic-API-Fehler ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Keine Textantwort von Claude erhalten.');

  let jsonText = textBlock.text.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();

  let items;
  try {
    items = JSON.parse(jsonText);
  } catch (err) {
    throw new Error('Antwort von Claude konnte nicht als JSON gelesen werden.');
  }
  if (!Array.isArray(items)) throw new Error('Unerwartetes Antwortformat von Claude.');

  return items
    .filter(it => it && it.title)
    .slice(0, 15)
    .map(it => ({
      title: String(it.title).slice(0, 200),
      days_offset: Number.isFinite(it.days_offset) ? Math.round(it.days_offset) : 0,
      note: it.note ? String(it.note).slice(0, 300) : '',
    }));
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
  analyzeContractText,
};
