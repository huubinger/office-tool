// ================= MARKETING (Kreatief) =================
// Social-Media- und Grafik-Tool: Kampagnen je Event erzeugen taeglich einen Post-Entwurf
// (Beitrag oder Story) aus Fotos/Videos der Dropbox, gestaltet von Claude als SVG. Jeder
// Entwurf muss freigegeben werden; freigegebene Posts werden zur geplanten Uhrzeit auf
// Instagram/Facebook veroeffentlicht. Dazu ein Grafik-Bereich fuer Druckprodukte
// (Plakat, Flyer, Bauzaunbanner) mit hinterlegten Flyeralarm-Formaten und PDF-Export.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const dropbox = require('./dropbox');
const meta = require('./meta');
const { FONTS, renderRaster, renderPdf, toCmyk, imageSize, toJpeg, mimeOf } = require('./render');

const MODEL = 'claude-opus-5';
const KK_API = process.env.KULTURKALENDER_API || 'https://www.neckarsulmer-kulturkalender.de/api/termine';
const FILE_DIR = path.join(process.env.DB_DIR && process.env.DB_DIR.trim() ? process.env.DB_DIR.trim() : path.join(__dirname, '..'), 'marketing-files');
if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });

const SOCIAL_SIZES = { feed: { w: 1080, h: 1350 }, story: { w: 1080, h: 1920 } };
const POST_STATUSES = ['generating', 'pending', 'approved', 'publishing', 'published', 'failed', 'rejected', 'error'];
const MAX_CANDIDATES = 12;

db.exec(`
CREATE TABLE IF NOT EXISTS mk_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS mk_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kk_id INTEGER,
  event_date TEXT NOT NULL,
  event_time TEXT,
  location TEXT,
  ticket_url TEXT,
  price TEXT,
  description TEXT,
  kk_image_url TEXT,
  dropbox_folder TEXT,
  start_date TEXT NOT NULL,
  post_time TEXT NOT NULL DEFAULT '18:00',
  post_kind TEXT NOT NULL DEFAULT 'auto',
  platforms TEXT NOT NULL DEFAULT '["instagram","facebook"]',
  style_brief TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mk_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES mk_campaigns(id) ON DELETE CASCADE,
  post_date TEXT NOT NULL,
  publish_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'feed',
  media_type TEXT NOT NULL DEFAULT 'image',
  platforms TEXT NOT NULL DEFAULT '["instagram","facebook"]',
  angle TEXT,
  headline TEXT,
  caption TEXT,
  svg TEXT,
  image_file TEXT,
  video_path TEXT,
  media_used TEXT,
  design_notes TEXT,
  hint TEXT,
  status TEXT NOT NULL DEFAULT 'generating',
  error TEXT,
  approved_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  approved_at TEXT,
  published_at TEXT,
  ig_media_id TEXT,
  fb_post_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mk_posts_campaign ON mk_posts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mk_posts_status ON mk_posts(status);

CREATE TABLE IF NOT EXISTS mk_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Sonstiges',
  width_mm REAL NOT NULL,
  height_mm REAL NOT NULL,
  bleed_mm REAL NOT NULL DEFAULT 1,
  safe_mm REAL NOT NULL DEFAULT 4,
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mk_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  preset_id INTEGER REFERENCES mk_presets(id) ON DELETE SET NULL,
  format TEXT NOT NULL,
  campaign_id INTEGER REFERENCES mk_campaigns(id) ON DELETE SET NULL,
  content TEXT,
  brief TEXT,
  media TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mk_design_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id INTEGER NOT NULL REFERENCES mk_designs(id) ON DELETE CASCADE,
  svg TEXT NOT NULL,
  preview_file TEXT,
  feedback TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- Konten (mehrere Instagram-/Facebook-Auftritte) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS mk_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  handle TEXT,
  about TEXT,
  brand TEXT,
  logo_path TEXT,
  hashtags TEXT,
  kk_filter TEXT,
  website TEXT,
  token TEXT,
  token_kind TEXT,
  token_expires TEXT,
  token_refreshed_at TEXT,
  ig_user_id TEXT,
  ig_username TEXT,
  fb_page_id TEXT,
  fb_page_name TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('mk_campaigns') WHERE name = 'account_id'").get()) {
  db.exec('ALTER TABLE mk_campaigns ADD COLUMN account_id INTEGER REFERENCES mk_accounts(id) ON DELETE SET NULL');
}
if (!db.prepare('SELECT 1 FROM mk_accounts LIMIT 1').get()) {
  // Startkonten; die bisherigen (globalen) Markenvorgaben und Meta-Variablen gehoeren zu Kreatief
  const old = Object.fromEntries(db.prepare('SELECT key, value FROM mk_settings').all().map(r => [r.key, r.value || '']));
  const ins = db.prepare(`INSERT INTO mk_accounts (name, handle, about, brand, logo_path, hashtags, kk_filter, website, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const kreatief = ins.run('Kreatief', '@daskreatief',
    'Kulturverein „Kreatief – Kultur im Unterland e.V.“ aus Neckarsulm: Konzerte, Musicals, Kabarett und Kleinkunst im Kreatief-Kulturkeller und in der Region.',
    old.brand || '', old.logo_path || '', old.hashtags || '', old.kk_filter || 'Kreatief', 'www.kreatief-neckarsulm.de', 1).lastInsertRowid;
  ins.run('Martin Renner', '@singt.martin',
    'Martin Renner – Sänger, Chorleiter und Musicaldarsteller aus dem Raum Neckarsulm/Heilbronn. Persönlicher Kanal: eigene Auftritte, Konzerte, Chöre, Einblicke in Proben und Musik.',
    '', '', '', '', 'www.martinrenner.de', 2);
  ins.run('Voctails', '@voctails',
    'Voctails – Vokalensemble. Konzerte und Auftritte, Einblicke in Proben und die Menschen im Ensemble.',
    '', '', '', 'Voctails', 'www.voctails.de', 3);
  db.prepare('UPDATE mk_campaigns SET account_id = ? WHERE account_id IS NULL').run(kreatief);
  if (process.env.META_PAGE_TOKEN && (process.env.META_PAGE_ID || process.env.META_IG_USER_ID)) {
    db.prepare(`UPDATE mk_accounts SET token = ?, token_kind = 'facebook', fb_page_id = ?, ig_user_id = ? WHERE id = ?`)
      .run(process.env.META_PAGE_TOKEN, process.env.META_PAGE_ID || null, process.env.META_IG_USER_ID || null, kreatief);
  }
}

// Flyeralarm-Formate als Startwerte (in der App anpassbar). Datenformat = Endformat + Beschnitt je Seite.
if (!db.prepare('SELECT 1 FROM mk_presets LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO mk_presets (name, category, width_mm, height_mm, bleed_mm, safe_mm, notes, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const presets = [
    ['Flyer DIN lang', 'Flyer', 98, 210, 1, 4, 'Flyeralarm-Endformat 98 × 210 mm. Beschnitt/Sicherheitsabstand bitte mit dem Produkt-Datenblatt abgleichen.'],
    ['Flyer DIN A6', 'Flyer', 105, 148, 1, 4, 'Beschnitt/Sicherheitsabstand bitte mit dem Produkt-Datenblatt abgleichen.'],
    ['Flyer DIN A5', 'Flyer', 148, 210, 1, 4, 'Beschnitt/Sicherheitsabstand bitte mit dem Produkt-Datenblatt abgleichen.'],
    ['Flyer DIN A4', 'Flyer', 210, 297, 1, 4, 'Beschnitt/Sicherheitsabstand bitte mit dem Produkt-Datenblatt abgleichen.'],
    ['Plakat DIN A3', 'Plakat', 297, 420, 3, 5, 'Laut Flyeralarm-Datenblatt: Datenformat 303 × 426 mm.'],
    ['Plakat DIN A2', 'Plakat', 420, 594, 3, 5, 'Laut Flyeralarm-Datenblatt: Datenformat 426 × 600 mm.'],
    ['Plakat DIN A1', 'Plakat', 594, 841, 3, 5, 'Laut Flyeralarm-Datenblatt: Datenformat 600 × 847 mm. Aus mehreren Metern lesbar gestalten.'],
    ['Plakat DIN A0', 'Plakat', 841, 1189, 3, 5, 'Laut Flyeralarm-Datenblatt: Datenformat 847 × 1195 mm. Aus mehreren Metern lesbar gestalten.'],
    ['Bauzaunbanner 340 × 173 cm', 'Banner', 3400, 1730, 40, 150, 'Laut Flyeralarm-Datenblatt: Datenformat 3480 × 1810 mm, rundum gesäumt, 42 Ösen ca. alle 25 cm. Wichtige Inhalte deutlich vom Rand weg (Saum/Ösen); wird aus großer Entfernung gesehen – riesige Headline, sehr wenig Text.'],
  ];
  presets.forEach((p, i) => ins.run(...p, i));
}

// Entwuerfe, die bei einem Neustart mitten in der Erstellung waren, sauber beenden
db.prepare(`UPDATE mk_posts SET status = 'error', error = 'Erstellung wurde durch einen Neustart abgebrochen – bitte neu erzeugen.' WHERE status = 'generating'`).run();
db.prepare(`UPDATE mk_posts SET status = 'approved' WHERE status = 'publishing'`).run();
db.prepare(`UPDATE mk_designs SET status = 'error', error = 'Erstellung wurde durch einen Neustart abgebrochen – bitte neu starten.' WHERE status = 'generating'`).run();

// ---------- Hilfen ----------
const clean = (v, max = 2000) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));

function berlinNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}
function fmtDateDE(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const SETTING_KEYS = ['default_post_time'];
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM mk_settings').all();
  const s = Object.fromEntries(SETTING_KEYS.map(k => [k, '']));
  for (const r of rows) if (SETTING_KEYS.includes(r.key)) s[r.key] = r.value || '';
  if (!s.default_post_time) s.default_post_time = '18:00';
  return s;
}

const ACCOUNT_FIELDS = ['name', 'handle', 'about', 'brand', 'logo_path', 'hashtags', 'kk_filter', 'website'];
function getAccount(id) {
  return (id && db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(id)) || db.prepare('SELECT * FROM mk_accounts ORDER BY sort, id LIMIT 1').get() || {};
}
// Fuer die Oberflaeche: ohne Token
function accountRow(a) {
  const { token, ...rest } = a;
  return { ...rest, connected: !!token, status: meta.accountStatus(a) };
}

function saveFile(buf, ext) {
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(FILE_DIR, name), buf);
  return name;
}
function removeFile(name) {
  if (!name || !/^[a-f0-9]{32}\.\w+$/.test(name)) return;
  fs.rm(path.join(FILE_DIR, name), { force: true }, () => {});
}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt.');
  if (!client) client = new Anthropic.default({ timeout: 15 * 60 * 1000 });
  return client;
}

// ---------- Medien ----------
// Kandidaten fuer einen Post: unbenutzte Fotos/Videos aus dem Kampagnen-Ordner (zufaellig),
// dazu das Veranstaltungsbild aus dem Kulturkalender.
async function pickCandidates(campaign, excludeUsed = true) {
  const out = [];
  if (campaign.dropbox_folder && dropbox.isConfigured()) {
    const all = await dropbox.listMediaRecursive(campaign.dropbox_folder);
    const used = new Set();
    if (excludeUsed) {
      for (const p of db.prepare(`SELECT media_used FROM mk_posts WHERE campaign_id = ? AND status NOT IN ('rejected', 'error')`).all(campaign.id)) {
        for (const m of JSON.parse(p.media_used || '[]')) used.add(m);
      }
    }
    let pool = all.filter(m => !used.has(m.path));
    if (pool.length < 4) pool = all; // alles schon verwendet -> wieder von vorn
    const shuffled = pool.sort(() => Math.random() - 0.5);
    const videos = shuffled.filter(m => m.media === 'video').slice(0, 3);
    const images = shuffled.filter(m => m.media === 'image').slice(0, MAX_CANDIDATES - videos.length);
    for (const m of [...images, ...videos]) out.push({ source: 'dropbox', path: m.path, name: m.name, media: m.media });
  }
  if (campaign.kk_image_url) out.push({ source: 'url', url: campaign.kk_image_url, name: 'Veranstaltungsbild (Kulturkalender)', media: 'image' });
  return out.map((c, i) => ({ ...c, id: `${c.media === 'video' ? 'vid' : 'img'}${i + 1}` }));
}

async function fetchUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bild konnte nicht geladen werden (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Kleines Vorschaubild fuer die KI (JPEG)
async function previewFor(c) {
  if (c.source === 'dropbox') return dropbox.thumbnail(c.path, 'w640h480');
  return toJpeg(await fetchUrl(c.url), 800);
}

// Bild in Renderqualitaet: Social = grosses Vorschaubild, Druck = Original (falls JPEG/PNG)
async function fullImageFor(c, forPrint) {
  if (c.source === 'url') {
    const buf = await fetchUrl(c.url);
    return ['image/jpeg', 'image/png'].includes(mimeOf(buf)) ? buf : toJpeg(buf, 3000);
  }
  if (forPrint && /\.(jpe?g|png)$/i.test(c.path)) {
    try { return await dropbox.download(c.path); } catch (e) { /* Fallback unten */ }
  }
  return dropbox.thumbnail(c.path, 'w2048h1536');
}

async function loadLogo(account) {
  if (!account || !account.logo_path || !dropbox.isConfigured()) return null;
  try {
    // PNG direkt (Transparenz bleibt erhalten), alles andere als JPEG-Vorschau von Dropbox
    return /\.png$/i.test(account.logo_path) ? await dropbox.download(account.logo_path) : await dropbox.thumbnail(account.logo_path, 'w1024h768');
  } catch (e) {
    console.error('[Marketing] Logo konnte nicht geladen werden:', e.message);
    return null;
  }
}

// ---------- KI-Gestaltung ----------
const DESIGN_TOOL = {
  name: 'entwurf_speichern',
  description: 'Speichert den fertigen Entwurf (SVG und ggf. Bildunterschrift). Nach jeder Überarbeitung erneut aufrufen.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      angle: { type: 'string', description: 'Thema/Aufhänger dieses Entwurfs in wenigen Worten, z.B. "Countdown 7 Tage", "Blick hinter die Kulissen".' },
      headline: { type: 'string', description: 'Die Hauptzeile der Grafik.' },
      kind: { type: 'string', enum: ['feed', 'story'], description: 'Nur Social Media: Beitrag (feed) oder Story. Bei Druck "feed".' },
      media_type: { type: 'string', enum: ['image', 'video'], description: 'image = gestaltete Grafik (svg). video = eines der Videos wird unverändert gepostet (svg leer).' },
      video_id: { type: 'string', description: 'Bei media_type video: die ID des Videos (z.B. vid11), sonst leer.' },
      media_ids: { type: 'array', items: { type: 'string' }, description: 'IDs aller verwendeten Fotos/Videos.' },
      svg: { type: 'string', description: 'Vollständiges SVG-Dokument (bei Video leer).' },
      caption: { type: 'string', description: 'Nur Social Media: Bildunterschrift inkl. Hashtags. Bei Druck leer.' },
      notes: { type: 'string', description: 'Ein bis zwei Sätze zur Gestaltungsidee.' },
    },
    required: ['angle', 'headline', 'kind', 'media_type', 'video_id', 'media_ids', 'svg', 'caption', 'notes'],
    additionalProperties: false,
  },
};

const fontList = Object.entries(FONTS).map(([f, d]) => `- "${f}": ${d}`).join('\n');

const SYSTEM = `Du bist Art Director und Social-Media-Profi einer renommierten Agentur für Theater-, Musical- und Konzertwerbung. Du gestaltest für Kulturveranstalter, Ensembles und Künstler aus der Region Neckarsulm/Heilbronn Werbemittel, die aussehen wie von professionellen Grafikdesignern und ein Ziel haben: Menschen sollen Tickets kaufen und zur Veranstaltung kommen. Für wen du gerade arbeitest, steht in der Aufgabe (Absender/Konto) – Tonfall, Ansprache und Look passen zu genau diesem Absender.

Gestaltung
- Starke visuelle Idee statt Vorlagen-Look: klare Hierarchie (ein dominantes Element, eine Headline), großzügiger Weißraum, bewusste Typo-Kontraste, max. 2–3 Schriften, eine prägnante Farbwelt (aus den Fotos oder den Markenvorgaben abgeleitet).
- Fotos sind das stärkste Material: groß und emotional einsetzen (Anschnitt, Ausschnitte, Duotone-Anmutung über Verläufe/Farbflächen), Gesichter nicht mit Text überdecken.
- Text über Fotos immer lesbar machen (Verlauf, Farbfläche, ausreichend Kontrast).
- Wichtige Infos unmissverständlich: Titel, Datum (Wochentag + Datum), Uhrzeit, Ort, Ticket-Hinweis. Nichts erfinden, was nicht in den Angaben steht (keine Preise, Namen, Zitate, Auszeichnungen).
- Deutsche Sprache, korrekte Rechtschreibung, typografische Anführungszeichen „…“ und Gedankenstriche –.

Technik (SVG)
- Genau ein <svg> mit den vorgegebenen width, height und viewBox. Keine externen Ressourcen, kein CSS mit @import, keine <foreignObject>, kein <script>.
- Erlaubt: rect, circle, ellipse, line, polyline, polygon, path, text, tspan, g, image, defs, linearGradient, radialGradient, stop, clipPath, mask, pattern, opacity, transform.
- Schriften ausschließlich (font-family genau so schreiben, font-weight numerisch):
${fontList}
- Text bricht NICHT automatisch um: jede Zeile als eigenes <text> oder <tspan x=".." dy="..">. Schätze Breiten vorsichtig: Laufweite pro Zeichen etwa Anton/Bebas Neue/Oswald 0,45–0,5 × font-size, Montserrat/Inter 0,55–0,65 × font-size (Versalien und fette Schnitte eher 0,7), Playfair/DM Serif 0,5–0,55. Lieber kleiner setzen oder umbrechen als überlaufen.
- Fotos: <image href="img3" x=".." y=".." width=".." height=".." preserveAspectRatio="xMidYMid slice"/> – href ist genau die ID aus der Liste. Formen per clipPath. Das Logo (falls vorhanden) mit href="logo" und preserveAspectRatio="xMidYMid meet".

Du rufst am Ende immer das Werkzeug "entwurf_speichern" auf.`;

const SOCIAL_RULES = `Social Media (Instagram/Facebook)
- Beitrag (feed): 1080 × 1350 px. Story: 1080 × 1920 px – in der Story oben 250 px und unten 320 px frei von wichtigen Inhalten (Instagram-Bedienelemente).
- Wenig Text auf der Grafik, große Headline, gut auf dem Handy lesbar (keine Schrift unter 30 px).
- Filter (feGaussianBlur, feDropShadow) sind bei Social Media erlaubt, sparsam einsetzen.
- Bildunterschrift (caption): erste Zeile als starker Aufhänger, dann 2–5 kurze Zeilen mit den wichtigsten Infos, klarer Handlungsaufruf zum Ticketkauf („Tickets über den Link in der Bio“ bzw. Ticket-Link), wenige passende Emojis, am Ende 5–10 Hashtags. Maximal 1.200 Zeichen.
- Jeder Tag braucht einen anderen Aufhänger, damit der Kanal abwechslungsreich bleibt – z.B. Countdown, Probeneinblick/Behind the Scenes, Vorfreude, Ensemble/Menschen, Musik/Szene, Frage an die Community, „Letzte Tickets“, „Heute ist es so weit“. Kurz vor dem Termin Dringlichkeit steigern.
- Ein Video (media_type "video") ist sinnvoll, wenn ein Video spannender ist als eine Grafik; dann wird es unverändert als Reel bzw. Story gepostet, du schreibst nur die caption (svg leer).`;

function printRules(format) {
  return `Druckprodukt: ${format.name}
- Endformat ${format.width_mm} × ${format.height_mm} mm, Beschnitt ${format.bleed_mm} mm je Seite → Datenformat ${format.width_mm + 2 * format.bleed_mm} × ${format.height_mm + 2 * format.bleed_mm} mm.
- Koordinaten in Zehntelmillimetern: 1 Einheit = 0,1 mm. Das SVG hat width/height/viewBox des Datenformats (siehe unten).
- Hintergründe und randabfallende Bilder bis ganz an den Rand des Datenformats (in den Beschnitt) ziehen.
- Alle Texte und wichtigen Elemente mindestens ${format.safe_mm} mm innerhalb des Endformats (Sicherheitsabstand).${format.notes ? `\n- Hinweis zum Format: ${format.notes}` : ''}
- KEINE Filter (kein feGaussianBlur, kein feDropShadow) – die Druck-PDF kann sie nicht darstellen. Schatten/Tiefe über Verläufe und Flächen.
- Lesbarkeit aus der typischen Betrachtungsdistanz (Plakat/Banner aus mehreren Metern: sehr große Headline und Eckdaten, wenig Text).
- caption leer lassen, kind "feed", media_type "image".`;
}

function eventBlock(c) {
  if (!c) return '';
  return `Veranstaltung
- Titel: ${c.title}
- Datum: ${fmtDateDE(c.event_date)}${c.event_time ? `, ${c.event_time} Uhr` : ''}
- Ort: ${c.location || '–'}
- Tickets: ${c.ticket_url || '–'}${c.price ? `\n- Eintritt: ${c.price}` : ''}${c.description ? `\n- Beschreibung: ${c.description}` : ''}${c.style_brief ? `\n- Gestaltungswünsche für diese Kampagne: ${c.style_brief}` : ''}${c.notes ? `\n- Weitere Infos/Hinweise: ${c.notes}` : ''}`;
}

function brandBlock(a) {
  if (!a || !a.name) return '';
  const parts = [`Absender/Konto: ${a.name}${a.handle ? ` (${a.handle})` : ''}`];
  if (a.about) parts.push(`Wer das ist: ${a.about}`);
  if (a.brand) parts.push(`Markenvorgaben ${a.name}: ${a.brand}`);
  if (a.website) parts.push(`Website: ${a.website}`);
  if (a.hashtags) parts.push(`Feste Hashtags (immer verwenden): ${a.hashtags}`);
  return parts.join('\n');
}

async function callDesigner(messages) {
  const response = await getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: SYSTEM,
    tools: [DESIGN_TOOL],
    messages,
  }).finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('Die KI hat diese Anfrage abgelehnt.');
  const call = response.content.find(b => b.type === 'tool_use' && b.name === DESIGN_TOOL.name);
  return { response, call };
}

// Kompletter Entwurfsablauf: Entwurf -> rendern -> KI prueft das Ergebnis selbst -> ueberarbeitet.
// render(input) liefert { jpg } fuer die Selbstkontrolle.
async function designWithReview(userContent, render, reviewRounds = 1) {
  const messages = [{ role: 'user', content: userContent }];
  let { response, call } = await callDesigner(messages);
  for (let i = 0; !call && i < 2; i++) {
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: 'Bitte rufe jetzt das Werkzeug "entwurf_speichern" mit deinem vollständigen Entwurf auf.' });
    ({ response, call } = await callDesigner(messages));
  }
  if (!call) throw new Error('Die KI hat keinen Entwurf geliefert – bitte erneut versuchen.');
  let result = call.input;
  for (let round = 0; round < reviewRounds && result.media_type !== 'video'; round++) {
    let rendered;
    let renderError = null;
    try { rendered = await render(result); } catch (e) { renderError = e.message; }
    messages.push({ role: 'assistant', content: response.content });
    const toolContent = renderError
      ? [{ type: 'text', text: `Das SVG ließ sich nicht darstellen: ${renderError}. Bitte korrigieren und erneut speichern.` }]
      : [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: rendered.jpg.toString('base64') } },
        { type: 'text', text: 'So sieht dein Entwurf gerendert aus. Prüfe ihn kritisch wie ein Art Director vor der Abgabe: abgeschnittene oder überlaufende Texte, Überlappungen, zu enge Ränder/Sicherheitsabstand, Lesbarkeit und Kontrast, Rechtschreibung, Bildausschnitt (Köpfe angeschnitten?), Gesamtwirkung. Verbessere alles Nötige und rufe "entwurf_speichern" erneut mit der finalen Fassung auf – auch wenn alles passt (dann unverändert).' },
      ];
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: toolContent }] });
    const next = await callDesigner(messages);
    if (!next.call) break;
    response = next.response;
    call = next.call;
    result = call.input;
  }
  return result;
}

async function candidateBlocks(candidates) {
  const blocks = [];
  const loaded = [];
  for (const c of candidates) {
    try {
      const buf = await previewFor(c);
      const size = imageSize(buf);
      loaded.push({ ...c, size });
      blocks.push({ type: 'text', text: `${c.id}${c.media === 'video' ? ' (VIDEO – Standbild)' : ''}: ${c.name}${size ? ` – Seitenverhältnis ${size.w}:${size.h}` : ''}` });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
    } catch (e) {
      console.error('[Marketing] Vorschaubild fehlgeschlagen:', c.name, e.message);
    }
  }
  return { blocks, loaded };
}

async function loadRenderImages(result, candidates, logo, forPrint) {
  const images = {};
  const ids = new Set(result.media_ids || []);
  for (const m of String(result.svg || '').matchAll(/href="((?:img|vid)\d+)"/g)) ids.add(m[1]);
  for (const id of ids) {
    const c = candidates.find(x => x.id === id);
    if (!c) continue;
    images[id] = c.media === 'video' ? await dropbox.thumbnail(c.path, 'w2048h1536') : await fullImageFor(c, forPrint);
  }
  if (logo) images.logo = logo;
  return images;
}

// ---------- Social-Posts erzeugen ----------
function postRow(p) {
  if (!p) return p;
  const { svg, ...rest } = p;
  return { ...rest, platforms: JSON.parse(p.platforms || '[]'), media_used: JSON.parse(p.media_used || '[]'), has_svg: !!svg };
}

async function generatePost(postId) {
  const post = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(postId);
  const campaign = db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(post.campaign_id);
  try {
    const account = getAccount(campaign.account_id);
    const candidates = await pickCandidates(campaign);
    const { blocks, loaded } = await candidateBlocks(candidates);
    const logo = await loadLogo(account);
    const history = db.prepare(`SELECT post_date, kind, media_type, angle, headline FROM mk_posts WHERE campaign_id = ? AND id != ? AND status NOT IN ('rejected', 'error', 'generating') ORDER BY post_date DESC LIMIT 14`).all(campaign.id, post.id);
    const daysLeft = daysBetween(post.post_date, campaign.event_date);
    const kindRule = campaign.post_kind === 'auto'
      ? 'Wähle selbst, ob Beitrag (feed) oder Story besser passt – abwechseln ist gut (etwa jeder dritte Tag eine Story).'
      : `Format ist fest vorgegeben: ${campaign.post_kind === 'story' ? 'Story' : 'Beitrag (feed)'}.`;
    const prev = post.hint && post.svg ? `\n\nÜberarbeite den bisherigen Entwurf gemäß Feedback. Bisheriges SVG:\n${post.svg}` : '';
    const text = `${SOCIAL_RULES}

${eventBlock(campaign)}

${brandBlock(account)}

Aufgabe: Gestalte den Post für ${fmtDateDE(post.post_date)} (Veröffentlichung ${post.publish_at.slice(11)} Uhr). ${daysLeft > 0 ? `Noch ${daysLeft} ${daysLeft === 1 ? 'Tag' : 'Tage'} bis zur Veranstaltung.` : daysLeft === 0 ? 'Die Veranstaltung ist HEUTE.' : 'Die Veranstaltung ist schon vorbei – Dank/Rückblick.'}
${kindRule}
Maße: Beitrag <svg width="1080" height="1350" viewBox="0 0 1080 1350">, Story <svg width="1080" height="1920" viewBox="0 0 1080 1920">.
${history.length ? `\nBisherige Posts dieser Kampagne (nicht wiederholen, anderer Aufhänger und anderes Layout):\n${history.map(h => `- ${h.post_date}: ${h.kind === 'story' ? 'Story' : 'Beitrag'}${h.media_type === 'video' ? ' (Video)' : ''} – ${h.angle || ''} – „${h.headline || ''}“`).join('\n')}` : '\nDas ist der erste Post der Kampagne.'}
${post.hint ? `\nFeedback/Wunsch vom Team: ${post.hint}` : ''}
${logo ? '\nDas Logo ist als href="logo" verfügbar – dezent einsetzen.' : ''}
${loaded.length ? '\nVerfügbares Material (Fotos und Standbilder von Videos):' : '\nEs gibt kein Foto-Material – gestalte rein typografisch/grafisch.'}${prev}`;

    const content = [{ type: 'text', text }, ...blocks];
    const render = async (r) => {
      const size = SOCIAL_SIZES[r.kind] || SOCIAL_SIZES.feed;
      const imgs = await loadRenderImages(r, loaded, logo, false);
      return renderRaster(r.svg, imgs, size.w / 2, { jpegQuality: 80 });
    };
    const result = await designWithReview(content, render, 1);

    const kind = campaign.post_kind === 'auto' ? (result.kind === 'story' ? 'story' : 'feed') : campaign.post_kind;
    let imageFile = null;
    let videoPath = null;
    let mediaType = 'image';
    if (result.media_type === 'video') {
      const vid = loaded.find(c => c.id === result.video_id && c.media === 'video');
      if (!vid) throw new Error('Die KI hat ein unbekanntes Video gewählt – bitte neu erzeugen.');
      videoPath = vid.path;
      mediaType = 'video';
    } else {
      const size = SOCIAL_SIZES[kind];
      const imgs = await loadRenderImages(result, loaded, logo, false);
      const out = renderRaster(result.svg, imgs, size.w, { jpegQuality: 92 });
      imageFile = saveFile(out.jpg, 'jpg');
    }
    const used = (result.media_ids || []).concat(result.video_id ? [result.video_id] : [])
      .map(id => loaded.find(c => c.id === id)).filter(c => c && c.path).map(c => c.path);

    removeFile(post.image_file);
    db.prepare(`UPDATE mk_posts SET status = 'pending', error = NULL, kind = ?, media_type = ?, angle = ?, headline = ?, caption = ?, svg = ?,
      image_file = ?, video_path = ?, media_used = ?, design_notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(kind, mediaType, clean(result.angle, 200), clean(result.headline, 300), clean(result.caption, 2200), mediaType === 'image' ? result.svg : null,
        imageFile, videoPath, JSON.stringify([...new Set(used)]), clean(result.notes, 1000), post.id);
  } catch (err) {
    console.error('[Marketing] Post-Erstellung fehlgeschlagen:', err);
    const msg = err instanceof Anthropic.APIError ? `KI-Dienst meldet Fehler ${err.status || ''}: ${err.message}` : err.message;
    db.prepare(`UPDATE mk_posts SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`).run(String(msg).slice(0, 1000), post.id);
  }
}

function createPost(campaign, postDate, hint) {
  const info = db.prepare(`INSERT INTO mk_posts (campaign_id, post_date, publish_at, kind, platforms, hint, status) VALUES (?, ?, ?, ?, ?, ?, 'generating')`)
    .run(campaign.id, postDate, `${postDate} ${campaign.post_time}`, campaign.post_kind === 'story' ? 'story' : 'feed', campaign.platforms, clean(hint, 1000));
  generatePost(info.lastInsertRowid);
  return info.lastInsertRowid;
}

// Naechster Tag ohne (aktiven) Post ab heute bzw. morgen, wenn die heutige Uhrzeit schon vorbei ist
function nextFreeDate(campaign) {
  const now = berlinNow();
  let d = campaign.start_date > now.date ? campaign.start_date : now.date;
  if (d === now.date && campaign.post_time <= now.time) d = addDays(d, 1);
  const taken = new Set(db.prepare(`SELECT post_date FROM mk_posts WHERE campaign_id = ? AND status NOT IN ('rejected', 'error')`).all(campaign.id).map(r => r.post_date));
  while (taken.has(d)) d = addDays(d, 1);
  return d;
}

// ---------- Veroeffentlichen ----------
function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://office.martinrenner.de').replace(/\/+$/, '');
}

function facebookCaption(post, campaign) {
  let cap = post.caption || '';
  if (campaign && campaign.ticket_url && !cap.includes(campaign.ticket_url)) {
    cap = cap.replace(/(Tickets?\s+(gibt'?s\s+)?(über|im|unter)\s+(den\s+)?Link\s+in\s+(der\s+)?Bio)/i, 'Tickets: ' + campaign.ticket_url);
    if (!cap.includes(campaign.ticket_url)) cap += `\n\n🎟 Tickets: ${campaign.ticket_url}`;
  }
  return cap;
}

async function publishPost(postId) {
  const post = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(postId);
  const campaign = post.campaign_id ? db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(post.campaign_id) : null;
  const platforms = JSON.parse(post.platforms || '[]');
  const account = getAccount(campaign && campaign.account_id);
  const st = meta.accountStatus(account);
  db.prepare(`UPDATE mk_posts SET status = 'publishing', error = NULL WHERE id = ?`).run(post.id);
  const errors = [];
  let igId = post.ig_media_id;
  let fbId = post.fb_post_id;
  try {
    const url = post.media_type === 'video'
      ? await dropbox.temporaryLink(post.video_path)
      : `${publicBaseUrl()}/m/${post.image_file}`;
    // Nicht verbundene Plattformen ueberspringen, solange wenigstens eine verbunden ist
    // (z.B. Konto nur mit Instagram-Login, Kampagne aber mit Instagram + Facebook)
    const skipOffline = platforms.some(p => st[p]);
    if (platforms.includes('instagram') && !igId && !(skipOffline && !st.instagram)) {
      if (!st.instagram) errors.push(`Instagram ist für ${account.handle || account.name} nicht verbunden`);
      else {
        try { igId = await meta.publishInstagram(account, { kind: post.kind, mediaType: post.media_type, url, caption: post.caption }); } catch (e) { errors.push(`Instagram: ${e.message}`); }
      }
    }
    if (platforms.includes('facebook') && !fbId && !(skipOffline && !st.facebook)) {
      if (!st.facebook) errors.push(`Facebook ist für ${account.handle || account.name} nicht verbunden`);
      else {
        try { fbId = await meta.publishFacebook(account, { kind: post.kind, mediaType: post.media_type, url, caption: facebookCaption(post, campaign) }); } catch (e) { errors.push(`Facebook: ${e.message}`); }
      }
    }
  } catch (e) {
    errors.push(e.message);
  }
  const ok = errors.length === 0;
  db.prepare(`UPDATE mk_posts SET status = ?, error = ?, ig_media_id = ?, fb_post_id = ?, published_at = CASE WHEN ? THEN datetime('now') ELSE published_at END, updated_at = datetime('now') WHERE id = ?`)
    .run(ok ? 'published' : 'failed', ok ? null : errors.join(' · ').slice(0, 1000), igId || null, fbId || null, ok ? 1 : 0, post.id);
  if (!ok) console.error('[Marketing] Veröffentlichung fehlgeschlagen:', post.id, errors.join(' · '));
}

let publishing = false;
async function publishDue() {
  if (publishing) return;
  publishing = true;
  try {
    const now = berlinNow();
    const due = db.prepare(`SELECT p.id, c.account_id FROM mk_posts p LEFT JOIN mk_campaigns c ON c.id = p.campaign_id
      WHERE p.status = 'approved' AND p.publish_at <= ? ORDER BY p.publish_at`).all(`${now.date} ${now.time}`);
    for (const p of due) {
      const st = meta.accountStatus(getAccount(p.account_id));
      if (st.instagram || st.facebook) await publishPost(p.id);
    }
  } finally {
    publishing = false;
  }
}

// Jeden Morgen: fuer jede laufende Kampagne den Entwurf fuer morgen anlegen (Zeit zum Freigeben)
function planDaily() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const tomorrow = addDays(berlinNow().date, 1);
  const campaigns = db.prepare('SELECT * FROM mk_campaigns WHERE active = 1 AND start_date <= ? AND event_date >= ?').all(tomorrow, tomorrow);
  for (const c of campaigns) {
    const exists = db.prepare(`SELECT 1 FROM mk_posts WHERE campaign_id = ? AND post_date = ? AND status NOT IN ('rejected', 'error')`).get(c.id, tomorrow);
    if (!exists) createPost(c, tomorrow, null);
  }
}

cron.schedule('*/5 * * * *', () => { publishDue().catch(e => console.error('[Marketing] Veröffentlichen:', e.message)); }, { timezone: 'Europe/Berlin' });
// Instagram-Login-Token laufen nach 60 Tagen ab -> alle 3 Wochen verlaengern
async function refreshTokens() {
  const due = db.prepare(`SELECT * FROM mk_accounts WHERE token_kind = 'instagram' AND token IS NOT NULL
    AND (token_refreshed_at IS NULL OR token_refreshed_at <= datetime('now', '-21 days'))`).all();
  for (const a of due) {
    try {
      const r = await meta.refreshInstagramToken(a.token);
      db.prepare(`UPDATE mk_accounts SET token = ?, token_refreshed_at = datetime('now'), token_expires = datetime('now', ?) WHERE id = ?`)
        .run(r.token, `+${Math.round((r.expiresIn || 5184000) / 86400)} days`, a.id);
    } catch (e) {
      console.error('[Marketing] Instagram-Token konnte nicht verlängert werden:', a.handle, e.message);
    }
  }
}
cron.schedule('30 4 * * *', () => { refreshTokens().catch(e => console.error('[Marketing] Token:', e.message)); }, { timezone: 'Europe/Berlin' });
cron.schedule('0 7 * * *', () => { try { planDaily(); } catch (e) { console.error('[Marketing] Tagesplanung:', e.message); } }, { timezone: 'Europe/Berlin' });

// ---------- Druck-Grafiken ----------
function designFormat(d) {
  return JSON.parse(d.format);
}

function designRow(d) {
  if (!d) return d;
  const versions = db.prepare('SELECT id, preview_file, feedback, notes, created_at FROM mk_design_versions WHERE design_id = ? ORDER BY id DESC').all(d.id);
  return { ...d, format: designFormat(d), media: JSON.parse(d.media || '[]'), versions };
}

async function generateDesign(designId, feedback, baseVersionId) {
  const d = db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(designId);
  try {
    const format = designFormat(d);
    const campaign = d.campaign_id ? db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(d.campaign_id) : null;
    const account = getAccount(campaign && campaign.account_id);
    const W = Math.round((format.width_mm + 2 * format.bleed_mm) * 10);
    const H = Math.round((format.height_mm + 2 * format.bleed_mm) * 10);
    const media = JSON.parse(d.media || '[]');
    const candidates = media.map((p, i) => ({ id: `img${i + 1}`, source: 'dropbox', path: p, name: p.split('/').pop(), media: 'image' }));
    if (!candidates.length && campaign && campaign.kk_image_url) candidates.push({ id: 'img1', source: 'url', url: campaign.kk_image_url, name: 'Veranstaltungsbild (Kulturkalender)', media: 'image' });
    const { blocks, loaded } = await candidateBlocks(candidates);
    const logo = await loadLogo(account);
    const base = baseVersionId
      ? db.prepare('SELECT * FROM mk_design_versions WHERE id = ? AND design_id = ?').get(baseVersionId, d.id)
      : null;

    const text = `${printRules(format)}
SVG: <svg width="${W / 10}mm" height="${H / 10}mm" viewBox="0 0 ${W} ${H}">
Endformat-Bereich: x ${format.bleed_mm * 10} bis ${W - format.bleed_mm * 10}, y ${format.bleed_mm * 10} bis ${H - format.bleed_mm * 10}. Sicherheitsbereich für Texte: x ${(format.bleed_mm + format.safe_mm) * 10} bis ${W - (format.bleed_mm + format.safe_mm) * 10}, y ${(format.bleed_mm + format.safe_mm) * 10} bis ${H - (format.bleed_mm + format.safe_mm) * 10}.

${campaign ? eventBlock(campaign) : ''}

${brandBlock(account)}

Titel des Werbemittels: ${d.title}
${d.content ? `Inhalte/Informationen, die auf das Werbemittel sollen:\n${d.content}` : 'Keine zusätzlichen Inhalte angegeben – nutze die Veranstaltungsdaten.'}
${d.brief ? `\nSo soll die Grafik aussehen:\n${d.brief}` : '\nKeine Gestaltungsvorgabe – kreiere eine neue, eigenständige, überraschende Gestaltung.'}
${feedback ? `\nÄnderungswünsche zur bisherigen Fassung:\n${feedback}` : ''}
${base ? `\nBisherige Fassung (SVG) als Grundlage – übernimm, was nicht geändert werden soll:\n${base.svg}` : ''}
${logo ? '\nDas Logo ist als href="logo" verfügbar.' : ''}
${loaded.length ? '\nFotos (verwende die passenden):' : '\nKeine Fotos – rein typografisch/grafisch gestalten.'}`;

    const previewWidth = 1400;
    const render = async (r) => renderRaster(r.svg, await loadRenderImages(r, loaded, logo, false), previewWidth, { jpegQuality: 80 });
    const result = await designWithReview([{ type: 'text', text }, ...blocks], render, 1);
    const preview = renderRaster(result.svg, await loadRenderImages(result, loaded, logo, false), 2000, { jpegQuality: 88 });
    const file = saveFile(preview.jpg, 'jpg');
    db.transaction(() => {
      db.prepare('INSERT INTO mk_design_versions (design_id, svg, preview_file, feedback, notes) VALUES (?, ?, ?, ?, ?)')
        .run(d.id, result.svg, file, clean(feedback, 2000), clean(result.notes, 1000));
      db.prepare(`UPDATE mk_designs SET status = 'idle', error = NULL, updated_at = datetime('now') WHERE id = ?`).run(d.id);
    })();
  } catch (err) {
    console.error('[Marketing] Grafik-Erstellung fehlgeschlagen:', err);
    const msg = err instanceof Anthropic.APIError ? `KI-Dienst meldet Fehler ${err.status || ''}: ${err.message}` : err.message;
    db.prepare(`UPDATE mk_designs SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`).run(String(msg).slice(0, 1000), d.id);
  }
}

// ---------- Kulturkalender ----------
async function kkEvents(filter) {
  const res = await fetch(KK_API);
  if (!res.ok) throw new Error(`Kulturkalender nicht erreichbar (${res.status})`);
  const rows = await res.json();
  const today = berlinNow().date;
  const origin = new URL(KK_API).origin;
  const f = String(filter || '').toLowerCase();
  return rows
    .filter(r => (r.datum_bis || r.datum_von) >= today)
    .filter(r => !f || String(r.verein_name || '').toLowerCase().includes(f))
    .map(r => ({
      kk_id: r.id,
      title: r.titel,
      event_date: r.datum_von,
      event_time: r.beginn || '',
      location: [r.ort_name, r.ort_adresse].filter(Boolean).join(', '),
      ticket_url: r.vorverkauf_link || '',
      price: r.eintritt || '',
      description: r.beschreibung || '',
      kk_image_url: r.bild_path || r.web_bild_path ? origin + (r.bild_path || r.web_bild_path) : '',
      verein: r.verein_name,
      kk_url: `${origin}/termin/${r.id}`,
    }));
}

// ---------- Routen ----------
function campaignRow(c) {
  if (!c) return c;
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM mk_posts WHERE campaign_id = ? GROUP BY status`).all(c.id);
  const a = c.account_id ? db.prepare('SELECT name, handle FROM mk_accounts WHERE id = ?').get(c.account_id) : null;
  return { ...c, account_name: a ? a.name : null, account_handle: a ? a.handle : null, platforms: JSON.parse(c.platforms || '[]'), post_counts: Object.fromEntries(counts.map(r => [r.status, r.n])) };
}

function campaignInput(b, existing) {
  const e = existing || {};
  const pick = (k, max) => (b[k] !== undefined ? clean(b[k], max) : e[k] ?? null);
  const out = {
    title: pick('title', 300),
    account_id: b.account_id !== undefined ? (db.prepare('SELECT id FROM mk_accounts WHERE id = ?').get(Number(b.account_id)) || {}).id || null : e.account_id ?? getAccount(null).id ?? null,
    kk_id: b.kk_id !== undefined ? (Number(b.kk_id) || null) : e.kk_id ?? null,
    event_date: b.event_date !== undefined ? b.event_date : e.event_date,
    event_time: pick('event_time', 20),
    location: pick('location', 500),
    ticket_url: pick('ticket_url', 1000),
    price: pick('price', 300),
    description: pick('description', 6000),
    kk_image_url: pick('kk_image_url', 1000),
    dropbox_folder: pick('dropbox_folder', 1000),
    start_date: b.start_date !== undefined ? b.start_date : e.start_date,
    post_time: b.post_time !== undefined ? b.post_time : (e.post_time || getSettings().default_post_time),
    post_kind: ['auto', 'feed', 'story'].includes(b.post_kind) ? b.post_kind : (e.post_kind || 'auto'),
    platforms: Array.isArray(b.platforms) ? JSON.stringify(['instagram', 'facebook'].filter(p => b.platforms.includes(p))) : (e.platforms || '["instagram","facebook"]'),
    style_brief: pick('style_brief', 3000),
    notes: pick('notes', 3000),
    active: b.active !== undefined ? (b.active ? 1 : 0) : (e.active ?? 1),
  };
  if (!out.title) return { error: 'Bitte einen Titel angeben' };
  if (!out.account_id) return { error: 'Bitte ein Konto wählen' };
  if (!isDate(out.event_date)) return { error: 'Bitte das Datum der Veranstaltung angeben' };
  if (!isDate(out.start_date)) out.start_date = berlinNow().date;
  if (out.start_date > out.event_date) return { error: 'Der Kampagnenstart liegt nach der Veranstaltung' };
  if (!isTime(out.post_time)) return { error: 'Uhrzeit bitte als HH:MM angeben' };
  return { value: out };
}

const CAMPAIGN_COLS = ['title', 'account_id', 'kk_id', 'event_date', 'event_time', 'location', 'ticket_url', 'price', 'description', 'kk_image_url',
  'dropbox_folder', 'start_date', 'post_time', 'post_kind', 'platforms', 'style_brief', 'notes', 'active'];

function register(app) {
  // Oeffentlich (ohne Login): freigegebene Bilder, damit Instagram/Facebook sie abholen koennen
  app.get('/m/:file', (req, res) => {
    const file = req.params.file;
    if (!/^[a-f0-9]{32}\.jpg$/.test(file)) return res.status(404).end();
    const ok = db.prepare(`SELECT 1 FROM mk_posts WHERE image_file = ? AND status IN ('approved', 'publishing', 'published', 'failed')`).get(file);
    if (!ok) return res.status(404).end();
    res.sendFile(path.join(FILE_DIR, file));
  });

  // Vorschaubilder/Dateien fuer angemeldete Nutzer
  app.get('/api/marketing/files/:file', (req, res) => {
    const file = req.params.file;
    if (!/^[a-f0-9]{32}\.(jpg|png)$/.test(file)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(FILE_DIR, file), err => { if (err && !res.headersSent) res.status(404).end(); });
  });

  app.get('/api/marketing/status', async (req, res) => {
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM mk_posts WHERE status = 'pending'`).get().n;
    const accounts = db.prepare('SELECT * FROM mk_accounts ORDER BY sort, id').all().map(accountRow);
    res.json({
      ai: !!process.env.ANTHROPIC_API_KEY,
      dropbox: dropbox.isConfigured(),
      dropbox_root: dropbox.rootPath(),
      oauth: meta.oauthConfigured(),
      accounts,
      meta: { instagram: accounts.some(a => a.status.instagram), facebook: accounts.some(a => a.status.facebook) },
      pending,
    });
  });

  // ---------- Konten ----------
  app.get('/api/marketing/accounts', (req, res) => {
    res.json(db.prepare('SELECT * FROM mk_accounts ORDER BY sort, id').all().map(accountRow));
  });
  app.post('/api/marketing/accounts', (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 200);
    if (!name) return res.status(400).json({ error: 'Bitte einen Namen angeben' });
    const sort = (db.prepare('SELECT MAX(sort) AS m FROM mk_accounts').get().m || 0) + 1;
    const info = db.prepare('INSERT INTO mk_accounts (name, sort) VALUES (?, ?)').run(name, sort);
    res.status(201).json(accountRow(db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(info.lastInsertRowid)));
  });
  app.put('/api/marketing/accounts/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Konto nicht gefunden' });
    const b = req.body || {};
    const v = {};
    for (const k of ACCOUNT_FIELDS) v[k] = b[k] !== undefined ? clean(b[k], 6000) : a[k];
    if (!v.name) return res.status(400).json({ error: 'Bitte einen Namen angeben' });
    if (v.handle && !v.handle.startsWith('@')) v.handle = '@' + v.handle;
    db.prepare(`UPDATE mk_accounts SET ${ACCOUNT_FIELDS.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...ACCOUNT_FIELDS.map(k => v[k]), a.id);
    res.json(accountRow(db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(a.id)));
  });
  app.delete('/api/marketing/accounts/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Konto nicht gefunden' });
    if (db.prepare('SELECT 1 FROM mk_campaigns WHERE account_id = ?').get(a.id)) return res.status(409).json({ error: 'Zu diesem Konto gibt es noch Kampagnen – bitte erst diese löschen oder einem anderen Konto zuordnen.' });
    db.prepare('DELETE FROM mk_accounts WHERE id = ?').run(a.id);
    res.status(204).end();
  });
  app.get('/api/marketing/accounts/:id/check', async (req, res) => {
    const a = db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Konto nicht gefunden' });
    res.json(await meta.checkAccount(a));
  });
  app.post('/api/marketing/accounts/:id/disconnect', (req, res) => {
    db.prepare(`UPDATE mk_accounts SET token = NULL, token_kind = NULL, token_expires = NULL, token_refreshed_at = NULL,
      ig_user_id = NULL, ig_username = NULL, fb_page_id = NULL, fb_page_name = NULL WHERE id = ?`).run(req.params.id);
    res.json(accountRow(getAccount(req.params.id)));
  });

  // Gefundene Verbindungen (nach Facebook-Login oder eingefuegtem Token) kurz im Speicher halten,
  // damit man sie einem Konto zuordnen kann. Tokens gehen nie an den Browser.
  const linkSets = new Map();
  const norm = (h) => String(h || '').replace(/^@/, '').trim().toLowerCase();
  function storeOptions(options, userId) {
    for (const [k, v] of linkSets) if (Date.now() - v.at > 3600000) linkSets.delete(k);
    const key = crypto.randomBytes(12).toString('hex');
    linkSets.set(key, { at: Date.now(), userId, options });
    return key;
  }
  function linkAccount(accountId, o) {
    db.prepare(`UPDATE mk_accounts SET token = ?, token_kind = ?, ig_user_id = ?, ig_username = ?, fb_page_id = ?, fb_page_name = ?,
      token_refreshed_at = datetime('now'), token_expires = CASE WHEN ? THEN datetime('now', '+60 days') ELSE NULL END WHERE id = ?`)
      .run(o.token, o.token_kind, o.ig_user_id, o.ig_username, o.fb_page_id, o.fb_page_name, o.token_kind === 'instagram' ? 1 : 0, accountId);
  }
  // Konten automatisch zuordnen, deren @Name zum gefundenen Instagram-Konto passt
  function autoLink(options) {
    const linked = [];
    for (const a of db.prepare('SELECT * FROM mk_accounts').all()) {
      const o = options.find(x => x.ig_username && norm(x.ig_username) === norm(a.handle));
      if (o) { linkAccount(a.id, o); linked.push(`${a.name} → @${o.ig_username}${o.fb_page_name ? ` + Facebook „${o.fb_page_name}“` : ''}`); }
    }
    return linked;
  }
  const publicOptions = (options) => options.map((o, i) => ({
    index: i, token_kind: o.token_kind, ig_username: o.ig_username, fb_page_name: o.fb_page_name,
  }));

  app.post('/api/marketing/accounts/:id/token', async (req, res) => {
    const a = db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Konto nicht gefunden' });
    try {
      const options = await meta.resolveToken((req.body || {}).token);
      if (!options.length) return res.status(400).json({ error: 'Mit diesem Token wurden keine Facebook-Seiten oder Instagram-Konten gefunden.' });
      // Genau ein Treffer -> direkt diesem Konto zuordnen; sonst automatisch nach @Name, Rest zur Auswahl
      if (options.length === 1) {
        linkAccount(a.id, options[0]);
        return res.json({ linked: [`${a.name} → ${options[0].ig_username ? '@' + options[0].ig_username : ''}${options[0].fb_page_name ? ` Facebook „${options[0].fb_page_name}“` : ''}`], key: null, options: [] });
      }
      const linked = autoLink(options);
      res.json({ linked, key: storeOptions(options, req.user.id), options: publicOptions(options) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/marketing/link-options/:key', (req, res) => {
    const set = linkSets.get(req.params.key);
    if (!set || set.userId !== req.user.id) return res.status(404).json({ error: 'Die Auswahl ist abgelaufen – bitte erneut verbinden.' });
    res.json({ options: publicOptions(set.options) });
  });
  app.post('/api/marketing/accounts/:id/link', (req, res) => {
    const a = db.prepare('SELECT * FROM mk_accounts WHERE id = ?').get(req.params.id);
    const set = linkSets.get(String((req.body || {}).key || ''));
    if (!a) return res.status(404).json({ error: 'Konto nicht gefunden' });
    if (!set || set.userId !== req.user.id) return res.status(410).json({ error: 'Die Auswahl ist abgelaufen – bitte erneut verbinden.' });
    const o = set.options[Number(req.body.index)];
    if (!o) return res.status(400).json({ error: 'Bitte eine Seite bzw. ein Instagram-Konto wählen' });
    const fbOnly = req.body.only === 'facebook';
    const igOnly = req.body.only === 'instagram';
    linkAccount(a.id, { ...o, ig_user_id: fbOnly ? null : o.ig_user_id, ig_username: fbOnly ? null : o.ig_username,
      fb_page_id: igOnly ? null : o.fb_page_id, fb_page_name: igOnly ? null : o.fb_page_name });
    res.json(accountRow(getAccount(a.id)));
  });

  // "Mit Facebook verbinden": Login bei Meta, danach werden alle Seiten + Instagram-Konten gefunden
  const oauthStates = new Map();
  const redirectUri = () => `${publicBaseUrl()}/api/marketing/meta/callback`;
  app.get('/api/marketing/meta/connect', (req, res) => {
    if (!meta.oauthConfigured()) return res.status(503).send('META_APP_ID / META_APP_SECRET fehlen in Railway.');
    for (const [k, v] of oauthStates) if (Date.now() - v.at > 900000) oauthStates.delete(k);
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, { at: Date.now(), userId: req.user.id });
    res.redirect(meta.oauthUrl(redirectUri(), state));
  });
  app.get('/api/marketing/meta/callback', async (req, res) => {
    const st = oauthStates.get(String(req.query.state || ''));
    oauthStates.delete(String(req.query.state || ''));
    const back = (params) => res.redirect(`/?${new URLSearchParams({ mk_connect: '1', ...params })}`);
    if (!st || st.userId !== req.user.id) return back({ mk_error: 'Anmeldung abgelaufen – bitte erneut verbinden.' });
    if (req.query.error) return back({ mk_error: String(req.query.error_description || req.query.error) });
    try {
      const userToken = await meta.exchangeCode(String(req.query.code || ''), redirectUri());
      const options = (await meta.pagesForUserToken(userToken)).map(p => ({ ...p, token_kind: 'facebook' }));
      if (!options.length) return back({ mk_error: 'Es wurden keine Facebook-Seiten gefunden. Beim Login alle Seiten (und die verknüpften Instagram-Konten) auswählen.' });
      const linked = autoLink(options);
      back({ mk_key: storeOptions(options, req.user.id), mk_linked: linked.join('\n') });
    } catch (e) {
      back({ mk_error: e.message });
    }
  });

  app.get('/api/marketing/settings', (req, res) => res.json(getSettings()));
  app.put('/api/marketing/settings', (req, res) => {
    const b = req.body || {};
    const up = db.prepare('INSERT INTO mk_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of SETTING_KEYS) if (b[k] !== undefined) up.run(k, clean(b[k], 6000) || '');
    const s = getSettings();
    if (!isTime(s.default_post_time)) up.run('default_post_time', '18:00');
    res.json(getSettings());
  });

  // Kulturkalender-Termine (Kreatief) zur Uebernahme in eine Kampagne
  app.get('/api/marketing/kk-events', async (req, res) => {
    try {
      res.json(await kkEvents(req.query.all ? '' : (getAccount(req.query.account_id).kk_filter || '')));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Dropbox
  app.get('/api/marketing/dropbox/list', async (req, res) => {
    try {
      const p = req.query.path !== undefined ? String(req.query.path) : dropbox.rootPath();
      res.json({ path: p, entries: await dropbox.listFolder(p) });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  app.get('/api/marketing/dropbox/thumb', async (req, res) => {
    try {
      const size = ['w256h256', 'w640h480', 'w1024h768'].includes(req.query.size) ? req.query.size : 'w256h256';
      const buf = await dropbox.thumbnail(String(req.query.path || ''), size);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=86400');
      res.send(buf);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  app.get('/api/marketing/dropbox/count', async (req, res) => {
    try {
      const items = await dropbox.listMediaRecursive(String(req.query.path || ''));
      res.json({ images: items.filter(i => i.media === 'image').length, videos: items.filter(i => i.media === 'video').length });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Kampagnen
  app.get('/api/marketing/campaigns', (req, res) => {
    res.json(db.prepare('SELECT * FROM mk_campaigns ORDER BY active DESC, event_date ASC').all().map(campaignRow));
  });
  app.post('/api/marketing/campaigns', (req, res) => {
    const { value, error } = campaignInput(req.body || {});
    if (error) return res.status(400).json({ error });
    const info = db.prepare(`INSERT INTO mk_campaigns (${CAMPAIGN_COLS.join(', ')}, created_by) VALUES (${CAMPAIGN_COLS.map(() => '?').join(', ')}, ?)`)
      .run(...CAMPAIGN_COLS.map(k => value[k]), req.user.id);
    const c = db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(info.lastInsertRowid);
    // Gleich den ersten Entwurf erzeugen
    if (req.body.generate_first !== false && process.env.ANTHROPIC_API_KEY && c.active) createPost(c, nextFreeDate(c), null);
    res.status(201).json(campaignRow(c));
  });
  app.put('/api/marketing/campaigns/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Kampagne nicht gefunden' });
    const { value, error } = campaignInput(req.body || {}, c);
    if (error) return res.status(400).json({ error });
    db.prepare(`UPDATE mk_campaigns SET ${CAMPAIGN_COLS.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPAIGN_COLS.map(k => value[k]), c.id);
    // Neue Uhrzeit auch fuer noch nicht veroeffentlichte Posts uebernehmen
    if (value.post_time !== c.post_time) {
      db.prepare(`UPDATE mk_posts SET publish_at = post_date || ' ' || ? WHERE campaign_id = ? AND status IN ('generating', 'pending', 'approved', 'error')`).run(value.post_time, c.id);
    }
    res.json(campaignRow(db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(c.id)));
  });
  app.delete('/api/marketing/campaigns/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Kampagne nicht gefunden' });
    if (db.prepare(`SELECT 1 FROM mk_posts WHERE campaign_id = ? AND status IN ('generating', 'publishing')`).get(c.id)) {
      return res.status(409).json({ error: 'Gerade wird ein Post erstellt oder veröffentlicht – bitte kurz warten.' });
    }
    for (const p of db.prepare('SELECT image_file FROM mk_posts WHERE campaign_id = ?').all(c.id)) removeFile(p.image_file);
    db.prepare('DELETE FROM mk_campaigns WHERE id = ?').run(c.id);
    res.status(204).end();
  });
  app.post('/api/marketing/campaigns/:id/generate', (req, res) => {
    const c = db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Kampagne nicht gefunden' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Die KI ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
    const b = req.body || {};
    let date = isDate(b.date) ? b.date : nextFreeDate(c);
    if (db.prepare(`SELECT 1 FROM mk_posts WHERE campaign_id = ? AND post_date = ? AND status NOT IN ('rejected', 'error')`).get(c.id, date)) {
      return res.status(409).json({ error: 'Für diesen Tag gibt es schon einen Post' });
    }
    const id = createPost(c, date, b.hint);
    res.status(202).json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(id)));
  });

  // Posts
  app.get('/api/marketing/posts', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.campaign_id) { where.push('p.campaign_id = ?'); params.push(req.query.campaign_id); }
    if (req.query.status && POST_STATUSES.includes(req.query.status)) { where.push('p.status = ?'); params.push(req.query.status); }
    const rows = db.prepare(`SELECT p.*, c.title AS campaign_title, c.event_date AS campaign_event_date, c.account_id, a.name AS account_name, a.handle AS account_handle
      FROM mk_posts p LEFT JOIN mk_campaigns c ON c.id = p.campaign_id LEFT JOIN mk_accounts a ON a.id = c.account_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.post_date DESC, p.id DESC LIMIT 200`).all(...params);
    res.json(rows.map(postRow));
  });
  app.get('/api/marketing/posts/:id', (req, res) => {
    const p = db.prepare(`SELECT p.*, c.title AS campaign_title, c.event_date AS campaign_event_date, c.account_id, a.name AS account_name, a.handle AS account_handle
      FROM mk_posts p LEFT JOIN mk_campaigns c ON c.id = p.campaign_id LEFT JOIN mk_accounts a ON a.id = c.account_id WHERE p.id = ?`).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Post nicht gefunden' });
    res.json(postRow(p));
  });
  app.get('/api/marketing/posts/:id/video', async (req, res) => {
    const p = db.prepare('SELECT video_path FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p || !p.video_path) return res.status(404).json({ error: 'Kein Video' });
    try { res.redirect(await dropbox.temporaryLink(p.video_path)); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.put('/api/marketing/posts/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Post nicht gefunden' });
    if (['publishing', 'published'].includes(p.status)) return res.status(409).json({ error: 'Bereits veröffentlicht' });
    const b = req.body || {};
    const caption = b.caption !== undefined ? clean(b.caption, 2200) : p.caption;
    const platforms = Array.isArray(b.platforms) ? JSON.stringify(['instagram', 'facebook'].filter(x => b.platforms.includes(x))) : p.platforms;
    let publishAt = p.publish_at;
    if (b.publish_at !== undefined) {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(String(b.publish_at));
      if (!m) return res.status(400).json({ error: 'Zeitpunkt bitte als Datum und Uhrzeit angeben' });
      publishAt = `${m[1]} ${m[2]}`;
    }
    db.prepare(`UPDATE mk_posts SET caption = ?, platforms = ?, publish_at = ?, updated_at = datetime('now') WHERE id = ?`).run(caption, platforms, publishAt, p.id);
    res.json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(p.id)));
  });
  app.post('/api/marketing/posts/:id/approve', (req, res) => {
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Post nicht gefunden' });
    if (!['pending', 'failed', 'rejected'].includes(p.status)) return res.status(409).json({ error: 'Dieser Post kann gerade nicht freigegeben werden' });
    if (!JSON.parse(p.platforms || '[]').length) return res.status(400).json({ error: 'Bitte mindestens eine Plattform auswählen' });
    db.prepare(`UPDATE mk_posts SET status = 'approved', error = NULL, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(req.user.id, p.id);
    publishDue().catch(e => console.error('[Marketing] Veröffentlichen:', e.message));
    res.json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(p.id)));
  });
  app.post('/api/marketing/posts/:id/unapprove', (req, res) => {
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p || p.status !== 'approved') return res.status(409).json({ error: 'Post ist nicht freigegeben' });
    db.prepare(`UPDATE mk_posts SET status = 'pending', approved_by = NULL, approved_at = NULL WHERE id = ?`).run(p.id);
    res.json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(p.id)));
  });
  app.post('/api/marketing/posts/:id/reject', (req, res) => {
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p || ['generating', 'publishing', 'published'].includes(p.status)) return res.status(409).json({ error: 'Dieser Post kann nicht verworfen werden' });
    db.prepare(`UPDATE mk_posts SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(p.id);
    res.json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(p.id)));
  });
  app.post('/api/marketing/posts/:id/regenerate', (req, res) => {
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Post nicht gefunden' });
    if (['generating', 'publishing', 'published'].includes(p.status)) return res.status(409).json({ error: 'Dieser Post kann gerade nicht neu erstellt werden' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Die KI ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
    const hint = clean((req.body || {}).feedback, 1000);
    // Mit Feedback wird der bisherige Entwurf ueberarbeitet, ohne ganz neu gestaltet
    const keepSvg = hint && (req.body || {}).mode !== 'new';
    db.prepare(`UPDATE mk_posts SET status = 'generating', error = NULL, hint = ?, svg = CASE WHEN ? THEN svg ELSE NULL END, approved_by = NULL, approved_at = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(hint, keepSvg ? 1 : 0, p.id);
    generatePost(p.id);
    res.status(202).json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(p.id)));
  });
  app.post('/api/marketing/posts/:id/publish-now', async (req, res) => {
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p || !['approved', 'failed'].includes(p.status)) return res.status(409).json({ error: 'Nur freigegebene Posts können veröffentlicht werden' });
    const c = p.campaign_id ? db.prepare('SELECT account_id FROM mk_campaigns WHERE id = ?').get(p.campaign_id) : null;
    const st = meta.accountStatus(getAccount(c && c.account_id));
    if (!st.instagram && !st.facebook) return res.status(503).json({ error: 'Instagram/Facebook sind für dieses Konto noch nicht verbunden' });
    await publishPost(p.id);
    res.json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(p.id)));
  });
  app.post('/api/marketing/posts/:id/mark-published', (req, res) => {
    // Manuell gepostet (z.B. solange Instagram/Facebook nicht verbunden sind)
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p || !['approved', 'failed', 'pending'].includes(p.status)) return res.status(409).json({ error: 'Nicht möglich' });
    db.prepare(`UPDATE mk_posts SET status = 'published', error = NULL, published_at = datetime('now') WHERE id = ?`).run(p.id);
    res.json(postRow(db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(p.id)));
  });
  app.delete('/api/marketing/posts/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM mk_posts WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Post nicht gefunden' });
    if (['generating', 'publishing'].includes(p.status)) return res.status(409).json({ error: 'Bitte kurz warten' });
    removeFile(p.image_file);
    db.prepare('DELETE FROM mk_posts WHERE id = ?').run(p.id);
    res.status(204).end();
  });

  // Druckformate (Flyeralarm-Vorgaben)
  app.get('/api/marketing/presets', (req, res) => res.json(db.prepare('SELECT * FROM mk_presets ORDER BY sort, id').all()));
  const presetInput = (b) => {
    const num = (v, min, max) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
    const out = {
      name: clean(b.name, 200), category: clean(b.category, 100) || 'Sonstiges',
      width_mm: num(b.width_mm, 10, 20000), height_mm: num(b.height_mm, 10, 20000),
      bleed_mm: num(b.bleed_mm, 0, 200), safe_mm: num(b.safe_mm, 0, 500), notes: clean(b.notes, 2000),
    };
    if (!out.name || out.width_mm === null || out.height_mm === null || out.bleed_mm === null || out.safe_mm === null) return null;
    return out;
  };
  app.post('/api/marketing/presets', (req, res) => {
    const v = presetInput(req.body || {});
    if (!v) return res.status(400).json({ error: 'Bitte Name und alle Maße angeben' });
    const sort = (db.prepare('SELECT MAX(sort) AS m FROM mk_presets').get().m || 0) + 1;
    const info = db.prepare('INSERT INTO mk_presets (name, category, width_mm, height_mm, bleed_mm, safe_mm, notes, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(v.name, v.category, v.width_mm, v.height_mm, v.bleed_mm, v.safe_mm, v.notes, sort);
    res.status(201).json(db.prepare('SELECT * FROM mk_presets WHERE id = ?').get(info.lastInsertRowid));
  });
  app.put('/api/marketing/presets/:id', (req, res) => {
    const v = presetInput(req.body || {});
    if (!v) return res.status(400).json({ error: 'Bitte Name und alle Maße angeben' });
    const info = db.prepare('UPDATE mk_presets SET name = ?, category = ?, width_mm = ?, height_mm = ?, bleed_mm = ?, safe_mm = ?, notes = ? WHERE id = ?')
      .run(v.name, v.category, v.width_mm, v.height_mm, v.bleed_mm, v.safe_mm, v.notes, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Format nicht gefunden' });
    res.json(db.prepare('SELECT * FROM mk_presets WHERE id = ?').get(req.params.id));
  });
  app.delete('/api/marketing/presets/:id', (req, res) => {
    db.prepare('DELETE FROM mk_presets WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // Grafiken (Druck)
  app.get('/api/marketing/designs', (req, res) => {
    res.json(db.prepare('SELECT * FROM mk_designs ORDER BY updated_at DESC').all().map(designRow));
  });
  app.get('/api/marketing/designs/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Grafik nicht gefunden' });
    res.json(designRow(d));
  });
  const designInput = (b, existing) => {
    const e = existing || {};
    let format = e.format ? JSON.parse(e.format) : null;
    let presetId = e.preset_id || null;
    if (b.preset_id !== undefined) {
      const p = db.prepare('SELECT * FROM mk_presets WHERE id = ?').get(b.preset_id);
      if (!p) return { error: 'Bitte ein Format wählen' };
      presetId = p.id;
      format = { name: p.name, width_mm: p.width_mm, height_mm: p.height_mm, bleed_mm: p.bleed_mm, safe_mm: p.safe_mm, notes: p.notes || '' };
    }
    if (!format) return { error: 'Bitte ein Format wählen' };
    const title = b.title !== undefined ? clean(b.title, 300) : e.title;
    if (!title) return { error: 'Bitte einen Titel angeben' };
    const media = Array.isArray(b.media) ? JSON.stringify(b.media.map(String).slice(0, 8)) : (e.media || '[]');
    const campaignId = b.campaign_id !== undefined ? (Number(b.campaign_id) || null) : (e.campaign_id || null);
    return {
      value: {
        title, preset_id: presetId, format: JSON.stringify(format), campaign_id: campaignId, media,
        content: b.content !== undefined ? clean(b.content, 6000) : e.content,
        brief: b.brief !== undefined ? clean(b.brief, 4000) : e.brief,
      },
    };
  };
  const DESIGN_COLS = ['title', 'preset_id', 'format', 'campaign_id', 'media', 'content', 'brief'];
  app.post('/api/marketing/designs', (req, res) => {
    const { value, error } = designInput(req.body || {});
    if (error) return res.status(400).json({ error });
    const info = db.prepare(`INSERT INTO mk_designs (${DESIGN_COLS.join(', ')}, created_by) VALUES (${DESIGN_COLS.map(() => '?').join(', ')}, ?)`)
      .run(...DESIGN_COLS.map(k => value[k]), req.user.id);
    res.status(201).json(designRow(db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(info.lastInsertRowid)));
  });
  app.put('/api/marketing/designs/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Grafik nicht gefunden' });
    const { value, error } = designInput(req.body || {}, d);
    if (error) return res.status(400).json({ error });
    db.prepare(`UPDATE mk_designs SET ${DESIGN_COLS.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...DESIGN_COLS.map(k => value[k]), d.id);
    res.json(designRow(db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(d.id)));
  });
  app.delete('/api/marketing/designs/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Grafik nicht gefunden' });
    if (d.status === 'generating') return res.status(409).json({ error: 'Bitte kurz warten' });
    for (const v of db.prepare('SELECT preview_file FROM mk_design_versions WHERE design_id = ?').all(d.id)) removeFile(v.preview_file);
    db.prepare('DELETE FROM mk_designs WHERE id = ?').run(d.id);
    res.status(204).end();
  });
  app.post('/api/marketing/designs/:id/generate', (req, res) => {
    const d = db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Grafik nicht gefunden' });
    if (d.status === 'generating') return res.status(409).json({ error: 'Die Grafik wird gerade erstellt' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Die KI ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
    const b = req.body || {};
    const base = b.base_version_id ? Number(b.base_version_id) : null;
    db.prepare(`UPDATE mk_designs SET status = 'generating', error = NULL, updated_at = datetime('now') WHERE id = ?`).run(d.id);
    generateDesign(d.id, clean(b.feedback, 2000), base);
    res.status(202).json(designRow(db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(d.id)));
  });
  app.delete('/api/marketing/designs/:id/versions/:vid', (req, res) => {
    const v = db.prepare('SELECT * FROM mk_design_versions WHERE id = ? AND design_id = ?').get(req.params.vid, req.params.id);
    if (!v) return res.status(404).json({ error: 'Fassung nicht gefunden' });
    removeFile(v.preview_file);
    db.prepare('DELETE FROM mk_design_versions WHERE id = ?').run(v.id);
    res.status(204).end();
  });
  app.get('/api/marketing/designs/:id/versions/:vid/pdf', async (req, res) => {
    const d = db.prepare('SELECT * FROM mk_designs WHERE id = ?').get(req.params.id);
    const v = d && db.prepare('SELECT * FROM mk_design_versions WHERE id = ? AND design_id = ?').get(req.params.vid, d.id);
    if (!v) return res.status(404).json({ error: 'Fassung nicht gefunden' });
    try {
      const format = designFormat(d);
      const media = JSON.parse(d.media || '[]');
      const candidates = media.map((p, i) => ({ id: `img${i + 1}`, source: 'dropbox', path: p, name: p.split('/').pop(), media: 'image' }));
      const campaign = d.campaign_id ? db.prepare('SELECT * FROM mk_campaigns WHERE id = ?').get(d.campaign_id) : null;
      if (!candidates.length && campaign && campaign.kk_image_url) candidates.push({ id: 'img1', source: 'url', url: campaign.kk_image_url, media: 'image' });
      const images = await loadRenderImages({ svg: v.svg, media_ids: [] }, candidates, await loadLogo(getAccount(campaign && campaign.account_id)), true);
      const rgb = await renderPdf(v.svg, images, format.width_mm + 2 * format.bleed_mm, format.height_mm + 2 * format.bleed_mm, { title: d.title });
      const { pdf, cmyk } = await toCmyk(rgb);
      res.set('X-Color-Space', cmyk ? 'CMYK' : 'RGB');
      const fname = `${d.title} – ${format.name}`.replace(/[^\wäöüÄÖÜß .–-]+/g, '').trim() || 'Druckdaten';
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="druckdaten.pdf"; filename*=UTF-8''${encodeURIComponent(fname)}.pdf`);
      res.send(pdf);
    } catch (e) {
      console.error('[Marketing] PDF-Export fehlgeschlagen:', e);
      res.status(500).json({ error: `PDF konnte nicht erstellt werden: ${e.message}` });
    }
  });
}

module.exports = { register, _test: { renderRaster, renderPdf, designWithReview, berlinNow, nextFreeDate, facebookCaption } };
