// Dropbox-Anbindung fuer den Marketing-Bereich: Ordner durchsuchen, Vorschaubilder und
// Originale laden, temporaere Links (z.B. fuer Videos, die Instagram selbst abholt).
// Zugang per App-Key/-Secret + Refresh-Token (DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
// DROPBOX_REFRESH_TOKEN); DROPBOX_ROOT ist optional der Startordner der Mediensuche.

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tif', 'tiff', 'gif', 'bmp'];
const VIDEO_EXT = ['mp4', 'mov', 'm4v'];

let cachedToken = null;
let cachedUntil = 0;

function isConfigured() {
  return !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN);
}

function rootPath() {
  const r = String(process.env.DROPBOX_ROOT || '').trim().replace(/\/+$/, '');
  return r && !r.startsWith('/') ? '/' + r : r;
}

async function accessToken() {
  if (!isConfigured()) throw new Error('Dropbox ist nicht verbunden (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN fehlen).');
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id: process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Dropbox-Anmeldung fehlgeschlagen (${res.status})`);
  const data = await res.json();
  cachedToken = data.access_token;
  cachedUntil = Date.now() + (data.expires_in - 120) * 1000;
  return cachedToken;
}

// Dropbox verlangt fuer den Header Dropbox-API-Arg reines ASCII (Umlaute als \uXXXX)
const apiArg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function rpc(endpoint, body) {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes('not_found')) throw new Error('Ordner/Datei in der Dropbox nicht gefunden');
    throw new Error(`Dropbox-Fehler ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function content(endpoint, arg) {
  const res = await fetch(`https://content.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Dropbox-API-Arg': apiArg(arg) },
  });
  if (!res.ok) throw new Error(`Dropbox-Fehler ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function mediaType(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

function toEntry(e) {
  return {
    type: e['.tag'] === 'folder' ? 'folder' : 'file',
    name: e.name,
    path: e.path_display,
    media: e['.tag'] === 'file' ? mediaType(e.name) : null,
    size: e.size || null,
    modified: e.client_modified || null,
  };
}

// Inhalt eines Ordners (nicht rekursiv) - fuer den Ordner-Browser im Frontend
async function listFolder(path) {
  let data = await rpc('files/list_folder', { path: path || '', limit: 2000 });
  const entries = data.entries.slice();
  while (data.has_more && entries.length < 6000) {
    data = await rpc('files/list_folder/continue', { cursor: data.cursor });
    entries.push(...data.entries);
  }
  return entries.map(toEntry)
    .filter(e => e.type === 'folder' || e.media)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'de') : a.type === 'folder' ? -1 : 1));
}

// Alle Fotos/Videos unterhalb eines Ordners (rekursiv), kurz zwischengespeichert
const mediaCache = new Map();
async function listMediaRecursive(path) {
  const key = path || '';
  const hit = mediaCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.items;
  let data = await rpc('files/list_folder', { path: key, recursive: true, limit: 2000 });
  const entries = data.entries.slice();
  while (data.has_more && entries.length < 20000) {
    data = await rpc('files/list_folder/continue', { cursor: data.cursor });
    entries.push(...data.entries);
  }
  const items = entries.filter(e => e['.tag'] === 'file').map(toEntry).filter(e => e.media);
  mediaCache.set(key, { at: Date.now(), items });
  return items;
}

// Vorschaubild als JPEG (funktioniert auch fuer HEIC und Videos). size z.B. 'w640h480', 'w2048h1536'
function thumbnail(path, size = 'w640h480') {
  return content('files/get_thumbnail_v2', {
    resource: { '.tag': 'path', path },
    format: 'jpeg',
    size,
    mode: 'fitone_bestfit',
  });
}

function download(path) {
  return content('files/download', { path });
}

async function temporaryLink(path) {
  const data = await rpc('files/get_temporary_link', { path });
  return data.link;
}

module.exports = {
  isConfigured, rootPath, listFolder, listMediaRecursive, thumbnail, download, temporaryLink, mediaType,
};
