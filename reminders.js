const db = require('./db');

// Nutzt die Brevo REST API (transaktionale E-Mails), analog zum Event Desk Tool.
// Ohne gesetzten BREVO_API_KEY wird nur geloggt, es wird nichts verschickt.

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const FROM_EMAIL = process.env.REMINDER_FROM_EMAIL || 'buero@example.com';
const FROM_NAME = process.env.REMINDER_FROM_NAME || 'Büro-Aufgabenplaner';

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDueTasksByPerson() {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.due_date, t.priority, p.id AS person_id, p.name AS person_name, p.email AS person_email
    FROM tasks t
    JOIN task_assignments ta ON ta.task_id = t.id
    JOIN people p ON p.id = ta.person_id
    WHERE t.status != 'erledigt'
      AND t.due_date IS NOT NULL
      AND t.due_date <= ?
      AND p.email IS NOT NULL
      AND p.active = 1
    ORDER BY p.name, t.due_date
  `).all(todayIso());

  const byPerson = new Map();
  for (const row of rows) {
    if (!byPerson.has(row.person_id)) {
      byPerson.set(row.person_id, { name: row.person_name, email: row.person_email, tasks: [] });
    }
    byPerson.get(row.person_id).tasks.push(row);
  }
  return byPerson;
}

async function sendReminderEmail(toEmail, toName, tasks) {
  const rowsHtml = tasks.map(t => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(t.title)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${t.due_date}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(t.priority)}</td>
    </tr>`).join('');

  const html = `
    <p>Hallo ${escapeHtml(toName)},</p>
    <p>folgende Aufgaben sind fällig oder überfällig:</p>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #333;">Aufgabe</th>
          <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #333;">Fällig</th>
          <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #333;">Priorität</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  if (!BREVO_API_KEY) {
    console.log(`[Erinnerung] BREVO_API_KEY nicht gesetzt - waere an ${toEmail} gegangen (${tasks.length} Aufgabe(n)).`);
    return { skipped: true };
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { email: FROM_EMAIL, name: FROM_NAME },
      to: [{ email: toEmail, name: toName }],
      subject: `Fällige Aufgaben (${tasks.length})`,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Brevo-Fehler ${res.status}: ${text}`);
  }
  return { skipped: false };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function runReminderCheck() {
  const byPerson = getDueTasksByPerson();
  const results = [];
  for (const [, info] of byPerson) {
    try {
      const r = await sendReminderEmail(info.email, info.name, info.tasks);
      results.push({ person: info.name, count: info.tasks.length, ...r });
    } catch (err) {
      console.error(`[Erinnerung] Fehler beim Senden an ${info.name}:`, err.message);
      results.push({ person: info.name, count: info.tasks.length, error: err.message });
    }
  }
  return results;
}

module.exports = { runReminderCheck };
