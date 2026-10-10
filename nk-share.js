// ================= NECKARSULMER KONZERTE: LESE-LINK FUER EXTERNE =================
// Kuenstler, Agentur oder Technik bekommen per geheimem Link nur Lesezugriff auf ausgewaehlte
// Infos eines Konzerts (Termin & Ort, Ablaufplan, Ansprechpartner, ausgewaehlte Dateien) -
// ohne eigenes Konto. Links lassen sich jederzeit zurueckziehen; optional mit Ablaufdatum.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const nk = require('./nk');
const contracts = require('./contracts');
const { displayForUserId } = require('./access');

const APP_URL = (process.env.APP_URL || 'https://office.martinrenner.de').replace(/\/$/, '');
const SECTIONS = {
  basics: 'Termin, Uhrzeit und Ort',
  run: 'Ablaufplan',
  contacts: 'Ansprechpartner (ohne Gagen)',
  files: 'Ausgewählte Dateien',
};

db.exec(`
CREATE TABLE IF NOT EXISTS nk_share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  label TEXT,
  message TEXT,
  sections TEXT,
  file_ids TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  view_count INTEGER DEFAULT 0,
  last_viewed_at TEXT,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; } catch (e) { return fallback; } };
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

function linkRow(l) {
  const expired = l.expires_at && l.expires_at < new Date().toISOString().slice(0, 10);
  return {
    id: l.id, label: l.label, message: l.message, sections: parseJson(l.sections, []), file_ids: parseJson(l.file_ids, []),
    expires_at: l.expires_at, revoked: !!l.revoked_at, expired: !!expired, active: !l.revoked_at && !expired,
    url: `${APP_URL}/nk/s/${l.token}`, view_count: l.view_count, last_viewed_at: l.last_viewed_at,
    created_by: displayForUserId(db, l.created_by).short, created_at: l.created_at,
  };
}

function activeLink(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || '')) return null;
  const l = db.prepare('SELECT * FROM nk_share_links WHERE token = ?').get(token);
  if (!l || l.revoked_at) return null;
  if (l.expires_at && l.expires_at < new Date().toISOString().slice(0, 10)) return null;
  return l;
}

function sharePage(l) {
  const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(l.concert_id);
  const sections = parseJson(l.sections, []);
  const fileIds = parseJson(l.file_ids, []);
  const parts = [];
  if (l.message) parts.push(`<section class="card note"><p>${esc(l.message).replace(/\n/g, '<br>')}</p></section>`);
  if (sections.includes('basics')) {
    parts.push(`<section class="card"><h2>Termin &amp; Ort</h2>
      <p class="big">${c.date ? esc(fmtDate(c.date)) : 'Datum noch offen'}${c.time ? ` · ${esc(c.time.slice(0, 5))} Uhr` : ''}</p>
      ${c.location ? `<p>📍 ${esc(c.location)} · <a href="https://maps.apple.com/?q=${encodeURIComponent(c.location)}" target="_blank" rel="noopener">Karte</a></p>` : ''}
      ${c.status === 'Abgesagt' ? '<p class="warn">Dieses Konzert ist abgesagt.</p>' : ''}
    </section>`);
  }
  if (sections.includes('run')) {
    const items = db.prepare('SELECT * FROM nk_run_items WHERE concert_id = ? ORDER BY time IS NULL, time, id').all(c.id);
    parts.push(`<section class="card"><h2>Ablaufplan</h2>${items.length ? `<table>${items.map(i => `
      <tr><td class="time">${esc(i.time || '')}</td><td><strong>${esc(i.title)}</strong>${i.note ? `<br><small>${esc(i.note)}</small>` : ''}</td></tr>`).join('')}</table>`
      : '<p class="muted">Der Ablaufplan folgt.</p>'}</section>`);
  }
  if (sections.includes('contacts')) {
    const people = db.prepare(`SELECT cc.role, k.name, k.contact_person, k.email, k.phone FROM nk_concert_contacts cc
      JOIN nk_contacts k ON k.id = cc.contact_id WHERE cc.concert_id = ? ORDER BY cc.id`).all(c.id);
    parts.push(`<section class="card"><h2>Ansprechpartner</h2>${people.length ? people.map(p => `
      <div class="person"><strong>${esc(p.name)}</strong>${p.role ? ` <span class="muted">· ${esc(p.role)}</span>` : ''}
        ${p.contact_person ? `<br>${esc(p.contact_person)}` : ''}
        ${p.phone ? `<br>📞 <a href="tel:${esc(p.phone.replace(/[^+\d]/g, ''))}">${esc(p.phone)}</a>` : ''}
        ${p.email ? `<br>✉️ <a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}</div>`).join('') : '<p class="muted">Noch keine Ansprechpartner eingetragen.</p>'}</section>`);
  }
  if (sections.includes('files') && fileIds.length) {
    const files = db.prepare(`SELECT * FROM nk_concert_files WHERE concert_id = ? AND id IN (${fileIds.map(() => '?').join(',')}) ORDER BY filename`).all(c.id, ...fileIds);
    if (files.length) {
      parts.push(`<section class="card"><h2>Dateien</h2>${files.map(f => `
        <p><a href="/nk/s/${esc(l.token)}/datei/${f.id}" target="_blank" rel="noopener">📄 ${esc(f.filename)}</a> <span class="muted">${esc(f.category || '')}</span></p>`).join('')}</section>`);
    }
  }
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(c.title)} – Neckarsulmer Konzerte</title>
<link rel="icon" href="/icons/nk-icon-192.png">
<style>
:root{--bg:#f6f3ee;--card:#fff;--ink:#2a2620;--muted:#8a7f6c;--accent:#6d4bd8;--line:#ece6dc}
@media (prefers-color-scheme:dark){:root{--bg:#17151a;--card:#221f27;--ink:#eee9e2;--muted:#a59c8e;--accent:#a78bfa;--line:#332e3a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}header{display:flex;gap:14px;align-items:center;margin-bottom:18px}
header img{width:52px;height:52px;border-radius:12px}h1{font-size:1.45rem;margin:0;line-height:1.2}header small{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}.big{font-size:1.15rem;font-weight:600;margin:0 0 4px}
table{width:100%;border-collapse:collapse}td{padding:7px 0;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
td.time{width:64px;font-variant-numeric:tabular-nums;font-weight:600;color:var(--accent)}a{color:var(--accent)}.muted,small{color:var(--muted)}
.person{padding:8px 0;border-top:1px solid var(--line)}.person:first-of-type{border-top:0}.note{border-left:4px solid var(--accent)}
.warn{color:#c2410c;font-weight:600}footer{color:var(--muted);font-size:.8rem;text-align:center;margin-top:24px}
</style></head><body><main>
<header><img src="/icons/nk-icon-192.png" alt=""><div><small>Neckarsulmer Konzerte</small><h1>${esc(c.title)}</h1></div></header>
${parts.join('\n') || '<section class="card"><p class="muted">Für diesen Link sind keine Inhalte freigegeben.</p></section>'}
<footer>Nur zum Lesen freigegeben${l.expires_at ? ` · gültig bis ${esc(l.expires_at.split('-').reverse().join('.'))}` : ''}</footer>
</main></body></html>`;
}

function register(app) {
  nk.extendDetail((c) => ({
    share_links: db.prepare('SELECT * FROM nk_share_links WHERE concert_id = ? ORDER BY revoked_at IS NOT NULL, id DESC').all(c.id).map(linkRow),
    share_sections: SECTIONS,
  }));

  app.post('/api/nk/concerts/:id/share', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const b = req.body || {};
    const sections = (Array.isArray(b.sections) ? b.sections : []).filter(s => SECTIONS[s]);
    if (!sections.length) return res.status(400).json({ error: 'Bitte mindestens einen Bereich freigeben' });
    const validFiles = new Set(db.prepare('SELECT id FROM nk_concert_files WHERE concert_id = ?').all(c.id).map(r => r.id));
    const fileIds = (Array.isArray(b.file_ids) ? b.file_ids : []).map(Number).filter(id => validFiles.has(id));
    const expires = /^\d{4}-\d{2}-\d{2}$/.test(b.expires_at || '') ? b.expires_at : null;
    db.prepare('INSERT INTO nk_share_links (token, concert_id, label, message, sections, file_ids, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomBytes(18).toString('base64url'), c.id, String(b.label || '').trim().slice(0, 120) || 'Lese-Link',
        String(b.message || '').trim().slice(0, 3000) || null, JSON.stringify(sections), JSON.stringify(fileIds), expires, req.user.id);
    res.status(201).json(nk.concertDetail(c.id, req));
  });

  app.post('/api/nk/concerts/:id/share/:linkId/revoke', (req, res) => {
    db.prepare("UPDATE nk_share_links SET revoked_at = datetime('now') WHERE id = ? AND concert_id = ?").run(req.params.linkId, req.params.id);
    res.json(nk.concertDetail(req.params.id, req));
  });
  app.delete('/api/nk/concerts/:id/share/:linkId', (req, res) => {
    db.prepare('DELETE FROM nk_share_links WHERE id = ? AND concert_id = ?').run(req.params.linkId, req.params.id);
    res.json(nk.concertDetail(req.params.id, req));
  });

  // ---- Oeffentliche Seiten (ohne Login, siehe server.js) ----
  app.get('/nk/s/:token', (req, res) => {
    const l = activeLink(req.params.token);
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!l) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link ungültig</title><p style="font-family:sans-serif;padding:24px">Dieser Link ist nicht (mehr) gültig.</p>');
    db.prepare("UPDATE nk_share_links SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?").run(l.id);
    res.type('html').send(sharePage(l));
  });
  app.get('/nk/s/:token/datei/:fileId', async (req, res) => {
    const l = activeLink(req.params.token);
    if (!l || !parseJson(l.sections, []).includes('files') || !parseJson(l.file_ids, []).includes(+req.params.fileId)) return res.status(404).send('Nicht gefunden');
    const f = db.prepare('SELECT * FROM nk_concert_files WHERE id = ? AND concert_id = ?').get(req.params.fileId, l.concert_id);
    if (!f) return res.status(404).send('Nicht gefunden');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'");
    const localPath = f.stored_path ? path.join(nk.FILES_DIR, f.stored_path) : null;
    if (localPath && fs.existsSync(localPath)) {
      res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
      if (f.mime_type) res.type(f.mime_type);
      return res.sendFile(localPath);
    }
    if (f.dropbox_path && contracts.isDropboxConfigured()) {
      try { return res.redirect(await contracts.getTemporaryLink(await contracts.getAccessToken(), f.dropbox_path)); } catch (e) { /* weiter unten */ }
    }
    res.status(404).send('Datei ist nicht mehr vorhanden');
  });
}

module.exports = { register };
