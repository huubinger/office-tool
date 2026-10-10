// ================= NECKARSULMER KONZERTE =================
// Terminfindung (Doodle-artige Umfragen) und Projekte (Konzerte mit Vertraegen und
// Kommentaren inkl. "gelesen"-Status). Zugriff wird ueber die Reiter-Freigaben
// nk_polls / nk_projects in server.js geregelt.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const contracts = require('./contracts');
const { displayForUserId, membersWithTab } = require('./access');
const mail = require('./nk-mail');
const budget = require('./nk-budget');

const FILES_DIR = path.join(db.dbDir, 'nk-files');
const DROPBOX_NK_FOLDER = process.env.DROPBOX_NK_FOLDER || '/Neckarsulmer Konzerte';
const MAX_FILE_BYTES = 18 * 1024 * 1024;
const VALID_ANSWERS = new Set(['yes', 'no', 'maybe']);
const CONCERT_STATUSES = ['Idee', 'Planung', 'Bestätigt', 'Abgeschlossen', 'Abgesagt'];
// Ordnerstruktur je Projekt: "<Datum> <Eventname>" -> Verträge / Sonstige Absprachen / 2Dos.
// Dokumente landen je nach Kategorie im Ordner Verträge oder Sonstige Absprachen.
const FOLDER_CONTRACTS = 'Verträge';
const FOLDER_AGREEMENTS = 'Sonstige Absprachen';
const FOLDER_GEMA = 'GEMA';
const FOLDER_BUDGET = 'Kalkulation';
const CONTRACT_CATEGORIES = ['Künstlervertrag', 'Mietvertrag', 'Technik/Rider', 'Sonstiger Vertrag'];
const GEMA_CATEGORIES = ['GEMA-Liste/Musikfolge', 'GEMA-Anmeldung', 'GEMA-Rechnung'];
const BUDGET_CATEGORIES = ['Kalkulation', 'Abrechnung'];

function folderForCategory(category) {
  if (CONTRACT_CATEGORIES.includes(category)) return FOLDER_CONTRACTS;
  if (GEMA_CATEGORIES.includes(category)) return FOLDER_GEMA;
  if (BUDGET_CATEGORIES.includes(category)) return FOLDER_BUDGET;
  return FOLDER_AGREEMENTS;
}

function projectFolderName(concert) {
  return `${concert.date ? concert.date + ' ' : ''}${contracts.sanitizeFolderName(concert.title)}`;
}

function canManage(req, createdBy) {
  return req.isAdmin || (createdBy && createdBy === req.user.id);
}

// Speichert eine Datei zum Konzert (Volume + Dropbox-Kopie) und markiert sie fuer den Hochladenden als gesehen.
async function storeConcertFile(c, { category, filename, buffer, mimeType, userId }) {
  const cleanName = safeFileName(filename);
  const dir = path.join(FILES_DIR, String(c.id));
  fs.mkdirSync(dir, { recursive: true });
  const storedName = `${Date.now()}-${cleanName}`;
  fs.writeFileSync(path.join(dir, storedName), buffer);

  let dropboxPath = null;
  if (contracts.isDropboxConfigured()) {
    try {
      const token = await contracts.getAccessToken();
      const folder = `${projectFolderName(c)}/${folderForCategory(category)}`;
      dropboxPath = await contracts.uploadFileToPath(token, `${DROPBOX_NK_FOLDER}/${folder}/${cleanName}`, buffer);
    } catch (err) {
      console.error('[NK] Dropbox-Kopie fehlgeschlagen:', err.message);
    }
  }
  const info = db.prepare(`
    INSERT INTO nk_concert_files (concert_id, category, filename, stored_path, dropbox_path, size_bytes, mime_type, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, category, cleanName, path.join(String(c.id), storedName), dropboxPath, buffer.length, mimeType || null, userId);
  db.prepare('INSERT OR IGNORE INTO nk_file_reads (file_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, userId);
  return { id: info.lastInsertRowid, filename: cleanName };
}

function safeFileName(name) {
  return String(name || 'Datei').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Datei';
}

// ---------- Terminfindung ----------
function pollSummary(poll) {
  const options = db.prepare('SELECT * FROM nk_poll_options WHERE poll_id = ? ORDER BY date, start_time').all(poll.id);
  const votes = db.prepare(`
    SELECT v.* FROM nk_poll_votes v JOIN nk_poll_options o ON o.id = v.option_id WHERE o.poll_id = ?
  `).all(poll.id);
  const counts = options.map(o => {
    const ov = votes.filter(v => v.option_id === o.id);
    return {
      ...o,
      yes: ov.filter(v => v.answer === 'yes').length,
      maybe: ov.filter(v => v.answer === 'maybe').length,
      no: ov.filter(v => v.answer === 'no').length,
    };
  });
  const best = [...counts].sort((a, b) => b.yes - a.yes || b.maybe - a.maybe || (a.date < b.date ? -1 : 1))[0];
  const voterIds = [...new Set(votes.map(v => v.user_id))];
  return { options: counts, votes, best: best && best.yes + best.maybe > 0 ? best : null, voterIds };
}

function pollDetail(pollId, req) {
  const poll = db.prepare('SELECT * FROM nk_polls WHERE id = ?').get(pollId);
  if (!poll) return null;
  const { options, votes, best } = pollSummary(poll);
  const members = membersWithTab(db, 'nk_polls');
  // Auch ehemalige Mitglieder, die schon abgestimmt haben, bleiben sichtbar
  const memberIds = new Set(members.map(m => m.user_id));
  [...new Set(votes.map(v => v.user_id))].forEach(uid => {
    if (!memberIds.has(uid)) members.push(displayForUserId(db, uid));
  });
  return {
    ...poll,
    created_by_display: displayForUserId(db, poll.created_by),
    can_manage: canManage(req, poll.created_by),
    options: options.map(o => ({
      ...o,
      votes: votes.filter(v => v.option_id === o.id).map(v => ({ user_id: v.user_id, answer: v.answer })),
    })),
    best_option_id: best ? best.id : null,
    members,
  };
}

function cleanOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .filter(o => o && /^\d{4}-\d{2}-\d{2}$/.test(o.date || ''))
    .map(o => ({
      id: o.id ? +o.id : null,
      date: o.date,
      start_time: o.start_time || null,
      end_time: o.end_time || null,
    }));
}

function register(app) {
  app.get('/api/nk/polls', (req, res) => {
    const polls = db.prepare('SELECT * FROM nk_polls ORDER BY closed ASC, created_at DESC').all();
    res.json(polls.map(p => {
      const { options, best, voterIds } = pollSummary(p);
      const myVotes = db.prepare(`
        SELECT COUNT(*) AS c FROM nk_poll_votes v JOIN nk_poll_options o ON o.id = v.option_id
        WHERE o.poll_id = ? AND v.user_id = ?
      `).get(p.id, req.user.id).c;
      const finalOption = p.final_option_id ? options.find(o => o.id === p.final_option_id) : null;
      return {
        ...p,
        created_by_display: displayForUserId(db, p.created_by),
        option_count: options.length,
        first_date: options[0] ? options[0].date : null,
        last_date: options.length ? options[options.length - 1].date : null,
        voter_count: voterIds.length,
        i_voted: myVotes > 0,
        best,
        final_option: finalOption || null,
      };
    }));
  });

  app.get('/api/nk/polls/:id', (req, res) => {
    const detail = pollDetail(req.params.id, req);
    if (!detail) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    res.json(detail);
  });

  app.post('/api/nk/polls', (req, res) => {
    const { title, description, location } = req.body || {};
    const options = cleanOptions(req.body && req.body.options);
    if (!title || !title.trim()) return res.status(400).json({ error: 'Titel ist erforderlich' });
    if (!options.length) return res.status(400).json({ error: 'Mindestens ein Terminvorschlag ist erforderlich' });
    const create = db.transaction(() => {
      const info = db.prepare('INSERT INTO nk_polls (title, description, location, created_by) VALUES (?, ?, ?, ?)')
        .run(title.trim(), description || null, location || null, req.user.id);
      const stmt = db.prepare('INSERT INTO nk_poll_options (poll_id, date, start_time, end_time) VALUES (?, ?, ?, ?)');
      options.forEach(o => stmt.run(info.lastInsertRowid, o.date, o.start_time, o.end_time));
      return info.lastInsertRowid;
    });
    const pollId = create();
    mail.notify({
      tab: 'nk_polls', actorId: req.user.id,
      subject: `Neue Terminumfrage: ${title.trim()}`,
      body: `${displayForUserId(db, req.user.id).name} hat die Terminumfrage „${title.trim()}“ mit ${options.length} Terminvorschlag${options.length === 1 ? '' : 'en'} angelegt – bitte ankreuzen, wann du kannst.`,
      path: `/nk?poll=${pollId}`,
    });
    res.status(201).json(pollDetail(pollId, req));
  });

  app.put('/api/nk/polls/:id', (req, res) => {
    const poll = db.prepare('SELECT * FROM nk_polls WHERE id = ?').get(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    if (!canManage(req, poll.created_by)) return res.status(403).json({ error: 'Nur Ersteller oder Admin dürfen die Umfrage ändern' });
    const { title, description, location } = req.body || {};
    const update = db.transaction(() => {
      db.prepare('UPDATE nk_polls SET title = ?, description = ?, location = ? WHERE id = ?').run(
        title !== undefined ? String(title).trim() || poll.title : poll.title,
        description !== undefined ? description : poll.description,
        location !== undefined ? location : poll.location,
        poll.id
      );
      if (req.body && Array.isArray(req.body.options)) {
        const options = cleanOptions(req.body.options);
        if (!options.length) throw new Error('Mindestens ein Terminvorschlag ist erforderlich');
        const existing = db.prepare('SELECT id FROM nk_poll_options WHERE poll_id = ?').all(poll.id).map(o => o.id);
        const keep = new Set(options.filter(o => o.id && existing.includes(o.id)).map(o => o.id));
        existing.filter(id => !keep.has(id)).forEach(id => db.prepare('DELETE FROM nk_poll_options WHERE id = ?').run(id));
        options.forEach(o => {
          if (o.id && keep.has(o.id)) {
            db.prepare('UPDATE nk_poll_options SET date = ?, start_time = ?, end_time = ? WHERE id = ?').run(o.date, o.start_time, o.end_time, o.id);
          } else {
            db.prepare('INSERT INTO nk_poll_options (poll_id, date, start_time, end_time) VALUES (?, ?, ?, ?)').run(poll.id, o.date, o.start_time, o.end_time);
          }
        });
        if (poll.final_option_id && !keep.has(poll.final_option_id)) {
          db.prepare('UPDATE nk_polls SET final_option_id = NULL, closed = 0 WHERE id = ?').run(poll.id);
        }
      }
    });
    try { update(); } catch (err) { return res.status(400).json({ error: err.message }); }
    res.json(pollDetail(poll.id, req));
  });

  // Eigene Antworten speichern: { votes: { [optionId]: 'yes'|'no'|'maybe'|null } }
  app.put('/api/nk/polls/:id/votes', (req, res) => {
    const poll = db.prepare('SELECT * FROM nk_polls WHERE id = ?').get(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    if (poll.closed) return res.status(400).json({ error: 'Diese Umfrage ist bereits abgeschlossen' });
    const votes = (req.body && req.body.votes) || {};
    const optionIds = new Set(db.prepare('SELECT id FROM nk_poll_options WHERE poll_id = ?').all(poll.id).map(o => o.id));
    const save = db.transaction(() => {
      Object.entries(votes).forEach(([optionId, answer]) => {
        if (!optionIds.has(+optionId)) return;
        if (answer && VALID_ANSWERS.has(answer)) {
          db.prepare(`
            INSERT INTO nk_poll_votes (option_id, user_id, answer, updated_at) VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(option_id, user_id) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at
          `).run(+optionId, req.user.id, answer);
        } else {
          db.prepare('DELETE FROM nk_poll_votes WHERE option_id = ? AND user_id = ?').run(+optionId, req.user.id);
        }
      });
    });
    save();
    res.json(pollDetail(poll.id, req));
  });

  // Umfrage abschliessen (mit festgelegtem Termin) bzw. wieder oeffnen (final_option_id: null, reopen: true)
  app.post('/api/nk/polls/:id/close', (req, res) => {
    const poll = db.prepare('SELECT * FROM nk_polls WHERE id = ?').get(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    if (!canManage(req, poll.created_by)) return res.status(403).json({ error: 'Nur Ersteller oder Admin dürfen die Umfrage abschließen' });
    const { final_option_id, reopen } = req.body || {};
    if (reopen) {
      db.prepare('UPDATE nk_polls SET closed = 0, final_option_id = NULL WHERE id = ?').run(poll.id);
    } else {
      const opt = final_option_id ? db.prepare('SELECT * FROM nk_poll_options WHERE id = ? AND poll_id = ?').get(final_option_id, poll.id) : null;
      db.prepare('UPDATE nk_polls SET closed = 1, final_option_id = ? WHERE id = ?').run(opt ? opt.id : null, poll.id);
      if (opt && !poll.closed) {
        const [y, m, d] = opt.date.split('-');
        mail.notify({
          tab: 'nk_polls', actorId: req.user.id,
          subject: `Termin festgelegt: ${poll.title}`,
          body: `Für „${poll.title}“ steht der Termin fest: ${d}.${m}.${y}${opt.start_time ? ', ' + opt.start_time.slice(0, 5) + ' Uhr' : ''}.`,
          path: `/nk?poll=${poll.id}`,
        });
      }
    }
    res.json(pollDetail(poll.id, req));
  });

  app.delete('/api/nk/polls/:id', (req, res) => {
    const poll = db.prepare('SELECT * FROM nk_polls WHERE id = ?').get(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
    if (!canManage(req, poll.created_by)) return res.status(403).json({ error: 'Nur Ersteller oder Admin dürfen die Umfrage löschen' });
    db.prepare('DELETE FROM nk_polls WHERE id = ?').run(poll.id);
    res.status(204).end();
  });

  // ---------- Projekte (Konzerte) ----------
  const unseenFilesStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM nk_concert_files f
    WHERE f.concert_id = ? AND NOT EXISTS (SELECT 1 FROM nk_file_reads r WHERE r.file_id = f.id AND r.user_id = ?)
  `);
  function budgetSummary(concertId) {
    const out = { plan_result: null, plan_visitors: null, ist_result: null, ist_visitors: null, ist_income: null, ist_expense: null };
    db.prepare('SELECT * FROM nk_budgets WHERE concert_id = ?').all(concertId).forEach(b => {
      const row = budget.budgetRow(b);
      out[`${b.kind}_result`] = row.totals.result;
      out[`${b.kind}_visitors`] = row.visitors;
      if (b.kind === 'ist') { out.ist_income = row.totals.income; out.ist_expense = row.totals.expense; }
    });
    return out;
  }
  // Sponsoring-Zusagen, die diesem Konzert zugeordnet sind (fuer die Kalkulation)
  function sponsorshipsForConcert(concertId) {
    return db.prepare(`
      SELECT s.id, s.amount, s.status, s.note, sp.name AS sponsor_name, sp.id AS sponsor_id
      FROM nk_sponsorships s JOIN nk_sponsors sp ON sp.id = s.sponsor_id
      WHERE s.concert_id = ? ORDER BY sp.name
    `).all(concertId);
  }

  const unreadForUserStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM nk_comments c
    WHERE c.concert_id = ? AND NOT EXISTS (SELECT 1 FROM nk_comment_reads r WHERE r.comment_id = c.id AND r.user_id = ?)
  `);

  function concertDetail(concertId, req) {
    const concert = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(concertId);
    if (!concert) return null;
    const members = membersWithTab(db, 'nk_projects');
    const fileReadsStmt = db.prepare('SELECT user_id FROM nk_file_reads WHERE file_id = ?');
    const files = db.prepare('SELECT * FROM nk_concert_files WHERE concert_id = ? ORDER BY uploaded_at DESC, id DESC').all(concert.id)
      .map(f => {
        const seenBy = fileReadsStmt.all(f.id).map(r => r.user_id);
        return {
          id: f.id, category: f.category, folder: folderForCategory(f.category), filename: f.filename, size_bytes: f.size_bytes, mime_type: f.mime_type,
          uploaded_at: f.uploaded_at, uploaded_by: displayForUserId(db, f.uploaded_by), in_dropbox: !!f.dropbox_path,
          can_delete: canManage(req, f.uploaded_by),
          seen_by: seenBy, seen_by_me: seenBy.includes(req.user.id), is_mine: f.uploaded_by === req.user.id,
        };
      });
    const budgets = {};
    db.prepare('SELECT * FROM nk_budgets WHERE concert_id = ?').all(concert.id).forEach(b => {
      const row = budget.budgetRow(b);
      budgets[b.kind] = { ...row, updated_by: row.updated_by ? displayForUserId(db, row.updated_by) : null };
    });
    const links = db.prepare('SELECT * FROM nk_links WHERE concert_id = ? ORDER BY id').all(concert.id)
      .map(l => ({ ...l, can_delete: canManage(req, l.created_by) }));
    const readsStmt = db.prepare('SELECT user_id, read_at FROM nk_comment_reads WHERE comment_id = ?');
    const comments = db.prepare('SELECT * FROM nk_comments WHERE concert_id = ? ORDER BY created_at, id').all(concert.id)
      .map(c => {
        const reads = readsStmt.all(c.id);
        return {
          ...c,
          author: displayForUserId(db, c.user_id),
          read_by: reads.map(r => r.user_id),
          read_by_me: reads.some(r => r.user_id === req.user.id),
          can_delete: canManage(req, c.user_id),
        };
      });
    const todos = db.prepare('SELECT * FROM nk_todos WHERE concert_id = ? ORDER BY done, due_date IS NULL, due_date, id').all(concert.id)
      .map(t => ({
        ...t,
        done: !!t.done,
        assignee: t.assignee_id ? displayForUserId(db, t.assignee_id) : null,
        done_by_display: t.done_by ? displayForUserId(db, t.done_by) : null,
        can_delete: canManage(req, t.created_by),
      }));
    return {
      ...concert,
      folder_name: projectFolderName(concert),
      created_by_display: displayForUserId(db, concert.created_by),
      can_manage: canManage(req, concert.created_by),
      files, comments, todos, members, statuses: CONCERT_STATUSES,
      contract_categories: CONTRACT_CATEGORIES,
      budgets, budget_template: budget.emptyBudget(), links,
      gema: {
        registered_at: concert.gema_registered_at, registered_by: concert.gema_registered_by ? displayForUserId(db, concert.gema_registered_by) : null,
        reported_at: concert.gema_reported_at, reported_by: concert.gema_reported_by ? displayForUserId(db, concert.gema_reported_by) : null,
      },
      sponsorships: sponsorshipsForConcert(concert.id),
      ai_available: !!process.env.ANTHROPIC_API_KEY,
    };
  }

  app.get('/api/nk/concerts', (req, res) => {
    const members = membersWithTab(db, 'nk_projects');
    const concerts = db.prepare(`
      SELECT * FROM nk_concerts
      ORDER BY CASE WHEN status IN ('Abgeschlossen', 'Abgesagt') THEN 1 ELSE 0 END, date IS NULL, date, created_at DESC
    `).all();
    res.json(concerts.map(c => {
      const commentIds = db.prepare('SELECT id FROM nk_comments WHERE concert_id = ?').all(c.id).map(r => r.id);
      let allRead = true;
      if (commentIds.length) {
        const readCountStmt = db.prepare('SELECT COUNT(*) AS c FROM nk_comment_reads WHERE comment_id = ? AND user_id IN (' + (members.map(m => m.user_id).join(',') || '0') + ')');
        allRead = commentIds.every(id => readCountStmt.get(id).c >= members.length);
      }
      return {
        ...c,
        folder_name: projectFolderName(c),
        file_count: db.prepare('SELECT COUNT(*) AS c FROM nk_concert_files WHERE concert_id = ?').get(c.id).c,
        contract_count: db.prepare(`SELECT COUNT(*) AS c FROM nk_concert_files WHERE concert_id = ? AND category IN (${CONTRACT_CATEGORIES.map(() => '?').join(',')})`).get(c.id, ...CONTRACT_CATEGORIES).c,
        todo_open: db.prepare('SELECT COUNT(*) AS c FROM nk_todos WHERE concert_id = ? AND done = 0').get(c.id).c,
        todo_total: db.prepare('SELECT COUNT(*) AS c FROM nk_todos WHERE concert_id = ?').get(c.id).c,
        comment_count: commentIds.length,
        unread_count: unreadForUserStmt.get(c.id, req.user.id).c,
        all_read: allRead,
        unseen_files: unseenFilesStmt.get(c.id, req.user.id).c,
        gema_file_count: db.prepare(`SELECT COUNT(*) AS c FROM nk_concert_files WHERE concert_id = ? AND category IN (${GEMA_CATEGORIES.map(() => '?').join(',')})`).get(c.id, ...GEMA_CATEGORIES).c,
        ...budgetSummary(c.id),
      };
    }));
  });

  app.get('/api/nk/summary', (req, res) => {
    const unread = req.tabs.includes('nk_projects') ? db.prepare(`
      SELECT COUNT(*) AS c FROM nk_comments c
      WHERE NOT EXISTS (SELECT 1 FROM nk_comment_reads r WHERE r.comment_id = c.id AND r.user_id = ?)
    `).get(req.user.id).c : 0;
    const openPolls = req.tabs.includes('nk_polls') ? db.prepare(`
      SELECT COUNT(*) AS c FROM nk_polls p WHERE p.closed = 0 AND NOT EXISTS (
        SELECT 1 FROM nk_poll_votes v JOIN nk_poll_options o ON o.id = v.option_id WHERE o.poll_id = p.id AND v.user_id = ?)
    `).get(req.user.id).c : 0;
    const unseenFiles = req.tabs.includes('nk_projects') ? db.prepare(`
      SELECT COUNT(*) AS c FROM nk_concert_files f
      WHERE NOT EXISTS (SELECT 1 FROM nk_file_reads r WHERE r.file_id = f.id AND r.user_id = ?)
    `).get(req.user.id).c : 0;
    res.json({ unread_comments: unread, unseen_files: unseenFiles, open_polls: openPolls });
  });

  app.get('/api/nk/concerts/:id', (req, res) => {
    const detail = concertDetail(req.params.id, req);
    if (!detail) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    res.json(detail);
  });

  app.post('/api/nk/concerts', (req, res) => {
    const { title, date, time, location, status, notes } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Titel ist erforderlich' });
    const info = db.prepare(`
      INSERT INTO nk_concerts (title, date, time, location, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title.trim(), date || null, time || null, location || null,
      CONCERT_STATUSES.includes(status) ? status : 'Planung', notes || null, req.user.id);
    res.status(201).json(concertDetail(info.lastInsertRowid, req));
  });

  app.put('/api/nk/concerts/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const b = req.body || {};
    db.prepare('UPDATE nk_concerts SET title = ?, date = ?, time = ?, location = ?, status = ?, notes = ? WHERE id = ?').run(
      b.title !== undefined ? (String(b.title).trim() || c.title) : c.title,
      b.date !== undefined ? (b.date || null) : c.date,
      b.time !== undefined ? (b.time || null) : c.time,
      b.location !== undefined ? (b.location || null) : c.location,
      b.status !== undefined && CONCERT_STATUSES.includes(b.status) ? b.status : c.status,
      b.notes !== undefined ? (b.notes || null) : c.notes,
      c.id
    );
    res.json(concertDetail(c.id, req));
  });

  app.delete('/api/nk/concerts/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    if (!canManage(req, c.created_by)) return res.status(403).json({ error: 'Nur Ersteller oder Admin dürfen das Projekt löschen' });
    // Lokale Kopien der Dateien bleiben als Sicherung liegen (Dropbox-Kopie ebenfalls).
    db.prepare('DELETE FROM nk_concerts WHERE id = ?').run(c.id);
    res.status(204).end();
  });

  // Datei-Upload: dauerhaft auf dem Volume gespeichert, zusaetzlich (falls eingerichtet) nach Dropbox kopiert.
  app.post('/api/nk/concerts/:id/files', async (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const { category, filename, file_base64, mime_type } = req.body || {};
    if (!filename || !file_base64) return res.status(400).json({ error: 'Datei fehlt' });
    const buffer = Buffer.from(file_base64, 'base64');
    if (buffer.length > MAX_FILE_BYTES) return res.status(400).json({ error: 'Datei ist zu groß (max. 18 MB)' });

    const stored = await storeConcertFile(c, { category: category || 'Sonstiges', filename, buffer, mimeType: mime_type, userId: req.user.id });
    notifyFile(c, stored.filename, category || 'Sonstiges', req.user.id);
    res.status(201).json({ id: stored.id, detail: concertDetail(c.id, req) });
  });

  function notifyFile(c, filename, category, actorId) {
    mail.notify({
      tab: 'nk_projects', actorId,
      subject: `Neue Datei bei ${c.title}`,
      body: `${displayForUserId(db, actorId).name} hat „${filename}“ (${category}) bei „${c.title}“ hochgeladen.`,
      path: `/nk?concert=${c.id}`,
    });
  }

  // Gesehen-Status: einzelne Datei bestaetigen (oder zuruecknehmen) bzw. alle Dateien eines Konzerts
  app.post('/api/nk/concerts/:id/files/:fileId/seen', (req, res) => {
    const f = db.prepare('SELECT * FROM nk_concert_files WHERE id = ? AND concert_id = ?').get(req.params.fileId, req.params.id);
    if (!f) return res.status(404).json({ error: 'Datei nicht gefunden' });
    if (req.body && req.body.unseen) db.prepare('DELETE FROM nk_file_reads WHERE file_id = ? AND user_id = ?').run(f.id, req.user.id);
    else db.prepare('INSERT OR IGNORE INTO nk_file_reads (file_id, user_id) VALUES (?, ?)').run(f.id, req.user.id);
    res.json(concertDetail(req.params.id, req));
  });
  app.post('/api/nk/concerts/:id/files-seen-all', (req, res) => {
    const ids = db.prepare('SELECT id FROM nk_concert_files WHERE concert_id = ?').all(req.params.id).map(r => r.id);
    const stmt = db.prepare('INSERT OR IGNORE INTO nk_file_reads (file_id, user_id) VALUES (?, ?)');
    db.transaction(() => ids.forEach(id => stmt.run(id, req.user.id)))();
    res.json(concertDetail(req.params.id, req));
  });

  app.get('/api/nk/concerts/:id/files/:fileId/download', async (req, res) => {
    const f = db.prepare('SELECT * FROM nk_concert_files WHERE id = ? AND concert_id = ?').get(req.params.fileId, req.params.id);
    if (!f) return res.status(404).send('Datei nicht gefunden');
    const localPath = f.stored_path ? path.join(FILES_DIR, f.stored_path) : null;
    if (localPath && fs.existsSync(localPath)) {
      const disposition = req.query.download ? 'attachment' : 'inline';
      res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
      if (f.mime_type) res.type(f.mime_type);
      return res.sendFile(localPath);
    }
    if (f.dropbox_path && contracts.isDropboxConfigured()) {
      try {
        const token = await contracts.getAccessToken();
        return res.redirect(await contracts.getTemporaryLink(token, f.dropbox_path));
      } catch (err) {
        return res.status(502).send('Datei konnte nicht aus Dropbox geladen werden: ' + err.message);
      }
    }
    res.status(404).send('Datei ist nicht mehr vorhanden');
  });

  app.delete('/api/nk/concerts/:id/files/:fileId', (req, res) => {
    const f = db.prepare('SELECT * FROM nk_concert_files WHERE id = ? AND concert_id = ?').get(req.params.fileId, req.params.id);
    if (!f) return res.status(404).json({ error: 'Datei nicht gefunden' });
    if (!canManage(req, f.uploaded_by)) return res.status(403).json({ error: 'Nur wer hochgeladen hat oder ein Admin darf die Datei entfernen' });
    // Nur der Eintrag verschwindet; die Datei selbst bleibt auf dem Volume und in Dropbox als Sicherung.
    db.prepare('DELETE FROM nk_concert_files WHERE id = ?').run(f.id);
    res.json(concertDetail(req.params.id, req));
  });

  // ---------- 2Dos ----------
  const cleanDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
  const validUserId = (id) => (id && db.prepare('SELECT id FROM app_users WHERE id = ?').get(+id) ? +id : null);

  app.post('/api/nk/concerts/:id/todos', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: '2Do ist leer' });
    const assignee = validUserId(b.assignee_id);
    db.prepare('INSERT INTO nk_todos (concert_id, title, assignee_id, due_date, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, title.slice(0, 500), assignee, cleanDate(b.due_date), req.user.id);
    if (assignee) notifyTodo(c, title, assignee, cleanDate(b.due_date), req.user.id);
    res.status(201).json(concertDetail(c.id, req));
  });

  function notifyTodo(c, title, assigneeId, dueDate, actorId) {
    const due = dueDate ? ` (fällig ${dueDate.split('-').reverse().join('.')})` : '';
    mail.notify({
      tab: 'nk_projects', actorId, onlyUserIds: [assigneeId],
      subject: `Neues 2Do für dich: ${title}`,
      body: `${displayForUserId(db, actorId).name} hat dir bei „${c.title}“ das 2Do „${title}“${due} zugewiesen.`,
      path: `/nk?concert=${c.id}&folder=todos`,
    });
  }

  app.put('/api/nk/concerts/:id/todos/:todoId', (req, res) => {
    const t = db.prepare('SELECT * FROM nk_todos WHERE id = ? AND concert_id = ?').get(req.params.todoId, req.params.id);
    if (!t) return res.status(404).json({ error: '2Do nicht gefunden' });
    const b = req.body || {};
    if (b.assignee_id !== undefined) {
      const next = validUserId(b.assignee_id);
      if (next && next !== t.assignee_id) {
        const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
        notifyTodo(c, b.title !== undefined ? String(b.title).trim() || t.title : t.title, next, b.due_date !== undefined ? cleanDate(b.due_date) : t.due_date, req.user.id);
      }
    }
    const done = b.done !== undefined ? !!b.done : !!t.done;
    db.prepare('UPDATE nk_todos SET title = ?, assignee_id = ?, due_date = ?, done = ?, done_by = ?, done_at = ? WHERE id = ?').run(
      b.title !== undefined ? (String(b.title).trim().slice(0, 500) || t.title) : t.title,
      b.assignee_id !== undefined ? validUserId(b.assignee_id) : t.assignee_id,
      b.due_date !== undefined ? cleanDate(b.due_date) : t.due_date,
      done ? 1 : 0,
      done ? (t.done ? t.done_by : req.user.id) : null,
      done ? (t.done ? t.done_at : new Date().toISOString().slice(0, 19).replace('T', ' ')) : null,
      t.id
    );
    res.json(concertDetail(req.params.id, req));
  });

  app.delete('/api/nk/concerts/:id/todos/:todoId', (req, res) => {
    const t = db.prepare('SELECT * FROM nk_todos WHERE id = ? AND concert_id = ?').get(req.params.todoId, req.params.id);
    if (!t) return res.status(404).json({ error: '2Do nicht gefunden' });
    if (!canManage(req, t.created_by)) return res.status(403).json({ error: 'Nur wer das 2Do angelegt hat oder ein Admin darf es löschen' });
    db.prepare('DELETE FROM nk_todos WHERE id = ?').run(t.id);
    res.json(concertDetail(req.params.id, req));
  });

  app.post('/api/nk/concerts/:id/comments', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Kommentar ist leer' });
    const info = db.prepare('INSERT INTO nk_comments (concert_id, user_id, body) VALUES (?, ?, ?)').run(c.id, req.user.id, body.slice(0, 5000));
    db.prepare('INSERT OR IGNORE INTO nk_comment_reads (comment_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, req.user.id);
    mail.notify({
      tab: 'nk_projects', actorId: req.user.id,
      subject: `Neuer Kommentar bei ${c.title}`,
      body: `${displayForUserId(db, req.user.id).name} bei „${c.title}“: ${body.length > 400 ? body.slice(0, 400) + ' …' : body}`,
      path: `/nk?concert=${c.id}&folder=agreements`,
    });
    res.status(201).json(concertDetail(c.id, req));
  });

  app.delete('/api/nk/concerts/:id/comments/:commentId', (req, res) => {
    const cm = db.prepare('SELECT * FROM nk_comments WHERE id = ? AND concert_id = ?').get(req.params.commentId, req.params.id);
    if (!cm) return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    if (!canManage(req, cm.user_id)) return res.status(403).json({ error: 'Nur eigene Kommentare können gelöscht werden' });
    db.prepare('DELETE FROM nk_comments WHERE id = ?').run(cm.id);
    res.json(concertDetail(req.params.id, req));
  });

  app.post('/api/nk/concerts/:id/comments/:commentId/read', (req, res) => {
    const cm = db.prepare('SELECT * FROM nk_comments WHERE id = ? AND concert_id = ?').get(req.params.commentId, req.params.id);
    if (!cm) return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    if (req.body && req.body.unread) {
      db.prepare('DELETE FROM nk_comment_reads WHERE comment_id = ? AND user_id = ?').run(cm.id, req.user.id);
    } else {
      db.prepare('INSERT OR IGNORE INTO nk_comment_reads (comment_id, user_id) VALUES (?, ?)').run(cm.id, req.user.id);
    }
    res.json(concertDetail(req.params.id, req));
  });

  app.post('/api/nk/concerts/:id/read-all', (req, res) => {
    const ids = db.prepare('SELECT id FROM nk_comments WHERE concert_id = ?').all(req.params.id).map(r => r.id);
    const stmt = db.prepare('INSERT OR IGNORE INTO nk_comment_reads (comment_id, user_id) VALUES (?, ?)');
    db.transaction(() => ids.forEach(id => stmt.run(id, req.user.id)))();
    res.json(concertDetail(req.params.id, req));
  });

  // ---------- Kalkulation (plan) & Abrechnung (ist) ----------
  app.put('/api/nk/concerts/:id/budget/:kind', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    if (!budget.KINDS.includes(req.params.kind)) return res.status(400).json({ error: 'Unbekannte Art' });
    const b = req.body || {};
    const data = budget.cleanBudget(b.data);
    db.prepare(`
      INSERT INTO nk_budgets (concert_id, kind, data, visitors, source, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(concert_id, kind) DO UPDATE SET data = excluded.data, visitors = excluded.visitors,
        source = COALESCE(excluded.source, nk_budgets.source), updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(c.id, req.params.kind, JSON.stringify(data), budget.cleanVisitors(b.visitors), b.source ? String(b.source).slice(0, 300) : null, req.user.id);
    res.json(concertDetail(c.id, req));
  });

  app.delete('/api/nk/concerts/:id/budget/:kind', (req, res) => {
    db.prepare('DELETE FROM nk_budgets WHERE concert_id = ? AND kind = ?').run(req.params.id, req.params.kind);
    res.json(concertDetail(req.params.id, req));
  });

  // Excel/CSV hochladen: Datei wird im Ordner "Kalkulation" abgelegt, Claude liest sie aus.
  // Das Ergebnis wird NICHT direkt gespeichert, sondern im Editor zur Kontrolle angezeigt.
  app.post('/api/nk/concerts/:id/budget-import', async (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const { filename, file_base64, mime_type, kind } = req.body || {};
    if (!filename || !file_base64) return res.status(400).json({ error: 'Datei fehlt' });
    if (!/\.(xlsx|xlsm|xls|ods|csv|numbers)$/i.test(filename)) return res.status(400).json({ error: 'Bitte eine Excel-Datei (.xlsx, .xls), .ods oder .csv hochladen' });
    if (/\.numbers$/i.test(filename)) return res.status(400).json({ error: 'Numbers-Dateien bitte vorher als Excel exportieren (Ablage › Exportieren › Excel).' });
    const buffer = Buffer.from(file_base64, 'base64');
    if (buffer.length > MAX_FILE_BYTES) return res.status(400).json({ error: 'Datei ist zu groß (max. 18 MB)' });
    try {
      const result = await budget.analyzeSpreadsheet(buffer, filename, c.title);
      const category = (kind || result.kind_guess) === 'ist' ? 'Abrechnung' : 'Kalkulation';
      const stored = await storeConcertFile(c, { category, filename, buffer, mimeType: mime_type, userId: req.user.id });
      notifyFile(c, stored.filename, category, req.user.id);
      res.json({ ...result, source: `Excel-Import: ${stored.filename}`, detail: concertDetail(c.id, req) });
    } catch (err) {
      console.error('[NK] Excel-Import fehlgeschlagen:', err);
      res.status(err.status ? 502 : 400).json({ error: err.message });
    }
  });

  // ---------- GEMA ----------
  app.put('/api/nk/concerts/:id/gema', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const b = req.body || {};
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    ['registered', 'reported'].forEach(key => {
      if (b[key] === undefined) return;
      db.prepare(`UPDATE nk_concerts SET gema_${key}_at = ?, gema_${key}_by = ? WHERE id = ?`)
        .run(b[key] ? now : null, b[key] ? req.user.id : null, c.id);
    });
    res.json(concertDetail(c.id, req));
  });

  app.post('/api/nk/concerts/:id/links', (req, res) => {
    const c = db.prepare('SELECT * FROM nk_concerts WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    let url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: 'Link fehlt' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Das ist kein gültiger Link' }); }
    const title = String((req.body && req.body.title) || '').trim().slice(0, 200) || url.replace(/^https?:\/\//, '').slice(0, 80);
    db.prepare('INSERT INTO nk_links (concert_id, section, title, url, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, 'gema', title, url.slice(0, 2000), req.user.id);
    res.status(201).json(concertDetail(c.id, req));
  });

  app.delete('/api/nk/concerts/:id/links/:linkId', (req, res) => {
    const l = db.prepare('SELECT * FROM nk_links WHERE id = ? AND concert_id = ?').get(req.params.linkId, req.params.id);
    if (!l) return res.status(404).json({ error: 'Link nicht gefunden' });
    if (!canManage(req, l.created_by)) return res.status(403).json({ error: 'Nur wer den Link angelegt hat oder ein Admin darf ihn löschen' });
    db.prepare('DELETE FROM nk_links WHERE id = ?').run(l.id);
    res.json(concertDetail(req.params.id, req));
  });
}

module.exports = { register, storeConcertFile, safeFileName, FILES_DIR, DROPBOX_NK_FOLDER, MAX_FILE_BYTES };
