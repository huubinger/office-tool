const { getAccessToken, isConfigured: isDropboxConfigured } = require('./backup');

// Basis-Ordner in Dropbox, in dem die Vertraege bereits nach Veranstaltung sortiert
// abliegen. Fuer jede neue Veranstaltung wird darunter automatisch ein Unterordner
// angelegt (Dropbox legt Ordner implizit beim ersten Datei-Upload dort an).
const DROPBOX_CONTRACTS_FOLDER = process.env.DROPBOX_CONTRACTS_FOLDER || '/Vertraege';

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

module.exports = {
  DROPBOX_CONTRACTS_FOLDER,
  isDropboxConfigured,
  getAccessToken,
  sanitizeFolderName,
  uploadContractFile,
  deleteContractFile,
};
