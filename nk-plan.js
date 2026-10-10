// ================= NECKARSULMER KONZERTE: PLANUNG =================
// Checkliste/Phasen je Konzert, Startseite (Dashboard), Fristen-Erinnerungen per Mail/Push,
// Kalender-Abo (ICS) und Suche ueber alles.

const cron = require('node-cron');
const crypto = require('crypto');
const db = require('./db');
const nk = require('./nk');
const mail = require('./nk-mail');
const { displayForUserId } = require('./access');

const APP_URL = (process.env.APP_URL || 'https://office.martinrenner.de').replace(/\/$/, '');

db.exec(`
CREATE TABLE IF NOT EXISTS nk_concert_checks (
  concert_id INTEGER NOT NULL REFERENCES nk_concerts(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  done_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  done_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (concert_id, step_key)
);
CREATE TABLE IF NOT EXISTS nk_reminders_sent (
  key TEXT PRIMARY KEY,
  sent_at TEXT DEFAULT (datetime('now'))
);
`);

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const count = (sql, ...args) => { try { return db.prepare(sql).get(...args).c; } catch (e) { return 0; } };

// ---------- Checkliste ----------
// auto: wird aus den Daten erkannt; alle Schritte lassen sich zusaetzlich von Hand abhaken.
const STEPS = [
  { key: 'termin', label: 'Termin steht', hint: 'automatisch bei Datum + Status „Bestätigt“', folder: null, auto: (c) => !!c.date && ['Bestätigt', 'Abgeschlossen'].includes(c.status) },
  { key: 'vertrag', label: 'Künstlervertrag unterschrieben', hint: 'Vertrag im Ordner „Verträge“ ablegen', folder: 'contracts' },
  { key: 'kalkulation', label: 'Kalkulation erstellt', hint: 'automatisch, sobald eine Kalkulation gespeichert ist', folder: 'budget', auto: (c, x) => x.plan },
  { key: 'technik', label: 'Saal und Technik geklärt', folder: 'evening' },
  { key: 'vvk', label: 'Ticketverkauf läuft', hint: 'automatisch, sobald eine Ticketquelle verknüpft ist', folder: 'overview', auto: (c, x) => x.tickets },
  { key: 'werbung', label: 'Werbung gestartet', hint: 'Plakat, Presse, Social Media', folder: 'promo' },
  { key: 'gema_anmeldung', label: 'Bei der GEMA angemeldet', folder: 'gema', auto: (c) => !!c.gema_registered_at },
  { key: 'helfer', label: 'Helfer eingeteilt', hint: 'automatisch, wenn alle Dienste besetzt sind', folder: 'evening', auto: (c, x) => x.shiftsTotal > 0 && x.shiftsOpen === 0 },
  { key: 'konzert', label: 'Konzert gespielt', folder: null, auto: (c) => !!c.date && c.date < todayIso() && c.status !== 'Abgesagt' },
  { key: 'musikfolge', label: 'Musikfolge an die GEMA gemeldet', folder: 'gema', auto: (c) => !!c.gema_reported_at },
  { key: 'abrechnung', label: 'Abrechnung fertig', folder: 'budget', auto: (c, x) => x.ist },
  { key: 'sponsoren', label: 'Sponsoren bedankt und abgerechnet', folder: null },
];

function checklistFacts(c) {
  const kinds = new Set(db.prepare('SELECT kind FROM nk_budgets WHERE concert_id = ?').all(c.id).map(r => r.kind));
  let shiftsTotal = 0, shiftsOpen = 0;
  try {
    const shifts = db.prepare('SELECT id, needed FROM nk_shifts WHERE concert_id = ?').all(c.id);
    shiftsTotal = shifts.length;
    shiftsOpen = shifts.filter(s => count('SELECT COUNT(*) AS c FROM nk_shift_signups WHERE shift_id = ?', s.id) < (s.needed || 1)).length;
  } catch (e) { /* Tabelle noch nicht da */ }
  return {
    plan: kinds.has('plan'), ist: kinds.has('ist'),
    tickets: count('SELECT COUNT(*) AS c FROM nk_ticket_sources WHERE concert_id = ?', c.id) > 0,
    shiftsTotal, shiftsOpen,
  };
}

function checklist(c, withDetails) {
  const facts = checklistFacts(c);
  const manual = new Map(db.prepare('SELECT * FROM nk_concert_checks WHERE concert_id = ?').all(c.id).map(r => [r.step_key, r]));
  const steps = STEPS.map(s => {
    const auto = s.auto ? !!s.auto(c, facts) : false;
    const m = manual.get(s.key);
    return {
      key: s.key, label: s.label, hint: s.hint || null, folder: s.folder, has_auto: !!s.auto,
      done: auto || !!m, auto_done: auto, manual: !!m,
      done_by: withDetails && m && m.done_by ? displayForUserId(db, m.done_by).short : null, done_at: m ? m.done_at : null,
    };
  });
  const done = steps.filter(s => s.done).length;
  const next = steps.find(s => !s.done);
  return { steps, done, total: steps.length, next: next ? next.label : null };
}

// ---------- Dashboard ----------
function dashboard(req) {
  const today = todayIso();
  const tabs = req.tabs;
  const me = req.user.id;
  const out = { today, next_concerts: [], my_todos: [], due_todos: [], polls: [], news: [], deadlines: [], my_shifts: [], sponsor_renewals: [] };
  const concertTitle = new Map(db.prepare('SELECT id, title, date FROM nk_concerts').all().map(c => [c.id, c]));

  if (tabs.includes('nk_projects')) {
    const upcoming = db.prepare("SELECT * FROM nk_concerts WHERE date >= ? AND status != 'Abgesagt' ORDER BY date, time LIMIT 3").all(today);
    out.next_concerts = upcoming.map(c => {
      const cl = checklist(c, false);
      return {
        id: c.id, title: c.title, date: c.date, time: c.time, location: c.location, status: c.status, capacity: c.capacity,
        days_until: daysBetween(today, c.date),
        progress: { done: cl.done, total: cl.total, next: cl.next },
        todo_open: count('SELECT COUNT(*) AS c FROM nk_todos WHERE concert_id = ? AND done = 0', c.id),
        tickets: ticketTotals(c.id),
      };
    });
    const todoRow = (t) => ({
      id: t.id, title: t.title, due_date: t.due_date, concert_id: t.concert_id,
      concert_title: (concertTitle.get(t.concert_id) || {}).title || '', overdue: !!t.due_date && t.due_date < today,
      assignee: t.assignee_id ? displayForUserId(db, t.assignee_id) : null,
    });
    out.my_todos = db.prepare('SELECT * FROM nk_todos WHERE done = 0 AND assignee_id = ? ORDER BY due_date IS NULL, due_date, id').all(me).map(todoRow);
    // Ohne Zustaendigkeit, aber bald faellig oder ueberfaellig
    const horizon = nk.addDays(today, 14);
    out.due_todos = db.prepare('SELECT * FROM nk_todos WHERE done = 0 AND assignee_id IS NULL AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date, id LIMIT 30').all(horizon).map(todoRow);

    const unseen = db.prepare(`
      SELECT f.concert_id, COUNT(*) AS c FROM nk_concert_files f
      WHERE NOT EXISTS (SELECT 1 FROM nk_file_reads r WHERE r.file_id = f.id AND r.user_id = ?) GROUP BY f.concert_id
    `).all(me);
    const unread = db.prepare(`
      SELECT c.concert_id, COUNT(*) AS c FROM nk_comments c
      WHERE NOT EXISTS (SELECT 1 FROM nk_comment_reads r WHERE r.comment_id = c.id AND r.user_id = ?) GROUP BY c.concert_id
    `).all(me);
    const news = new Map();
    unseen.forEach(r => news.set(r.concert_id, { concert_id: r.concert_id, files: r.c, comments: 0 }));
    unread.forEach(r => { const n = news.get(r.concert_id) || { concert_id: r.concert_id, files: 0, comments: 0 }; n.comments = r.c; news.set(r.concert_id, n); });
    out.news = [...news.values()].filter(n => concertTitle.has(n.concert_id))
      .map(n => ({ ...n, concert_title: concertTitle.get(n.concert_id).title, concert_date: concertTitle.get(n.concert_id).date }));

    out.deadlines = deadlines(today, 28);
    try {
      out.my_shifts = db.prepare(`
        SELECT s.*, c.title AS concert_title, c.date AS concert_date FROM nk_shift_signups su
        JOIN nk_shifts s ON s.id = su.shift_id JOIN nk_concerts c ON c.id = s.concert_id
        WHERE su.user_id = ? AND c.date >= ? AND c.status != 'Abgesagt' ORDER BY c.date, s.start_time
      `).all(me, today);
    } catch (e) { /* Tabelle noch nicht da */ }
  }
  if (tabs.includes('nk_polls')) {
    out.polls = db.prepare(`
      SELECT p.id, p.title, p.created_at FROM nk_polls p WHERE p.closed = 0 AND NOT EXISTS (
        SELECT 1 FROM nk_poll_votes v JOIN nk_poll_options o ON o.id = v.option_id WHERE o.poll_id = p.id AND v.user_id = ?)
      ORDER BY p.created_at DESC
    `).all(me);
  }
  if (tabs.includes('nk_sponsors')) out.sponsor_renewals = sponsorRenewals(new Date().getFullYear());
  return out;
}

function ticketTotals(concertId) {
  try {
    const rows = db.prepare('SELECT * FROM nk_ticket_sources WHERE concert_id = ?').all(concertId);
    if (!rows.length) return null;
    const sold = rows.reduce((s, r) => s + (r.sold || 0), 0);
    const capacity = rows.every(r => r.capacity) ? rows.reduce((s, r) => s + r.capacity, 0) : null;
    return { sold, capacity };
  } catch (e) { return null; }
}

// Fristen der naechsten `days` Tage (inkl. Ueberfaelligem) - fuer Startseite und Erinnerungen
function deadlines(today, days) {
  const until = nk.addDays(today, days);
  const list = [];
  db.prepare("SELECT * FROM nk_concerts WHERE status != 'Abgesagt' AND date IS NOT NULL").all().forEach(c => {
    if (c.date >= today && c.date <= until) list.push({ type: 'concert', date: c.date, title: `🎵 ${c.title}`, concert_id: c.id });
    const gemaDue = nk.addDays(c.date, -3);
    if (!c.gema_registered_at && c.date >= today && gemaDue <= until) {
      list.push({ type: 'gema', date: gemaDue, title: `GEMA-Anmeldung: ${c.title}`, concert_id: c.id, folder: 'gema', overdue: gemaDue < today });
    }
    const repDue = nk.addDays(c.date, 10);
    if (!c.gema_reported_at && c.date < today && repDue <= until) {
      list.push({ type: 'musikfolge', date: repDue, title: `Musikfolge melden: ${c.title}`, concert_id: c.id, folder: 'gema', overdue: repDue < today });
    }
    const istDue = nk.addDays(c.date, 21);
    if (c.date < today && istDue <= until && !db.prepare("SELECT 1 FROM nk_budgets WHERE concert_id = ? AND kind = 'ist'").get(c.id)) {
      list.push({ type: 'abrechnung', date: istDue, title: `Abrechnung: ${c.title}`, concert_id: c.id, folder: 'budget', overdue: istDue < today });
    }
  });
  db.prepare('SELECT t.*, c.title AS concert_title FROM nk_todos t JOIN nk_concerts c ON c.id = t.concert_id WHERE t.done = 0 AND t.due_date IS NOT NULL AND t.due_date <= ?')
    .all(until).forEach(t => list.push({
      type: 'todo', date: t.due_date, title: `${t.title} (${t.concert_title})`, concert_id: t.concert_id, folder: 'todos',
      overdue: t.due_date < today, assignee: t.assignee_id ? displayForUserId(db, t.assignee_id).short : null,
    }));
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

// Sponsoren, die im Vorjahr dabei waren, fuer dieses Jahr aber noch keinen Eintrag haben
function sponsorRenewals(year) {
  try {
    return db.prepare(`
      SELECT sp.id, sp.name, SUM(CASE WHEN COALESCE(sh.year, CAST(substr(c.date, 1, 4) AS INTEGER)) = ? THEN sh.amount ELSE 0 END) AS last_amount
      FROM nk_sponsors sp JOIN nk_sponsorships sh ON sh.sponsor_id = sp.id LEFT JOIN nk_concerts c ON c.id = sh.concert_id
      WHERE sh.status != 'abgelehnt'
      GROUP BY sp.id
      HAVING SUM(CASE WHEN COALESCE(sh.year, CAST(substr(c.date, 1, 4) AS INTEGER)) = ? THEN 1 ELSE 0 END) > 0
         AND SUM(CASE WHEN COALESCE(sh.year, CAST(substr(c.date, 1, 4) AS INTEGER)) >= ? THEN 1 ELSE 0 END) = 0
      ORDER BY sp.name COLLATE NOCASE
    `).all(year - 1, year - 1, year);
  } catch (e) { return []; }
}

// ---------- Erinnerungen (taeglich 6:50, vor der Mail-Zusammenfassung um 7:00) ----------
function remindOnce(key, payload) {
  if (db.prepare('SELECT 1 FROM nk_reminders_sent WHERE key = ?').get(key)) return false;
  db.prepare('INSERT INTO nk_reminders_sent (key) VALUES (?)').run(key);
  mail.notify({ actorId: null, ...payload });
  return true;
}

function runReminders() {
  const today = todayIso();
  let sent = 0;
  // 2Dos: 3 Tage vorher, am Tag selbst, 1 Tag ueberfaellig - an die zustaendige Person (sonst an alle)
  db.prepare('SELECT t.*, c.title AS concert_title FROM nk_todos t JOIN nk_concerts c ON c.id = t.concert_id WHERE t.done = 0 AND t.due_date IS NOT NULL').all().forEach(t => {
    const d = daysBetween(today, t.due_date);
    const stage = d === 3 ? 'soon' : d === 0 ? 'due' : d === -1 ? 'overdue' : null;
    if (!stage) return;
    const when = { soon: `ist in 3 Tagen fällig (${fmtDate(t.due_date)})`, due: 'ist heute fällig', overdue: `ist seit gestern überfällig (${fmtDate(t.due_date)})` }[stage];
    if (remindOnce(`todo:${t.id}:${stage}:${t.due_date}`, {
      tab: 'nk_projects', onlyUserIds: t.assignee_id ? [t.assignee_id] : null,
      subject: `${stage === 'overdue' ? 'Überfällig' : 'Erinnerung'}: ${t.title}`,
      body: `Das 2Do „${t.title}“ bei „${t.concert_title}“ ${when}.`,
      path: `/nk?concert=${t.concert_id}&folder=todos`,
    })) sent++;
  });
  db.prepare("SELECT * FROM nk_concerts WHERE status != 'Abgesagt' AND date IS NOT NULL").all().forEach(c => {
    const d = daysBetween(today, c.date);
    if (!c.gema_registered_at && (d === 14 || d === 5)) {
      if (remindOnce(`gema:${c.id}:${c.date}:${d}`, {
        tab: 'nk_projects', subject: `GEMA-Anmeldung offen: ${c.title}`,
        body: `„${c.title}“ ist in ${d} Tagen (${fmtDate(c.date)}) und noch nicht bei der GEMA angemeldet. Bitte rechtzeitig vor der Veranstaltung anmelden – Nachmeldungen kosten Zuschlag.`,
        path: `/nk?concert=${c.id}&folder=gema`,
      })) sent++;
    }
    if (!c.gema_reported_at && (d === -7 || d === -21)) {
      if (remindOnce(`musikfolge:${c.id}:${c.date}:${d}`, {
        tab: 'nk_projects', subject: `Musikfolge melden: ${c.title}`,
        body: `„${c.title}“ war am ${fmtDate(c.date)} – die Musikfolge ist noch nicht an die GEMA gemeldet (bitte zeitnah nachholen).`,
        path: `/nk?concert=${c.id}&folder=gema`,
      })) sent++;
    }
    if ((d === -21 || d === -42) && !db.prepare("SELECT 1 FROM nk_budgets WHERE concert_id = ? AND kind = 'ist'").get(c.id)) {
      if (remindOnce(`abrechnung:${c.id}:${c.date}:${d}`, {
        tab: 'nk_projects', subject: `Abrechnung fehlt: ${c.title}`,
        body: `Für „${c.title}“ (${fmtDate(c.date)}) ist noch keine Abrechnung eingetragen.`,
        path: `/nk?concert=${c.id}&folder=budget`,
      })) sent++;
    }
  });
  // Sponsoring zugesagt, Konzert vorbei -> Rechnung stellen / Zahlung pruefen
  try {
    db.prepare(`
      SELECT sh.*, sp.name AS sponsor_name, c.title AS concert_title, c.date AS concert_date
      FROM nk_sponsorships sh JOIN nk_sponsors sp ON sp.id = sh.sponsor_id LEFT JOIN nk_concerts c ON c.id = sh.concert_id
      WHERE sh.status = 'zugesagt'
    `).all().forEach(sh => {
      const due = sh.concert_date ? daysBetween(sh.concert_date, today) >= 7 : (sh.year && sh.year < new Date().getFullYear() && today.slice(5) >= '01-15');
      if (!due) return;
      if (remindOnce(`sponsor-inv:${sh.id}`, {
        tab: 'nk_sponsors', subject: `Sponsoring abrechnen: ${sh.sponsor_name}`,
        body: `${sh.sponsor_name} hat ${sh.amount ? sh.amount.toLocaleString('de-DE') + ' € ' : ''}${sh.concert_title ? `für „${sh.concert_title}“ ` : ''}zugesagt, der Betrag ist noch nicht als bezahlt markiert. Rechnung stellen bzw. Zahlung prüfen.`,
        path: '/nk?tab=nk_sponsors',
      })) sent++;
    });
  } catch (e) { /* Sponsoren-Tabellen fehlen */ }
  // Jaehrlich: Sponsoren verlaengern (ab 10. Januar) und KSK-Meldung (ab 1. Maerz)
  const year = new Date().getFullYear();
  if (today.slice(5) >= '01-10') {
    sponsorRenewals(year).forEach(sp => {
      if (remindOnce(`sponsor-renew:${sp.id}:${year}`, {
        tab: 'nk_sponsors', subject: `Sponsor für ${year} anfragen: ${sp.name}`,
        body: `${sp.name} hat ${year - 1} unterstützt${sp.last_amount ? ` (${sp.last_amount.toLocaleString('de-DE')} €)` : ''} – für ${year} ist noch nichts eingetragen. Zeit für eine neue Anfrage.`,
        path: '/nk?tab=nk_sponsors',
      })) sent++;
    });
  }
  if (today.slice(5) >= '03-01' && today.slice(5) <= '03-31'
    && count("SELECT COUNT(*) AS c FROM nk_concerts WHERE status != 'Abgesagt' AND substr(date, 1, 4) = ?", String(year - 1)) > 0) {
    if (remindOnce(`ksk:${year}`, {
      tab: 'nk_projects', subject: `KSK-Meldung für ${year - 1} bis 31. März`,
      body: `Bis 31.03.${year} müssen die Künstlerhonorare aus ${year - 1} an die Künstlersozialkasse gemeldet werden. Die Gagen stehen in den Abrechnungen bzw. bei den Kontakten (Gagen-Historie).`,
      path: '/nk?view=stats',
    })) sent++;
  }
  db.prepare("DELETE FROM nk_reminders_sent WHERE sent_at < datetime('now', '-400 days')").run();
  return sent;
}

// ---------- Kalender-Abo ----------
function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsFold(line) {
  // Zeilen > 75 Bytes umbrechen (RFC 5545)
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
function icsEvent({ uid, date, time, endTime, durationMin, title, description, location, url }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const d = date.replace(/-/g, '');
  const lines = ['BEGIN:VEVENT', `UID:${uid}@office-tool-nk`, `DTSTAMP:${stamp}`];
  if (time) {
    const [h, m] = time.slice(0, 5).split(':').map(Number);
    lines.push(`DTSTART;TZID=Europe/Berlin:${d}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`);
    let end;
    if (endTime) end = endTime.slice(0, 5).replace(':', '') + '00';
    else {
      const total = h * 60 + m + (durationMin || 120);
      end = `${String(Math.min(23, Math.floor(total / 60))).padStart(2, '0')}${String(total >= 24 * 60 ? 59 : total % 60).padStart(2, '0')}00`;
    }
    lines.push(`DTEND;TZID=Europe/Berlin:${d}T${end}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nk.addDays(date, 1).replace(/-/g, '')}`);
  }
  lines.push(`SUMMARY:${icsEscape(title)}`);
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push('END:VEVENT');
  return lines.map(icsFold).join('\r\n');
}
const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

function buildCalendar(user, scope) {
  const { effectiveTabs } = require('./access');
  const tabs = effectiveTabs(user);
  const events = [];
  const since = nk.addDays(todayIso(), -120);
  if (tabs.includes('nk_projects')) {
    db.prepare("SELECT * FROM nk_concerts WHERE status != 'Abgesagt' AND date IS NOT NULL AND date >= ?").all(since).forEach(c => {
      events.push(icsEvent({
        uid: `concert-${c.id}`, date: c.date, time: c.time, title: `🎵 ${c.title}${c.status === 'Idee' ? ' (Idee)' : ''}`,
        description: [c.status, c.notes].filter(Boolean).join('\n'), location: c.location, url: `${APP_URL}/nk?concert=${c.id}`,
      }));
    });
    const todos = scope === 'all'
      ? db.prepare('SELECT t.*, c.title AS ct FROM nk_todos t JOIN nk_concerts c ON c.id = t.concert_id WHERE t.done = 0 AND t.due_date IS NOT NULL').all()
      : db.prepare('SELECT t.*, c.title AS ct FROM nk_todos t JOIN nk_concerts c ON c.id = t.concert_id WHERE t.done = 0 AND t.due_date IS NOT NULL AND t.assignee_id = ?').all(user.id);
    todos.forEach(t => events.push(icsEvent({
      uid: `todo-${t.id}`, date: t.due_date, title: `☑️ ${t.title}`, description: `2Do bei „${t.ct}“${t.assignee_id ? ' · ' + displayForUserId(db, t.assignee_id).name : ''}`,
      url: `${APP_URL}/nk?concert=${t.concert_id}&folder=todos`,
    })));
    try {
      db.prepare(`
        SELECT s.*, c.title AS ct, c.date AS cdate, c.location AS cloc FROM nk_shift_signups su
        JOIN nk_shifts s ON s.id = su.shift_id JOIN nk_concerts c ON c.id = s.concert_id
        WHERE su.user_id = ? AND c.date >= ? AND c.status != 'Abgesagt'
      `).all(user.id, since).forEach(s => events.push(icsEvent({
        uid: `shift-${s.id}-${user.id}`, date: s.cdate, time: s.start_time, endTime: s.end_time, durationMin: 60,
        title: `🙋 Dienst ${s.role}: ${s.ct}`, location: s.cloc, url: `${APP_URL}/nk?concert=${s.concert_id}&folder=evening`,
      })));
    } catch (e) { /* Tabelle fehlt */ }
  }
  if (tabs.includes('nk_polls')) {
    db.prepare('SELECT p.*, o.date, o.start_time, o.end_time FROM nk_polls p JOIN nk_poll_options o ON o.id = p.final_option_id WHERE o.date >= ?').all(since)
      .forEach(p => events.push(icsEvent({
        uid: `poll-${p.id}`, date: p.date, time: p.start_time, endTime: p.end_time, durationMin: 90, title: `📅 ${p.title}`,
        description: p.description, location: p.location, url: `${APP_URL}/nk?poll=${p.id}`,
      })));
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Office-Tool//Neckarsulmer Konzerte//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Neckarsulmer Konzerte', 'X-WR-TIMEZONE:Europe/Berlin', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    VTIMEZONE, ...events, 'END:VCALENDAR'].join('\r\n');
}

function calendarToken(user, renew) {
  if (user.nk_ics_token && !renew) return user.nk_ics_token;
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE app_users SET nk_ics_token = ? WHERE id = ?').run(token, user.id);
  return token;
}

// ---------- Suche ----------
function snippet(text, q) {
  const t = String(text || '');
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t.slice(0, 120);
  const start = Math.max(0, i - 50);
  return (start ? '… ' : '') + t.slice(start, i + q.length + 70).trim() + (i + q.length + 70 < t.length ? ' …' : '');
}

function search(req, q) {
  const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
  const results = [];
  const tabs = req.tabs;
  if (tabs.includes('nk_projects')) {
    db.prepare("SELECT * FROM nk_concerts WHERE title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR promo_text LIKE ? ESCAPE '\\' LIMIT 20")
      .all(like, like, like, like).forEach(c => results.push({ type: 'concert', icon: '📁', title: c.title, sub: [c.date && fmtDate(c.date), c.location].filter(Boolean).join(' · '), concert_id: c.id }));
    db.prepare(`SELECT f.*, c.title AS ct FROM nk_concert_files f JOIN nk_concerts c ON c.id = f.concert_id
      WHERE f.filename LIKE ? ESCAPE '\\' OR f.content_text LIKE ? ESCAPE '\\' ORDER BY f.uploaded_at DESC LIMIT 30`).all(like, like)
      .forEach(f => results.push({
        type: 'file', icon: '📄', title: f.filename, sub: `${f.ct} · ${nk.folderForCategory(f.category)}`,
        snippet: f.filename.toLowerCase().includes(q.toLowerCase()) ? null : snippet(f.content_text, q),
        concert_id: f.concert_id, file_id: f.id, folder_key: folderKey(nk.folderForCategory(f.category)), filename: f.filename, mime_type: f.mime_type,
      }));
    db.prepare(`SELECT cm.*, c.title AS ct FROM nk_comments cm JOIN nk_concerts c ON c.id = cm.concert_id WHERE cm.body LIKE ? ESCAPE '\\' ORDER BY cm.created_at DESC LIMIT 20`).all(like)
      .forEach(cm => results.push({ type: 'comment', icon: '💬', title: displayForUserId(db, cm.user_id).name, sub: cm.ct, snippet: snippet(cm.body, q), concert_id: cm.concert_id, folder_key: 'agreements' }));
    db.prepare(`SELECT t.*, c.title AS ct FROM nk_todos t JOIN nk_concerts c ON c.id = t.concert_id WHERE t.title LIKE ? ESCAPE '\\' ORDER BY t.done, t.due_date LIMIT 20`).all(like)
      .forEach(t => results.push({ type: 'todo', icon: t.done ? '✅' : '☑️', title: t.title, sub: `${t.ct}${t.due_date ? ' · fällig ' + fmtDate(t.due_date) : ''}`, concert_id: t.concert_id, folder_key: 'todos' }));
  }
  if (tabs.includes('nk_contacts')) {
    try {
      db.prepare(`SELECT * FROM nk_contacts WHERE name LIKE ? ESCAPE '\\' OR contact_person LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' LIMIT 20`)
        .all(like, like, like, like).forEach(k => results.push({ type: 'contact', icon: '👤', title: k.name, sub: [k.kind, k.contact_person].filter(Boolean).join(' · '), contact_id: k.id }));
    } catch (e) { /* noch keine Kontakte */ }
  }
  if (tabs.includes('nk_sponsors')) {
    try {
      db.prepare(`SELECT * FROM nk_sponsors WHERE name LIKE ? ESCAPE '\\' OR contact_person LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' LIMIT 20`)
        .all(like, like, like).forEach(s => results.push({ type: 'sponsor', icon: '🤝', title: s.name, sub: s.contact_person || 'Sponsor', sponsor_id: s.id }));
    } catch (e) { /* noch keine Sponsoren */ }
  }
  return results;
}
function folderKey(folder) {
  return { 'Verträge': 'contracts', 'Sonstige Absprachen': 'agreements', Kalkulation: 'budget', GEMA: 'gema', Werbung: 'promo' }[folder] || 'agreements';
}

function register(app) {
  nk.extendDetail((c) => ({ checklist: checklist(c, true) }));
  nk.extendList((c) => {
    const cl = checklist(c, false);
    return { progress: { done: cl.done, total: cl.total, next: cl.next } };
  });

  app.put('/api/nk/concerts/:id/checks/:step', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    if (!STEPS.some(s => s.key === req.params.step)) return res.status(400).json({ error: 'Unbekannter Schritt' });
    if (req.body && req.body.done) {
      db.prepare('INSERT OR REPLACE INTO nk_concert_checks (concert_id, step_key, done_by) VALUES (?, ?, ?)').run(c.id, req.params.step, req.user.id);
    } else {
      db.prepare('DELETE FROM nk_concert_checks WHERE concert_id = ? AND step_key = ?').run(c.id, req.params.step);
    }
    res.json(nk.concertDetail(c.id, req));
  });

  app.get('/api/nk/dashboard', (req, res) => res.json(dashboard(req)));

  app.get('/api/nk/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    res.json(search(req, q.slice(0, 100)));
  });

  // Kalender-Abo: persoenlicher geheimer Link (ohne Login abrufbar)
  app.get('/api/nk/calendar-link', (req, res) => {
    const token = calendarToken(req.user, false);
    const base = `${APP_URL.replace(/^https?:\/\//, '')}/nk/kalender/${token}`;
    res.json({ https: `https://${base}.ics`, webcal: `webcal://${base}.ics`, https_all: `https://${base}.ics?alle=1`, webcal_all: `webcal://${base}.ics?alle=1` });
  });
  app.post('/api/nk/calendar-link/renew', (req, res) => {
    calendarToken(req.user, true);
    res.json({ ok: true });
  });
  app.get('/nk/kalender/:token.ics', (req, res) => {
    const token = String(req.params.token || '');
    const user = /^[a-f0-9]{48}$/.test(token) ? db.prepare('SELECT * FROM app_users WHERE nk_ics_token = ?').get(token) : null;
    if (!user) return res.status(404).send('Kalender nicht gefunden');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="neckarsulmer-konzerte.ics"');
    res.send(buildCalendar(user, req.query.alle ? 'all' : 'mine'));
  });

  cron.schedule('50 6 * * *', () => {
    try { runReminders(); } catch (err) { console.error('[NK-Erinnerungen]', err); }
  }, { timezone: 'Europe/Berlin' });
}

module.exports = { register, checklist, dashboard, deadlines, runReminders, buildCalendar, search, STEPS, sponsorRenewals, ticketTotals };
