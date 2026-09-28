// Rendert die von der KI entworfenen SVG-Grafiken: als PNG/JPEG (Social Media, Vorschau) mit
// resvg und als Druck-PDF (Vektor, Text in Pfade umgewandelt) mit PDFKit. Schriften liegen im
// Ordner fonts/ (Google Fonts, SIL Open Font License) und sind damit auf dem Server identisch.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Resvg } = require('@resvg/resvg-js');
const jpeg = require('jpeg-js');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'fonts');

// Schriften, die die KI verwenden darf (Familie -> verfuegbare Schnitte)
const FONTS = {
  'Anton': 'sehr schmale, fette Plakat-Grotesk (nur 400) – große Headlines, Versalien',
  'Bebas Neue': 'schmale Versal-Grotesk (nur 400) – Headlines, Datumszeilen',
  'Oswald': 'schmale Grotesk 400/700 – Headlines, Infozeilen',
  'Archivo Black': 'breite, sehr fette Grotesk (nur 400) – plakative Headlines',
  'Montserrat': 'geometrische Grotesk 400/600/800/900, 400 kursiv – Fließtext, Infos, Buttons',
  'Inter': 'neutrale Grotesk 400/600/800 – Fließtext, kleine Infos',
  'Space Grotesk': 'moderne Grotesk mit Charakter 400/700',
  'Playfair Display': 'elegante Serifenschrift 400/700/900, 400 kursiv – Titel mit Klasse, Zitate',
  'DM Serif Display': 'kontrastreiche Display-Serif 400 und kursiv',
  'Abril Fatface': 'fette Didone (nur 400) – dramatische Titel',
  'Caveat': 'Handschrift 700 – kurze persönliche Akzente',
};

function mimeOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}

// EXIF-Ausrichtung eines JPEG (1 = normal). resvg ignoriert sie, PDFKit wertet sie aus -
// deshalb werden gedrehte Fotos vorab einheitlich "gerade" gerechnet.
function exifOrientation(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return 1;
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('ascii', i + 4, i + 8) === 'Exif') {
      const t = i + 10;
      const le = buf.toString('ascii', t, t + 2) === 'II';
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 1;
}

const oriented = new WeakMap();
function orientImage(buf) {
  const o = exifOrientation(buf);
  if (o === 1) return buf;
  if (oriented.has(buf)) return oriented.get(buf);
  const size = imageSize(buf);
  if (!size) return buf;
  const { w, h } = size;
  const swap = o >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  // Transformation, die das gespeicherte Bild in die richtige Lage bringt
  const tf = {
    2: `matrix(-1 0 0 1 ${w} 0)`, 3: `matrix(-1 0 0 -1 ${w} ${h})`, 4: `matrix(1 0 0 -1 0 ${h})`,
    5: 'matrix(0 1 1 0 0 0)', 6: `matrix(0 1 -1 0 ${h} 0)`, 7: `matrix(0 -1 -1 0 ${h} ${w})`, 8: `matrix(0 -1 1 0 0 ${w})`,
  }[o];
  // Das JPEG ohne EXIF-Block einbetten, damit der Renderer nicht selbst noch einmal dreht
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g transform="${tf}"><image href="data:image/jpeg;base64,${stripExif(buf).toString('base64')}" width="${w}" height="${h}" preserveAspectRatio="none"/></g></svg>`;
  const out = new Resvg(svg, { background: 'rgba(255,255,255,1)', font: { loadSystemFonts: false } }).render();
  const res = jpeg.encode({ data: Buffer.from(out.pixels), width: out.width, height: out.height }, 92).data;
  oriented.set(buf, res);
  return res;
}

function stripExif(buf) {
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (marker !== 0xe1) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

// Unsichere/unnoetige Teile entfernen und Bild-Platzhalter (href="img3") durch Daten ersetzen
function prepareSvg(svg, images) {
  let s = String(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
  s = s.replace(/(\s(?:xlink:)?href)="([^"]*)"/g, (m, attr, ref) => {
    if (ref.startsWith('#')) return m;
    const buf = images[ref] && orientImage(images[ref]);
    if (!buf) return `${attr}=""`;
    return `${attr}="data:${mimeOf(buf)};base64,${buf.toString('base64')}"`;
  });
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s)) s = s.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

function makeResvg(svg, width) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.round(width) },
    font: { fontDirs: [FONT_DIR], loadSystemFonts: false, defaultFontFamily: 'Inter' },
    background: 'rgba(255,255,255,1)',
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
  });
}

// Raster fuer Social Media / Vorschau. Liefert PNG und JPEG.
function renderRaster(svg, images, width, { jpegQuality = 90 } = {}) {
  const r = makeResvg(prepareSvg(svg, images), width);
  const out = r.render();
  const png = out.asPng();
  const jpg = jpeg.encode({ data: Buffer.from(out.pixels), width: out.width, height: out.height }, jpegQuality).data;
  return { png, jpg, width: out.width, height: out.height };
}

// Druck-PDF in exakter Datengroesse (Endformat + Beschnitt), Text als Vektorpfade
function renderPdf(svg, images, widthMm, heightMm, meta = {}) {
  const r = makeResvg(prepareSvg(svg, images), 1000);
  const flat = r.toString();
  const pt = (mm) => (mm * 72) / 25.4;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [pt(widthMm), pt(heightMm)], margin: 0, autoFirstPage: true,
      info: { Title: meta.title || 'Druckdaten', Creator: 'Office-Tool Marketing' },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    SVGtoPDF(doc, flat, 0, 0, { width: pt(widthMm), height: pt(heightMm), preserveAspectRatio: 'none' });
    doc.end();
  });
}

// Pixelmasse aus dem Dateikopf (JPEG, PNG, WebP)
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// Beliebiges Bild (JPEG/PNG/WebP/GIF) auf max. Kantenlaenge verkleinern und als JPEG liefern
function toJpeg(buf, maxDim) {
  const size = imageSize(buf);
  if (!size) throw new Error('Unbekanntes Bildformat');
  if (mimeOf(buf) === 'image/jpeg' && Math.max(size.w, size.h) <= maxDim) return buf;
  const scale = Math.min(1, maxDim / Math.max(size.w, size.h));
  const w = Math.max(1, Math.round(size.w * scale));
  const h = Math.max(1, Math.round(size.h * scale));
  const mime = mimeOf(buf);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="data:${mime};base64,${buf.toString('base64')}" width="${w}" height="${h}" preserveAspectRatio="none"/></svg>`;
  const out = new Resvg(svg, { background: 'rgba(255,255,255,1)', font: { loadSystemFonts: false } }).render();
  return jpeg.encode({ data: Buffer.from(out.pixels), width: out.width, height: out.height }, 90).data;
}

// Druckereien wie Flyeralarm verlangen CMYK. Ist Ghostscript installiert (auf Railway per
// nixpacks.toml), wird die PDF damit nach CMYK umgerechnet; sonst bleibt sie RGB.
let gsAvailable = null;
function hasGhostscript() {
  if (gsAvailable !== null) return Promise.resolve(gsAvailable);
  return new Promise(resolve => execFile('gs', ['--version'], (err) => { gsAvailable = !err; resolve(gsAvailable); }));
}

async function toCmyk(pdf) {
  if (!(await hasGhostscript())) return { pdf, cmyk: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pdf-'));
  const inFile = path.join(dir, 'in.pdf');
  const outFile = path.join(dir, 'out.pdf');
  fs.writeFileSync(inFile, pdf);
  try {
    await new Promise((resolve, reject) => execFile('gs', [
      '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6',
      '-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK', '-dAutoRotatePages=/None',
      '-dDownsampleColorImages=false', '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode', '-dJPEGQ=95',
      `-sOutputFile=${outFile}`, inFile,
    ], { timeout: 180000, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve())));
    return { pdf: fs.readFileSync(outFile), cmyk: true };
  } catch (e) {
    console.error('[Marketing] CMYK-Umwandlung fehlgeschlagen, liefere RGB:', e.message);
    return { pdf, cmyk: false };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { FONTS, renderRaster, renderPdf, toCmyk, prepareSvg, imageSize, toJpeg, mimeOf };
