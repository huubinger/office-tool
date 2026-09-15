// Sehr einfacher iCal-Parser: liest VEVENT-Bloecke aus einer .ics-Datei/URL und extrahiert
// Titel (SUMMARY) und Datum (DTSTART, sowie DTEND falls vorhanden). Deckt den ueblichen Fall
// von Termin-/Turnierkalendern ab (ein Termin pro VEVENT, taggenaue oder Datum+Uhrzeit-Werte).
// Unterstuetzt bewusst keine RRULE-Wiederholungsregeln aus externen Kalendern - die allermeisten
// oeffentlichen Turnierkalender (Fussball-WM/EM etc.) listen jeden Termin ohnehin einzeln auf.

function parseIcsDate(value) {
  // Format entweder "YYYYMMDD" (ganztaegig) oder "YYYYMMDDTHHMMSS[Z]"
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function parseIcsText(text) {
  // Zeilenumbrueche gemaess RFC5545 entfalten (fortgesetzte Zeilen beginnen mit Leerzeichen/Tab)
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\n/);

  const events = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      current = {};
    } else if (line.startsWith('END:VEVENT')) {
      if (current && current.title && current.date) events.push(current);
      current = null;
    } else if (current) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).split(';')[0];
      const value = line.slice(idx + 1);
      if (key === 'SUMMARY') current.title = value.replace(/\\,/g, ',').replace(/\\;/g, ';');
      if (key === 'DTSTART') current.date = parseIcsDate(value);
      if (key === 'DTEND') current.end_date = parseIcsDate(value);
    }
  }
  return events;
}

async function fetchAndParseIcs(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kalender konnte nicht geladen werden (${res.status})`);
  const text = await res.text();
  return parseIcsText(text);
}

module.exports = { parseIcsText, fetchAndParseIcs };
