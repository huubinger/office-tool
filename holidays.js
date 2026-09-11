// Berechnet die gesetzlichen Feiertage in Baden-Württemberg fuer ein Jahr.
// Bewegliche Feiertage (Ostern-abhaengig) werden ueber die Gauss'sche Osterformel berechnet.

function easterSunday(year) {
  // Gauss'sche Osterformel
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Maerz, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const cache = new Map();

// Gibt ein Set von ISO-Datumsstrings (YYYY-MM-DD) der BW-Feiertage eines Jahres zurueck
function getHolidaysForYear(year) {
  if (cache.has(year)) return cache.get(year);

  const easter = easterSunday(year);
  const dates = [
    new Date(year, 0, 1),        // Neujahr
    new Date(year, 0, 6),        // Heilige Drei Koenige (BW-spezifisch)
    addDays(easter, -2),         // Karfreitag
    addDays(easter, 1),          // Ostermontag
    new Date(year, 4, 1),        // Tag der Arbeit
    addDays(easter, 39),         // Christi Himmelfahrt
    addDays(easter, 50),         // Pfingstmontag
    addDays(easter, 60),         // Fronleichnam (BW-spezifisch)
    new Date(year, 9, 3),        // Tag der Deutschen Einheit
    new Date(year, 10, 1),       // Allerheiligen (BW-spezifisch)
    new Date(year, 11, 25),      // 1. Weihnachtsfeiertag
    new Date(year, 11, 26),      // 2. Weihnachtsfeiertag
  ];

  const set = new Set(dates.map(toIso));
  cache.set(year, set);
  return set;
}

function isHoliday(isoDate) {
  const year = Number(isoDate.slice(0, 4));
  return getHolidaysForYear(year).has(isoDate);
}

module.exports = { getHolidaysForYear, isHoliday };
