// ================= NECKARSULMER KONZERTE: KALKULATION & ABRECHNUNG =================
// Pro Konzert eine Kalkulation (Plan) und eine Abrechnung (Ist) im selben Tabellenformat:
// Einnahmen- und Ausgabenzeilen (Bezeichnung, Betrag, Notiz) plus Besucherzahl.
// Summen und Ergebnis rechnet immer der Server - auch beim Excel-Import, bei dem Claude die
// Tabelle nur liest und in Zeilen uebersetzt (Rechenfehler der KI fallen so nicht ins Gewicht).

const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');

const MODEL = 'claude-opus-5-5';
const KINDS = ['plan', 'ist'];
const MAX_ROWS = 120;
const MAX_SHEET_CHARS = 120000;

// Vorlage fuer neue Kalkulationen
const TEMPLATE = {
  income: [
    'Ticketverkauf Vorverkauf', 'Abendkasse', 'Sponsoren', 'Zuschüsse / Fördermittel', 'Spenden', 'Sonstige Einnahmen',
  ],
  expense: [
    'Gagen Künstler', 'Reise / Übernachtung', 'Saalmiete', 'Technik (Ton / Licht)', 'Werbung / Druck', 'GEMA',
    'Künstlersozialkasse (KSK)', 'Catering / Bewirtung', 'Personal / Helfer', 'Versicherung', 'Vorverkaufsgebühren', 'Sonstige Ausgaben',
  ],
};

function emptyBudget() {
  return {
    income: TEMPLATE.income.map(label => ({ label, amount: null, note: '' })),
    expense: TEMPLATE.expense.map(label => ({ label, amount: null, note: '' })),
    tickets: [{ label: 'Vorverkauf', price: null, count: null }, { label: 'Vorverkauf ermäßigt', price: null, count: null }, { label: 'Abendkasse', price: null, count: null }],
  };
}

function toAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  // deutsche Schreibweise "1.234,50 €" ebenso wie "1234.50"
  let s = String(v).replace(/[€\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.200 = Tausenderpunkt
  else if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAX_ROWS)
    .map(r => ({
      label: String((r && r.label) || '').trim().slice(0, 200),
      amount: toAmount(r && r.amount),
      note: String((r && r.note) || '').trim().slice(0, 500),
    }))
    .filter(r => r.label || r.amount !== null || r.note);
}

// Ticketpreise fuer den Kostendeckungs-Rechner: [{ label, price, count }] (count = geplante Anzahl, optional)
function cleanTickets(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 20).map(r => ({
    label: String((r && r.label) || '').trim().slice(0, 100),
    price: toAmount(r && r.price),
    count: cleanVisitors(r && r.count),
  })).filter(r => r.label || r.price !== null);
}

function cleanBudget(data) {
  return { income: cleanRows(data && data.income), expense: cleanRows(data && data.expense), tickets: cleanTickets(data && data.tickets) };
}

function cleanVisitors(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(+v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const sum = (rows) => Math.round(rows.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100;

function totals(data) {
  const income = sum(data.income || []);
  const expense = sum(data.expense || []);
  return { income, expense, result: Math.round((income - expense) * 100) / 100 };
}

function budgetRow(row) {
  if (!row) return null;
  let data;
  try { data = cleanBudget(JSON.parse(row.data)); } catch (e) { data = emptyBudget(); }
  return { kind: row.kind, data, visitors: row.visitors, source: row.source, updated_at: row.updated_at, updated_by: row.updated_by, totals: totals(data) };
}

// ---------- Excel-Import ----------
function workbookToText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  let text = '';
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: ';', blankrows: false, strip: true });
    if (!csv.trim()) continue;
    text += `### Tabellenblatt "${name}"\n${csv}\n\n`;
  }
  return text;
}

const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    kind_guess: { type: 'string', enum: ['plan', 'ist', 'unklar'], description: 'Ist das eine Planung/Kalkulation (plan) oder eine Endabrechnung mit tatsächlichen Zahlen (ist)?' },
    visitors: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Besucherzahl (geplant bzw. tatsächlich), falls angegeben' },
    income: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          amount: { type: 'number', description: 'Betrag in Euro, positiv' },
          note: { type: 'string', description: 'z.B. Rechenweg aus der Tabelle ("120 Tickets × 18 €") oder leer' },
        },
        required: ['label', 'amount', 'note'],
        additionalProperties: false,
      },
    },
    expense: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          amount: { type: 'number', description: 'Betrag in Euro, positiv' },
          note: { type: 'string' },
        },
        required: ['label', 'amount', 'note'],
        additionalProperties: false,
      },
    },
    sheet_total_income: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Summe der Einnahmen, wie sie in der Tabelle selbst steht (falls vorhanden)' },
    sheet_total_expense: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Summe der Ausgaben, wie sie in der Tabelle selbst steht (falls vorhanden)' },
    remarks: { type: 'string', description: 'Kurze Hinweise auf Unklarheiten, auf Deutsch; leer wenn alles eindeutig ist' },
  },
  required: ['kind_guess', 'visitors', 'income', 'expense', 'sheet_total_income', 'sheet_total_expense', 'remarks'],
  additionalProperties: false,
};

const SYSTEM = `Du liest Kalkulationen und Abrechnungen von Konzerten eines gemeinnützigen Kulturvereins aus Excel-Tabellen (als CSV mit Semikolon) aus und überträgst sie in ein einheitliches Format aus Einnahmen- und Ausgabenzeilen.
Regeln:
- Übernimm nur Einzelposten, keine Zwischen- oder Gesamtsummen als eigene Zeile (die Summen der Tabelle gehören in sheet_total_income/sheet_total_expense).
- Beträge immer positiv in Euro; ob Einnahme oder Ausgabe, entscheidet die Liste.
- Wenn die Tabelle Plan- und Ist-Spalten hat, nimm die Spalte, die zur Art des Dokuments passt, und erwähne das in remarks.
- Erfinde keine Posten oder Beträge. Was du nicht eindeutig zuordnen kannst, beschreibst du in remarks.
- Verwende nach Möglichkeit diese üblichen Bezeichnungen: Einnahmen: ${TEMPLATE.income.join(', ')}. Ausgaben: ${TEMPLATE.expense.join(', ')}. Andere Posten behalten ihre eigene Bezeichnung.`;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Die KI ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).');
  if (!client) client = new Anthropic.default({ timeout: 10 * 60 * 1000 });
  return client;
}

async function analyzeSpreadsheet(buffer, filename, concertTitle) {
  let text;
  try {
    text = workbookToText(buffer);
  } catch (err) {
    throw new Error('Die Datei konnte nicht als Tabelle gelesen werden (unterstützt: .xlsx, .xls, .ods, .csv).');
  }
  if (!text.trim()) throw new Error('Die Tabelle ist leer.');
  if (text.length > MAX_SHEET_CHARS) throw new Error('Die Tabelle ist zu groß für die automatische Auswertung – bitte nur die Kalkulation als eigene Datei hochladen.');

  const response = await getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: IMPORT_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Konzert: ${concertTitle}\nDatei: ${filename}\n\n${text}`,
    }],
  }).finalMessage();

  if (response.stop_reason === 'refusal') throw new Error('Die KI hat die Auswertung abgelehnt.');
  if (response.stop_reason === 'max_tokens') throw new Error('Die Tabelle war zu umfangreich für die Auswertung.');
  const block = response.content.find(b => b.type === 'text');
  if (!block) throw new Error('Die KI hat kein Ergebnis geliefert.');
  const out = JSON.parse(block.text);

  const data = cleanBudget({ income: out.income, expense: out.expense });
  const t = totals(data);
  const warnings = [];
  const differs = (a, b) => a !== null && a !== undefined && Math.abs(a - b) > 0.5;
  if (differs(out.sheet_total_income, t.income)) {
    warnings.push(`Einnahmen: Die Tabelle nennt ${fmtEuro(out.sheet_total_income)}, die übernommenen Posten ergeben ${fmtEuro(t.income)}. Bitte prüfen.`);
  }
  if (differs(out.sheet_total_expense, t.expense)) {
    warnings.push(`Ausgaben: Die Tabelle nennt ${fmtEuro(out.sheet_total_expense)}, die übernommenen Posten ergeben ${fmtEuro(t.expense)}. Bitte prüfen.`);
  }
  return {
    data, totals: t, visitors: cleanVisitors(out.visitors),
    kind_guess: KINDS.includes(out.kind_guess) ? out.kind_guess : null,
    remarks: String(out.remarks || '').trim(), warnings,
  };
}

function fmtEuro(n) {
  return Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

module.exports = { toAmount, KINDS, TEMPLATE, emptyBudget, cleanBudget, cleanVisitors, totals, budgetRow, analyzeSpreadsheet };
