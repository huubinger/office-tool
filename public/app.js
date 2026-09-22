(() => {
  'use strict';

  // ---------- State ----------
  let people = [];
  let projects = [];
  let tasks = [];
  let calendarEntries = [];
  let activeTimers = [];
  let absences = [];
  let currentWeekStart = getMonday(new Date());
  let calendarViewMode = 'week'; // 'week' | 'day'
  let currentDay = new Date();
  let reportWeekStart = getMonday(new Date());
  let editingTaskId = null;
  let editingPersonId = null;
  let editingTimeEntryId = null;
  let editingTimeEntryTaskId = null;
  let editingTimeEntryNote = null;
  let lifetimeBalances = new Map(); // person_id -> lifetime report response
  let pendingDrop = null; // { taskId } fuer Neuplanung aus dem Pool
  let pendingMove = null; // { entryId, duration } fuer Verschieben eines bestehenden Termins
  let estimateDebounce = null;
  let taskFilters = { search: '', person: '', project: '', status: '', priority: '' };

  const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const START_HOUR = 0;
  const END_HOUR = 24;
  const MAIN_VIEW_START_HOUR = 9;
  const MAIN_VIEW_END_HOUR = 22;
  const SLOT_MINUTES = 30;
  const SLOT_HEIGHT = 32;
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
      if (tab === 'calendar') renderCalendar();
      if (tab === 'timetracking') { loadReport(); loadAbsences(); loadWarnings(); loadTimeOff(); }
      if (tab === 'yearcalendar') { renderYearCalendar(); maybeAutoOpenSecondHalf(); }
      if (tab === 'contracts') { loadContractEvents(); }
    });
  });

  // ================= PEOPLE =================
  const personForm = document.getElementById('person-form');
  const personNameInput = document.getElementById('person-name');
  const personRoleInput = document.getElementById('person-role');
  const personColorInput = document.getElementById('person-color');
  const personIdInput = document.getElementById('person-id');
  const personWeeklyHoursInput = document.getElementById('person-weekly-hours');
  const personSubmitBtn = document.getElementById('person-submit-btn');
  const personCancelBtn = document.getElementById('person-cancel-btn');
  const personContractTypeInput = document.getElementById('person-contract-type');
  const bfdFieldsBlock = document.getElementById('bfd-fields');
  const personVacationDaysInput = document.getElementById('person-vacation-days');
  const personProbationWeeksInput = document.getElementById('person-probation-weeks');
  const personContractStartInput = document.getElementById('person-contract-start-general');
  const personContractEndInput = document.getElementById('person-contract-end');
  const contractFileInput = document.getElementById('contract-file-input');
  const contractParseHint = document.getElementById('contract-parse-hint');

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

  async function loadToolStartDate() {
    try {
      const data = await api('/api/settings/tool-start-date');
      document.getElementById('tool-start-date-input').value = data.tool_start_date;
    } catch (e) { /* ignorieren */ }
  }
  document.getElementById('tool-start-date-save').addEventListener('click', async () => {
    const val = document.getElementById('tool-start-date-input').value;
    if (!val) return;
    await api('/api/settings/tool-start-date', { method: 'PUT', body: JSON.stringify({ tool_start_date: val }) });
    await loadReport();
  });

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
            <div><strong>${escapeHtml(p.name)}</strong>${p.active ? '' : ' <span class="status-badge">inaktiv</span>'}${p.contract_type ? ` <span class="status-badge">${escapeHtml(p.contract_type)}</span>` : ''}</div>
            <div class="task-meta">${escapeHtml(p.role || '')}${weeklyHours ? ' · Soll ' + weeklyHours + ' Std/Woche' : ''}${contractMeta}</div>
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
    personIdInput.value = id;
    personNameInput.value = p.name;
    personRoleInput.value = p.role || '';
    personColorInput.value = p.color || '#4f46e5';
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
  }

  function resetPersonForm() {
    editingPersonId = null;
    personForm.reset();
    personColorInput.value = '#4f46e5';
    personSubmitBtn.textContent = 'Person anlegen';
    personCancelBtn.classList.add('hidden');
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
      weekly_target_minutes: personWeeklyHoursInput.value ? Math.round(+personWeeklyHoursInput.value * 60) : null,
      contract_type: personContractTypeInput.value || null,
      vacation_days_total: personVacationDaysInput.value ? +personVacationDaysInput.value : null,
      probation_weeks: personProbationWeeksInput.value ? +personProbationWeeksInput.value : null,
      contract_start: personContractStartInput.value || null,
      contract_end: personContractEndInput.value || null,
    };
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

    // In der Zeiterfassung steht die eingeloggte Person immer zuerst in den Auswahlfeldern,
    // damit man sie nicht erst in einer langen Liste suchen muss.
    const meFirst = currentUser.person_id
      ? [...activePeople].sort((a, b) => (a.id === currentUser.person_id ? -1 : b.id === currentUser.person_id ? 1 : 0))
      : activePeople;
    const timeTrackingOptionsHtml = meFirst.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

    document.getElementById('time-person').innerHTML = timeTrackingOptionsHtml;
    document.getElementById('absence-person').innerHTML = timeTrackingOptionsHtml;
    document.getElementById('timeoff-person').innerHTML = timeTrackingOptionsHtml;
    document.getElementById('time-filter-person').innerHTML = '<option value="">Alle</option>' + timeTrackingOptionsHtml;
    if (currentUser.person_id) document.getElementById('time-person').value = String(currentUser.person_id);
    document.getElementById('task-filter-person').innerHTML = '<option value="">Alle Personen</option>' + optionsHtml;
    document.getElementById('qa-person').innerHTML = '<option value="">Zuständig</option>' + optionsHtml;
  }

  // ================= PROJEKTE =================
  async function loadProjects() {
    projects = await api('/api/projects');
    renderProjectList();
    fillProjectSelects();
  }

  const searchablePickers = new Map();

  // Verwandelt ein Textfeld + verstecktes Feld in ein durchsuchbares Projekt-Dropdown: Tippen
  // filtert die Projektliste live, Auswahl per Klick schreibt die Projekt-ID ins versteckte
  // Feld - der ganze bestehende Code, der z.B. document.getElementById('task-project').value
  // liest, funktioniert dadurch unveraendert weiter.
  function initSearchableProjectPicker(inputId, hiddenId, initialValue, opts) {
    const input = document.getElementById(inputId);
    const hidden = document.getElementById(hiddenId);
    if (!input || !hidden) return;
    const emptyLabel = (opts && opts.emptyLabel) || '— kein Projekt —';
    const allowEmpty = !(opts && opts.allowEmpty === false);
    searchablePickers.set(inputId, { input, hidden, emptyLabel, allowEmpty });

    let dropdown = input.nextElementSibling;
    if (!dropdown || !dropdown.classList.contains('searchable-dropdown')) {
      dropdown = document.createElement('div');
      dropdown.className = 'searchable-dropdown hidden';
      input.after(dropdown);
    }

    function renderOptions(filterText) {
      const ft = filterText.trim().toLowerCase();
      const filtered = projects.filter(p => p.name.toLowerCase().includes(ft));
      let html = '';
      if (allowEmpty && emptyLabel.toLowerCase().includes(ft)) {
        html += `<div class="searchable-option" data-value="">${escapeHtml(emptyLabel)}</div>`;
      }
      html += filtered.map(p => `<div class="searchable-option" data-value="${p.id}"><span class="color-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</div>`).join('');
      dropdown.innerHTML = html || '<div class="searchable-option-empty">Keine Treffer</div>';
      dropdown.classList.remove('hidden');
      dropdown.querySelectorAll('.searchable-option[data-value]').forEach(opt => {
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectValue(opt.dataset.value);
        });
      });
    }

    function selectValue(val) {
      hidden.value = val;
      const p = val ? projects.find(pr => pr.id === +val) : null;
      input.value = p ? p.name : (allowEmpty ? emptyLabel : '');
      dropdown.classList.add('hidden');
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }

    input.addEventListener('focus', () => { input.select(); renderOptions(''); });
    input.addEventListener('input', () => renderOptions(input.value === emptyLabel ? '' : input.value));
    input.addEventListener('blur', () => setTimeout(() => dropdown.classList.add('hidden'), 150));

    if (initialValue) {
      const p = projects.find(pr => pr.id === +initialValue);
      hidden.value = String(initialValue);
      input.value = p ? p.name : '';
    } else {
      hidden.value = '';
      input.value = allowEmpty ? '' : '';
    }
  }

  // Alle bereits initialisierten Picker nach dem (Neu-)Laden der Projekte aktualisieren: falls
  // sich ein Projektname geaendert hat oder ein Projekt geloescht wurde, Anzeige nachziehen.
  function refreshSearchableProjectPickers() {
    searchablePickers.forEach(({ input, hidden, emptyLabel, allowEmpty }) => {
      if (hidden.value) {
        const p = projects.find(pr => pr.id === +hidden.value);
        if (p) { input.value = p.name; }
        else { hidden.value = ''; input.value = allowEmpty ? '' : ''; }
      }
    });
  }

  function fillProjectSelects() {
    if (!searchablePickers.has('task-project-search')) {
      initSearchableProjectPicker('task-project-search', 'task-project', '', { emptyLabel: '— keins —' });
      initSearchableProjectPicker('task-filter-project-search', 'task-filter-project', '', { emptyLabel: 'Alle Projekte' });
      initSearchableProjectPicker('qa-project-search', 'qa-project', '', { emptyLabel: 'Projekt auswählen' });
      initSearchableProjectPicker('yc-event-project-search', 'yc-event-project', '', { emptyLabel: '— kein Projekt —' });
    } else {
      refreshSearchableProjectPickers();
    }
  }

  // Setzt sowohl das versteckte Feld als auch das sichtbare Suchfeld eines Projekt-Pickers -
  // fuer Stellen im Code, die den Wert programmatisch setzen (nicht per Klick in der Liste).
  function setSearchableProjectValue(hiddenId, value) {
    const hidden = document.getElementById(hiddenId);
    if (!hidden) return;
    hidden.value = value || '';
    const config = [...searchablePickers.values()].find(c => c.hidden === hidden);
    if (config) {
      const p = value ? projects.find(pr => pr.id === +value) : null;
      config.input.value = p ? p.name : (config.allowEmpty ? '' : '');
    }
  }

  function renderProjectList() {
    const container = document.getElementById('project-list');
    if (!projects.length) {
      container.innerHTML = '<p class="empty-state">Noch keine Projekte angelegt.</p>';
      return;
    }
    container.innerHTML = projects.map(p => `
      <div class="person-row">
        <div class="person-row-main">
          <input type="color" class="project-color-input" data-project-color="${p.id}" value="${p.color}" title="Farbe ändern">
          <strong>${escapeHtml(p.name)}</strong>
        </div>
        <div class="row-actions">
          <button class="danger" data-delete-project="${p.id}">Löschen</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-delete-project]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Projekt wirklich löschen? Zugeordnete Aufgaben bleiben erhalten, verlieren aber die Projektzuordnung.')) return;
      await api(`/api/projects/${b.dataset.deleteProject}`, { method: 'DELETE' });
      await loadProjects();
      await loadTasks();
    }));
    container.querySelectorAll('[data-project-color]').forEach(input => input.addEventListener('change', async () => {
      await api(`/api/projects/${input.dataset.projectColor}`, { method: 'PUT', body: JSON.stringify({ color: input.value }) });
      await loadProjects();
      await loadTasks();
      if (document.getElementById('tab-calendar').classList.contains('active')) await renderCalendar();
    }));
  }

  document.getElementById('project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('project-name').value.trim();
    const color = document.getElementById('project-color').value;
    if (!name) return;
    try {
      await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, color }) });
      document.getElementById('project-form').reset();
      document.getElementById('project-color').value = '#4f46e5';
      await loadProjects();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('task-project-add-btn').addEventListener('click', async () => {
    const name = prompt('Name des neuen Projekts:');
    if (!name || !name.trim()) return;
    try {
      const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      await loadProjects();
      setSearchableProjectValue('task-project', project.id);
    } catch (err) {
      alert(err.message);
    }
  });

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
  const taskModalOverlay = document.getElementById('task-modal-overlay');
  let collapsedProjectGroups = new Set();
  let taskSort = 'deadline';

  async function loadTasks() {
    tasks = await api('/api/tasks');
    renderTaskList();
    renderDoneSection();
    renderUrgentSection();
    fillTaskSelect();
    if (document.getElementById('tab-calendar').classList.contains('active')) renderCalendar();
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

  function initials(name) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  }

  // ---------- Start/Stopp-Zeiterfassung ----------
  async function loadActiveTimers() {
    activeTimers = await api('/api/time-entries/active');
  }

  function findActiveTimer(taskId, personId) {
    return activeTimers.find(e => e.task_id === taskId && e.person_id === personId);
  }

  async function startTimer(taskId, personId) {
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
      // Erledigte Aufgaben wandern standardmaessig ins eigene "Erledigt"-Feld unten und
      // werden aus der normalen Tabelle ausgeblendet - ausser der Status-Filter wurde
      // gezielt auf "erledigt" gesetzt, dann greift er wie gewohnt.
      if (t.status === 'erledigt' && taskFilters.status !== 'erledigt') return false;
      if (search && !(
        t.title.toLowerCase().includes(search) ||
        (t.description || '').toLowerCase().includes(search) ||
        (t.project && t.project.name.toLowerCase().includes(search)) ||
        t.people.some(p => p.name.toLowerCase().includes(search))
      )) return false;
      if (taskFilters.person && !t.people.some(p => p.id === +taskFilters.person)) return false;
      if (taskFilters.project && (!t.project || t.project.id !== +taskFilters.project)) return false;
      if (taskFilters.status && t.status !== taskFilters.status) return false;
      if (taskFilters.priority && t.priority !== taskFilters.priority) return false;
      return true;
    });
  }

  const PRIORITY_RANK = { hoch: 0, mittel: 1, niedrig: 2 };
  function sortTasks(list) {
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (taskSort === 'deadline') return (a.due_date || '9999') < (b.due_date || '9999') ? -1 : (a.due_date || '9999') > (b.due_date || '9999') ? 1 : 0;
      if (taskSort === 'priority') return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      return a.title.localeCompare(b.title, 'de');
    });
    return sorted;
  }

  function priorityDotHtml(priority) {
    return `<span class="task-priority-dot ${priority}"><span class="dot"></span>${escapeHtml(priority.charAt(0).toUpperCase() + priority.slice(1))}</span>`;
  }

  function statusPillHtml(status) {
    const icons = { offen: '○', 'in Arbeit': '★', erledigt: '✓' };
    return `<span class="task-status-pill ${statusClass(status)}">${icons[status] || '○'} ${escapeHtml(status)}</span>`;
  }

  // Tabellenzeile innerhalb einer Projekt-Gruppe: Aufgabe, Zustaendig, Prioritaet, Start,
  // Deadline, Dauer (Minuten), Status. Klick oeffnet das Detail-Formular.
  function taskTableRowHtml(t) {
    const doneClass = t.status === 'erledigt' ? 'task-row-done' : '';
    const assignee = t.people.length
      ? `<div class="task-assignee"><span class="task-avatar" style="background:${t.people[0].color}">${initials(t.people[0].name)}</span>
          <span>${escapeHtml(t.people[0].name)}${t.people.length > 1 ? ` +${t.people.length - 1}` : ''}</span></div>`
      : '<span class="task-meta">—</span>';
    return `
      <tr class="task-table-row ${doneClass}" data-task-row="${t.id}" style="border-left-color:${t.project ? t.project.color : 'transparent'}">
        <td class="task-done-cell"><input type="checkbox" class="task-done-checkbox" data-done-toggle="${t.id}" ${t.status === 'erledigt' ? 'checked' : ''} title="Als erledigt markieren"></td>
        <td>${escapeHtml(t.title)}</td>
        <td>${assignee}</td>
        <td>${priorityDotHtml(t.priority || 'mittel')}</td>
        <td>${t.due_date ? fmtDateDE(t.due_date) : '–'}</td>
        <td>${fmtDuration(t.estimated_minutes)}</td>
        <td>${statusPillHtml(t.status)}</td>
        <td><button type="button" class="task-row-menu-btn" data-task-row="${t.id}">⋯</button></td>
      </tr>
    `;
  }

  // Kompakte Zeile fuer das Dashboard (kein Tabellenkontext dort)
  function compactTaskRowHtml(t) {
    const peopleNames = t.people.length ? t.people.map(p => escapeHtml(p.name)).join(', ') : '—';
    const projectLine = t.project ? `<span class="crc-project" style="color:${t.project.color}">${escapeHtml(t.project.name)}</span>` : '';
    return `
      <div class="task-row-compact" data-task-row="${t.id}">
        <input type="checkbox" class="task-done-checkbox" data-done-toggle="${t.id}" ${t.status === 'erledigt' ? 'checked' : ''} title="Als erledigt markieren">
        <span class="crc-text">
          ${projectLine}
          <span class="crc-title">${escapeHtml(t.title)}</span>
        </span>
        <span class="task-meta">${peopleNames}</span>
      </div>
    `;
  }

  function wireTaskRowClicks(container) {
    container.querySelectorAll('[data-task-row]').forEach(el =>
      el.addEventListener('click', () => startEditTask(+el.dataset.taskRow)));
    container.querySelectorAll('[data-done-toggle]').forEach(cb => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', async (e) => {
        e.stopPropagation();
        await toggleTaskDone(+cb.dataset.doneToggle, cb.checked);
      });
    });
  }

  async function toggleTaskDone(id, done) {
    await api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status: done ? 'erledigt' : 'offen' }) });
    await loadTasks();
  }

  // Gruppiert die gefilterten Aufgaben nach Projekt und rendert je Gruppe eine farbige
  // Kopfzeile (mit Anzahl + Ein-/Ausklappen) gefolgt von den Aufgaben-Zeilen.
  function renderTaskList() {
    const container = document.getElementById('task-list');
    const filtered = getFilteredTasks();
    if (!tasks.length) {
      container.innerHTML = '<tr><td colspan="8" class="empty-state">Noch keine Aufgaben angelegt.</td></tr>';
      return;
    }
    if (!filtered.length) {
      container.innerHTML = '<tr><td colspan="8" class="empty-state">Keine Aufgaben passen zu den Filtern.</td></tr>';
      return;
    }

    const groups = new Map(); // key: project id or 'none' -> { project, tasks }
    filtered.forEach(t => {
      const key = t.project ? t.project.id : 'none';
      if (!groups.has(key)) groups.set(key, { project: t.project || null, tasks: [] });
      groups.get(key).tasks.push(t);
    });

    const orderedKeys = [
      ...projects.map(p => p.id).filter(id => groups.has(id)),
      ...(groups.has('none') ? ['none'] : []),
    ];

    container.innerHTML = orderedKeys.map(key => {
      const group = groups.get(key);
      const collapsed = collapsedProjectGroups.has(key);
      const color = group.project ? group.project.color : '#5b6472';
      const name = group.project ? group.project.name : 'Ohne Projekt';
      const rows = collapsed ? '' : sortTasks(group.tasks).map(taskTableRowHtml).join('');
      return `
        <tbody data-group="${key}">
          <tr class="task-group-header ${collapsed ? 'collapsed' : ''}" data-group-toggle="${key}" style="background:${color}33">
            <td colspan="8">
              <div class="tgh-inner">
                <span>${escapeHtml(name)}</span>
                <span class="task-group-count">${group.tasks.length} Aufgabe${group.tasks.length === 1 ? '' : 'n'}</span>
                <span class="task-group-chevron">▾</span>
              </div>
            </td>
          </tr>
          ${rows}
        </tbody>
      `;
    }).join('');

    container.querySelectorAll('[data-group-toggle]').forEach(el => el.addEventListener('click', () => {
      const key = el.dataset.groupToggle;
      if (collapsedProjectGroups.has(key)) collapsedProjectGroups.delete(key);
      else collapsedProjectGroups.add(key);
      renderTaskList();
    }));
    wireTaskRowClicks(container);
  }

  // Eigenes, standardmaessig eingeklapptes Feld fuer erledigte Aufgaben - unabhaengig
  // vom Status-Filter oben, der weiterhin normal funktioniert.
  function renderDoneSection() {
    const done = tasks.filter(t => t.status === 'erledigt');
    const card = document.getElementById('done-tasks-card');
    card.classList.toggle('hidden', done.length === 0);
    document.getElementById('done-tasks-count').textContent = `Erledigt (${done.length})`;
    const container = document.getElementById('done-task-list');
    container.innerHTML = sortTasks(done).map(taskTableRowHtml).join('');
    wireTaskRowClicks(container);
  }
  document.getElementById('done-tasks-toggle').addEventListener('click', () => {
    const table = document.getElementById('done-tasks-table');
    const chevron = document.getElementById('done-tasks-chevron');
    const nowHidden = table.classList.toggle('hidden');
    chevron.classList.toggle('collapsed', nowHidden);
  });

  ['task-filter-search', 'task-filter-person', 'task-filter-project', 'task-filter-status', 'task-filter-priority'].forEach(id => {
    const el = document.getElementById(id);
    const handler = () => {
      taskFilters = {
        search: document.getElementById('task-filter-search').value,
        person: document.getElementById('task-filter-person').value,
        project: document.getElementById('task-filter-project').value,
        status: document.getElementById('task-filter-status').value,
        priority: document.getElementById('task-filter-priority').value,
      };
      renderTaskList();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
  document.getElementById('task-sort').addEventListener('change', (e) => {
    taskSort = e.target.value;
    renderTaskList();
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

  function renderTaskTimersInForm(task) {
    const box = document.getElementById('task-timers-in-form');
    if (!task) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = `<label>Zeiterfassung</label>${renderTaskTimers(task)}`;
    box.querySelectorAll('[data-start-task]').forEach(b => b.addEventListener('click', async () => {
      await startTimer(+b.dataset.startTask, +b.dataset.startPerson);
      const fresh = tasks.find(x => x.id === task.id);
      if (fresh) renderTaskTimersInForm(fresh);
    }));
    box.querySelectorAll('[data-stop]').forEach(b => b.addEventListener('click', async () => {
      await stopTimer(+b.dataset.stop);
      const fresh = tasks.find(x => x.id === task.id);
      if (fresh) renderTaskTimersInForm(fresh);
    }));
    tickElapsedDisplays();
  }

  // Das Detail-Formular (Modal) dient ausschliesslich zum Bearbeiten einer bestehenden
  // Aufgabe. Neue Aufgaben werden ueber die Schnellanlage-Leiste oben angelegt.
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
    setSearchableProjectValue('task-project', t.project ? t.project.id : '');
    document.querySelectorAll('#task-people-checkboxes input').forEach(cb => {
      cb.checked = t.people.some(p => p.id === +cb.value);
    });
    document.getElementById('task-form-heading').textContent = 'Aufgabe bearbeiten';
    document.getElementById('task-delete-series-btn').classList.toggle('hidden', !t.recurrence_group);
    document.getElementById('task-delete-series-btn').dataset.group = t.recurrence_group || '';
    renderTaskTimersInForm(t);
    hideEstimateHint();
    taskModalOverlay.classList.remove('hidden');
  }

  function closeTaskModal() {
    editingTaskId = null;
    taskModalOverlay.classList.add('hidden');
    taskForm.reset();
    setSearchableProjectValue('task-project', '');
    document.getElementById('task-delete-series-btn').classList.add('hidden');
  }
  document.getElementById('task-cancel-btn').addEventListener('click', closeTaskModal);
  taskModalOverlay.addEventListener('click', (e) => { if (e.target === taskModalOverlay) closeTaskModal(); });
  document.getElementById('task-delete-btn').addEventListener('click', async () => {
    if (editingTaskId) await deleteTask(editingTaskId);
  });
  document.getElementById('task-delete-series-btn').addEventListener('click', async (e) => {
    const group = e.target.dataset.group;
    if (!group) return;
    if (!confirm('Die gesamte Wiederholungsserie löschen? Das entfernt alle Aufgaben dieser Reihe.')) return;
    await api(`/api/tasks/series/${group}`, { method: 'DELETE' });
    closeTaskModal();
    await loadTasks();
  });

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
    if (!editingTaskId) return;
    const person_ids = Array.from(document.querySelectorAll('#task-people-checkboxes input:checked')).map(cb => +cb.value);
    const dueDate = taskDueDateInput.value || null;
    const dueTime = taskDueTimeInput.value || null;
    const projectVal = document.getElementById('task-project').value;
    const payload = {
      title: taskTitleInput.value.trim(),
      description: taskDescInput.value.trim(),
      estimated_minutes: taskDurationInput.value ? +taskDurationInput.value : null,
      status: taskStatusInput.value,
      priority: taskPriorityInput.value,
      due_date: dueDate,
      due_time: dueDate ? dueTime : null,
      clear_due_date: !dueDate,
      project_id: projectVal ? +projectVal : null,
      clear_project: !projectVal,
      person_ids,
    };
    if (!payload.title) return;

    const task = await api(`/api/tasks/${editingTaskId}`, { method: 'PUT', body: JSON.stringify(payload) });

    if (task && dueDate && dueTime) {
      await autoScheduleTask(task, dueDate, dueTime);
    }

    closeTaskModal();
    await loadTasks();
    if (document.getElementById('tab-calendar').classList.contains('active')) await renderCalendar();
  });

  // Schnellanlage-Leiste oben auf der Aufgaben-Seite: legt direkt eine neue Aufgabe an
  // (Projekt, Titel, eine zustaendige Person, Prioritaet, Start, Deadline, Dauer in Minuten).
  // Weitere Details (Beschreibung, mehrere Personen, Uhrzeit, Status) lassen sich danach
  // per Klick auf die Aufgabe im Detail-Formular ergaenzen.
  document.getElementById('qa-recurrence').addEventListener('change', (e) => {
    document.getElementById('qa-recurrence-until').classList.toggle('hidden', e.target.value === 'keine');
  });

  document.getElementById('task-quickadd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('qa-title').value.trim();
    if (!title) return;
    const projectVal = document.getElementById('qa-project').value;
    const personVal = document.getElementById('qa-person').value;
    const dueDate = document.getElementById('qa-due-date').value || null;
    const recurrenceType = document.getElementById('qa-recurrence').value;
    const recurrenceUntil = document.getElementById('qa-recurrence-until').value;
    const payload = {
      title,
      project_id: projectVal ? +projectVal : null,
      person_ids: personVal ? [+personVal] : [],
      priority: document.getElementById('qa-priority').value,
      due_date: dueDate,
      estimated_minutes: document.getElementById('qa-duration').value ? +document.getElementById('qa-duration').value : 60,
    };
    if (recurrenceType !== 'keine' && recurrenceUntil) {
      if (!dueDate) { alert('Für eine Wiederholung wird ein Datum als Ausgangspunkt benötigt.'); return; }
      payload.recurrence = { type: recurrenceType, until: recurrenceUntil };
    }
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('task-quickadd-form').reset();
    setSearchableProjectValue('qa-project', '');
    document.getElementById('qa-priority').value = 'mittel';
    document.getElementById('qa-recurrence-until').classList.add('hidden');
    await loadTasks();
    if (document.getElementById('tab-calendar').classList.contains('active')) await renderCalendar();
  });

  // Legt fuer jede zugeordnete Person einen Kalendertermin an (Datum+Uhrzeit der Aufgabe),
  // Legt fuer jede zugeordnete Person einen Kalendertermin an (Datum+Uhrzeit der Aufgabe),
  // sofern noch keiner existiert. Zeigt bei Bedarf einen Nachtdienst-Hinweis fuer BFD-Personen
  // (rein informativ, blockiert die Anlage nicht).
  async function autoScheduleTask(task, dueDate, dueTime) {
    if (!task.people.length) return;
    const startMin = timeToMinutes(dueTime);
    const endMin = startMin + (task.estimated_minutes || 30);
    const endTime = minutesToTime(endMin);

    let existingOnDate = [];
    try {
      existingOnDate = await api(`/api/calendar?from=${dueDate}&to=${dueDate}`);
    } catch (e) { /* Kalenderabfrage optional - im Zweifel einfach anlegen */ }

    const warnings = [];

    for (const person of task.people) {
      const alreadyExists = existingOnDate.some(ce => ce.task_id === task.id && ce.person_id === person.id);
      if (alreadyExists) continue;
      try {
        await api('/api/calendar', {
          method: 'POST',
          body: JSON.stringify({ task_id: task.id, person_id: person.id, date: dueDate, start_time: dueTime, end_time: endTime }),
        });
      } catch (err) { continue; }

      if (person.contract_type === 'BFD') {
        const nightOverlap = !(endMin <= 1380 && startMin >= 360); // 23:00-06:00
        if (nightOverlap) {
          warnings.push(`${person.name}: Termin überschneidet sich mit der Nachtzeit (23:00–06:00) — bei BFD (pauschal < 26 Jahre) nur in Ausnahmefällen zulässig.`);
        }
      }
    }

    if (warnings.length) alert('Hinweis:\n\n' + warnings.join('\n'));
  }

  async function deleteTask(id) {
    if (!confirm('Aufgabe wirklich löschen? Geplante Kalendertermine dazu werden ebenfalls entfernt.')) return;
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    closeTaskModal();
    await loadTasks();
    await loadCalendar();
  }

  async function markTaskDone(id) {
    await api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'erledigt' }) });
    await loadTasks();
  }

  function fillTaskSelect() {
    // Feld "Bezug zu Aufgabe" bei der Zeiterfassung wurde entfernt - keine Befuellung mehr noetig.
  }

  // ================= CALENDAR =================
  function visibleDays() {
    if (calendarViewMode === 'day') return [currentDay];
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(currentWeekStart, i));
    return days;
  }
  function dayWidth() {
    if (calendarViewMode === 'day') return DAY_VIEW_WIDTH;
    // Woche soll komplett ohne horizontales Scrollen passen: Breite dynamisch aus dem
    // verfuegbaren Platz berechnen statt eine feste Breite je Tag zu nutzen.
    const container = document.querySelector('.calendar-main-full');
    if (!container) return WEEK_DAY_WIDTH;
    const available = container.clientWidth - 32 /* Innenabstand links+rechts */ - 56 /* Uhrzeit-Spalte */;
    return Math.max(60, Math.floor(available / 7));
  }

  async function loadCalendar() {
    const days = visibleDays();
    const from = isoDate(days[0]);
    const to = isoDate(days[days.length - 1]);
    calendarEntries = await api(`/api/calendar?from=${from}&to=${to}`);
    document.getElementById('ical-export-link').href = `/api/calendar/export.ics?from=${from}&to=${to}`;
  }

  const PRIORITY_RANK_URGENCY = { hoch: 0, mittel: 1, niedrig: 2 };
  // Sortiert Aufgaben nach Dringlichkeit (ueberfaellig zuerst, dann nahende Faelligkeit, dann
  // Prioritaet) - gemeinsam genutzt vom "Dringend"-Bereich und der Aufgaben-Verteilung rund
  // um den Kalender in der Wochenplanung.
  function sortByUrgency(list) {
    const todayIso = isoDate(new Date());
    return [...list].sort((a, b) => {
      const aOverdue = a.due_date && a.due_date < todayIso;
      const bOverdue = b.due_date && b.due_date < todayIso;
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
      if (a.due_date && !b.due_date) return -1;
      if (!a.due_date && b.due_date) return 1;
      return PRIORITY_RANK_URGENCY[a.priority] - PRIORITY_RANK_URGENCY[b.priority];
    });
  }

  function magnetTaskCardHtml(t) {
    const peopleNames = t.people.map(p => p.name).join(', ') || '—';
    const projectHtml = t.project ? `<span class="mc-project" style="color:${t.project.color}">${escapeHtml(t.project.name)}</span>` : '';
    return `
      <div class="magnet-card" draggable="true" data-task-id="${t.id}">
        ${projectHtml}
        <span class="mc-title">${escapeHtml(t.title)}</span>
        <span class="mc-person">${escapeHtml(peopleNames)}</span>
      </div>
    `;
  }

  // Links neben dem Kalender: dringende Aufgaben (gleiches Kriterium wie der "Dringend"-Bereich
  // bei den Aufgaben), rechts: alle uebrigen offenen Aufgaben. Beide Spalten scrollen unabhaengig
  // und sind genauso hoch wie der Kalender in der Mitte.
  // Verbindet die automatische Dringlichkeits-Sortierung mit manuell per Drag&Drop gesetzten
  // Positionen (manual_rank): Aufgaben ohne manual_rank bleiben an ihrer automatischen Position,
  // manuell einsortierte Aufgaben behalten ihren fest gesetzten Platz dazwischen.
  function mergeManualOrder(autoSortedTasks) {
    const withKeys = autoSortedTasks.map((t, i) => ({
      task: t,
      key: (t.manual_rank !== null && t.manual_rank !== undefined) ? t.manual_rank : i * 1000,
    }));
    withKeys.sort((a, b) => a.key - b.key);
    return withKeys;
  }

  let currentUrgentMerged = [];

  function renderTaskPool() {
    // Aufgaben, die in der aktuell sichtbaren Woche bereits einen Kalendertermin haben, sind
    // schon eingeplant und verschwinden aus den beiden Listen - sonst stehen sie doppelt da.
    const scheduledTaskIds = new Set(calendarEntries.map(e => e.task_id));
    const openTasks = tasks.filter(t => t.status !== 'erledigt' && !scheduledTaskIds.has(t.id));
    const soonIso = isoDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const urgentAuto = sortByUrgency(openTasks.filter(t => t.priority === 'hoch' || (t.due_date && t.due_date <= soonIso)));
    const urgentMerged = mergeManualOrder(urgentAuto);
    currentUrgentMerged = urgentMerged;
    const urgent = urgentMerged.map(x => x.task);
    const urgentIds = new Set(urgent.map(t => t.id));
    const other = openTasks.filter(t => !urgentIds.has(t.id));

    document.getElementById('pool-urgent-count').textContent = `(${urgent.length})`;
    document.getElementById('pool-other-count').textContent = `(${other.length})`;

    const urgentZone = document.getElementById('pool-zone-urgent');
    const otherZone = document.getElementById('pool-zone-other');
    urgentZone.innerHTML = urgent.length ? urgent.map(magnetTaskCardHtml).join('') : '<p class="empty-state">Keine dringenden Aufgaben.</p>';
    otherZone.innerHTML = other.length ? other.map(magnetTaskCardHtml).join('') : '<p class="empty-state">Keine weiteren Aufgaben.</p>';

    document.querySelectorAll('.magnet-card').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/json', JSON.stringify({ type: 'schedule', taskId: +card.dataset.taskId }));
        e.dataTransfer.effectAllowed = 'copy';
      });
      // Tippen (Touch-Alternative zum Ziehen): Aufgabe auswaehlen, dann Zielort antippen.
      // Ist bereits ein VERSCHIEBEN-Vorgang aktiv, zaehlt ein Tipp auf irgendeine Karte hier
      // als "in diese Liste verschieben" (= Termin entfernen), nicht als neue Auswahl.
      card.addEventListener('click', async (e) => {
        const taskId = +card.dataset.taskId;
        if (tapSelectedPayload && tapSelectedPayload.type === 'move') {
          e.stopPropagation();
          await applyTapUnschedule();
          return;
        }
        if (tapSelectedPayload && tapSelectedPayload.type === 'schedule' && tapSelectedPayload.taskId === taskId) {
          clearTapSelection();
          return;
        }
        const task = tasks.find(t => t.id === taskId);
        startTapSelection({ type: 'schedule', taskId }, task ? task.title : 'Aufgabe');
      });
    });
  }

  // Manuelles Umsortieren innerhalb "Dringend" per Drag&Drop: beim Ablegen wird anhand der
  // Maus-Position die Einfuegestelle bestimmt und eine manual_rank zwischen den Nachbar-Werten
  // gesetzt (Bruch-Indexierung) - die automatische Sortierung bleibt fuer alle anderen bestehen.
  // Wird nur EINMAL eingerichtet (nicht bei jedem renderTaskPool), liest aber immer den
  // aktuellen Stand ueber currentUrgentMerged.
  // Entfernt einen Kalendertermin bzw. das Faelligkeitsdatum eines Ganztaegig-Chips, wenn er auf
  // eine der beiden Aufgaben-Spalten (Dringend/Weitere Aufgaben) gezogen wird. Gibt true zurueck,
  // wenn das Payload so behandelt wurde (und die Aufrufer-Funktion sich um renderTaskPool() kuemmern muss).
  async function unscheduleFromDropPayload(payload) {
    if (payload.type === 'move') {
      const entry = calendarEntries.find(en => en.id === payload.entryId);
      if (!entry) return false;
      const group = calendarEntries.filter(e2 =>
        e2.task_id === entry.task_id && e2.date === entry.date &&
        e2.start_time === entry.start_time && e2.end_time === entry.end_time
      );
      await Promise.all(group.map(e2 => api(`/api/calendar/${e2.id}`, { method: 'DELETE' })));
      await loadCalendar();
      renderAllDayRow();
      renderCalendarEntries();
      renderCalendarMobileList();
      return true;
    }
    if (payload.type === 'schedule' && payload.source === 'allday') {
      await api(`/api/tasks/${payload.taskId}`, { method: 'PUT', body: JSON.stringify({ clear_due_date: true }) });
      await loadTasks();
      renderAllDayRow();
      return true;
    }
    return false;
  }

  function setupUrgentReorder() {
    const zone = document.getElementById('pool-zone-urgent');
    if (!zone) return;

    zone.addEventListener('dragover', (e) => e.preventDefault());

    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch (err) { return; }
      if (!payload) return;

      if (payload.type === 'move' || (payload.type === 'schedule' && payload.source === 'allday')) {
        // Auf "Dringend" abgelegt: Termin/Faelligkeitsdatum entfernen UND Prioritaet auf "hoch"
        // setzen, damit die Aufgabe tatsaechlich dort landet statt automatisch bei "Weitere
        // Aufgaben" zu verschwinden (Dringend-Zugehoerigkeit richtet sich nach Prioritaet/Termin).
        const taskId = payload.type === 'move'
          ? (calendarEntries.find(en => en.id === payload.entryId) || {}).task_id
          : payload.taskId;
        const unscheduled = await unscheduleFromDropPayload(payload);
        if (unscheduled && taskId) {
          await api(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ priority: 'hoch' }) });
          await loadTasks();
        }
        if (unscheduled) { renderTaskPool(); return; }
      }
      if (payload.type !== 'schedule') return;

      const draggedId = payload.taskId;
      const isAlreadyInUrgent = currentUrgentMerged.some(x => x.task.id === draggedId);
      if (!isAlreadyInUrgent) return; // von ausserhalb (z.B. Weitere Aufgaben) -> kein Reorder hier

      const cards = [...zone.querySelectorAll('.magnet-card')];
      let insertIndex = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { insertIndex = i; break; }
      }
      const draggedCurrentIndex = currentUrgentMerged.findIndex(x => x.task.id === draggedId);
      const remaining = currentUrgentMerged.filter(x => x.task.id !== draggedId);
      let adjIndex = insertIndex;
      if (draggedCurrentIndex !== -1 && draggedCurrentIndex < insertIndex) adjIndex -= 1;
      const before = remaining[adjIndex - 1];
      const after = remaining[adjIndex];
      let newRank;
      if (!before && !after) newRank = 0;
      else if (!before) newRank = after.key - 1000;
      else if (!after) newRank = before.key + 1000;
      else newRank = (before.key + after.key) / 2;

      await api(`/api/tasks/${draggedId}`, { method: 'PUT', body: JSON.stringify({ manual_rank: newRank }) });
      const task = tasks.find(t => t.id === draggedId);
      if (task) task.manual_rank = newRank;
      renderTaskPool();
    });

    // Tippen (Touch-Alternative): ein per "Verschieben" ausgewaehlter Termin landet hier als
    // dringende Aufgabe (gleiche Wirkung wie das Ablegen per Drag&Drop oben).
    zone.addEventListener('click', async (e) => {
      if (e.target !== zone) return; // Klicks auf Karten haben ihren eigenen Handler
      if (!tapSelectedPayload || tapSelectedPayload.type !== 'move') return;
      const payload = tapSelectedPayload;
      const taskId = (calendarEntries.find(en => en.id === payload.entryId) || {}).task_id;
      clearTapSelection();
      const unscheduled = await unscheduleFromDropPayload(payload);
      if (unscheduled && taskId) {
        await api(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ priority: 'hoch' }) });
        await loadTasks();
      }
      if (unscheduled) renderTaskPool();
    });
  }

  // Erlaubt, einen Termin aus dem Zeitraster oder einen Ganztaegig-Chip auf "Weitere Aufgaben"
  // zu ziehen: entfernt den hinterlegten Termin (bzw. das Faelligkeitsdatum), die Aufgabe wird
  // wieder unverplant und taucht in der Aufgaben-Uebersicht auf.
  function setupPoolOtherDropTarget() {
    const zone = document.getElementById('pool-zone-other');
    if (!zone) return;
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch (err) { return; }
      if (!payload) return;
      if (await unscheduleFromDropPayload(payload)) renderTaskPool();
    });
    // Tippen auf leere Flaeche der Zone (nicht auf eine Karte, die hat ihren eigenen Handler).
    zone.addEventListener('click', async () => {
      if (tapSelectedPayload && tapSelectedPayload.type === 'move') await applyTapUnschedule();
    });
  }

  function renderCalendarGrid() {
    const days = visibleDays();
    const dw = dayWidth();

    // Kopfzeile mit Wochentagen ausserhalb des scrollbaren Bereichs, damit sie beim
    // Scrollen im Zeitraster (z.B. zur 9-Uhr-Hauptansicht) sichtbar bleibt.
    const header = document.getElementById('calendar-header-row');
    header.innerHTML = '';
    header.style.gridTemplateColumns = `56px repeat(${days.length}, ${dw}px)`;
    header.style.width = (56 + days.length * dw) + 'px';
    const corner = document.createElement('div');
    corner.className = 'cal-head';
    header.appendChild(corner);
    days.forEach(d => {
      const head = document.createElement('div');
      head.className = 'cal-head';
      head.innerHTML = `${DAY_NAMES[d.getDay() === 0 ? 6 : d.getDay() - 1]}<div class="cal-head-date">${fmtDateLabel(d)}</div>`;
      header.appendChild(head);
    });

    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `56px repeat(${days.length}, ${dw}px)`;
    grid.style.width = (56 + days.length * dw) + 'px';

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
        chip.title = t.title + ' — auf eine Uhrzeit ziehen, um sie dort einzuplanen';
        chip.draggable = true;
        chip.addEventListener('click', () => startEditTask(t.id));
        chip.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/json', JSON.stringify({ type: 'schedule', taskId: t.id, source: 'allday' }));
          e.dataTransfer.effectAllowed = 'copy';
        });
        cell.appendChild(chip);
      });

      // Erlaubt, einen bereits verplanten Termin aus dem Zeitraster wieder zurueck in die
      // Ganztaegig-Zeile zu ziehen: entfernt die konkrete Uhrzeit, Aufgabe erscheint danach
      // ganztaegig an dem Tag, auf den gezogen wurde.
      cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
      cell.addEventListener('drop', async (e) => {
        e.preventDefault();
        cell.classList.remove('drag-over');
        let payload;
        try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch (err) { return; }
        if (!payload || payload.type !== 'move') return;
        const entry = calendarEntries.find(en => en.id === payload.entryId);
        if (!entry) return;
        await api(`/api/calendar/${entry.id}`, { method: 'DELETE' });
        await api(`/api/tasks/${entry.task_id}`, { method: 'PUT', body: JSON.stringify({ due_date: dateIso, due_time: null }) });
        await loadTasks();
        await loadCalendar();
        renderAllDayRow();
        renderCalendarEntries();
        renderCalendarMobileList();
      });

      row.appendChild(cell);
    });
  }

  // ---------- Tippen-statt-Ziehen: Touch-Alternative zum Drag & Drop ----------
  // Auf Touch-Geraeten funktioniert natives HTML5-Drag&Drop nicht. Als Alternative: Aufgabe/
  // Termin antippen zum Auswaehlen, dann den Zielort antippen (Zeitzelle oder Dringend/Weitere
  // Aufgaben). Nutzt dieselbe Payload-Form wie beim Ziehen, damit die Zielort-Logik geteilt wird.
  let tapSelectedPayload = null;
  const tapBanner = document.getElementById('tap-schedule-banner');

  function startTapSelection(payload, label) {
    tapSelectedPayload = payload;
    document.getElementById('tap-schedule-banner-text').textContent = `${label} ausgewählt — jetzt eine Uhrzeit im Kalender oder "Dringend"/"Weitere Aufgaben" antippen.`;
    tapBanner.classList.remove('hidden');
  }
  function clearTapSelection() {
    tapSelectedPayload = null;
    tapBanner.classList.add('hidden');
  }
  document.getElementById('tap-schedule-cancel').addEventListener('click', clearTapSelection);

  async function applyTapTarget(dateIso, slotIndex) {
    const payload = tapSelectedPayload;
    if (!payload) return false;
    clearTapSelection();
    if (payload.type === 'schedule') {
      openScheduleModal(payload.taskId, dateIso, slotIndex);
    } else if (payload.type === 'move') {
      const entry = calendarEntries.find(en => en.id === payload.entryId);
      if (!entry) return true;
      const durationMin = timeToMinutes(entry.end_time) - timeToMinutes(entry.start_time);
      const newStart = slotIndexToTime(slotIndex);
      const newEnd = minutesToTime(timeToMinutes(newStart) + durationMin);
      await api(`/api/calendar/${entry.id}`, {
        method: 'PUT',
        body: JSON.stringify({ date: dateIso, start_time: newStart, end_time: newEnd }),
      });
      await loadCalendar();
      renderCalendarEntries();
      renderCalendarMobileList();
    }
    return true;
  }

  // Variante fuer die mobile Listenansicht (kein Zeitraster, nur Tage): bei "schedule" oeffnet
  // sich das Einplanungs-Fenster mit dem angetippten Tag (Uhrzeit dort waehlen); bei "move"
  // bleibt die bisherige Uhrzeit erhalten, nur der Tag aendert sich.
  async function applyTapTargetDate(dateIso) {
    const payload = tapSelectedPayload;
    if (!payload) return false;
    clearTapSelection();
    if (payload.type === 'schedule') {
      const defaultSlot = Math.round(((9 - START_HOUR) * 60) / SLOT_MINUTES); // 09:00 als Vorschlag
      openScheduleModal(payload.taskId, dateIso, defaultSlot);
    } else if (payload.type === 'move') {
      const entry = calendarEntries.find(en => en.id === payload.entryId);
      if (!entry) return true;
      await api(`/api/calendar/${entry.id}`, { method: 'PUT', body: JSON.stringify({ date: dateIso }) });
      await loadCalendar();
      renderCalendarEntries();
      renderCalendarMobileList();
    }
    return true;
  }

  async function applyTapUnschedule() {
    const payload = tapSelectedPayload;
    if (!payload) return false;
    clearTapSelection();
    if (await unscheduleFromDropPayload(payload)) renderTaskPool();
    return true;
  }

  function attachDropHandlers(cell) {
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      await handleCalendarDrop(e, cell.dataset.date, +cell.dataset.slot);
    });
    // Klick: wenn gerade eine Aufgabe/ein Termin per Antippen ausgewaehlt ist, hierher
    // einplanen/verschieben - sonst wie gehabt eine neue Aufgabe an dieser Zeitzelle anlegen.
    cell.addEventListener('click', async () => {
      if (tapSelectedPayload) { await applyTapTarget(cell.dataset.date, +cell.dataset.slot); return; }
      openQuickCreateModal(cell.dataset.date, +cell.dataset.slot);
    });
  }

  // Gemeinsame Drop-Logik, sowohl von leeren Zeitzellen als auch von bereits belegten
  // Terminen aus aufrufbar - damit sich auch bei einer Zeitüberschneidung noch ein
  // weiterer Termin (z.B. fuer eine andere Person) daneben anlegen laesst.
  async function handleCalendarDrop(e, dateIso, slotIndex) {
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch (err) { return; }
    if (!payload) return;

    if (payload.type === 'schedule') {
      openScheduleModal(payload.taskId, dateIso, slotIndex);
    } else if (payload.type === 'move') {
      const entry = calendarEntries.find(en => en.id === payload.entryId);
      if (!entry) return;
      // Immer die exakte Maus-Y-Position auswerten (statt der Zellen-Slot-Nummer) und dabei
      // den Greif-Versatz abziehen, damit der Termin exakt dort einrastet, wo sein Anfang
      // tatsaechlich abgelegt wurde - unabhaengig davon, wo innerhalb des Termins gegriffen wurde.
      const grabOffsetSlots = Math.round((payload.grabOffsetY || 0) / SLOT_HEIGHT);
      const preciseSlot = Math.max(0, Math.min(SLOTS_PER_DAY - 1, slotFromOverlayY(e.clientY) - grabOffsetSlots));
      const durationMin = timeToMinutes(entry.end_time) - timeToMinutes(entry.start_time);
      const newStart = slotIndexToTime(preciseSlot);
      const newEnd = minutesToTime(timeToMinutes(newStart) + durationMin);
      await api(`/api/calendar/${entry.id}`, {
        method: 'PUT',
        body: JSON.stringify({ date: dateIso, start_time: newStart, end_time: newEnd }),
      });
      await loadCalendar();
      renderCalendarEntries();
    }
  }

  // Rechnet aus einer Maus-Y-Position innerhalb der Termin-Ebene den zugehoerigen Zeit-Slot aus -
  // wird gebraucht, damit ein Drop direkt auf einem bestehenden Termin (statt auf freier Flaeche)
  // trotzdem funktioniert und nicht vom bereits liegenden Termin blockiert wird.
  function slotFromOverlayY(clientY) {
    const overlay = document.getElementById('calendar-entries-overlay');
    const rect = overlay.getBoundingClientRect();
    const relY = clientY - rect.top;
    return Math.max(0, Math.min(SLOTS_PER_DAY - 1, Math.floor(relY / SLOT_HEIGHT)));
  }

  // Weist ueberlappenden Terminen an einem Tag Spalten zu (wie bei Google Kalender),
  // damit mehrere Termine zur gleichen Zeit nebeneinander statt uebereinander liegen -
  // wichtig, wenn mehrere Personen zeitgleich an unterschiedlichen Aufgaben arbeiten.
  function layoutOverlappingEntries(dayEntries) {
    const sorted = [...dayEntries].sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
    let group = [];
    let groupEnd = -1;
    const groups = [];

    sorted.forEach(entry => {
      const start = timeToMinutes(entry.start_time);
      const end = timeToMinutes(entry.end_time);
      if (group.length && start >= groupEnd) {
        groups.push(group);
        group = [];
        groupEnd = -1;
      }
      group.push(entry);
      groupEnd = Math.max(groupEnd, end);
    });
    if (group.length) groups.push(group);

    const positioned = [];
    groups.forEach(g => {
      const columnEnds = []; // letztes Ende je Spalte
      g.forEach(entry => {
        const start = timeToMinutes(entry.start_time);
        const end = timeToMinutes(entry.end_time);
        let col = columnEnds.findIndex(colEnd => colEnd <= start);
        if (col === -1) { col = columnEnds.length; columnEnds.push(end); }
        else columnEnds[col] = end;
        positioned.push({ entry, col });
      });
      positioned.filter(p => g.includes(p.entry)).forEach(p => { p.groupColumns = columnEnds.length; });
    });
    return positioned;
  }

  // Fasst Termine zusammen, die zur selben Aufgabe, demselben Tag und derselben Uhrzeit
  // gehoeren (mehrere Personen am selben Termin) - werden als EIN mehrfarbiger Balken
  // dargestellt statt sich die Spaltenbreite mit schmalen Einzel-Terminen zu teilen.
  function groupSameSlotEntries(dayEntries) {
    const groups = new Map();
    dayEntries.forEach(e => {
      const key = `${e.task_id}|${e.start_time}|${e.end_time}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });
    return [...groups.values()];
  }

  function renderCalendarEntries() {
    const overlay = document.getElementById('calendar-entries-overlay');
    overlay.innerHTML = '';
    overlay.style.height = (SLOTS_PER_DAY * SLOT_HEIGHT) + 'px';
    const days = visibleDays();
    const dw = dayWidth();
    overlay.style.width = (days.length * dw) + 'px';

    const dayIso = days.map(isoDate);

    dayIso.forEach((iso, dayIdx) => {
      const dayEntries = calendarEntries.filter(e => e.date === iso);
      const slotGroups = groupSameSlotEntries(dayEntries);
      // layoutOverlappingEntries arbeitet mit dem jeweils ersten Eintrag jeder Gruppe als
      // Stellvertreter fuer Start-/Endzeit, damit sich mehrpersonige Termine wie ein Block
      // verhalten statt in mehrere schmale Spalten aufgeteilt zu werden.
      const representatives = slotGroups.map(g => g[0]);
      const positioned = layoutOverlappingEntries(representatives);
      const groupByRepId = new Map(slotGroups.map(g => [g[0].id, g]));

      positioned.forEach(({ entry, col, groupColumns }) => {
        const group = groupByRepId.get(entry.id);
        const startMin = timeToMinutes(entry.start_time) - START_HOUR * 60;
        const endMin = timeToMinutes(entry.end_time) - START_HOUR * 60;
        if (endMin <= 0 || startMin >= SLOTS_PER_DAY * SLOT_MINUTES) return;
        const top = Math.max(0, (startMin / SLOT_MINUTES) * SLOT_HEIGHT);
        const height = Math.max(SLOT_HEIGHT - 2, ((endMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT - 2);
        const colWidth = dw / groupColumns;

        const el = document.createElement('div');
        const anyDone = group.some(e => e.task_status === 'erledigt');
        el.className = 'cal-entry' + (anyDone ? ' done' : '');
        el.draggable = true;
        el.dataset.entryId = entry.id;
        el.style.top = top + 'px';
        el.style.height = height + 'px';
        el.style.left = (dayIdx * dw + col * colWidth + 2) + 'px';
        el.style.width = (colWidth - 4) + 'px';

        const colors = group.slice(0, 3).map(e => e.person_color || '#4f46e5');
        if (colors.length === 1) {
          el.style.background = colors[0];
        } else {
          const stripe = 100 / colors.length;
          const stops = colors.map((c, i) => `${c} ${i * stripe}%, ${c} ${(i + 1) * stripe}%`).join(', ');
          el.style.background = `linear-gradient(to right, ${stops})`;
        }

        const peopleNames = group.map(e => e.person_name).join(', ');
        const timeLabel = `${entry.start_time.slice(0, 5)}–${entry.end_time.slice(0, 5)} · ${peopleNames}`;
        const titleWithProject = entry.project_name ? `${entry.project_name}: ${entry.task_title}` : entry.task_title;
        el.dataset.tooltip = `${titleWithProject}\n${timeLabel}`;
        const anyDoneForCheckbox = group.some(e => e.task_status === 'erledigt');
        el.innerHTML = `
          <div class="ce-content">
            <label class="ce-done-check" title="Als erledigt markieren">
              <input type="checkbox" class="ce-done-checkbox" ${anyDoneForCheckbox ? 'checked' : ''}>
            </label>
            <div class="ce-title">${entry.project_name ? `<span class="cal-entry-project">${escapeHtml(entry.project_name)}:</span> ` : ''}${escapeHtml(entry.task_title)}</div>
            <div class="ce-time">${escapeHtml(timeLabel)}</div>
          </div>
          <div class="ce-resize-handle" data-resize="${entry.id}"></div>
        `;

        const doneCheckbox = el.querySelector('.ce-done-checkbox');
        doneCheckbox.addEventListener('click', (ev) => ev.stopPropagation());
        doneCheckbox.addEventListener('change', async (ev) => {
          ev.stopPropagation();
          await toggleTaskDone(entry.task_id, doneCheckbox.checked);
        });

        let suppressClick = false;

        el.addEventListener('dragstart', (e) => {
          // Position innerhalb des Termins merken, an der er gegriffen wurde - sonst landet
          // er beim Ablegen leicht verschoben (Versatz zwischen Mausposition und Terminanfang).
          const grabOffsetY = e.clientY - el.getBoundingClientRect().top;
          e.dataTransfer.setData('application/json', JSON.stringify({ type: 'move', entryId: entry.id, grabOffsetY }));
          e.dataTransfer.effectAllowed = 'move';
          el.classList.add('dragging-source');
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging-source'));

        // Drop direkt auf einem bestehenden Termin muss trotzdem funktionieren, damit sich
        // ein weiterer Termin zur gleichen Zeit daneben anlegen laesst (nicht blockiert sein).
        el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          el.classList.remove('drag-over');
          await handleCalendarDrop(e, iso, slotFromOverlayY(e.clientY));
        });

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (suppressClick) { suppressClick = false; return; }
          openEntryMenu(group);
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
              // Bei mehrpersonigen Terminen alle zugehoerigen Eintraege gemeinsam verlaengern/kuerzen.
              await Promise.all(group.map(e => api(`/api/calendar/${e.id}`, { method: 'PUT', body: JSON.stringify({ end_time: newEnd }) })));
              await loadCalendar();
            }
            renderCalendarEntries();
          }
          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        });

        overlay.appendChild(el);
      });
    });
  }

  async function renderCalendar() {
    renderCalendarGrid();
    await loadCalendar();
    renderTaskPool();
    renderAllDayRow();
    renderCalendarEntries();
    renderCalendarMobileList();
    scrollCalendarToMainView();
  }

  // Zeigt beim Oeffnen/Neuladen standardmaessig 9-20 Uhr an (Hauptzeitfenster), Rest per
  // Scrollen erreichbar - vermeidet, dass man immer erst zur relevanten Zeit scrollen muss.
  function scrollCalendarToMainView() {
    const wrap = document.querySelector('.calendar-grid-wrap');
    if (!wrap) return;
    const offsetMinutes = (MAIN_VIEW_START_HOUR - START_HOUR) * 60;
    wrap.scrollTop = (offsetMinutes / SLOT_MINUTES) * SLOT_HEIGHT;
  }

  const DE_WEEKDAY_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

  // Einfache chronologische Tagesliste fuer die mobile Ansicht (statt Raster-Kalender,
  // der auf schmalen Bildschirmen abgeschnitten wird). Nutzt dieselben Daten wie das Raster.
  function renderCalendarMobileList() {
    const container = document.getElementById('calendar-mobile-list');
    const days = visibleDays();
    const dayIso = days.map(isoDate);

    const html = dayIso.map(iso => {
      const dayEntries = calendarEntries
        .filter(e => e.date === iso)
        .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
      const d = new Date(iso);
      const heading = `${DE_WEEKDAY_LONG[d.getDay()]}, ${fmtDateDE(iso)}`;
      const rows = dayEntries.length
        ? dayEntries.map(e => `
            <div class="cml-entry ${e.task_status === 'erledigt' ? 'done' : ''}" data-cml-entry="${e.id}">
              <span class="cml-entry-color" style="background:${e.person_color || '#4f46e5'}"></span>
              <span class="cml-entry-time">${e.start_time.slice(0, 5)}–${e.end_time.slice(0, 5)}</span>
              <span class="cml-entry-body">
                <span class="cml-entry-title">${e.project_name ? `<span class="cml-project-tag" style="color:${e.project_color}">${escapeHtml(e.project_name)}:</span> ` : ''}${escapeHtml(e.task_title)}</span>
                <span class="cml-entry-person">${escapeHtml(e.person_name)}</span>
              </span>
            </div>
          `).join('')
        : '<p class="empty-state">Keine Termine.</p>';
      return `<div class="cml-day"><div class="cml-day-heading" data-cml-day-target="${iso}">${heading}</div>${rows}</div>`;
    }).join('');

    container.innerHTML = html;
    container.querySelectorAll('[data-cml-day-target]').forEach(el => {
      el.addEventListener('click', async () => {
        if (!tapSelectedPayload) return;
        await applyTapTargetDate(el.dataset.cmlDayTarget);
      });
    });
    container.querySelectorAll('[data-cml-entry]').forEach(el => {
      const entry = calendarEntries.find(e => e.id === +el.dataset.cmlEntry);
      if (entry) el.addEventListener('click', () => {
        const group = calendarEntries.filter(e =>
          e.task_id === entry.task_id && e.date === entry.date &&
          e.start_time === entry.start_time && e.end_time === entry.end_time
        );
        openEntryMenu(group);
      });
    });
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
      <label>Enddatum (optional, für mehrtägige Termine) <input type="date" id="modal-end-date" value="${date}"></label>
      <label>Start <input type="time" id="modal-start" value="${startTime}"></label>
      <label>Ende <input type="time" id="modal-end" value="${endTime}"></label>
      <label>Person
        <select id="modal-person">${peopleOptions || '<option value="">— keine Person angelegt —</option>'}</select>
      </label>
      <label>Projekt
        <div class="searchable-select-wrap"><input type="text" id="modal-project-search" placeholder="Projekt suchen..." autocomplete="off"><input type="hidden" id="modal-project"></div>
      </label>
      <p class="hint">Bei mehrtägigen Terminen gilt dieselbe Uhrzeit an jedem Tag im Zeitraum.</p>
    `;
    initSearchableProjectPicker('modal-project-search', 'modal-project', task.project ? task.project.id : '');
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
    const endDateField = document.getElementById('modal-end-date');
    const end_date = endDateField ? endDateField.value : null;
    const start_time = document.getElementById('modal-start').value;
    const end_time = document.getElementById('modal-end').value;
    const person_id = +document.getElementById('modal-person').value;
    if (!date || !start_time || !end_time || !person_id) {
      alert('Bitte Datum, Uhrzeit und Person angeben.');
      return;
    }
    if (end_date && end_date < date) {
      alert('Das Enddatum darf nicht vor dem Startdatum liegen.');
      return;
    }
    await api('/api/calendar', {
      method: 'POST',
      body: JSON.stringify({ task_id: pendingDrop.taskId, person_id, date, start_time, end_time, end_date: end_date || null }),
    });

    // Projekt an der Aufgabe aktualisieren, falls im Einplanungs-Fenster geaendert
    const projectVal = document.getElementById('modal-project').value;
    const task = tasks.find(t => t.id === pendingDrop.taskId);
    const currentProjectId = task && task.project ? task.project.id : null;
    const newProjectId = projectVal ? +projectVal : null;
    if (newProjectId !== currentProjectId) {
      await api(`/api/tasks/${pendingDrop.taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ project_id: newProjectId, clear_project: !newProjectId }),
      });
    }

    closeModal();
    await loadTasks();
    await loadCalendar();
    renderAllDayRow();
    renderCalendarEntries();
    renderCalendarMobileList();
  });

  // ---------- Termin-Menü (Klick auf bestehenden Kalendereintrag) ----------
  const entryMenuOverlay = document.getElementById('entry-menu-overlay');
  let pendingEntryGroup = null;

  function renderEntryMenuPeopleList() {
    const container = document.getElementById('entry-menu-people-list');
    const activePeople = people.filter(p => p.active);
    container.innerHTML = pendingEntryGroup.map(e => {
      const options = activePeople.map(p => `<option value="${p.id}" ${p.id === e.person_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
      return `
        <div class="yc-day-event-row" data-people-row="${e.id}">
          <span class="color-dot" style="background:${e.person_color}"></span>
          <select class="entry-menu-person-select" data-entry-id="${e.id}" style="flex:1">${options}</select>
          <button type="button" class="danger" data-remove-person-entry="${e.id}" title="Person von diesem Termin entfernen">✕</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.entry-menu-person-select').forEach(sel => sel.addEventListener('change', async () => {
      const entryId = +sel.dataset.entryId;
      await api(`/api/calendar/${entryId}`, { method: 'PUT', body: JSON.stringify({ person_id: +sel.value }) });
      await loadCalendar();
      renderCalendarEntries();
      renderCalendarMobileList();
      const entry = calendarEntries.find(e => e.id === entryId);
      if (entry) {
        pendingEntryGroup = pendingEntryGroup.map(e => e.id === entryId ? entry : e);
        renderEntryMenuPeopleList();
        fillEntryMenuAddPersonSelect();
      }
    }));
    container.querySelectorAll('[data-remove-person-entry]').forEach(b => b.addEventListener('click', async () => {
      if (pendingEntryGroup.length <= 1) { alert('Die letzte Person kann hier nicht entfernt werden - nutze stattdessen "Aus Kalender entfernen".'); return; }
      const entryId = +b.dataset.removePersonEntry;
      await api(`/api/calendar/${entryId}`, { method: 'DELETE' });
      pendingEntryGroup = pendingEntryGroup.filter(e => e.id !== entryId);
      await loadCalendar();
      renderCalendarEntries();
      renderCalendarMobileList();
      renderEntryMenuPeopleList();
      fillEntryMenuAddPersonSelect();
    }));
  }

  function fillEntryMenuAddPersonSelect() {
    const sel = document.getElementById('entry-menu-add-person');
    const assignedIds = new Set(pendingEntryGroup.map(e => e.person_id));
    const available = people.filter(p => p.active && !assignedIds.has(p.id));
    sel.innerHTML = '<option value="">— Person wählen —</option>' +
      available.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  }

  function openEntryMenu(group) {
    pendingEntryGroup = group;
    const first = group[0];
    const titlePrefix = first.project_name ? `${first.project_name}: ` : '';
    document.getElementById('entry-menu-title').textContent = `${titlePrefix}${first.task_title} · ${first.start_time.slice(0, 5)}–${first.end_time.slice(0, 5)}`;
    document.getElementById('entry-menu-remove-series').classList.toggle('hidden', !group.some(e => e.series_id));
    renderEntryMenuPeopleList();
    fillEntryMenuAddPersonSelect();
    entryMenuOverlay.classList.remove('hidden');
  }
  function closeEntryMenu() {
    entryMenuOverlay.classList.add('hidden');
    pendingEntryGroup = null;
  }
  document.getElementById('entry-menu-cancel').addEventListener('click', closeEntryMenu);
  entryMenuOverlay.addEventListener('click', (e) => { if (e.target === entryMenuOverlay) closeEntryMenu(); });

  document.getElementById('entry-menu-add-person-btn').addEventListener('click', async () => {
    const sel = document.getElementById('entry-menu-add-person');
    const newPersonId = +sel.value;
    if (!newPersonId) return;
    const first = pendingEntryGroup[0];
    const task = tasks.find(t => t.id === first.task_id);
    if (task) {
      const mergedIds = [...new Set([...task.people.map(p => p.id), newPersonId])];
      await api(`/api/tasks/${first.task_id}`, { method: 'PUT', body: JSON.stringify({ person_ids: mergedIds }) });
    }
    const newEntry = await api('/api/calendar', {
      method: 'POST',
      body: JSON.stringify({
        task_id: first.task_id, person_id: newPersonId,
        date: first.date, start_time: first.start_time, end_time: first.end_time,
      }),
    });
    await loadTasks();
    await loadCalendar();
    renderAllDayRow();
    renderCalendarEntries();
    renderCalendarMobileList();
    pendingEntryGroup = [...pendingEntryGroup, newEntry];
    renderEntryMenuPeopleList();
    fillEntryMenuAddPersonSelect();
  });

  document.getElementById('entry-menu-move').addEventListener('click', () => {
    if (!pendingEntryGroup) return;
    const entry = pendingEntryGroup[0];
    closeEntryMenu();
    startTapSelection({ type: 'move', entryId: entry.id }, `${entry.task_title} (${entry.start_time.slice(0, 5)}–${entry.end_time.slice(0, 5)})`);
  });
  document.getElementById('entry-menu-edit-task').addEventListener('click', () => {
    if (!pendingEntryGroup) return;
    const taskId = pendingEntryGroup[0].task_id;
    closeEntryMenu();
    startEditTask(taskId);
  });
  document.getElementById('entry-menu-done').addEventListener('click', async () => {
    if (!pendingEntryGroup) return;
    await markTaskDone(pendingEntryGroup[0].task_id);
    closeEntryMenu();
  });
  document.getElementById('entry-menu-remove').addEventListener('click', async () => {
    if (!pendingEntryGroup) return;
    // Entfernt den gesamten Termin (alle zugeordneten Personen), nicht nur eine einzelne.
    await Promise.all(pendingEntryGroup.map(e => api(`/api/calendar/${e.id}`, { method: 'DELETE' })));
    closeEntryMenu();
    await loadCalendar();
    renderCalendarEntries();
    renderCalendarMobileList();
  });
  document.getElementById('entry-menu-remove-series').addEventListener('click', async () => {
    const withSeries = pendingEntryGroup && pendingEntryGroup.find(e => e.series_id);
    if (!withSeries) return;
    if (!confirm('Den gesamten mehrtägigen Termin (alle Tage) entfernen?')) return;
    await api(`/api/calendar/series/${withSeries.series_id}`, { method: 'DELETE' });
    closeEntryMenu();
    await loadCalendar();
    renderCalendarEntries();
    renderCalendarMobileList();
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
    await loadLifetimeBalances();
    document.getElementById('csv-export-link').href = '/api/time-entries/export.csv?' + params.toString();
  }

  document.getElementById('pdf-export-btn').addEventListener('click', () => {
    const personEl = document.getElementById('time-filter-person');
    const fromEl = document.getElementById('time-filter-from');
    const toEl = document.getElementById('time-filter-to');
    const personId = personEl.value;
    const from = fromEl.value;
    const to = toEl.value;
    if (!personId) { alert('Bitte oben eine konkrete Person auswählen (nicht "Alle").'); return; }
    if (!from && !to) { alert('Bitte oben Von- und Bis-Datum auswählen.'); return; }
    if (!from) { alert('Bitte oben das Von-Datum auswählen.'); fromEl.focus(); return; }
    if (!to) { alert('Bitte oben das Bis-Datum auswählen.'); toEl.focus(); return; }
    if (to < from) { alert('Das Bis-Datum liegt vor dem Von-Datum.'); return; }
    const params = new URLSearchParams({ person_id: personId, from, to });
    window.open('/api/reports/timesheet-pdf?' + params.toString(), '_blank');
  });

  // Kumulierte Ueber-/Unterstunden je Person laden (nur fuer Personen mit Wochensoll)
  async function loadLifetimeBalances() {
    const targets = currentUser.is_admin
      ? people.filter(p => p.weekly_target_minutes)
      : people.filter(p => p.weekly_target_minutes && p.id === currentUser.person_id);
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
    const warn = data.bfd_warning ? ` <span class="lifetime-balance negative">⚠ ${escapeHtml(data.bfd_warning)}</span>` : '';
    return ` <span class="lifetime-balance ${cls}">(gesamt ${sign}${fmtDuration(Math.abs(data.diff_minutes))})</span>${warn}`;
  }

  // Montag der ISO-Woche zu einem Datumsstring
  function mondayOfIso(dateIso) {
    return getMonday(new Date(dateIso));
  }

  function startEditTimeEntry(e) {
    if (e.running) { alert('Eine laufende Zeiterfassung kann hier nicht bearbeitet werden. Bitte zuerst über die Aufgabe stoppen.'); return; }
    editingTimeEntryId = e.id;
    document.getElementById('time-entry-id').value = e.id;
    document.getElementById('time-person').value = e.person_id;
    document.getElementById('time-date').value = e.date;
    document.getElementById('time-start').value = e.start_time ? e.start_time.slice(0, 5) : '';
    document.getElementById('time-end').value = e.end_time ? e.end_time.slice(0, 5) : '';
    document.getElementById('time-break-start').value = e.break_start ? e.break_start.slice(0, 5) : '';
    document.getElementById('time-break-end').value = e.break_end ? e.break_end.slice(0, 5) : '';
    editingTimeEntryTaskId = e.task_id || null;
    editingTimeEntryNote = e.note || null;
    timeSubmitBtn.textContent = 'Änderungen speichern';
    timeCancelBtn.classList.remove('hidden');
    document.getElementById('time-form-heading').textContent = 'Arbeitszeit bearbeiten';
    if (typeof timeForm.scrollIntoView === 'function') timeForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetTimeForm() {
    editingTimeEntryId = null;
    editingTimeEntryTaskId = null;
    editingTimeEntryNote = null;
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
    const payload = {
      person_id: personId,
      date: document.getElementById('time-date').value,
      start_time: document.getElementById('time-start').value || null,
      end_time: document.getElementById('time-end').value || null,
      break_start: document.getElementById('time-break-start').value || null,
      break_end: document.getElementById('time-break-end').value || null,
      task_id: editingTimeEntryTaskId,
      note: editingTimeEntryNote || '',
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
    const warnings = currentUser.is_admin ? data.warnings : data.warnings.filter(w => w.person_id === currentUser.person_id);
    if (!warnings.length) {
      container.innerHTML = '<p class="empty-state">Keine Überschreitungen erfasst.</p>';
      return;
    }
    container.innerHTML = warnings.map(w => `
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
    document.getElementById('absence-list-count').textContent = `Abwesenheiten (${absences.length})`;
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
  document.getElementById('absence-list-toggle').addEventListener('click', () => {
    const list = document.getElementById('absence-list');
    const chevron = document.getElementById('absence-list-chevron');
    const nowHidden = list.classList.toggle('hidden');
    chevron.classList.toggle('collapsed', nowHidden);
  });

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

  // ================= FREIZEITAUSGLEICH =================
  const timeoffForm = document.getElementById('timeoff-form');

  async function loadTimeOff() {
    const entries = await api('/api/time-off');
    const container = document.getElementById('timeoff-list');
    if (!entries.length) {
      container.innerHTML = '<p class="empty-state">Noch kein Freizeitausgleich erfasst.</p>';
      return;
    }
    container.innerHTML = entries.map(t => `
      <div class="time-row-item">
        <div>
          <div class="tri-main"><strong>${escapeHtml(t.person_name)}</strong> · ${fmtDateDE(t.date)}</div>
          <div class="tri-meta">${fmtDuration(t.minutes)}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
        </div>
        <div class="row-actions">
          <button class="danger" data-delete-timeoff="${t.id}">Löschen</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-delete-timeoff]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/time-off/${b.dataset.deleteTimeoff}`, { method: 'DELETE' });
      await loadTimeOff();
      await loadReport();
    }));
  }

  timeoffForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      person_id: +document.getElementById('timeoff-person').value,
      date: document.getElementById('timeoff-date').value,
      minutes: Math.round(+document.getElementById('timeoff-hours').value * 60),
      note: document.getElementById('timeoff-note').value.trim(),
    };
    if (!payload.person_id || !payload.date || !payload.minutes) return;
    await api('/api/time-off', { method: 'POST', body: JSON.stringify(payload) });
    timeoffForm.reset();
    await loadTimeOff();
    await loadReport();
  });

  // ================= WOCHENREPORT =================
  const OVERTIME_WARN_THRESHOLD_MINUTES = 60; // ab 1 Std Abweichung wird die Zeile als Warnung hervorgehoben

  const REPORT_WEEKS_PER_PAGE = 8;

  async function loadReport() {
    const weekStarts = [];
    for (let i = REPORT_WEEKS_PER_PAGE - 1; i >= 0; i--) weekStarts.push(addDays(reportWeekStart, -7 * i));
    const results = await Promise.all(weekStarts.map(ws => api('/api/reports/week?date=' + isoDate(ws))));

    document.getElementById('report-week-label').textContent =
      `${fmtDateLabel(new Date(results[0].from))} – ${fmtDateLabel(new Date(results[results.length - 1].to))}`;

    const rows = [];
    [...results].reverse().forEach(data => {
      const report = currentUser.is_admin ? data.report : data.report.filter(r => r.person_id === currentUser.person_id);
      report.forEach(r => rows.push({ ...r, weekFrom: data.from, weekTo: data.to }));
    });

    const container = document.getElementById('report-table');
    if (!rows.length) {
      container.innerHTML = '<tr><td colspan="5" class="empty-state">Keine Daten in diesem Zeitraum.</td></tr>';
      return;
    }
    container.innerHTML = rows.map(r => {
      const sign = r.diff_minutes > 0 ? '+' : (r.diff_minutes < 0 ? '-' : '');
      const diffText = r.diff_minutes === null ? '–' : sign + fmtDuration(Math.abs(r.diff_minutes));
      const diffClass = r.diff_minutes === null ? '' : (r.diff_minutes >= 0 ? 'diff-positive' : 'diff-negative');
      const isWarn = (r.diff_minutes !== null && Math.abs(r.diff_minutes) >= OVERTIME_WARN_THRESHOLD_MINUTES) || r.bfd_warning;
      const warnLabel = r.diff_minutes !== null && Math.abs(r.diff_minutes) >= OVERTIME_WARN_THRESHOLD_MINUTES
        ? (r.diff_minutes > 0 ? ' ⚠ Überstunden' : ' ⚠ Unterstunden') : '';
      return `
        <tr class="report-detail-row ${isWarn ? 'warn' : ''}" data-report-person="${r.person_id}" data-report-week="${r.weekFrom}">
          <td>${fmtDateLabel(new Date(r.weekFrom))} – ${fmtDateLabel(new Date(r.weekTo))}</td>
          <td>${escapeHtml(r.person_name)}</td>
          <td>${r.target_minutes ? fmtDuration(r.target_minutes) : '–'}</td>
          <td>${fmtDuration(r.actual_minutes)}</td>
          <td class="${diffClass}">${diffText}${warnLabel}${r.bfd_warning ? ` · ⚠ BFD: ${escapeHtml(r.bfd_warning)}` : ''}</td>
        </tr>
      `;
    }).join('');
    container.querySelectorAll('[data-report-person]').forEach(row => row.addEventListener('click', () =>
      openWeekDetailModal(+row.dataset.reportPerson, row.dataset.reportWeek)));
  }
  document.getElementById('report-week-prev').addEventListener('click', () => { reportWeekStart = addDays(reportWeekStart, -7 * REPORT_WEEKS_PER_PAGE); loadReport(); });
  document.getElementById('report-week-next').addEventListener('click', () => { reportWeekStart = addDays(reportWeekStart, 7 * REPORT_WEEKS_PER_PAGE); loadReport(); });

  const weekDetailModal = document.getElementById('week-detail-modal-overlay');
  async function openWeekDetailModal(personId, weekFromIso) {
    const data = await api(`/api/reports/week-detail?person_id=${personId}&date=${weekFromIso}`);
    document.getElementById('week-detail-modal-title').textContent =
      `${data.person_name} · ${fmtDateLabel(new Date(data.days[0].date))} – ${fmtDateLabel(new Date(data.days[6].date))}`;
    const total = data.days.reduce((sum, d) => sum + d.total_minutes, 0);

    document.getElementById('week-detail-modal-body').innerHTML = `
      <div class="yc-day-modal-list">
        ${data.days.map(d => {
          const dow = new Date(d.date).getDay();
          const dayName = DAY_NAMES[dow === 0 ? 6 : dow - 1];
          const entryRows = d.entries.length
            ? d.entries.map(e => {
                const timeText = e.start_time && e.end_time
                  ? `${e.start_time.slice(0, 5)}–${e.end_time.slice(0, 5)}`
                  : (e.running ? 'läuft noch' : '–');
                const breakText = e.break_start && e.break_end
                  ? ` · Pause ${e.break_start.slice(0, 5)}–${e.break_end.slice(0, 5)}`
                  : (e.break_minutes ? ` · Pause ${e.break_minutes} Min` : '');
                const taskText = e.task_title ? ` · ${escapeHtml(e.task_title)}` : '';
                return `
                  <div class="wd-entry-row">
                    <span>${timeText}${breakText}${taskText} ${e.duration_minutes ? `<strong>(${fmtDuration(e.duration_minutes)})</strong>` : ''}</span>
                    <span class="row-actions">
                      <button type="button" class="ghost" data-wd-edit="${e.id}">Bearbeiten</button>
                      <button type="button" class="danger" data-wd-delete="${e.id}">Löschen</button>
                    </span>
                  </div>
                `;
              }).join('')
            : '<div class="wd-entry-row wd-empty">Keine Einträge</div>';
          return `
            <div class="wd-day">
              <div class="wd-day-heading">${dayName}, ${fmtDateDE(d.date)} <strong>${d.total_minutes ? fmtDuration(d.total_minutes) : '–'}</strong></div>
              ${entryRows}
            </div>
          `;
        }).join('')}
        <div class="yc-day-event-row" style="border-color:var(--accent)">
          <span><strong>Summe der Woche</strong></span>
          <strong>${fmtDuration(total)}</strong>
        </div>
      </div>
    `;

    const allEntries = data.days.flatMap(d => d.entries);
    document.getElementById('week-detail-modal-body').querySelectorAll('[data-wd-edit]').forEach(b => b.addEventListener('click', () => {
      const entry = allEntries.find(e => e.id === +b.dataset.wdEdit);
      if (entry) { weekDetailModal.classList.add('hidden'); startEditTimeEntry(entry); }
    }));
    document.getElementById('week-detail-modal-body').querySelectorAll('[data-wd-delete]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Diesen Zeiteintrag wirklich löschen?')) return;
      await api(`/api/time-entries/${b.dataset.wdDelete}`, { method: 'DELETE' });
      await loadWarnings();
      await loadReport();
      await openWeekDetailModal(personId, weekFromIso);
    }));

    weekDetailModal.classList.remove('hidden');
  }
  document.getElementById('week-detail-modal-close').addEventListener('click', () => weekDetailModal.classList.add('hidden'));
  weekDetailModal.addEventListener('click', (e) => { if (e.target === weekDetailModal) weekDetailModal.classList.add('hidden'); });

  // ================= DASHBOARD =================
  // Projektuebergreifender "Dringend"-Bereich oben auf der Aufgaben-Seite: offene Aufgaben
  // mit hoher Prioritaet oder einem Termin innerhalb der naechsten 7 Tage, unabhaengig
  // davon, zu welchem Projekt sie gehoeren. Die projekt-gruppierte Tabelle bleibt unveraendert.
  function renderUrgentSection() {
    const soonIso = isoDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const openTasks = tasks.filter(t => t.status !== 'erledigt');
    const urgentUnsorted = openTasks.filter(t => t.priority === 'hoch' || (t.due_date && t.due_date <= soonIso));
    const urgent = sortByUrgency(urgentUnsorted);

    const card = document.getElementById('urgent-card');
    card.classList.toggle('hidden', urgent.length === 0);
    if (!urgent.length) return;
    document.getElementById('urgent-list').innerHTML = urgent.map(compactTaskRowHtml).join('');
    wireTaskRowClicks(document.getElementById('urgent-list'));
  }

  // ================= JAHRESKALENDER =================
  const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  let ycYear = new Date().getFullYear();
  let ycHalf = 'h1';
  let ycEvents = [];
  let ycExternalEvents = [];
  let ycSchoolHolidays = [];
  let ycPublicHolidays = [];
  let ycExternalCalendars = [];

  // Prueft beim Laden, ob dieses Fenster ueber den "andere Haelfte oeffnen"-Link
  // gestartet wurde, und stellt dann direkt auf den Jahreskalender + die passende Haelfte.
  function initYearCalendarFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('yc') === 'h2') {
      ycHalf = 'h2';
      const y = params.get('ycyear');
      if (y) ycYear = +y;
    }
  }

  async function loadYearCalendarData() {
    [ycEvents, ycExternalEvents, ycSchoolHolidays, ycPublicHolidays, ycExternalCalendars] = await Promise.all([
      api(`/api/year-events?year=${ycYear}`),
      api(`/api/external-calendar-events?year=${ycYear}`),
      api(`/api/school-holidays?year=${ycYear}`),
      api(`/api/public-holidays?year=${ycYear}`),
      api('/api/external-calendars'),
    ]);
  }

  // Regenbogenfarben je Monat (rein dekorativ für die Spaltenköpfe, angelehnt an
  // klassische Jahresplaner-Poster) - unabhaengig von den Projektfarben der Termine.
  const MONTH_COLORS = ['#3b82f6', '#0ea5e9', '#14b8a6', '#65c96f', '#a3d939', '#eab308', '#f97316', '#ef4444', '#ec4899', '#d946ef', '#a855f7', '#6366f1'];

  function isSchoolHoliday(dateIso) {
    return ycSchoolHolidays.some(h => dateIso >= h.from && dateIso <= h.to);
  }

  // Baut das Label fuer einen Jahreskalender-Termin inkl. Uhrzeit-Praefix, z.B. "18:00–20:00 Probe"
  function ycEventLabel(e) {
    if (e.start_time && e.end_time) return `${e.start_time.slice(0, 5)}–${e.end_time.slice(0, 5)} ${e.title}`;
    if (e.start_time) return `${e.start_time.slice(0, 5)} ${e.title}`;
    return e.title;
  }

  // Lineares Monats-Spalten-Layout (wie ein Wand-Jahresplaner): jede Spalte ist ein
  // Monat, jede Zeile ein Tag. Termine erscheinen als lesbarer Text direkt in der
  // Zeile (nicht nur als Punkt), damit man auf einen Blick sieht, was ansteht.
  const DOW_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

  function renderMonthColumnHtml(year, monthIndex) {
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const todayIso = isoDate(new Date());

    let rows = '';
    for (let d = 1; d <= daysInMonth; d++) {
      const dateIso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dow = new Date(year, monthIndex, d).getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isPublicHoliday = ycPublicHolidays.includes(dateIso);
      const isSchool = isSchoolHoliday(dateIso);
      const dayEvents = ycEvents.filter(e => e.date === dateIso);
      const dayExternal = ycExternalEvents.filter(e => e.date === dateIso);
      const allDayItems = [
        ...dayEvents.map(e => ({ title: ycEventLabel(e), color: e.project_color || '#8a8d90' })),
        ...dayExternal.map(e => ({ title: e.title, color: e.calendar_color })),
      ];
      const shown = allDayItems.slice(0, 3);
      const moreCount = allDayItems.length - shown.length;
      const chips = shown.map(it => `<span class="yc-event-chip" style="background:${it.color}" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>`).join('')
        + (moreCount > 0 ? `<span class="yc-event-more">+${moreCount} weitere</span>` : '');

      const classes = ['yc-day-row'];
      if (isWeekend) classes.push('yc-weekend');
      if (isSchool) classes.push('yc-school-holiday');
      if (isPublicHoliday) classes.push('yc-public-holiday');
      if (dateIso === todayIso) classes.push('yc-today');

      rows += `
        <div class="${classes.join(' ')}" data-yc-day="${dateIso}" title="${isPublicHoliday ? 'Feiertag' : ''}${isSchool ? ' Schulferien' : ''}">
          <span class="yc-day-num">${String(d).padStart(2, '0')} <span class="yc-day-dow">${DOW_SHORT[dow]}</span></span>
          <div class="yc-day-events">${chips}</div>
        </div>
      `;
    }

    return `
      <div class="yc-month-col">
        <div class="yc-month-col-header" style="background:${MONTH_COLORS[monthIndex]}">${MONTH_NAMES[monthIndex]}</div>
        ${rows}
      </div>
    `;
  }

  function isMobileViewport() { return window.innerWidth <= 820; }

  let ycMobileMonthsShown = 0;
  const YC_MOBILE_INITIAL_MONTHS = 3;
  const YC_MOBILE_LOAD_MORE = 2;

  async function renderYearCalendar() {
    document.getElementById('yc-year-label').textContent = ycYear;
    document.getElementById('yc-half-label').textContent = ycHalf === 'h1' ? 'Januar – Juni' : 'Juli – Dezember';
    await loadYearCalendarData();

    if (isMobileViewport()) {
      // App-Version: keine Jahreshaelften-Umschaltung, stattdessen alle 12 Monate des Jahres
      // fortlaufend untereinander, anfangs nur ein paar, weitere werden beim Runterscrollen
      // automatisch angehaengt (siehe setupYcInfiniteScroll).
      ycMobileMonthsShown = Math.min(YC_MOBILE_INITIAL_MONTHS, 12);
      renderYcMobileMonths();
    } else {
      const monthsRange = ycHalf === 'h1' ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
      document.getElementById('yc-months-grid').innerHTML = monthsRange.map(m => renderMonthColumnHtml(ycYear, m)).join('');
      document.querySelectorAll('[data-yc-day]').forEach(el => el.addEventListener('click', () => openYcDayModal(el.dataset.ycDay)));
    }

    renderYcExternalList();
    loadYcShareLink();
  }

  function renderYcMobileMonths() {
    const grid = document.getElementById('yc-months-grid');
    const monthsRange = Array.from({ length: ycMobileMonthsShown }, (_, i) => i);
    grid.innerHTML = monthsRange.map(m => renderMonthColumnHtml(ycYear, m)).join('');
    grid.querySelectorAll('[data-yc-day]').forEach(el => el.addEventListener('click', () => openYcDayModal(el.dataset.ycDay)));
  }

  // Laedt beim Runterscrollen weitere Monate des aktuellen Jahres nach (Endlos-Scroll-Gefuehl),
  // damit man auf dem Handy nicht erst umstaendlich zwischen Jahreshaelften wechseln muss.
  let ycScrollListenerAttached = false;
  function setupYcInfiniteScroll() {
    if (ycScrollListenerAttached) return;
    ycScrollListenerAttached = true;
    window.addEventListener('scroll', () => {
      if (!isMobileViewport()) return;
      if (!document.getElementById('tab-yearcalendar').classList.contains('active')) return;
      if (ycMobileMonthsShown >= 12) return;
      const scrollBottom = window.innerHeight + window.scrollY;
      if (scrollBottom >= document.body.scrollHeight - 400) {
        ycMobileMonthsShown = Math.min(ycMobileMonthsShown + YC_MOBILE_LOAD_MORE, 12);
        renderYcMobileMonths();
      }
    });
  }

  function renderYcExternalList() {
    const container = document.getElementById('yc-external-list');
    if (!ycExternalCalendars.length) {
      container.innerHTML = '<p class="empty-state">Noch keine externen Kalender abonniert.</p>';
      return;
    }
    container.innerHTML = ycExternalCalendars.map(c => `
      <div class="time-row-item">
        <div>
          <div class="tri-main"><span class="color-dot" style="background:${c.color}"></span> <strong>${escapeHtml(c.name)}</strong></div>
          <div class="tri-meta">${c.last_sync_error ? 'Fehler: ' + escapeHtml(c.last_sync_error) : c.last_synced_at ? 'Zuletzt aktualisiert: ' + c.last_synced_at : 'Noch nicht synchronisiert'}</div>
        </div>
        <div class="row-actions">
          <button class="ghost" data-sync-cal="${c.id}">Jetzt aktualisieren</button>
          <button class="danger" data-delete-cal="${c.id}">Löschen</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-sync-cal]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/api/external-calendars/${b.dataset.syncCal}/sync`, { method: 'POST' });
      } catch (err) { /* Fehler steht ohnehin in last_sync_error */ }
      await renderYearCalendar();
    }));
    container.querySelectorAll('[data-delete-cal]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Diesen abonnierten Kalender wirklich entfernen?')) return;
      await api(`/api/external-calendars/${b.dataset.deleteCal}`, { method: 'DELETE' });
      await renderYearCalendar();
    }));
  }

  const ycDayModal = document.getElementById('yc-day-modal-overlay');
  let ycSelectedDate = null;

  function openYcDayModal(dateIso) {
    ycSelectedDate = dateIso;
    document.getElementById('yc-day-modal-title').textContent = fmtDateDE(dateIso);
    const dayEvents = ycEvents.filter(e => e.date === dateIso);
    const dayExternal = ycExternalEvents.filter(e => e.date === dateIso);
    const body = document.getElementById('yc-day-modal-body');

    const notes = [];
    if (ycPublicHolidays.includes(dateIso)) notes.push('<div class="hint">Gesetzlicher Feiertag</div>');
    if (isSchoolHoliday(dateIso)) notes.push('<div class="hint">Schulferien (Baden-Württemberg)</div>');

    const rows = [
      ...dayEvents.map(e => `
        <div class="yc-day-event-row">
          <span><span class="color-dot" style="background:${e.project_color || '#8a8d90'}"></span> ${escapeHtml(ycEventLabel(e))}${e.project_name ? ' · ' + escapeHtml(e.project_name) : ''}</span>
          <span class="row-actions">
            <button type="button" class="danger" data-delete-yc-event="${e.id}">Löschen</button>
            ${e.recurrence_group ? `<button type="button" class="danger" data-delete-yc-group="${e.recurrence_group}">Ganze Serie löschen</button>` : ''}
          </span>
        </div>
      `),
      ...dayExternal.map(e => `
        <div class="yc-day-event-row">
          <span><span class="color-dot" style="background:${e.calendar_color}"></span> ${escapeHtml(e.title)} · <span class="task-meta">${escapeHtml(e.calendar_name)}</span></span>
        </div>
      `),
    ];

    body.innerHTML = notes.join('') + `<div class="yc-day-modal-list">${rows.length ? rows.join('') : '<p class="empty-state">Keine Termine an diesem Tag.</p>'}</div>`;

    body.querySelectorAll('[data-delete-yc-event]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Diesen Termin löschen?')) return;
      await api(`/api/year-events/${b.dataset.deleteYcEvent}`, { method: 'DELETE' });
      await renderYearCalendar();
      openYcDayModal(dateIso);
    }));
    body.querySelectorAll('[data-delete-yc-group]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Die komplette Wiederholungsserie löschen? Das entfernt alle Termine dieser Reihe, nicht nur diesen Tag.')) return;
      await api(`/api/year-events/group/${b.dataset.deleteYcGroup}`, { method: 'DELETE' });
      await renderYearCalendar();
      openYcDayModal(dateIso);
    }));

    ycDayModal.classList.remove('hidden');
  }

  function closeYcDayModal() {
    ycDayModal.classList.add('hidden');
    ycSelectedDate = null;
  }
  document.getElementById('yc-day-modal-close').addEventListener('click', closeYcDayModal);
  ycDayModal.addEventListener('click', (e) => { if (e.target === ycDayModal) closeYcDayModal(); });
  document.getElementById('yc-day-modal-add').addEventListener('click', () => {
    if (ycSelectedDate) document.getElementById('yc-event-date').value = ycSelectedDate;
    closeYcDayModal();
    document.getElementById('yc-event-title').focus();
  });

  document.getElementById('yc-event-recurrence').addEventListener('change', (e) => {
    document.getElementById('yc-event-until').classList.toggle('hidden', e.target.value === 'keine');
  });

  document.getElementById('yc-event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('yc-event-title').value.trim();
    const date = document.getElementById('yc-event-date').value;
    if (!title || !date) return;
    const projectVal = document.getElementById('yc-event-project').value;
    const recurrenceType = document.getElementById('yc-event-recurrence').value;
    const until = document.getElementById('yc-event-until').value;
    const endDate = document.getElementById('yc-event-end-date').value;
    if (endDate && endDate < date) { alert('Das Enddatum darf nicht vor dem Startdatum liegen.'); return; }
    const payload = {
      title, date, project_id: projectVal ? +projectVal : null,
      start_time: document.getElementById('yc-event-start-time').value || null,
      end_time: document.getElementById('yc-event-end-time').value || null,
    };
    if (endDate && endDate > date) {
      payload.end_date = endDate;
    } else if (recurrenceType !== 'keine' && until) {
      payload.recurrence = { type: recurrenceType, until };
    }
    await api('/api/year-events', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('yc-event-form').reset();
    setSearchableProjectValue('yc-event-project', '');
    document.getElementById('yc-event-until').classList.add('hidden');
    await renderYearCalendar();
  });

  document.getElementById('yc-external-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('yc-ext-name').value.trim();
    const ical_url = document.getElementById('yc-ext-url').value.trim();
    const color = document.getElementById('yc-ext-color').value;
    if (!name || !ical_url) return;
    try {
      await api('/api/external-calendars', { method: 'POST', body: JSON.stringify({ name, ical_url, color }) });
      document.getElementById('yc-external-form').reset();
      document.getElementById('yc-ext-color').value = '#8a8d90';
      await renderYearCalendar();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('yc-year-prev').addEventListener('click', () => { ycYear--; renderYearCalendar(); });
  document.getElementById('yc-year-next').addEventListener('click', () => { ycYear++; renderYearCalendar(); });

  async function loadYcShareLink() {
    const data = await api('/api/year-calendar/share-info');
    document.getElementById('yc-share-link').value = data.url;
  }
  document.getElementById('yc-share-copy').addEventListener('click', () => {
    const input = document.getElementById('yc-share-link');
    input.select();
    navigator.clipboard?.writeText(input.value).catch(() => {});
  });
  document.getElementById('yc-share-regenerate').addEventListener('click', async () => {
    if (!confirm('Neuen Link erzeugen? Der alte Link funktioniert danach nicht mehr — bereits eingebundene Kalender-Apps müssten neu verknüpft werden.')) return;
    const data = await api('/api/year-calendar/share-info/regenerate', { method: 'POST' });
    document.getElementById('yc-share-link').value = data.url;
  });

  document.getElementById('yc-open-other-half').addEventListener('click', (e) => {
    e.preventDefault();
    const otherHalf = ycHalf === 'h1' ? 'h2' : 'h1';
    window.open(`${window.location.pathname}?yc=${otherHalf}&ycyear=${ycYear}`, '_blank');
  });

  // Vollbild-Umschaltung fuer den gesamten Jahreskalender-Bereich, ueber die Fullscreen-API
  // des Browsers - nuetzlich, um mehr von den Monaten gleichzeitig zu sehen.
  const ycFullscreenBtn = document.getElementById('yc-fullscreen-btn');
  ycFullscreenBtn.addEventListener('click', () => {
    const section = document.getElementById('tab-yearcalendar');
    if (!document.fullscreenElement) {
      section.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = document.fullscreenElement === document.getElementById('tab-yearcalendar');
    ycFullscreenBtn.textContent = isFullscreen ? '✕ Vollbild verlassen' : '⛶ Vollbild';
  });

  // Beim allerersten Wechsel in den Jahreskalender (H1-Ansicht, einmal pro Browser-Sitzung)
  // automatisch ein zweites Browser-Tab mit der zweiten Jahreshaelfte oeffnen - gedacht zum
  // Rueberziehen auf einen zweiten Bildschirm fuer den vollen Jahresueberblick.
  function maybeAutoOpenSecondHalf() {
    if (ycHalf !== 'h1') return;
    if (sessionStorage.getItem('yc_second_half_opened')) return;
    sessionStorage.setItem('yc_second_half_opened', '1');
    window.open(`${window.location.pathname}?yc=h2&ycyear=${ycYear}`, '_blank');
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
        <div class="tri-main">${escapeHtml(u.username)}${u.person_name ? ` <span class="task-meta">(${escapeHtml(u.person_name)})</span>` : ' <span class="task-meta">(Admin)</span>'}</div>
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
    const personSelect = document.getElementById('new-user-person');
    personSelect.innerHTML = '<option value="">— keine (Admin, uneingeschränkt) —</option>' +
      people.filter(p => p.active).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    usersError.classList.add('hidden');
    usersModal.classList.remove('hidden');
    await loadUsers();
  });
  document.getElementById('users-modal-close').addEventListener('click', () => usersModal.classList.add('hidden'));
  usersModal.addEventListener('click', (e) => { if (e.target === usersModal) usersModal.classList.add('hidden'); });
  document.getElementById('users-add-confirm').addEventListener('click', async () => {
    const username = document.getElementById('new-user-username').value.trim();
    const password = document.getElementById('new-user-password').value;
    const personVal = document.getElementById('new-user-person').value;
    usersError.classList.add('hidden');
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, person_id: personVal ? +personVal : null }) });
      document.getElementById('new-user-username').value = '';
      document.getElementById('new-user-password').value = '';
      document.getElementById('new-user-person').value = '';
      await loadUsers();
    } catch (err) {
      usersError.textContent = err.message;
      usersError.classList.remove('hidden');
    }
  });

  // ---------- Backup ----------
  document.getElementById('backup-now-btn').addEventListener('click', async (e) => {
    accountDropdown.classList.add('hidden');
    const btn = e.currentTarget;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sichert …';
    try {
      const result = await api('/api/backup/run', { method: 'POST' });
      if (result.skipped) {
        alert('Backup übersprungen: ' + result.message + '\n\nDropbox ist noch nicht eingerichtet (siehe README).');
      } else if (result.ok) {
        alert('Backup erfolgreich erstellt.');
      } else {
        alert('Backup fehlgeschlagen: ' + result.message);
      }
    } catch (err) {
      alert('Backup fehlgeschlagen: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  let currentUser = { username: null, person_id: null, person_name: null, is_admin: true };

  async function loadAccount() {
    try {
      const me = await api('/api/me');
      currentUser = me;
      document.getElementById('account-username').textContent = me.username;
      applyRoleRestrictions();
    } catch (e) { /* Redirect passiert bereits in api() bei 401 */ }
  }

  // Nicht-Admin-Logins (an eine Person gebunden) duerfen in der Zeiterfassung nur die
  // eigene Person sehen/bearbeiten (serverseitig ohnehin erzwungen); hier wird das
  // Frontend passend eingeschraenkt, damit gar nicht erst versucht wird, andere
  // auszuwaehlen. In Aufgaben/Kalender/Dashboard liegt nur der Fokus auf der eigenen
  // Person (voreingestellter Filter), der Rest bleibt einsehbar.
  function applyRoleRestrictions() {
    if (currentUser.is_admin) return;

    ['time-person', 'time-filter-person', 'timeoff-person'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<option value="${currentUser.person_id}">${escapeHtml(currentUser.person_name || '')}</option>`;
      el.disabled = true;
    });

    // Fokus auf eigene Person im Aufgaben-Filter (bleibt umschaltbar)
    const taskPersonFilter = document.getElementById('task-filter-person');
    if (taskPersonFilter) {
      taskPersonFilter.value = String(currentUser.person_id);
      taskFilters.person = String(currentUser.person_id);
    }
  }

  // ---------- Init ----------
  // ================= VERTRAEGE =================
  let contractEvents = [];
  let currentContractDetail = null;
  let contractEditingItemId = null;

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function loadContractEvents() {
    contractEvents = await api('/api/contract-events');
    const open = contractEvents.filter(e => e.status !== 'erledigt');
    const done = contractEvents.filter(e => e.status === 'erledigt');
    document.getElementById('contract-events-list').innerHTML = open.length
      ? open.map(contractEventCardHtml).join('')
      : '<p class="empty-state">Noch keine Veranstaltungen angelegt.</p>';
    document.getElementById('contract-done-card').classList.toggle('hidden', done.length === 0);
    document.getElementById('contract-done-count').textContent = `Erledigte Veranstaltungen (${done.length})`;
    document.getElementById('contract-done-list').innerHTML = done.map(contractEventCardHtml).join('');
    document.querySelectorAll('.contract-event-card').forEach(card => {
      card.addEventListener('click', () => openContractDetail(+card.dataset.eventId));
    });
  }

  function contractEventCardHtml(e) {
    const doneClass = e.status === 'erledigt' ? 'contract-event-card-done' : '';
    const progress = e.items_total ? `${e.items_done}/${e.items_total} Punkte erledigt` : 'Noch keine Punkte';
    return `
      <div class="contract-event-card ${doneClass}" data-event-id="${e.id}">
        <div class="cec-title">${escapeHtml(e.title)}</div>
        <div class="cec-meta">${fmtDateDE(e.date)}${e.location ? ' · ' + escapeHtml(e.location) : ''}</div>
        <div class="cec-progress">${progress}</div>
      </div>
    `;
  }

  document.getElementById('contract-done-toggle').addEventListener('click', () => {
    const list = document.getElementById('contract-done-list');
    const chevron = document.getElementById('contract-done-chevron');
    const nowHidden = list.classList.toggle('hidden');
    chevron.classList.toggle('collapsed', nowHidden);
  });

  // ---- Neue Veranstaltung ----
  const contractNewOverlay = document.getElementById('contract-new-modal-overlay');
  document.getElementById('contract-new-btn').addEventListener('click', () => {
    document.getElementById('contract-new-form').reset();
    contractNewOverlay.classList.remove('hidden');
  });
  document.getElementById('contract-new-cancel').addEventListener('click', () => contractNewOverlay.classList.add('hidden'));
  contractNewOverlay.addEventListener('click', (e) => { if (e.target === contractNewOverlay) contractNewOverlay.classList.add('hidden'); });

  document.getElementById('contract-new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('contract-new-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Wird angelegt...';
    try {
      const payload = {
        title: document.getElementById('ce-title').value.trim(),
        date: document.getElementById('ce-date').value,
        time: document.getElementById('ce-time').value || null,
        location: document.getElementById('ce-location').value.trim() || null,
        notes: document.getElementById('ce-notes').value.trim() || null,
      };
      if (!payload.title || !payload.date) return;
      const event = await api('/api/contract-events', { method: 'POST', body: JSON.stringify(payload) });

      const fileFields = [
        { id: 'ce-file-miet', category: 'Mietvertrag' },
        { id: 'ce-file-gastspiel', category: 'Gastspielvertrag' },
        { id: 'ce-file-sonstige', category: 'Sonstiges' },
      ];
      for (const f of fileFields) {
        const input = document.getElementById(f.id);
        if (input.files && input.files[0]) {
          try {
            const base64 = await fileToBase64(input.files[0]);
            await api(`/api/contract-events/${event.id}/files`, {
              method: 'POST',
              body: JSON.stringify({ category: f.category, filename: input.files[0].name, file_base64: base64 }),
            });
          } catch (err) {
            alert(`Upload "${f.category}" fehlgeschlagen: ${err.message}`);
          }
        }
      }
      contractNewOverlay.classList.add('hidden');
      await loadContractEvents();
      await openContractDetail(event.id);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Anlegen';
    }
  });

  // ---- Detail + Vertraege ----
  const contractDetailOverlay = document.getElementById('contract-detail-overlay');

  async function openContractDetail(eventId) {
    currentContractDetail = await api(`/api/contract-events/${eventId}`);
    renderContractDetail();
    contractDetailOverlay.classList.remove('hidden');
  }

  function renderContractDetail() {
    const e = currentContractDetail;
    document.getElementById('contract-detail-title').textContent = e.title;
    const metaParts = [fmtDateDE(e.date)];
    if (e.time) metaParts.push(e.time.slice(0, 5) + ' Uhr');
    if (e.location) metaParts.push(escapeHtml(e.location));
    document.getElementById('contract-detail-meta').innerHTML =
      metaParts.join(' · ') + (e.notes ? `<p class="hint">${escapeHtml(e.notes)}</p>` : '');

    const filesList = document.getElementById('contract-detail-files-list');
    filesList.innerHTML = e.files.length
      ? e.files.map(f => `
          <div class="contract-file-row">
            <span>${escapeHtml(f.category)}: ${escapeHtml(f.filename)}</span>
            <button type="button" class="danger" data-delete-file="${f.id}">Entfernen</button>
          </div>
        `).join('')
      : '<p class="empty-state">Noch keine Verträge hochgeladen.</p>';
    filesList.querySelectorAll('[data-delete-file]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Diesen Vertrag entfernen?')) return;
      await api(`/api/contract-events/${e.id}/files/${btn.dataset.deleteFile}`, { method: 'DELETE' });
      currentContractDetail = await api(`/api/contract-events/${e.id}`);
      renderContractDetail();
    }));

    renderContractFlowchart(e);
  }

  document.getElementById('contract-detail-close').addEventListener('click', async () => {
    contractDetailOverlay.classList.add('hidden');
    await loadContractEvents();
  });
  contractDetailOverlay.addEventListener('click', async (e) => {
    if (e.target === contractDetailOverlay) { contractDetailOverlay.classList.add('hidden'); await loadContractEvents(); }
  });

  document.getElementById('contract-add-file-btn').addEventListener('click', async () => {
    const input = document.getElementById('contract-add-file-input');
    const category = document.getElementById('contract-add-file-category').value;
    if (!input.files || !input.files[0]) { alert('Bitte eine Datei auswählen.'); return; }
    try {
      const base64 = await fileToBase64(input.files[0]);
      await api(`/api/contract-events/${currentContractDetail.id}/files`, {
        method: 'POST',
        body: JSON.stringify({ category, filename: input.files[0].name, file_base64: base64 }),
      });
      input.value = '';
      currentContractDetail = await api(`/api/contract-events/${currentContractDetail.id}`);
      renderContractDetail();
    } catch (err) {
      alert('Upload fehlgeschlagen: ' + err.message);
    }
  });

  document.getElementById('contract-analyze-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('contract-analyze-status');
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Claude analysiert den Vertrag …';
    try {
      const data = await api(`/api/contract-events/${currentContractDetail.id}/analyze`, { method: 'POST', body: JSON.stringify({}) });
      if (data.skipped && data.skipped.length) {
        statusEl.textContent = 'Nicht gelesen (Download fehlgeschlagen): ' + data.skipped.join(', ');
      } else {
        statusEl.classList.add('hidden');
      }
      openContractSuggestions(data.suggestions);
    } catch (err) {
      statusEl.textContent = 'Fehler: ' + err.message;
    }
  });

  // ---- KI-Vorschlaege pruefen ----
  const contractSuggestionsOverlay = document.getElementById('contract-suggestions-overlay');
  let contractSuggestions = [];
  function openContractSuggestions(suggestions) {
    if (!suggestions.length) { alert('Claude konnte keine konkreten Punkte aus dem Vertrag ableiten.'); return; }
    contractSuggestions = suggestions;
    const personOptions = people.filter(p => p.active).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    document.getElementById('contract-suggestions-list').innerHTML = suggestions.map((s, i) => `
      <div class="contract-suggestion-row">
        <div class="yc-day-event-row">
          <input type="checkbox" class="cs-include" data-idx="${i}" checked>
          <input type="text" class="cs-title" data-idx="${i}" value="${escapeHtml(s.title)}">
          <input type="date" class="cs-date" data-idx="${i}" value="${s.date}">
          <select class="cs-person" data-idx="${i}"><option value="">— niemand —</option>${personOptions}</select>
        </div>
        ${renderContractSource(s.rule, s.quote, s.source_file)}
      </div>
    `).join('');
    contractSuggestionsOverlay.classList.remove('hidden');
  }
  document.getElementById('contract-suggestions-cancel').addEventListener('click', () => contractSuggestionsOverlay.classList.add('hidden'));
  document.getElementById('contract-suggestions-apply').addEventListener('click', async () => {
    const checkboxes = [...document.querySelectorAll('.cs-include')];
    for (const cb of checkboxes) {
      if (!cb.checked) continue;
      const idx = cb.dataset.idx;
      const title = document.querySelector(`.cs-title[data-idx="${idx}"]`).value.trim();
      const date = document.querySelector(`.cs-date[data-idx="${idx}"]`).value;
      const personVal = document.querySelector(`.cs-person[data-idx="${idx}"]`).value;
      if (!title || !date) continue;
      const s = contractSuggestions[idx];
      await api(`/api/contract-events/${currentContractDetail.id}/items`, {
        method: 'POST',
        body: JSON.stringify({
          title, date, person_id: personVal ? +personVal : null,
          source_quote: s.quote, source_file: s.source_file, source_rule: s.rule,
        }),
      });
    }
    contractSuggestionsOverlay.classList.add('hidden');
    currentContractDetail = await api(`/api/contract-events/${currentContractDetail.id}`);
    renderContractDetail();
    await loadTasks();
  });

  // Frist-Regel und woertliche Vertragspassage, aus der ein Punkt abgeleitet wurde.
  function renderContractSource(rule, quote, file) {
    if (!rule && !quote) return '';
    return `<div class="contract-source">
      ${rule ? `<div class="contract-source-rule">⏱ ${escapeHtml(rule)}</div>` : ''}
      ${quote
        ? `<blockquote class="contract-source-quote">„${escapeHtml(quote)}“</blockquote>${file ? `<div class="contract-source-file">📄 ${escapeHtml(file)}</div>` : ''}`
        : '<div class="contract-source-file">Steht nicht im Vertrag – Standard-Vorschlag</div>'}
    </div>`;
  }

  // ---- Flowchart rendern: chronologische Kette verbundener Kaestchen, Veranstaltung als
  // eigener Knoten an ihrer zeitlichen Position dazwischen einsortiert. ----
  function renderContractFlowchart(event) {
    const container = document.getElementById('contract-flowchart');
    const items = [...event.items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const nodes = [];
    let eventInserted = false;
    items.forEach(it => {
      if (!eventInserted && it.date >= event.date) {
        nodes.push({ type: 'event' });
        eventInserted = true;
      }
      nodes.push({ type: 'item', item: it });
    });
    if (!eventInserted) nodes.push({ type: 'event' });

    if (!items.length) {
      container.innerHTML = `
        <div class="fc-node fc-node-event">
          <div class="fc-node-date">${fmtDateDE(event.date)}</div>
          <div class="fc-node-title">🎪 ${escapeHtml(event.title)}</div>
        </div>
        <p class="empty-state">Noch keine Punkte im Ablauf — mit KI analysieren oder manuell hinzufügen.</p>
      `;
      return;
    }

    container.innerHTML = nodes.map((n, i) => {
      const connector = i > 0 ? '<div class="fc-connector"><div class="fc-connector-line"></div><div class="fc-connector-arrow">▼</div></div>' : '';
      if (n.type === 'event') {
        return `${connector}<div class="fc-node fc-node-event">
          <div class="fc-node-date">${fmtDateDE(event.date)}</div>
          <div class="fc-node-title">🎪 ${escapeHtml(event.title)}</div>
          ${event.location ? `<div class="fc-node-person">${escapeHtml(event.location)}</div>` : ''}
        </div>`;
      }
      const it = n.item;
      const doneClass = it.status === 'erledigt' ? 'fc-node-done' : '';
      return `${connector}<div class="fc-node ${doneClass}" data-item-id="${it.id}">
        <label class="fc-node-check-wrap"><input type="checkbox" class="fc-node-check" data-item-id="${it.id}" ${it.status === 'erledigt' ? 'checked' : ''}></label>
        <div class="fc-node-date">${fmtDateDE(it.date)}</div>
        <div class="fc-node-title">${escapeHtml(it.title)}</div>
        <div class="fc-node-person">${it.person_name ? escapeHtml(it.person_name) : '— niemand zugewiesen'}</div>
        ${it.source_rule ? `<div class="fc-node-source">⏱ ${escapeHtml(it.source_rule)}</div>` : ''}
      </div>`;
    }).join('');

    container.querySelectorAll('.fc-node-check').forEach(cb => {
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', async () => {
        await api(`/api/contract-events/${event.id}/items/${cb.dataset.itemId}`, {
          method: 'PUT', body: JSON.stringify({ status: cb.checked ? 'erledigt' : 'offen' }),
        });
        currentContractDetail = await api(`/api/contract-events/${event.id}`);
        renderContractDetail();
        await loadTasks();
      });
    });
    container.querySelectorAll('.fc-node[data-item-id]').forEach(node => {
      node.addEventListener('click', () => openContractItemModal(+node.dataset.itemId));
    });
  }

  // ---- Punkt manuell anlegen/bearbeiten ----
  const contractItemOverlay = document.getElementById('contract-item-modal-overlay');
  function fillContractItemPersonSelect() {
    const sel = document.getElementById('ci-person');
    sel.innerHTML = '<option value="">— niemand —</option>' +
      people.filter(p => p.active).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  }
  document.getElementById('contract-add-item-btn').addEventListener('click', () => {
    contractEditingItemId = null;
    fillContractItemPersonSelect();
    document.getElementById('contract-item-form').reset();
    document.getElementById('ci-date').value = currentContractDetail.date;
    document.getElementById('ci-source').classList.add('hidden');
    document.getElementById('contract-item-modal-heading').textContent = 'Punkt hinzufügen';
    document.getElementById('contract-item-delete').classList.add('hidden');
    contractItemOverlay.classList.remove('hidden');
  });
  function openContractItemModal(itemId) {
    const item = currentContractDetail.items.find(i => i.id === itemId);
    if (!item) return;
    contractEditingItemId = itemId;
    fillContractItemPersonSelect();
    document.getElementById('ci-title').value = item.title;
    document.getElementById('ci-date').value = item.date;
    document.getElementById('ci-person').value = item.person_id || '';
    const sourceEl = document.getElementById('ci-source');
    sourceEl.innerHTML = renderContractSource(item.source_rule, item.source_quote, item.source_file);
    sourceEl.classList.toggle('hidden', !sourceEl.innerHTML);
    document.getElementById('contract-item-modal-heading').textContent = 'Punkt bearbeiten';
    document.getElementById('contract-item-delete').classList.remove('hidden');
    contractItemOverlay.classList.remove('hidden');
  }
  document.getElementById('contract-item-cancel').addEventListener('click', () => contractItemOverlay.classList.add('hidden'));
  document.getElementById('contract-item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      title: document.getElementById('ci-title').value.trim(),
      date: document.getElementById('ci-date').value,
      person_id: document.getElementById('ci-person').value ? +document.getElementById('ci-person').value : null,
    };
    if (!payload.title || !payload.date) return;
    if (contractEditingItemId) {
      await api(`/api/contract-events/${currentContractDetail.id}/items/${contractEditingItemId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api(`/api/contract-events/${currentContractDetail.id}/items`, { method: 'POST', body: JSON.stringify(payload) });
    }
    contractItemOverlay.classList.add('hidden');
    currentContractDetail = await api(`/api/contract-events/${currentContractDetail.id}`);
    renderContractDetail();
    await loadTasks();
  });
  document.getElementById('contract-item-delete').addEventListener('click', async () => {
    if (!contractEditingItemId || !confirm('Diesen Punkt (und die verknüpfte Aufgabe) löschen?')) return;
    await api(`/api/contract-events/${currentContractDetail.id}/items/${contractEditingItemId}`, { method: 'DELETE' });
    contractItemOverlay.classList.add('hidden');
    currentContractDetail = await api(`/api/contract-events/${currentContractDetail.id}`);
    renderContractDetail();
    await loadTasks();
  });

  async function init() {
    // Manche Browser stellen einen zuvor in dieses Feld eingegebenen Wert beim Neuladen
    // der Seite automatisch wieder her, unabhaengig von autocomplete="off" - deshalb hier
    // aktiv leeren.
    document.getElementById('task-filter-search').value = '';
    document.getElementById('absence-from').value = isoDate(new Date());
    document.getElementById('absence-to').value = isoDate(new Date());
    document.getElementById('timeoff-date').value = isoDate(new Date());
    document.getElementById('yc-event-date').value = isoDate(new Date());
    setupPoolOtherDropTarget();
    setupUrgentReorder();
    setupYcInfiniteScroll();
    resetPersonForm();
    resetTimeForm();
    initYearCalendarFromUrl();
    await loadAccount();
    await loadPeople();
    await loadToolStartDate();
    await loadProjects();
    await loadActiveTimers();
    await loadTasks();
    await loadTimeEntries();
    await loadWarnings();
    applyRoleRestrictions();
    if (ycHalf === 'h2') {
      document.querySelector('[data-tab="yearcalendar"]').click();
    }
  }
  init();
})();
