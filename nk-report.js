// ================= NECKARSULMER KONZERTE: AUSWERTUNGEN & EXPORT =================
// Zahlen aller Konzerte fuer Diagramme/Jahresplanung (GET /api/nk/stats) und Export der
// Auswertung fuer Vorstand und Foerderer als Excel (.xlsx) bzw. PDF.

const path = require('path');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const db = require('./db');
const budget = require('./nk-budget');

const FONT = path.join(__dirname, 'fonts', 'Inter-400.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'Inter-600.ttf');

function newDoc(opts = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, ...opts });
  doc.registerFont('regular', FONT);
  doc.registerFont('bold', FONT_BOLD);
  doc.font('regular');
  return doc;
}
const euro = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const num = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('de-DE'));
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

function concertStats(year) {
  const concerts = db.prepare(`SELECT * FROM nk_concerts ${year ? 'WHERE substr(date, 1, 4) = ?' : ''} ORDER BY date IS NULL, date`).all(...(year ? [String(year)] : []));
  return concerts.map(c => {
    const out = { id: c.id, title: c.title, date: c.date, status: c.status, capacity: c.capacity, plan: null, ist: null };
    db.prepare('SELECT * FROM nk_budgets WHERE concert_id = ?').all(c.id).forEach(b => {
      const row = budget.budgetRow(b);
      out[b.kind] = { totals: row.totals, visitors: row.visitors, data: row.data };
    });
    try {
      const t = db.prepare('SELECT SUM(sold) AS sold, COUNT(*) AS n FROM nk_ticket_sources WHERE concert_id = ?').get(c.id);
      out.tickets_sold = t.n ? t.sold || 0 : null;
    } catch (e) { out.tickets_sold = null; }
    try { out.guest_total = db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM nk_guests WHERE concert_id = ?').get(c.id).n; } catch (e) { out.guest_total = 0; }
    try {
      out.sponsoring = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM nk_sponsorships WHERE concert_id = ? AND status != 'abgelehnt'").get(c.id).s;
    } catch (e) { out.sponsoring = 0; }
    try { out.fees = db.prepare('SELECT COALESCE(SUM(fee), 0) AS s FROM nk_concert_contacts WHERE concert_id = ?').get(c.id).s; } catch (e) { out.fees = 0; }
    return out;
  });
}

// Kennzahlen je Konzert (Ist, sonst nichts)
function metrics(c) {
  const ist = c.ist;
  const visitors = ist ? ist.visitors : null;
  const m = {
    visitors,
    utilization: visitors && c.capacity ? Math.round(visitors / c.capacity * 1000) / 10 : null,
    income: ist ? ist.totals.income : null, expense: ist ? ist.totals.expense : null, result: ist ? ist.totals.result : null,
    plan_result: c.plan ? c.plan.totals.result : null,
  };
  m.deviation = m.result !== null && m.plan_result !== null ? Math.round((m.result - m.plan_result) * 100) / 100 : null;
  m.cost_per_visitor = visitors && m.expense !== null ? Math.round(m.expense / visitors * 100) / 100 : null;
  m.subsidy_per_visitor = visitors && m.result !== null && m.result < 0 ? Math.round(-m.result / visitors * 100) / 100 : (visitors && m.result !== null ? 0 : null);
  return m;
}

function workbook(year) {
  const stats = concertStats(year).filter(c => c.status !== 'Abgesagt');
  const head = ['Datum', 'Konzert', 'Status', 'Kapazität', 'Besucher', 'Auslastung %', 'Einnahmen', 'Ausgaben', 'Ergebnis', 'Ergebnis Plan', 'Abweichung', 'Kosten je Besucher', 'Zuschuss je Besucher'];
  const rows = stats.map(c => {
    const m = metrics(c);
    return [c.date ? fmtDate(c.date) : '', c.title, c.status, c.capacity, m.visitors, m.utilization, m.income, m.expense, m.result, m.plan_result, m.deviation, m.cost_per_visitor, m.subsidy_per_visitor];
  });
  const settled = stats.map(metrics).filter(m => m.result !== null);
  rows.push([]);
  rows.push(['', 'Summe', '', '', settled.reduce((s, m) => s + (m.visitors || 0), 0), '', settled.reduce((s, m) => s + m.income, 0),
    settled.reduce((s, m) => s + m.expense, 0), settled.reduce((s, m) => s + m.result, 0)]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
  ws['!cols'] = [{ wch: 11 }, { wch: 40 }, { wch: 13 }, ...head.slice(3).map(() => ({ wch: 13 }))];
  XLSX.utils.book_append_sheet(wb, ws, 'Übersicht');

  // Alle Posten Plan vs. Ist
  const items = [['Datum', 'Konzert', 'Art', 'Posten', 'Plan', 'Ist', 'Abweichung']];
  stats.forEach(c => {
    ['income', 'expense'].forEach(section => {
      const labels = [...new Set([...(c.plan ? c.plan.data[section] : []), ...(c.ist ? c.ist.data[section] : [])].map(r => r.label))];
      labels.forEach(label => {
        const p = c.plan && c.plan.data[section].find(r => r.label === label);
        const i = c.ist && c.ist.data[section].find(r => r.label === label);
        const pa = p ? p.amount : null, ia = i ? i.amount : null;
        if (pa === null && ia === null) return;
        items.push([c.date ? fmtDate(c.date) : '', c.title, section === 'income' ? 'Einnahme' : 'Ausgabe', label, pa, ia, pa !== null && ia !== null ? Math.round((ia - pa) * 100) / 100 : null]);
      });
    });
  });
  const ws2 = XLSX.utils.aoa_to_sheet(items);
  ws2['!cols'] = [{ wch: 11 }, { wch: 36 }, { wch: 10 }, { wch: 32 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Posten Plan-Ist');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function pdfReport(year, res) {
  const stats = concertStats(year).filter(c => c.status !== 'Abgesagt');
  const doc = newDoc({ layout: 'landscape', margin: 40 });
  doc.pipe(res);
  doc.font('bold').fontSize(18).text(`Neckarsulmer Konzerte – Auswertung ${year || 'alle Jahre'}`);
  doc.font('regular').fontSize(9).fillColor('#777').text(`Stand ${new Date().toLocaleDateString('de-DE')}`).fillColor('#000').moveDown(1);

  const cols = [
    ['Datum', 62, 'left'], ['Konzert', 200, 'left'], ['Besucher', 58, 'right'], ['Auslastung', 62, 'right'], ['Einnahmen', 80, 'right'],
    ['Ausgaben', 80, 'right'], ['Ergebnis', 80, 'right'], ['Plan', 74, 'right'], ['Zuschuss*', 70, 'right'],
  ];
  const left = doc.page.margins.left;
  const row = (values, bold) => {
    if (doc.y > doc.page.height - 70) doc.addPage();
    const y = doc.y;
    let x = left;
    doc.font(bold ? 'bold' : 'regular').fontSize(9);
    values.forEach((v, i) => {
      doc.text(String(v ?? ''), x, y, { width: cols[i][1] - 6, align: cols[i][2], lineBreak: false, ellipsis: true });
      x += cols[i][1];
    });
    doc.y = y + 16;
    doc.moveTo(left, doc.y - 3).lineTo(left + cols.reduce((s, c) => s + c[1], 0), doc.y - 3).strokeColor('#e5e0d8').lineWidth(0.5).stroke();
  };
  row(cols.map(c => c[0]), true);
  let sumV = 0, sumI = 0, sumE = 0, sumR = 0, n = 0;
  stats.forEach(c => {
    const m = metrics(c);
    if (m.result !== null) { sumV += m.visitors || 0; sumI += m.income; sumE += m.expense; sumR += m.result; n++; }
    row([fmtDate(c.date), c.title, num(m.visitors), m.utilization !== null ? m.utilization.toLocaleString('de-DE') + ' %' : '–',
      euro(m.income), euro(m.expense), euro(m.result), euro(m.plan_result), euro(m.subsidy_per_visitor)]);
  });
  doc.moveDown(0.3);
  row(['', `Summe (${n} abgerechnet)`, num(sumV), '', euro(sumI), euro(sumE), euro(sumR), '', sumV ? euro(sumR < 0 ? -sumR / sumV : 0) : '–'], true);
  doc.moveDown(1.2);
  doc.font('regular').fontSize(8.5).fillColor('#777')
    .text('Ergebnis = Einnahmen − Ausgaben laut Abrechnung (Ist). Plan = Ergebnis der Kalkulation. * Zuschuss je Besucher = Fehlbetrag geteilt durch die Besucherzahl.', left);
  doc.end();
}

function register(app) {
  app.get('/api/nk/stats', (req, res) => {
    const stats = concertStats(req.query.year ? +req.query.year : null);
    let sponsorYears = [];
    try {
      sponsorYears = db.prepare(`SELECT COALESCE(sh.year, CAST(substr(c.date, 1, 4) AS INTEGER)) AS year, sh.status, SUM(sh.amount) AS amount
        FROM nk_sponsorships sh LEFT JOIN nk_concerts c ON c.id = sh.concert_id GROUP BY 1, 2`).all();
    } catch (e) { /* keine Sponsoren */ }
    res.json({ concerts: stats.map(c => ({ ...c, metrics: metrics(c) })), sponsor_years: sponsorYears });
  });
  app.get('/api/nk/report.xlsx', (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? +req.query.year : null;
    res.set('Content-Disposition', `attachment; filename="Neckarsulmer Konzerte Auswertung ${year || 'gesamt'}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(workbook(year));
  });
  app.get('/api/nk/report.pdf', (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? +req.query.year : null;
    res.set('Content-Disposition', `inline; filename="Neckarsulmer Konzerte Auswertung ${year || 'gesamt'}.pdf"`);
    res.type('application/pdf');
    pdfReport(year, res);
  });
}

module.exports = { register, newDoc, concertStats, metrics, euro, fmtDate };
