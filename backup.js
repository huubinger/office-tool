const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');

// Sichert die Datenbank periodisch nach Dropbox, damit bei Updates/Redeploys oder
// versehentlichem Datenverlust immer ein aktueller Stand wiederherstellbar ist.
//
// Benoetigt eine einmalig eingerichtete Dropbox-App mit Refresh-Token (siehe README).
// Ohne gesetzte Umgebungsvariablen wird nur geloggt, es passiert nichts.

const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY || '';
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET || '';
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || '';
const DROPBOX_FOLDER = process.env.DROPBOX_BACKUP_FOLDER || '/office-tool-backups';
const KEEP_BACKUPS = 30; // Anzahl aeltester Backups, die beim Aufraeumen geloescht werden, wenn mehr vorhanden sind

function isConfigured() {
  return !!(DROPBOX_APP_KEY && DROPBOX_APP_SECRET && DROPBOX_REFRESH_TOKEN);
}

async function getAccessToken() {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id: DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Dropbox-Token-Fehler ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// Erstellt eine konsistente Kopie der SQLite-Datenbank (sicher, auch waehrend das Tool
// aktiv genutzt wird), statt die Live-Datei direkt zu kopieren.
async function createConsistentSnapshot() {
  const tmpPath = path.join(os.tmpdir(), `office-tool-backup-${Date.now()}.db`);
  await db.backup(tmpPath);
  return tmpPath;
}

async function uploadToDropbox(accessToken, localPath, remoteName) {
  const fileBuffer = fs.readFileSync(localPath);
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: `${DROPBOX_FOLDER}/${remoteName}`,
        mode: 'add',
        autorename: false,
        mute: true,
      }),
    },
    body: fileBuffer,
  });
  if (!res.ok) throw new Error(`Dropbox-Upload-Fehler ${res.status}: ${await res.text()}`);
  return res.json();
}

async function cleanupOldBackups(accessToken) {
  const listRes = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DROPBOX_FOLDER }),
  });
  if (!listRes.ok) return; // Ordner existiert evtl. beim allerersten Mal noch nicht - kein Problem
  const data = await listRes.json();
  const files = (data.entries || [])
    .filter(e => e['.tag'] === 'file')
    .sort((a, b) => new Date(b.client_modified) - new Date(a.client_modified));

  const toDelete = files.slice(KEEP_BACKUPS);
  for (const file of toDelete) {
    await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path_lower }),
    }).catch(() => {}); // einzelne fehlgeschlagene Loeschungen sollen das Backup nicht scheitern lassen
  }
}

function logResult(success, message) {
  try {
    db.prepare('INSERT INTO backup_log (success, message) VALUES (?, ?)').run(success ? 1 : 0, message);
  } catch (e) { /* Logging darf den eigentlichen Vorgang nicht stoeren */ }
}

async function runBackup() {
  if (!isConfigured()) {
    const msg = 'Dropbox-Zugangsdaten nicht gesetzt - Backup uebersprungen.';
    console.log(`[Backup] ${msg}`);
    logResult(false, msg);
    return { skipped: true, message: msg };
  }

  let tmpPath;
  try {
    tmpPath = await createConsistentSnapshot();
    const accessToken = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const remoteName = `data-${timestamp}.db`;
    await uploadToDropbox(accessToken, tmpPath, remoteName);
    await cleanupOldBackups(accessToken);
    const msg = `Backup erfolgreich als ${remoteName} hochgeladen.`;
    console.log(`[Backup] ${msg}`);
    logResult(true, msg);
    return { ok: true, message: msg };
  } catch (err) {
    console.error('[Backup] Fehler:', err.message);
    logResult(false, err.message);
    return { ok: false, message: err.message };
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

function getLastBackup() {
  return db.prepare('SELECT * FROM backup_log ORDER BY id DESC LIMIT 1').get() || null;
}

module.exports = { runBackup, getLastBackup, isConfigured, getAccessToken, DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN };
