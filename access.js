// Zugriffsrechte je Reiter (Tab) und einheitliche Anzeige von Benutzern (Name, Kuerzel, Farbe).

const ALL_TABS = ['tasks', 'calendar', 'people', 'timetracking', 'yearcalendar', 'contracts', 'nk_polls', 'nk_projects'];
// Reiter, die ein Konto ohne ausdruecklich gesetzte Freigaben sieht (Stand vor Einfuehrung der
// Freigaben). Die "Neckarsulmer Konzerte"-Reiter muessen immer explizit freigegeben werden.
const LEGACY_TABS = ['tasks', 'calendar', 'people', 'timetracking', 'yearcalendar', 'contracts'];

function parseTabs(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(t => ALL_TABS.includes(t)) : null;
  } catch (e) {
    return null;
  }
}

function effectiveTabs(user) {
  if (!user) return [];
  const parsed = parseTabs(user.allowed_tabs);
  if (parsed) return parsed;
  return user.is_admin ? [...ALL_TABS] : [...LEGACY_TABS];
}

function normalizeTabsInput(tabs) {
  if (!Array.isArray(tabs)) return null;
  return JSON.stringify(ALL_TABS.filter(t => tabs.includes(t)));
}

const USER_COLORS = ['#22d3b8', '#f59e0b', '#8b5cf6', '#ec4899', '#3b82f6', '#10b981', '#ef4444', '#14b8a6'];

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// Anzeigename: eigener Anzeigename > Name der verknuepften Person > Benutzername.
function userDisplay(user, person) {
  if (!user) return { user_id: null, name: 'Ehemaliger Benutzer', short: '?', color: '#5c6472' };
  const name = (user.display_name && user.display_name.trim()) || (person && person.name) || user.username;
  return {
    user_id: user.id,
    name,
    short: (person && person.short_code) || initialsOf(name),
    color: (person && person.color) || USER_COLORS[user.id % USER_COLORS.length],
  };
}

function displayForUserId(db, userId) {
  if (!userId) return userDisplay(null);
  const user = db.prepare('SELECT * FROM app_users WHERE id = ?').get(userId);
  if (!user) return userDisplay(null);
  const person = user.person_id ? db.prepare('SELECT name, short_code, color FROM people WHERE id = ?').get(user.person_id) : null;
  return userDisplay(user, person);
}

// Alle Konten, die einen bestimmten Reiter sehen duerfen - fuer "Wer hat schon abgestimmt/gelesen?"
function membersWithTab(db, tab) {
  const users = db.prepare('SELECT * FROM app_users ORDER BY id').all();
  const personStmt = db.prepare('SELECT name, short_code, color FROM people WHERE id = ?');
  return users
    .filter(u => effectiveTabs(u).includes(tab))
    .map(u => userDisplay(u, u.person_id ? personStmt.get(u.person_id) : null))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

module.exports = {
  ALL_TABS, LEGACY_TABS, parseTabs, effectiveTabs, normalizeTabsInput,
  userDisplay, displayForUserId, membersWithTab, initialsOf,
};
