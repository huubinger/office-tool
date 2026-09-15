// Schulferien-Termine fuer Baden-Wuerttemberg. Im Gegensatz zu gesetzlichen Feiertagen
// (siehe holidays.js) lassen sich Schulferien nicht algorithmisch berechnen, da sie vom
// Kultusministerium jaehrlich neu festgelegt werden. Die Termine hier sind die offiziell
// bekannten Zeitraeume (Stand: Recherche 2026) und muessen fuer weiter in der Zukunft
// liegende Jahre ergaenzt werden, sobald das Kultusministerium sie veroeffentlicht.
//
// Quelle u.a.: Kultusministerium Baden-Wuerttemberg (km.baden-wuerttemberg.de/de/service/ferien),
// Verkehrsverbund naldo (gesetzliche Schulferien-Uebersicht).

const SCHOOL_HOLIDAYS = [
  // Schuljahr 2025/26 (Auszug, soweit er 2026 betrifft)
  { name: 'Weihnachtsferien', from: '2025-12-22', to: '2026-01-05' },
  { name: 'Osterferien', from: '2026-03-30', to: '2026-04-11' },
  { name: 'Pfingstferien', from: '2026-05-26', to: '2026-06-05' },
  { name: 'Sommerferien', from: '2026-07-30', to: '2026-09-12' },
  { name: 'Herbstferien', from: '2026-10-26', to: '2026-10-30' },

  // Schuljahr 2026/27
  { name: 'Weihnachtsferien', from: '2026-12-23', to: '2027-01-09' },
  { name: 'Osterferien', from: '2027-03-30', to: '2027-04-03' },
  { name: 'Pfingstferien', from: '2027-05-18', to: '2027-05-29' },
  { name: 'Sommerferien', from: '2027-07-29', to: '2027-09-11' },
  { name: 'Herbstferien', from: '2027-11-02', to: '2027-11-06' },
];

// Gibt alle Ferienzeitraeume zurueck, die (auch nur teilweise) in das angegebene Jahr fallen
function getSchoolHolidaysForYear(year) {
  return SCHOOL_HOLIDAYS.filter(h => h.from.slice(0, 4) === String(year) || h.to.slice(0, 4) === String(year));
}

module.exports = { getSchoolHolidaysForYear };
