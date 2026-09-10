(() => {
  'use strict';

  // ---------- State ----------
  let people = [];
  let tasks = [];
  let calendarEntries = [];
  let timeEntries = [];
  let activeTimers = [];
  let absences = [];
  let currentWeekStart = getMonday(new Date());
  let calendarViewMode = 'week'; // 'week' | 'day'
  let currentDay = new Date();
  let reportWeekStart = getMonday(new Date());
  let editingTaskId = null;
  let editingPersonId = null;
  let editingTimeEntryId = null;
  let lifetimeBalances = new Map(); // person_id -> lifetime report response
  let pendingDrop = null; // { taskId } fuer Neuplanung aus dem Pool
  let pendingMove = null; // { entryId, duration } fuer Verschieben eines bestehenden Termins
  let pendingEntryForMenu = null;
  let estimateDebounce = null;
  let pinResolver = null;
  let taskFilters = { search: '', person: '', status: '', priority: '' };

  const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const START_HOUR = 7;
  const END_HOUR = 20;
  const SLOT_MINUTES = 30;
  const SLOT_HEIGHT = 24;
  const SLOTS_PER_DAY = ((END_HOUR - START_HOUR) * 60) / SLOT_MINUTES;
  const WEEK_DAY_WIDTH = 140;
  const DAY_VIEW_WIDTH = 640;

  // ---------- Utilities ----------
  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function minutesToTime(mins) { return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`; }
  function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  function slotIndexToTime(idx) { return minutesToTime(START_HOUR * 60 + idx * SLOT_MINUTES); }
  function fmtDateLabel(d) { return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); }
  function fmtDuration(mins) {
    if (mins === null || mins === undefined || isNaN(mins)) return '–';
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return `${h} Std ${m} Min`;
    if (h) return `${h} Std`;
    return `${m} Min`;
  }
  function fmtDateDE(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  async function api(path, options) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      return new Promise(() => {}); // Weiterlaufen des aktuellen Codepfads verhindern, Redirect uebernimmt
    }
    if (!res.ok) {
      let msg = 'Fehler bei der Anfrage';
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Tabs ----------
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('tab-' + tab).classList.add('active');
      const pageTitle = document.getElementById('page-title');
      if (pageTitle) pageTitle.textContent = btn.dataset.title || btn.textContent.trim();
      if (tab === 'today') renderToday();
      if (tab === 'calendar') renderCalendar();
      if (tab === 'dashboard') renderDashboard();
      if (tab === 'timetracking') { loadReport(); loadAbsences(); loadWarnings(); }
    });
  });

  // ================= PIN-Schutz ================= 
  const pinOverlay = document.getElementById('pin-modal-overlay');
  const pinInput = document.getElementById('pin-modal-input');
  const pinText = document.getElementById('pin-modal-text');

  function requirePin(personId, actionLabel) {
    const person = people.find(p => p.id === personId);
    if (!person || !person.has_pin) return Promise.resolve(true);
    pinText.textContent = `${person.name} hat eine PIN hinterlegt. Bitte PIN eingeben, um "${actionLabel}" fortzusetzen.`;
    pinInput.value = '';
    pinOverlay.classList.remove('hidden');
    pinInput.focus();
    return new Promise(resolve => {
      pinResolver = { resolve, personId };
    });
  }

  document.getElementById('pin-modal-confirm').addEventListener('click', async () => {
    if (!pinResolver) return;
    const { resolve, personId } = pinResolver;
    try {
      const result = await api(`/api/people/${personId}/verify-pin`, { method: 'POST', body: JSON.stringify({ pin: pinInput.value.trim() }) });
      if (result.valid) {
        pinOverlay.classList.add('hidden');
        pinResolver = null;
        resolve(true);
      } else {
        pinText.textContent = 'Falsche PIN, bitte erneut versuchen.';
        pinInput.value = '';
        pinInput.focus();
      }
    } catch (e) {
      pinText.textContent = 'Fehler bei der PIN-Prüfung.';
    }
  });
  document.getElementById('pin-modal-cancel').addEventListener('click', () => {
    if (pinResolver) { pinResolver.resolve(false); pinResolver = null; }
    pinOverlay.classList.add('hidden');
  });
  pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('pin-modal-confirm').click(); });

  // ================= QUICKSTART ================= 
  const quickstartForm = document.getElementById('quickstart-form');
  quickstartForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const personId = +document.getElementById('quickstart-person').value;
    const title = document.getElementById('quickstart-title').value.trim();
    if (!personId) return;
    const ok = await requirePin(personId, 'Schnellstart');
    if (!ok) return;
    await api('/api/time-entries/quick-start', { method: 'POST', body: JSON.stringify({ person_id: personId, title }) });
    document.getElementById('quickstart-title').value = '';
    await refreshAfterTimerChange();
  });

  // ================= PEOPLE =================
  const personForm = document.getElementById('person-form');
  const personNameInput = document.getElementById('person-name');
  const personRoleInput = document.getElementById('person-role');
  const personColorInput = document.getElementById('person-color');
  const personIdInput = document.getElementById('person-id');
  const personEmailInput = document.getElementById('person-email');
  const personPinInput = document.getElementById('person-pin');
  const personWeeklyHoursInput = document.getElementById('person-weekly-hours');
  const personPinStatus = document.getElementById('person-pin-status');
  const personSubmitBtn = document.getElementById('person-submit-btn');
  const personCancelBtn = document.getElementById('person-cancel-btn');
  const personContractTypeInput = document.getElementById('person-contract-type');
  const bfdFieldsBlock = document.getElementById('bfd-fields');
  const personVacationDaysInput = document.getElementById('person-vacation-days');
  const personProbationWeeksInput = document.getElementById('person-probation-weeks');
  const personContractStartInput = document.getElementById('person-contract-start');
  const personContractEndInput = document.getElementById('person-contract-end');
  const contractFileInput = document.getElementById('contract-file-input');
  const contractParseHint = document.getElementById('contract-parse-hint');
  let clearPinFlag = false;

  personContractTypeInput.addEventListener('change', () => {
    bfdFieldsBlock.classList.toggle('hidden', !personContractTypeInput.value);
  });

  document.getElementById('bfd-defaults-btn').addEventListener('click', async () => {
    try {
      const d = await api('/api/bfd-defaults');
      personWeeklyHoursInput.value = d.weekly_hours;
      personVacationDaysInput.value = d.vacation_days;
      personProbationWeeksInput.value = d.probation_weeks;
    } catch (e) { /* ignorieren */ }
  });

  contractFileInput.addEventListener('change', () => {
    const file = contractFileInput.files[0];
    if (!file) return;
    contractParseHint.classList.remove('hidden');
    contractParseHint.innerHTML = '<span>Vertrag wird gelesen …</span>';
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1];
      try {
        const result = await api('/api/people/parse-contract', { method: 'POST', body: JSON.stringify({ file_base64: base64 }) });
        renderContractParseResult(result);
      } catch (err) {
        contractParseHint.innerHTML = `<span>Fehler beim Lesen der PDF: ${escapeHtml(err.message)}</span>`;
      }
    };
    reader.readAsDataURL(file);
  });

  function renderContractParseResult(result) {
    if (result.likely_scanned || result.found_count === 0) {
      contractParseHint.innerHTML = `<span>${escapeHtml(result.message || 'Es konnten keine Werte automatisch erkannt werden. Bitte manuell eintragen.')}</span>`;
      return;
    }
    const parts = [];
    if (result.weekly_hours) parts.push(`${result.weekly_hours} Std/Woche`);
    if (result.vacation_days) parts.push(`${result.vacation_days} Urlaubstage`);
    if (result.probation_weeks) parts.push(`${result.probation_weeks} Wochen Probezeit`);
    if (result.contract_start && result.contract_end) parts.push(`${fmtDateDE(result.contract_start)} – ${fmtDateDE(result.contract_end)}`);
    if (result.seminar_days_total) parts.push(`${result.seminar_days_total} Seminartage`);
    contractParseHint.innerHTML = `
      <span>Gefunden: ${parts.map(escapeHtml).join(', ')}</span>
      <button type="button" id="contract-apply-btn">Übernehmen</button>
    `;
    document.getElementById('contract-apply-btn').addEventListener('click', () => {
      if (result.weekly_hours) personWeeklyHoursInput.value = result.weekly_hours;
      if (result.vacation_days) personVacationDaysInput.value = result.vacation_days;
      if (result.probation_weeks) personProbationWeeksInput.value = result.probation_weeks;
      if (result.contract_start) personContractStartInput.value = result.contract_start;
      if (result.contract_end) personContractEndInput.value = result.contract_end;
      contractParseHint.classList.add('hidden');
    });
  }

  async function loadPeople() {
    people = await api('/api/people');
    renderPeopleList();
    renderTaskPeopleCheckboxes();
    fillPersonSelects();
  }

  function renderPeopleList() {
    const container = document.getElementById('people-list');
    if (!people.length) {
      container.innerHTML = '<p class="empty-state">Noch keine Personen angelegt.</p>';
      return;
    }
    container.innerHTML = '';
    people.forEach(p => {
      const row = document.createElement('div');
      row.className = 'person-row';
      const weeklyHours = p.weekly_target_minutes ? (p.weekly_target_minutes / 60).toFixed(1).replace(/\.0$/, '') : null;
      const contractMeta = p.contract_type
        ? ` · ${escapeHtml(p.contract_type)}${p.vacation_days_total ? ` (${p.vacation_days_total} Urlaubstage)` : ''}`
        : '';
      row.innerHTML = `
        <div class="person-row-main">
          <span class="color-dot" style="background:${p.color}"></span>
          <div>
            <div><strong>${escapeHtml(p.name)}</strong>${p.active ? '' : ' <span class="status-badge">inaktiv</span>'}${p.has_pin ? ' <span class="status-badge">🔒 PIN</span>' : ''}${p.contract_type ? ` <span class="status-badge">${escapeHtml(p.contract_type)}</span>` : ''}</div>
            <div class="task-meta">${escapeHtml(p.role || '')}${p.email ? ' · ' + escapeHtml(p.email) : ''}${weeklyHours ? ' · Soll ' + weeklyHours + ' Std/Woche' : ''}${contractMeta}</div>
          </div>
        </div>
        <div class="row-actions">
          <button class="ghost" data-edit="${p.id}">Bearbeiten</button>
          <button class="danger" data-delete="${p.id}">Löschen</button>
        </div>
      `;
      container.appendChild(row);
    });
    container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => startEditPerson(+b.dataset.edit)));
    container.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => deletePerson(+b.dataset.delete)));
  }

  function startEditPerson(id) {
    const p = people.find(x => x.id === id);
    if (!p) return;
    editingPersonId = id;
    clearPinFlag = false;
    personIdInput.value = id;
    personNameInput.value = p.name;
    personRoleInput.value = p.role || '';
    personColorInput.value = p.color || '#4f46e5';
    personEmailInput.value = p.email || '';
    personPinInput.value = '';
    personWeeklyHoursInput.value = p.weekly_target_minutes ? p.weekly_target_minutes / 60 : '';
    personContractTypeInput.value = p.contract_type || '';
    personVacationDaysInput.value = p.vacation_days_total || '';
    personProbationWeeksInput.value = p.probation_weeks || '';
    personContractStartInput.value = p.contract_start || '';
    personContractEndInput.value = p.contract_end || '';
    bfdFieldsBlock.classList.toggle('hidden', !p.contract_type);
    contractParseHint.classList.add('hidden');
    personSubmitBtn.textContent = 'Änderungen speichern';
    personCancelBtn.classList.remove('hidden');
    renderPinStatus(p);
  }

  function renderPinStatus(p) {
    if (p && p.has_pin) {
      personPinStatus.innerHTML = 'PIN ist gesetzt. Neue PIN eingeben zum Ändern, oder <a href="#" id="clear-pin-link">PIN entfernen</a>.';
      const link = document.getElementById('clear-pin-link');
      if (link) link.addEventListener('click', (e) => {
        e.preventDefault();
        clearPinFlag = true;
        personPinStatus.textContent = 'PIN wird beim Speichern entfernt.';
      });
    } else {
      personPinStatus.textContent = '';
    }
  }

  function resetPersonForm() {
    editingPersonId = null;
    clearPinFlag = false;
    personForm.reset();
    personColorInput.value = '#4f46e5';
    personSubmitBtn.textContent = 'Person anlegen';
    personCancelBtn.classList.add('hidden');
    personPinStatus.textContent = '';
    bfdFieldsBlock.classList.add('hidden');
    contractParseHint.classList.add('hidden');
  }
  personCancelBtn.addEventListener('click', resetPersonForm);

  personForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: personNameInput.value.trim(),
      role: personRoleInput.value.trim(),
      color: personColorInput.value,
      email: personEmailInput.value.trim(),
      weekly_target_minutes: personWeeklyHoursInput.value ? Math.round(+personWeeklyHoursInput.value * 60) : null,
      contract_type: personContractTypeInput.value || null,
      vacation_days_total: personVacationDaysInput.value ? +personVacationDaysInput.value : null,
      probation_weeks: personProbationWeeksInput.value ? +personProbationWeeksInput.value : null,
      contract_start: personContractStartInput.value || null,
      contract_end: personContractEndInput.value || null,
    };
    if (personPinInput.value.trim()) payload.pin = personPinInput.value.trim();
    if (clearPinFlag) payload.clear_pin = true;
    if (!payload.name) return;
    if (editingPersonId) {
      await api(`/api/people/${editingPersonId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/people', { method: 'POST', body: JSON.stringify(payload) });
    }
    resetPersonForm();
    await loadPeople();
  });

  async function deletePerson(id) {
    if (!confirm('Person wirklich löschen? Zugeordnete Aufgaben und Termine dieser Person werden ebenfalls entfernt.')) return;
    await api(`/api/people/${id}`, { method: 'DELETE' });
    await loadPeople();
    await loadTasks();
    await loadCalendar();
  }

  function fillPersonSelects() {
    const activePeople = people.filter(p => p.active);
    const optionsHtml = activePeople.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

    document.getElementById('time-person').innerHTML = optionsHtml;
    document.getElementById('absence-person').innerHTML = optionsHtml;
    document.getElementById('quickstart-person').innerHTML = optionsHtml;
    document.getElementById('time-filter-person').innerHTML = '<option value="">Alle</option>' + optionsHtml;
    document.getElementById('task-filter-person').innerHTML = '<option value="">Alle</option>' + optionsHtml;
  }

  // ================= TASKS =================
  const taskForm = document.getElementById('task-form');
  const taskIdInput = document.getElementById('task-id');
  const taskTitleInput = document.getElementById('task-title');
  const taskDescInput = document.getElementById('task-description');
  const taskDurationInput = document.getElementById('task-duration');
  const taskStatusInput = document.getElementById('task-status');
  const taskPriorityInput = document.getElementById('task-priority');
  const taskDueDateInput = document.getElementById('task-due-date');
  const taskDueTimeInput = document.getElementById('task-due-time');
  const taskSubmitBtn = document.getElementById('task-submit-btn');
  const taskCancelBtn = document.getElementById('task-cancel-btn');

  async function loadTasks() {
    tasks = await api('/api/tasks');
    renderTaskList();
    fillTaskSelect();
    if (document.getElementById('tab-calendar').classList.contains('active')) renderCalendar();
    if (document.getElementById('tab-dashboard').classList.contains('active')) renderDashboard();
    if (document.getElementById('tab-today').classList.contains('active')) renderToday();
  }

  function renderTaskPeopleCheckboxes() {
    const container = document.getElementById('task-people-checkboxes');
    if (!people.length) {
      container.innerHTML = '<span class="task-meta">Erst Personen anlegen.</span>';
      return;
    }
    container.innerHTML = people.filter(p => p.active).map(p => `
      <label>
        <input type="checkbox" value="${p.id}">
        ${escapeHtml(p.name)}
      </label>
    `).join('');
  }

  function statusClass(status) { return status.replace(' ', '-'); }

  // ---------- Start/Stopp-Zeiterfassung ----------
  async function loadActiveTimers() {
    activeTimers = await api('/api/time-entries/active');
  }

  function findActiveTimer(taskId, personId) {
    return activeTimers.find(e => e.task_id === taskId && e.person_id === personId);
  }

  async function startTimer(taskId, personId) {
    const ok = await requirePin(personId, 'Zeit starten');
    if (!ok) return;
    await api('/api/time-entries/start', { method: 'POST', body: JSON.stringify({ task_id: taskId, person_id: personId }) });
    await refreshAfterTimerChange();
  }

  async function stopTimer(entryId) {
    await api(`/api/time-entries/${entryId}/stop`, { method: 'POST' });
    await refreshAfterTimerChange();
  }

  async function refreshAfterTimerChange() {
    await loadActiveTimers();
    await loadTasks();
    if (document.getElementById('tab-timetracking').classList.contains('active')) {
      await loadTimeEntries();
      await loadReport();
      await loadWarnings();
    }
    if (document.getElementById('tab-today').classList.contains('active')) await renderToday();
  }

  function renderTaskTimers(task) {
    if (!task.people.length) {
      return '<div class="task-tracked-total">Erst eine Person zuordnen, um Zeit zu erfassen.</div>';
    }
    const rows = task.people.map(p => {
      const running = findActiveTimer(task.id, p.id);
      if (running) {
        return `
          <div class="timer-row">
            <span class="timer-person"><span class="color-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</span>
            <span class="timer-elapsed" data-start-iso="${running.date}T${running.start_time}">00:00:00</span>
            <button class="timer-btn stop" data-stop="${running.id}">■ Stopp</button>
          </div>`;
      }
      return `
        <div class="timer-row">
          <span class="timer-person"><span class="color-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</span>
          <button class="timer-btn start" data-start-task="${task.id}" data-start-person="${p.id}">▶ Start</button>
        </div>`;
    }).join('');
    const trackedLine = task.actual_minutes
      ? `<div class="task-tracked-total">Bisher erfasst: ${fmtDuration(task.actual_minutes)}</div>`
      : '';
    return `${trackedLine}<div class="task-timers">${rows}</div>`;
  }

  function getFilteredTasks() {
    const search = taskFilters.search.trim().toLowerCase();
    return tasks.filter(t => {
      if (search && !(t.title.toLowerCase().includes(search) || (t.description || '').toLowerCase().includes(search))) return false;
      if (taskFilters.person && !t.people.some(p => p.id === +taskFilters.person)) return false;
      if (taskFilters.status && t.status !== taskFilters.status) return false;
      if (taskFilters.priority && t.priority !== taskFilters.priority) return false;
      return true;
    });
  }

  function taskRowHtml(t, opts) {
    opts = opts || {};
    const todayIso = isoDate(new Date());
    const overdue = t.due_date && t.due_date < todayIso && t.status !== 'erledigt';
    return `
      <div class="task-row" data-task-row="${t.id}">
        <div class="task-row-main">
          <div class="task-title-line">
            ${escapeHtml(t.title)}
            <span class="status-badge ${statusClass(t.status)}">${escapeHtml(t.status)}</span>
            <span class="priority-badge ${t.priority}">${escapeHtml(t.priority)}</span>
          </div>
          <div class="task-meta">
            Geschätzt: ${fmtDuration(t.estimated_minutes)}
            ${t.due_date ? ` · <span class="due-date ${overdue ? 'overdue' : ''}">Fällig: ${fmtDateDE(t.due_date)}</span>` : ''}
          </div>
          ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
          <div class="people-chips">
            ${t.people.length
              ? t.people.map(p => `<span class="person-chip" style="background:${p.color}">${escapeHtml(p.name)}</span>`).join('')
              : '<span class="task-meta">Niemandem zugeordnet</span>'}
          </div>
          ${opts.withTimers ? renderTaskTimers(t) : ''}
        </div>
        <div class="row-actions">
          <button class="ghost" data-edit="${t.id}">Bearbeiten</button>
          <button class="danger" data-delete="${t.id}">Löschen</button>
        </div>
      </div>
    `;
  }

  function wireTaskRowButtons(container) {
    container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => startEditTask(+b.dataset.edit)));
    container.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => deleteTask(+b.dataset.delete)));
    container.querySelectorAll('[data-start-task]').forEach(b => b.addEventListener('click', () =>
      startTimer(+b.dataset.startTask, +b.dataset.startPerson)));
    container.querySelectorAll('[data-stop]').forEach(b => b.addEventListener('click', () => stopTimer(+b.dataset.stop)));
    tickElapsedDisplays();
  }

  function renderTaskList() {
    const container = document.getElementById('task-list');
    const filtered = getFilteredTasks();
    if (!tasks.length) {
      container.innerHTML = '<p class="empty-state">Noch keine Aufgaben angelegt.</p>';
      return;
    }
    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine Aufgaben passen zu den Filtern.</p>';
      return;
    }
    container.innerHTML = filtered.map(t => taskRowHtml(t, { withTimers: true })).join('');
    wireTaskRowButtons(container);
  }

  ['task-filter-search', 'task-filter-person', 'task-filter-status', 'task-filter-priority'].forEach(id => {
    const el = document.getElementById(id);
    const handler = () => {
      taskFilters = {
        search: document.getElementById('task-filter-search').value,
        person: document.getElementById('task-filter-person').value,
        status: document.getElementById('task-filter-status').value,
        priority: document.getElementById('task-filter-priority').value,
      };
      renderTaskList();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });

  function tickElapsedDisplays() {
    document.querySelectorAll('.timer-elapsed').forEach(el => {
      const start = new Date(el.dataset.startIso);
      if (isNaN(start.getTime())) return;
      const diffSec = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
      const h = String(Math.floor(diffSec / 3600)).padStart(2, '0');
      const m = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
      const s = String(diffSec % 60).padStart(2, '0');
      el.textContent = `${h}:${m}:${s}`;
    });
  }
  setInterval(tickElapsedDisplays, 1000);

  function startEditTask(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    editingTaskId = id;
    taskIdInput.value = id;
    taskTitleInput.value = t.title;
    taskDescInput.value = t.description || '';
    taskDurationInput.value = t.estimated_minutes || '';
    taskStatusInput.value = t.status;
    taskPriorityInput.value = t.priority || 'mittel';
    taskDueDateInput.value = t.due_date || '';
    taskDueTimeInput.value = t.due_time || '';
    document.querySelectorAll('#task-people-checkboxes input').forEach(cb => {
      cb.checked = t.people.some(p => p.id === +cb.value);
    });
    taskSubmitBtn.textContent = 'Änderungen speichern';
    taskCancelBtn.classList.remove('hidden');
    document.getElementById('task-form-heading').textContent = 'Aufgabe bearbeiten';
    document.querySelector('[data-tab="tasks"]').click();
    taskTitleInput.focus();
  }

  function resetTaskForm() {
    editingTaskId = null;
    taskForm.reset();
    taskDurationInput.value = 60;
    taskStatusInput.value = 'offen';
    taskPriorityInput.value = 'mittel';
    document.querySelectorAll('#task-people-checkboxes input').forEach(cb => cb.checked = false);
    taskSubmitBtn.textContent = 'Aufgabe anlegen';
    taskCancelBtn.classList.add('hidden');
    document.getElementById('task-form-heading').textContent = 'Neue Aufgabe';
    hideEstimateHint();
  }
  taskCancelBtn.addEventListener('click', resetTaskForm);

  // ---------- Dauer-Schätzung anhand früherer, ähnlicher Aufgaben ----------
  const estimateHint = document.getElementById('task-estimate-hint');

  function hideEstimateHint() {
    estimateHint.classList.add('hidden');
    estimateHint.innerHTML = '';
  }

  async function fetchEstimate(title) {
    const params = new URLSearchParams({ title });
    if (editingTaskId) params.set('exclude_id', editingTaskId);
    try {
      return await api('/api/tasks/estimate?' + params.toString());
    } catch (e) {
      return { suggested_minutes: null };
    }
  }

  taskTitleInput.addEventListener('input', () => {
    clearTimeout(estimateDebounce);
    const title = taskTitleInput.value.trim();
    if (title.length < 3) { hideEstimateHint(); return; }
    estimateDebounce = setTimeout(async () => {
      const result = await fetchEstimate(title);
      if (!result.suggested_minutes) { hideEstimateHint(); return; }
      const exampleText = result.examples[0] ? ` (z. B. „${escapeHtml(result.examples[0].title)}“: ${fmtDuration(result.examples[0].minutes)})` : '';
      estimateHint.innerHTML = `
        <span>Ähnliche Aufgaben brauchten im Schnitt ${fmtDuration(result.suggested_minutes)}
        · basierend auf ${result.based_on_count} früheren Aufgabe(n)${exampleText}</span>
        <button type="button" id="estimate-apply-btn">Übernehmen</button>
      `;
      estimateHint.classList.remove('hidden');
      document.getElementById('estimate-apply-btn').addEventListener('click', () => {
        taskDurationInput.value = result.suggested_minutes;
        hideEstimateHint();
      });
    }, 350);
  });

  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const person_ids = Array.from(document.querySelectorAll('#task-people-checkboxes input:checked')).map(cb => +cb.value);
    const dueDate = taskDueDateInput.value || null;
    const dueTime = taskDueTimeInput.value || null;
    const payload = {
      title: taskTitleInput.value.trim(),
      description: taskDescInput.value.trim(),
      estimated_minutes: taskDurationInput.value ? +taskDurationInput.value : null,
      status: taskStatusInput.value,
      priority: taskPriorityInput.value,
      due_date: dueDate,
      due_time: dueDate ? dueTime : null,
      clear_due_date: !dueDate,
      person_ids,
    };
    if (!payload.title) return;

    let createdTask = null;
    if (editingTaskId) {
      await api(`/api/tasks/${editingTaskId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      createdTask = await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    }

    // Neue Aufgabe mit Datum + Uhrzeit und genau einer zugeordneten Person: direkt in den Kalender uebernehmen
    if (createdTask && dueDate && dueTime && createdTask.people.length === 1) {
      const startMin = timeToMinutes(dueTime);
      const endMin = startMin + (createdTask.estimated_minutes || 30);
      try {
        await api('/api/calendar', {
          method: 'POST',
          body: JSON.stringify({
            task_id: createdTask.id,
            person_id: createdTask.people[0].id,
            date: dueDate,
            start_time: dueTime,
            end_time: minutesToTime(endMin),
          }),
        });
      } catch (err) { /* Kalenderuebernahme optional - Aufgabe bleibt trotzdem angelegt */ }
    }

    resetTaskForm();
    await loadTasks();
    if (document.getElementById('tab-calendar').classList.contains('active')) await renderCalendar();
  });

  async function deleteTask(id) {
    if (!confirm('Aufgabe wirklich löschen? Geplante Kalendertermine dazu werden ebenfalls entfernt.')) return;
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    await loadTasks();
    await loadCalendar();
  }

  async function markTaskDone(id) {
    await api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'erledigt' }) });
    await loadTasks();
  }

  function fillTaskSelect() {
    const sel = document.getElementById('time-task');
    sel.innerHTML = '<option value="">— keine —</option>' +
      tasks.map(t => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join('');
  }

  // ================= CALENDAR =================
  function visibleDays() {
    if (calendarViewMode === 'day') return [currentDay];
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(currentWeekStart, i));
    return days;
  }
  function dayWidth() { return calendarViewMode === 'day' ? DAY_VIEW_WIDTH : WEEK_DAY_WIDTH; }

  async function loadCalendar() {
    const days = visibleDays();
    const from = isoDate(days[0]);
    const to = isoDate(days[days.length - 1]);
    calendarEntries = await api(`/api/calendar?from=${from}&to=${to}`);
    document.getElementById('ical-export-link').href = `/api/calendar/export.ics?from=${from}&to=${to}`;
  }

  function renderTaskPool() {
    const pool = document.getElementById('calendar-task-pool');
    const openTasks = tasks.filter(t => t.status !== 'erledigt');
    if (!openTasks.length) {
      pool.innerHTML = '<p class="empty-state">Keine offenen Aufgaben.</p>';
      return;
    }
    pool.innerHTML = '';
    openTasks.forEach(t => {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.draggable = true;
      card.dataset.taskId = t.id;
      const peopleNames = t.people.map(p => p.name).join(', ') || 'niemand zugeordnet';
      card.innerHTML = `
        <div class="tc-title">${escapeHtml(t.title)}</div>
        <div class="tc-meta">${fmtDuration(t.estimated_minutes)} · ${escapeHtml(peopleNames)}</div>
      `;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/json', JSON.stringify({ type: 'schedule', taskId: t.id }));
        e.dataTransfer.effectAllowed = 'copy';
      });
      pool.appendChild(card);
    });
  }

  function renderCalendarGrid() {
    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';
    const days = visibleDays();
    const dw = dayWidth();
    grid.style.gridTemplateColumns = `56px repeat(${days.length}, ${dw}px)`;
    grid.style.width = (56 + days.length * dw) + 'px';

    const corner = document.createElement('div');
    corner.className = 'cal-head';
    grid.appendChild(corner);

    days.forEach((d, i) => {
      const head = document.createElement('div');
      head.className = 'cal-head';
      head.innerHTML = `${DAY_NAMES[d.getDay() === 0 ? 6 : d.getDay() - 1]}<div class="cal-head-date">${fmtDateLabel(d)}</div>`;
      grid.appendChild(head);
    });

    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const isHour = (s % (60 / SLOT_MINUTES)) === 0;
      const label = document.createElement('div');
      label.className = 'cal-time-label';
      label.textContent = isHour ? slotIndexToTime(s) : '';
      grid.appendChild(label);

      days.forEach(d => {
        const cell = document.createElement('div');
        cell.className = 'cal-cell' + (isHour ? ' hour-mark' : '');
        cell.style.width = dw + 'px';
        cell.dataset.date = isoDate(d);
        cell.dataset.slot = s;
        attachDropHandlers(cell);
        grid.appendChild(cell);
      });
    }

    const days0 = days[0], daysN = days[days.length - 1];
    document.getElementById('week-label').textContent = calendarViewMode === 'day'
      ? `${DAY_NAMES[days0.getDay() === 0 ? 6 : days0.getDay() - 1]}, ${fmtDateLabel(days0)}`
      : `${fmtDateLabel(days0)} – ${fmtDateLabel(daysN)}`;
  }

  // Aufgaben mit Fälligkeitsdatum an diesem Tag, die (noch) keinen Kalendertermin an diesem Tag haben
  function allDayTasksForDate(dateIso) {
    return tasks.filter(t =>
      t.due_date === dateIso &&
      t.status !== 'erledigt' &&
      !calendarEntries.some(ce => ce.task_id === t.id && ce.date === dateIso)
    );
  }

  function renderAllDayRow() {
    const row = document.getElementById('calendar-allday-grid');
    const days = visibleDays();
    const dw = dayWidth();
    row.style.gridTemplateColumns = `56px repeat(${days.length}, ${dw}px)`;
    row.style.width = (56 + days.length * dw) + 'px';
    row.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'cal-allday-label';
    label.textContent = 'Ganztägig';
    row.appendChild(label);

    days.forEach(d => {
      const dateIso = isoDate(d);
      const cell = document.createElement('div');
      cell.className = 'cal-allday-cell';
      cell.style.width = dw + 'px';
      allDayTasksForDate(dateIso).forEach(t => {
        const chip = document.createElement('div');
        chip.className = 'cal-allday-chip';
        chip.textContent = t.title;
        chip.style.background = (t.people[0] && t.people[0].color) || '#8a8d90';
        chip.title = t.title;
        chip.addEventListener('click', () => startEditTask(t.id));
        cell.appendChild(chip);
      });
      row.appendChild(cell);
    });
  }

  function attachDropHandlers(cell) {
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch (err) { return; }
      if (!payload) return;

      if (payload.type === 'schedule') {
        openScheduleModal(payload.taskId, cell.dataset.date, +cell.dataset.slot);
      } else if (payload.type === 'move') {
        const entry = calendarEntries.find(en => en.id === payload.entryId);
        if (!entry) return;
        const durationMin = timeToMinutes(entry.end_time) - timeToMinutes(entry.start_time);
        const newStart = slotIndexToTime(+cell.dataset.slot);
        const newEnd = minutesToTime(timeToMinutes(newStart) + durationMin);
        await api(`/api/calendar/${entry.id}`, {
          method: 'PUT',
          body: JSON.stringify({ date: cell.dataset.date, start_time: newStart, end_time: newEnd }),
        });
        await loadCalendar();
        renderCalendarEntries();
      }
    });
    // Klick auf eine leere Zeitzelle legt direkt eine neue Aufgabe samt Kalendertermin an
    cell.addEventListener('click', () => openQuickCreateModal(cell.dataset.date, +cell.dataset.slot));
  }

  function renderCalendarEntries() {
    const overlay = document.getElementById('calendar-entries-overlay');
    overlay.innerHTML = '';
    overlay.style.height = (SLOTS_PER_DAY * SLOT_HEIGHT) + 'px';
    const days = visibleDays();
    const dw = dayWidth();
    overlay.style.width = (days.length * dw) + 'px';

    const dayIso = days.map(isoDate);

    calendarEntries.forEach(entry => {
      const dayIdx = dayIso.indexOf(entry.date);
      if (dayIdx === -1) return;
      const startMin = timeToMinutes(entry.start_time) - START_HOUR * 60;
      const endMin = timeToMinutes(entry.end_time) - START_HOUR * 60;
      if (endMin <= 0 || startMin >= SLOTS_PER_DAY * SLOT_MINUTES) return;
      const top = Math.max(0, (startMin / SLOT_MINUTES) * SLOT_HEIGHT);
      const height = Math.max(SLOT_HEIGHT - 2, ((endMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT - 2);

      const el = document.createElement('div');
      el.className = 'cal-entry' + (entry.task_status === 'erledigt' ? ' done' : '');
      el.draggable = true;
      el.dataset.entryId = entry.id;
      el.style.top = top + 'px';
      el.style.height = height + 'px';
      el.style.left = (dayIdx * dw + 2) + 'px';
      el.style.width = (dw - 4) + 'px';
      el.style.background = entry.person_color || '#4f46e5';
      el.innerHTML = `
        <div class="ce-title">${escapeHtml(entry.task_title)}</div>
        <div class="ce-time">${entry.start_time.slice(0, 5)}–${entry.end_time.slice(0, 5)} · ${escapeHtml(entry.person_name)}</div>
        <div class="ce-resize-handle" data-resize="${entry.id}"></div>
      `;

      let suppressClick = false;

      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/json', JSON.stringify({ type: 'move', entryId: entry.id }));
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging-source');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging-source'));

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }
        openEntryMenu(entry);
      });

      const handle = el.querySelector('.ce-resize-handle');
      handle.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        suppressClick = true;
        el.draggable = false;
        el.classList.add('resizing');
        const startY = ev.clientY;
        const startHeight = el.offsetHeight;

        function onMouseMove(mv) {
          const deltaSlots = Math.round((mv.clientY - startY) / SLOT_HEIGHT);
          const newHeight = Math.max(SLOT_HEIGHT - 2, startHeight + deltaSlots * SLOT_HEIGHT);
          el.style.height = newHeight + 'px';
        }
        async function onMouseUp() {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          el.classList.remove('resizing');
          el.draggable = true;
          const finalHeight = el.offsetHeight;
          const slotsSpan = Math.max(1, Math.round((finalHeight + 2) / SLOT_HEIGHT));
          const newEndMin = timeToMinutes(entry.start_time) + slotsSpan * SLOT_MINUTES;
          const newEnd = minutesToTime(newEndMin);
          if (newEnd !== entry.end_time) {
            await api(`/api/calendar/${entry.id}`, { method: 'PUT', body: JSON.stringify({ end_time: newEnd }) });
            await loadCalendar();
          }
          renderCalendarEntries();
        }
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      overlay.appendChild(el);
    });
  }

  async function renderCalendar() {
    renderTaskPool();
    renderCalendarGrid();
    await loadCalendar();
    renderAllDayRow();
    renderCalendarEntries();
  }

  document.getElementById('week-prev').addEventListener('click', async () => {
    if (calendarViewMode === 'day') currentDay = addDays(currentDay, -1);
    else currentWeekStart = addDays(currentWeekStart, -7);
    await renderCalendar();
  });
  document.getElementById('week-next').addEventListener('click', async () => {
    if (calendarViewMode === 'day') currentDay = addDays(currentDay, 1);
    else currentWeekStart = addDays(currentWeekStart, 7);
    await renderCalendar();
  });
  document.getElementById('view-week-btn').addEventListener('click', async () => {
    calendarViewMode = 'week';
    document.getElementById('view-week-btn').classList.add('active');
    document.getElementById('view-day-btn').classList.remove('active');
    await renderCalendar();
  });
  document.getElementById('view-day-btn').addEventListener('click', async () => {
    calendarViewMode = 'day';
    currentDay = new Date();
    document.getElementById('view-day-btn').classList.add('active');
    document.getElementById('view-week-btn').classList.remove('active');
    await renderCalendar();
  });

  // ---------- Schedule modal (Neuplanung aus Pool) ----------
  const modalOverlay = document.getElementById('modal-overlay');
  const modalBody = document.getElementById('modal-body');
  const modalConfirm = document.getElementById('modal-confirm');
  const modalCancel = document.getElementById('modal-cancel');

  function openScheduleModal(taskId, date, slotIndex) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const startTime = slotIndexToTime(slotIndex);
    const endMinutes = timeToMinutes(startTime) + (task.estimated_minutes || 30);
    const endTime = minutesToTime(endMinutes);

    const peopleOptions = (task.people.length ? task.people : people.filter(p => p.active))
      .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

    modalBody.innerHTML = `
      <label>Aufgabe<br><strong>${escapeHtml(task.title)}</strong></label>
      <label>Datum <input type="date" id="modal-date" value="${date}"></label>
      <label>Start <input type="time" id="modal-start" value="${startTime}"></label>
      <label>Ende <input type="time" id="modal-end" value="${endTime}"></label>
      <label>Person
        <select id="modal-person">${peopleOptions || '<option value="">— keine Person angelegt —</option>'}</select>
      </label>
    `;
    pendingDrop = { taskId };
    modalOverlay.classList.remove('hidden');
  }

  function closeModal() {
    modalOverlay.classList.add('hidden');
    pendingDrop = null;
  }
  modalCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

  modalConfirm.addEventListener('click', async () => {
    if (!pendingDrop) return;
    const date = document.getElementById('modal-date').value;
    const start_time = document.getElementById('modal-start').value;
    const end_time = document.getElementById('modal-end').value;
    const person_id = +document.getElementById('modal-person').value;
    if (!date || !start_time || !end_time || !person_id) {
      alert('Bitte Datum, Uhrzeit und Person angeben.');
      return;
    }
    await api('/api/calendar', {
      method: 'POST',
      body: JSON.stringify({ task_id: pendingDrop.taskId, person_id, date, start_time, end_time }),
    });
    closeModal();
    await loadCalendar();
    renderCalendarEntries();
  });

  // ---------- Termin-Menü (Klick auf bestehenden Kalendereintrag) ----------
  const entryMenuOverlay = document.getElementById('entry-menu-overlay');
  function openEntryMenu(entry) {
    pendingEntryForMenu = entry;
    document.getElementById('entry-menu-title').textContent = `${entry.task_title} · ${entry.start_time.slice(0, 5)}–${entry.end_time.slice(0, 5)}`;
    entryMenuOverlay.classList.remove('hidden');
  }
  function closeEntryMenu() {
    entryMenuOverlay.classList.add('hidden');
    pendingEntryForMenu = null;
  }
  document.getElementById('entry-menu-cancel').addEventListener('click', closeEntryMenu);
  entryMenuOverlay.addEventListener('click', (e) => { if (e.target === entryMenuOverlay) closeEntryMenu(); });
  document.getElementById('entry-menu-done').addEventListener('click', async () => {
    if (!pendingEntryForMenu) return;
    await markTaskDone(pendingEntryForMenu.task_id);
    closeEntryMenu();
  });
  document.getElementById('entry-menu-remove').addEventListener('click', async () => {
    if (!pendingEntryForMenu) return;
    await api(`/api/calendar/${pendingEntryForMenu.id}`, { method: 'DELETE' });
    closeEntryMenu();
    await loadCalendar();
    renderCalendarEntries();
  });

  // ---------- Direkt-Anlage im Kalender (Klick auf leere Zeitzelle) ----------
  const quickcreateOverlay = document.getElementById('quickcreate-overlay');
  const quickcreateBody = document.getElementById('quickcreate-body');
  let pendingQuickCreate = null;

  function openQuickCreateModal(date, slotIndex) {
    const startTime = slotIndexToTime(slotIndex);
    const activePeople = people.filter(p => p.active);
    const peopleOptions = activePeople.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

    quickcreateBody.innerHTML = `
      <label>Titel <input type="text" id="qc-title" placeholder="z.B. Kundentelefonat" autofocus></label>
      <label>Datum <input type="date" id="qc-date" value="${date}"></label>
      <label>Start <input type="time" id="qc-start" value="${startTime}"></label>
      <label>Dauer (Minuten) <input type="number" id="qc-duration" value="30" min="5" step="5"></label>
      <label>Person
        <select id="qc-person">${peopleOptions || '<option value="">— keine Person angelegt —</option>'}</select>
      </label>
    `;
    pendingQuickCreate = { date, slotIndex };
    quickcreateOverlay.classList.remove('hidden');
    setTimeout(() => document.getElementById('qc-title').focus(), 0);
  }

  function closeQuickCreateModal() {
    quickcreateOverlay.classList.add('hidden');
    pendingQuickCreate = null;
  }
  document.getElementById('quickcreate-cancel').addEventListener('click', closeQuickCreateModal);
  quickcreateOverlay.addEventListener('click', (e) => { if (e.target === quickcreateOverlay) closeQuickCreateModal(); });

  document.getElementById('quickcreate-confirm').addEventListener('click', async () => {
    if (!pendingQuickCreate) return;
    const title = document.getElementById('qc-title').value.trim();
    const date = document.getElementById('qc-date').value;
    const start = document.getElementById('qc-start').value;
    const duration = +document.getElementById('qc-duration').value || 30;
    const personId = +document.getElementById('qc-person').value;
    if (!title || !date || !start || !personId) {
      alert('Bitte Titel, Datum, Uhrzeit und Person angeben.');
      return;
    }
    const newTask = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title, estimated_minutes: duration, status: 'offen', priority: 'mittel',
        due_date: date, due_time: start, person_ids: [personId],
      }),
    });
    const endTime = minutesToTime(timeToMinutes(start) + duration);
    await api('/api/calendar', {
      method: 'POST',
      body: JSON.stringify({ task_id: newTask.id, person_id: personId, date, start_time: start, end_time: endTime }),
    });
    closeQuickCreateModal();
    await loadTasks();
    await loadCalendar();
    renderAllDayRow();
    renderCalendarEntries();
  });

  // ================= TIME TRACKING =================
  const timeForm = document.getElementById('time-form');
  const timeSubmitBtn = document.getElementById('time-submit-btn');
  const timeCancelBtn = document.getElementById('time-cancel-btn');

  async function loadTimeEntries() {
    const personId = document.getElementById('time-filter-person').value;
    const from = document.getElementById('time-filter-from').value;
    const to = document.getElementById('time-filter-to').value;
    const params = new URLSearchParams();
    if (personId) params.set('person_id', personId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    timeEntries = await api('/api/time-entries?' + params.toString());
    await loadLifetimeBalances();
    renderTimeList();
    document.getElementById('csv-export-link').href = '/api/time-entries/export.csv?' + params.toString();
  }

  // Kumulierte Ueber-/Unterstunden je Person laden (nur fuer Personen mit Wochensoll)
  async function loadLifetimeBalances() {
    const targets = people.filter(p => p.weekly_target_minutes);
    await Promise.all(targets.map(async p => {
      try {
        const data = await api('/api/reports/lifetime?person_id=' + p.id);
        lifetimeBalances.set(p.id, data);
      } catch (e) { /* ignorieren */ }
    }));
  }

  function lifetimeBalanceBadge(personId) {
    const data = lifetimeBalances.get(personId);
    if (!data || !data.available) return '';
    const cls = data.diff_minutes >= 0 ? 'positive' : 'negative';
    const sign = data.diff_minutes > 0 ? '+' : (data.diff_minutes < 0 ? '-' : '');
    return ` <span class="lifetime-balance ${cls}">(gesamt ${sign}${fmtDuration(Math.abs(data.diff_minutes))})</span>`;
  }

  // Montag der ISO-Woche zu einem Datumsstring
  function mondayOfIso(dateIso) {
    return getMonday(new Date(dateIso));
  }

  function renderTimeList() {
    const container = document.getElementById('time-list');
    const summary = document.getElementById('time-summary');
    if (!timeEntries.length) {
      container.innerHTML = '<p class="empty-state">Keine Einträge im gewählten Zeitraum.</p>';
      summary.textContent = 'Gesamt: 0 Std';
      return;
    }
    const totalMinutes = timeEntries.reduce((sum, e) => sum + (e.duration_minutes || 0), 0);
    summary.textContent = `Gesamt: ${fmtDuration(totalMinutes)} über ${timeEntries.length} Einträge`;

    // Nach Kalenderwoche (Mo-So) gruppieren; timeEntries kommt bereits datumsabsteigend sortiert
    let currentWeekKey = null;
    const parts = [];
    timeEntries.forEach(e => {
      const weekMonday = mondayOfIso(e.date);
      const weekKey = isoDate(weekMonday);
      if (weekKey !== currentWeekKey) {
        currentWeekKey = weekKey;
        const weekSunday = addDays(weekMonday, 6);
        parts.push(`<div class="time-week-header">Woche ${fmtDateLabel(weekMonday)} – ${fmtDateLabel(weekSunday)}</div>`);
      }
      const canPushToCalendar = e.task_id && e.start_time && e.end_time && !e.running;
      parts.push(`
        <div class="time-row-item" data-entry-row="${e.id}">
          <div>
            <div class="tri-main"><strong>${escapeHtml(e.person_name)}</strong>${lifetimeBalanceBadge(e.person_id)} · ${e.date}</div>
            <div class="tri-meta">
              ${e.start_time && e.end_time ? `${e.start_time.slice(0, 5)}–${e.end_time.slice(0, 5)}` : ''}
              ${e.break_minutes ? ` · Pause ${e.break_minutes} Min` : ''}
              ${e.duration_minutes ? ` · ${fmtDuration(e.duration_minutes)}` : ''}
              ${e.task_title ? ` · Aufgabe: ${escapeHtml(e.task_title)}` : ''}
              ${e.note ? ` · ${escapeHtml(e.note)}` : ''}
            </div>
          </div>
          <div class="row-actions">
            ${canPushToCalendar ? `<button class="ghost" data-to-calendar="${e.id}">→ Kalender</button>` : ''}
            <button class="ghost" data-edit-entry="${e.id}">Bearbeiten</button>
            <button class="danger" data-delete="${e.id}">Löschen</button>
          </div>
        </div>
      `);
    });
    container.innerHTML = parts.join('');
    container.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/time-entries/${b.dataset.delete}`, { method: 'DELETE' });
      await loadTimeEntries();
      await loadWarnings();
    }));
    container.querySelectorAll('[data-edit-entry]').forEach(b => b.addEventListener('click', () => startEditTimeEntry(+b.dataset.editEntry)));
    container.querySelectorAll('[data-to-calendar]').forEach(b => b.addEventListener('click', () => pushTimeEntryToCalendar(+b.dataset.toCalendar, b)));
  }

  async function pushTimeEntryToCalendar(entryId, btn) {
    const e = timeEntries.find(x => x.id === entryId);
    if (!e || !e.task_id || !e.start_time || !e.end_time) return;
    btn.disabled = true;
    try {
      await api('/api/calendar', {
        method: 'POST',
        body: JSON.stringify({
          task_id: e.task_id,
          person_id: e.person_id,
          date: e.date,
          start_time: e.start_time.slice(0, 5),
          end_time: e.end_time.slice(0, 5),
        }),
      });
      btn.textContent = 'Im Kalender ✓';
      if (document.getElementById('tab-calendar').classList.contains('active')) {
        await loadCalendar();
        renderAllDayRow();
        renderCalendarEntries();
      }
    } catch (err) {
      btn.disabled = false;
      alert('Konnte nicht in den Kalender übernommen werden: ' + err.message);
    }
  }

  function startEditTimeEntry(id) {
    const e = timeEntries.find(x => x.id === id);
    if (!e) return;
    if (e.running) { alert('Eine laufende Zeiterfassung kann hier nicht bearbeitet werden. Bitte zuerst über die Aufgabe stoppen.'); return; }
    editingTimeEntryId = id;
    document.getElementById('time-entry-id').value = id;
    document.getElementById('time-person').value = e.person_id;
    document.getElementById('time-date').value = e.date;
    document.getElementById('time-start').value = e.start_time ? e.start_time.slice(0, 5) : '';
    document.getElementById('time-end').value = e.end_time ? e.end_time.slice(0, 5) : '';
    document.getElementById('time-break-start').value = e.break_start ? e.break_start.slice(0, 5) : '';
    document.getElementById('time-break-end').value = e.break_end ? e.break_end.slice(0, 5) : '';
    document.getElementById('time-task').value = e.task_id || '';
    document.getElementById('time-note').value = e.note || '';
    timeSubmitBtn.textContent = 'Änderungen speichern';
    timeCancelBtn.classList.remove('hidden');
    document.getElementById('time-form-heading').textContent = 'Arbeitszeit bearbeiten';
    timeForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetTimeForm() {
    editingTimeEntryId = null;
    timeForm.reset();
    document.getElementById('time-date').value = isoDate(new Date());
    timeSubmitBtn.textContent = 'Eintragen';
    timeCancelBtn.classList.add('hidden');
    document.getElementById('time-form-heading').textContent = 'Arbeitszeit eintragen';
  }
  timeCancelBtn.addEventListener('click', resetTimeForm);

  timeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const personId = +document.getElementById('time-person').value;
    if (!personId) return;
    const ok = await requirePin(personId, editingTimeEntryId ? 'Arbeitszeit ändern' : 'Arbeitszeit eintragen');
    if (!ok) return;
    const payload = {
      person_id: personId,
      date: document.getElementById('time-date').value,
      start_time: document.getElementById('time-start').value || null,
      end_time: document.getElementById('time-end').value || null,
      break_start: document.getElementById('time-break-start').value || null,
      break_end: document.getElementById('time-break-end').value || null,
      task_id: document.getElementById('time-task').value || null,
      note: document.getElementById('time-note').value.trim(),
    };
    if (!payload.date) return;
    if (editingTimeEntryId) {
      payload.clear_task = !payload.task_id;
      payload.clear_break = !payload.break_start && !payload.break_end;
      await api(`/api/time-entries/${editingTimeEntryId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/time-entries', { method: 'POST', body: JSON.stringify(payload) });
    }
    resetTimeForm();
    await loadTimeEntries();
    await loadWarnings();
  });

  document.getElementById('time-filter-person').addEventListener('change', loadTimeEntries);
  document.getElementById('time-filter-from').addEventListener('change', loadTimeEntries);
  document.getElementById('time-filter-to').addEventListener('change', loadTimeEntries);

  // ---------- Warnungen (Tageshöchstarbeitszeit überschritten) ----------
  async function loadWarnings() {
    const data = await api('/api/warnings');
    const container = document.getElementById('warnings-list');
    document.getElementById('warnings-hint').textContent =
      `Wird protokolliert, wenn die Arbeitszeit einer Person an einem Tag ${fmtDuration(data.daily_max_minutes)} überschreitet.`;
    if (!data.warnings.length) {
      container.innerHTML = '<p class="empty-state">Keine Überschreitungen erfasst.</p>';
      return;
    }
    container.innerHTML = data.warnings.map(w => `
      <div class="time-row-item">
        <div>
          <div class="tri-main"><strong>${escapeHtml(w.person_name)}</strong> · ${fmtDateDE(w.date)}</div>
          <div class="tri-meta">⚠ ${fmtDuration(w.minutes)} an diesem Tag erfasst</div>
        </div>
      </div>
    `).join('');
  }

  // ================= ABWESENHEITEN =================
  const absenceForm = document.getElementById('absence-form');

  async function loadAbsences() {
    absences = await api('/api/absences');
    renderAbsenceList();
  }

  function renderAbsenceList() {
    const container = document.getElementById('absence-list');
    if (!absences.length) {
      container.innerHTML = '<p class="empty-state">Keine Abwesenheiten erfasst.</p>';
      return;
    }
    container.innerHTML = '';
    absences.forEach(a => {
      const row = document.createElement('div');
      row.className = 'time-row-item';
      row.innerHTML = `
        <div>
          <div class="tri-main"><strong>${escapeHtml(a.person_name)}</strong> · ${escapeHtml(a.type)}</div>
          <div class="tri-meta">${fmtDateDE(a.date_from)} – ${fmtDateDE(a.date_to)}${a.note ? ' · ' + escapeHtml(a.note) : ''}</div>
        </div>
        <div class="row-actions">
          <button class="danger" data-delete="${a.id}">Löschen</button>
        </div>
      `;
      container.appendChild(row);
    });
    container.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/absences/${b.dataset.delete}`, { method: 'DELETE' });
      await loadAbsences();
      await loadReport();
    }));
  }

  absenceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      person_id: +document.getElementById('absence-person').value,
      date_from: document.getElementById('absence-from').value,
      date_to: document.getElementById('absence-to').value,
      type: document.getElementById('absence-type').value,
      note: document.getElementById('absence-note').value.trim(),
    };
    if (!payload.person_id || !payload.date_from || !payload.date_to) return;
    await api('/api/absences', { method: 'POST', body: JSON.stringify(payload) });
    absenceForm.reset();
    await loadAbsences();
    await loadReport();
  });

  // ================= WOCHENREPORT =================
  const OVERTIME_WARN_THRESHOLD_MINUTES = 60; // ab 1 Std Abweichung wird die Zeile als Warnung hervorgehoben

  async function loadReport() {
    const data = await api('/api/reports/week?date=' + isoDate(reportWeekStart));
    document.getElementById('report-week-label').textContent = `${fmtDateLabel(new Date(data.from))} – ${fmtDateLabel(new Date(data.to))}`;
    const container = document.getElementById('report-table');
    if (!data.report.length) {
      container.innerHTML = '<p class="empty-state">Keine aktiven Personen.</p>';
      return;
    }
    container.innerHTML = data.report.map(r => {
      const sign = r.diff_minutes > 0 ? '+' : (r.diff_minutes < 0 ? '-' : '');
      const diffText = r.diff_minutes === null ? '–' : sign + fmtDuration(Math.abs(r.diff_minutes));
      const diffClass = r.diff_minutes === null ? '' : (r.diff_minutes >= 0 ? 'positive' : 'negative');
      const isWarn = r.diff_minutes !== null && Math.abs(r.diff_minutes) >= OVERTIME_WARN_THRESHOLD_MINUTES;
      const warnLabel = isWarn ? (r.diff_minutes > 0 ? ' ⚠ Überstunden' : ' ⚠ Unterstunden') : '';
      return `
        <div class="report-row ${isWarn ? 'warn' : ''}">
          <strong>${escapeHtml(r.person_name)}</strong>
          <span>Soll: ${r.target_minutes ? fmtDuration(r.target_minutes) : '–'}</span>
          <span>Ist: ${fmtDuration(r.actual_minutes)}</span>
          <span class="rr-diff ${diffClass}">${diffText}${warnLabel}</span>
        </div>
      `;
    }).join('');
  }
  document.getElementById('report-week-prev').addEventListener('click', () => { reportWeekStart = addDays(reportWeekStart, -7); loadReport(); });
  document.getElementById('report-week-next').addEventListener('click', () => { reportWeekStart = addDays(reportWeekStart, 7); loadReport(); });

  // ================= DASHBOARD =================
  function renderDashboard() {
    const openTasks = tasks.filter(t => t.status !== 'erledigt');

    const workloadByPerson = new Map();
    openTasks.forEach(t => {
      t.people.forEach(p => {
        const cur = workloadByPerson.get(p.id) || { name: p.name, color: p.color, minutes: 0 };
        cur.minutes += t.estimated_minutes || 0;
        workloadByPerson.set(p.id, cur);
      });
    });
    const workloadArr = Array.from(workloadByPerson.values()).sort((a, b) => b.minutes - a.minutes);
    const maxMinutes = Math.max(1, ...workloadArr.map(w => w.minutes));

    const workloadContainer = document.getElementById('workload-list');
    workloadContainer.innerHTML = workloadArr.length ? workloadArr.map(w => `
      <div class="workload-row">
        <div class="wl-label"><span>${escapeHtml(w.name)}</span><span>${fmtDuration(w.minutes)}</span></div>
        <div class="wl-bar-track"><div class="wl-bar-fill" style="width:${(w.minutes / maxMinutes) * 100}%;background:${w.color}"></div></div>
      </div>
    `).join('') : '<p class="empty-state">Keine offenen Aufgaben.</p>';

    const priorityRank = { hoch: 0, mittel: 1, niedrig: 2 };
    const upcoming = [...openTasks].sort((a, b) => {
      if (a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
      if (a.due_date) return -1;
      if (b.due_date) return 1;
      return priorityRank[a.priority] - priorityRank[b.priority];
    }).slice(0, 10);

    const upcomingContainer = document.getElementById('upcoming-list');
    upcomingContainer.innerHTML = upcoming.length
      ? upcoming.map(t => taskRowHtml(t, { withTimers: false })).join('')
      : '<p class="empty-state">Keine offenen Aufgaben.</p>';
    wireTaskRowButtons(upcomingContainer);
  }

  // ---------- Heute (mobile Startansicht) ----------
  async function renderToday() {
    // Laeuft gerade
    const timerContainer = document.getElementById('today-active-timers');
    if (!activeTimers.length) {
      timerContainer.innerHTML = '<p class="empty-state">Aktuell läuft keine Zeiterfassung.</p>';
    } else {
      timerContainer.innerHTML = activeTimers.map(t => `
        <div class="timer-row">
          <span class="timer-person">${escapeHtml(t.person_name)} · ${escapeHtml(t.task_title)}</span>
          <span class="timer-elapsed" data-start-iso="${t.date}T${t.start_time}">00:00:00</span>
          <button class="timer-btn stop" data-stop="${t.id}">■ Stopp</button>
        </div>
      `).join('');
      timerContainer.querySelectorAll('[data-stop]').forEach(b => b.addEventListener('click', () => stopTimer(+b.dataset.stop)));
      tickElapsedDisplays();
    }

    // Heute geplant (frischer Abruf, unabhaengig von der im Kalender-Tab gewaehlten Woche)
    const today = isoDate(new Date());
    const calContainer = document.getElementById('today-calendar-list');
    try {
      const todaysEntries = await api(`/api/calendar?from=${today}&to=${today}`);
      calContainer.innerHTML = todaysEntries.length ? todaysEntries.map(e => `
        <div class="time-row-item">
          <div>
            <div class="tri-main"><strong>${e.start_time.slice(0, 5)}–${e.end_time.slice(0, 5)}</strong> · ${escapeHtml(e.task_title)}</div>
            <div class="tri-meta">${escapeHtml(e.person_name)}</div>
          </div>
        </div>
      `).join('') : '<p class="empty-state">Heute nichts eingeplant.</p>';
    } catch (e) {
      calContainer.innerHTML = '<p class="empty-state">Konnte nicht geladen werden.</p>';
    }

    // Faellig heute oder ueberfaellig
    const dueContainer = document.getElementById('today-due-list');
    const due = tasks.filter(t => t.status !== 'erledigt' && t.due_date && t.due_date <= today)
      .sort((a, b) => a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0);
    dueContainer.innerHTML = due.length
      ? due.map(t => taskRowHtml(t, { withTimers: false })).join('')
      : '<p class="empty-state">Nichts fällig oder überfällig.</p>';
    wireTaskRowButtons(dueContainer);
  }

  // ================= ACCOUNT / LOGIN =================
  const accountBtn = document.getElementById('account-btn');
  const accountDropdown = document.getElementById('account-dropdown');

  accountBtn.addEventListener('click', () => accountDropdown.classList.toggle('hidden'));
  document.addEventListener('click', (e) => {
    if (!accountBtn.contains(e.target) && !accountDropdown.contains(e.target)) accountDropdown.classList.add('hidden');
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  const passwordModal = document.getElementById('password-modal-overlay');
  const pwError = document.getElementById('pw-error');
  document.getElementById('change-password-btn').addEventListener('click', () => {
    accountDropdown.classList.add('hidden');
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    pwError.classList.add('hidden');
    passwordModal.classList.remove('hidden');
  });
  document.getElementById('pw-cancel').addEventListener('click', () => passwordModal.classList.add('hidden'));
  passwordModal.addEventListener('click', (e) => { if (e.target === passwordModal) passwordModal.classList.add('hidden'); });
  document.getElementById('pw-confirm').addEventListener('click', async () => {
    const current_password = document.getElementById('pw-current').value;
    const new_password = document.getElementById('pw-new').value;
    try {
      await api('/api/account/change-password', { method: 'POST', body: JSON.stringify({ current_password, new_password }) });
      passwordModal.classList.add('hidden');
    } catch (err) {
      pwError.textContent = err.message;
      pwError.classList.remove('hidden');
    }
  });

  // ---------- Benutzerverwaltung ----------
  const usersModal = document.getElementById('users-modal-overlay');
  const usersError = document.getElementById('users-error');

  async function loadUsers() {
    const users = await api('/api/users');
    const container = document.getElementById('users-list');
    container.innerHTML = users.map(u => `
      <div class="time-row-item">
        <div class="tri-main">${escapeHtml(u.username)}</div>
        <div class="row-actions">
          <button class="danger" data-delete-user="${u.id}">Löschen</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-delete-user]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Dieses Benutzerkonto wirklich löschen?')) return;
      try {
        await api(`/api/users/${b.dataset.deleteUser}`, { method: 'DELETE' });
        await loadUsers();
      } catch (err) {
        usersError.textContent = err.message;
        usersError.classList.remove('hidden');
      }
    }));
  }

  document.getElementById('manage-users-btn').addEventListener('click', async () => {
    accountDropdown.classList.add('hidden');
    document.getElementById('new-user-username').value = '';
    document.getElementById('new-user-password').value = '';
    usersError.classList.add('hidden');
    usersModal.classList.remove('hidden');
    await loadUsers();
  });
  document.getElementById('users-modal-close').addEventListener('click', () => usersModal.classList.add('hidden'));
  usersModal.addEventListener('click', (e) => { if (e.target === usersModal) usersModal.classList.add('hidden'); });
  document.getElementById('users-add-confirm').addEventListener('click', async () => {
    const username = document.getElementById('new-user-username').value.trim();
    const password = document.getElementById('new-user-password').value;
    usersError.classList.add('hidden');
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password }) });
      document.getElementById('new-user-username').value = '';
      document.getElementById('new-user-password').value = '';
      await loadUsers();
    } catch (err) {
      usersError.textContent = err.message;
      usersError.classList.remove('hidden');
    }
  });

  async function loadAccount() {
    try {
      const me = await api('/api/me');
      document.getElementById('account-username').textContent = me.username;
    } catch (e) { /* Redirect passiert bereits in api() bei 401 */ }
  }

  // ---------- Init ----------
  async function init() {
    document.getElementById('absence-from').value = isoDate(new Date());
    document.getElementById('absence-to').value = isoDate(new Date());
    resetTaskForm();
    resetPersonForm();
    resetTimeForm();
    await loadAccount();
    await loadPeople();
    await loadActiveTimers();
    await loadTasks();
    await loadTimeEntries();
    await loadWarnings();
  }
  init();
})();
