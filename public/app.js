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
  // Reihenfolge fuer die mobile Bottom-Navigation (die ersten 4 freigegebenen, Rest unter "Mehr").
  const MOBILE_TAB_ORDER = ['tasks', 'timetracking', 'nk_projects', 'nk_polls', 'calendar', 'yearcalendar', 'contracts', 'people'];
  const MOBILE_LABELS = {
    tasks: 'Aufgaben', calendar: 'Woche', people: 'Personen', timetracking: 'Zeit',
    yearcalendar: 'Jahr', contracts: 'Verträge', nk_polls: 'Termine', nk_projects: 'Konzerte',
  };
  let activeTab = null;

  function can(tab) { return !currentUser.tabs || currentUser.tabs.includes(tab); }

  function sidebarBtn(tab) { return document.querySelector(`.sidebar .tab-btn[data-tab="${tab}"]`); }

  function switchTab(tab, opts = {}) {
    if (!document.getElementById('tab-' + tab)) return;
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const moreBtn = document.getElementById('bottom-nav-more');
    if (moreBtn) moreBtn.classList.toggle('active', !document.querySelector(`#bottom-nav .tab-btn[data-tab="${tab}"]`));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    const src = sidebarBtn(tab);
    document.getElementById('page-title').textContent = src ? (src.dataset.title || src.textContent.trim()) : '';
    const kicker = document.getElementById('page-kicker');
    kicker.textContent = (src && src.dataset.group) || '';
    kicker.classList.toggle('hidden', !(src && src.dataset.group));
    try { localStorage.setItem('office_last_tab', tab); } catch (e) { /* egal */ }
    if (!opts.noScroll) window.scrollTo({ top: 0 });
    if (tab === 'calendar') renderCalendar();
    if (tab === 'timetracking') { loadReport(); loadAbsences(); loadWarnings(); loadTimeOff(); }
    if (tab === 'yearcalendar') { renderYearCalendar(); if (!opts.restore) maybeAutoOpenSecondHalf(); }
    if (tab === 'contracts') { loadContractEvents(); }
    if (tab === 'nk_polls') { showNkPollList(); loadNkPolls(); }
    if (tab === 'nk_projects') { showNkConcertList(); loadNkConcerts(); }
  }

  document.querySelectorAll('.sidebar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Blendet nicht freigegebene Reiter aus und baut die mobile Navigation passend auf.
  function applyTabPermissions() {
    document.querySelectorAll('.sidebar .tab-btn').forEach(btn => btn.classList.toggle('hidden', !can(btn.dataset.tab)));
    const anyNk = can('nk_polls') || can('nk_projects');
    document.getElementById('nk-section-label').classList.toggle('hidden', !anyNk);
    const anyMain = LEGACY_TABS.some(can);
    document.querySelector('.sidebar-section-label').classList.toggle('hidden', !anyMain);

    const allowed = MOBILE_TAB_ORDER.filter(can);
    const primary = allowed.length > 5 ? allowed.slice(0, 4) : allowed;
    const overflow = allowed.filter(t => !primary.includes(t));
    const nav = document.getElementById('bottom-nav');
    nav.innerHTML = primary.map(t => {
      const icon = sidebarBtn(t).querySelector('svg').outerHTML;
      return `<button class="tab-btn" data-tab="${t}">${icon}<span>${MOBILE_LABELS[t]}</span><span class="nav-badge hidden" data-badge="${t}"></span></button>`;
    }).join('') + (overflow.length ? `
      <button class="more-btn" id="bottom-nav-more" type="button">
        <svg class="tab-icon" viewBox="0 0 20 20" fill="none"><circle cx="5" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="10" r="1.6" fill="currentColor"/></svg>
        <span>Mehr</span><span class="nav-badge hidden" data-badge="more"></span>
      </button>` : '');
    nav.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    const moreBtn = document.getElementById('bottom-nav-more');
    if (moreBtn) moreBtn.addEventListener('click', () => openMoreSheet(allowed));
  }

  const LEGACY_TABS = ['tasks', 'calendar', 'people', 'timetracking', 'yearcalendar', 'contracts'];

  const moreSheet = document.getElementById('more-sheet-overlay');
  function openMoreSheet(allowed) {
    const list = document.getElementById('more-sheet-list');
    list.innerHTML = allowed.map(t => {
      const src = sidebarBtn(t);
      return `<button type="button" class="more-sheet-item ${t === activeTab ? 'active' : ''}" data-sheet-tab="${t}">
        ${src.querySelector('svg').outerHTML}<span>${escapeHtml(src.dataset.title)}</span>
        ${src.dataset.group ? `<span class="more-sheet-group">${escapeHtml(src.dataset.group)}</span>` : ''}
      </button>`;
    }).join('');
    list.querySelectorAll('[data-sheet-tab]').forEach(b => b.addEventListener('click', () => {
      moreSheet.classList.add('hidden');
      switchTab(b.dataset.sheetTab);
    }));
    moreSheet.classList.remove('hidden');
  }
  moreSheet.addEventListener('click', (e) => { if (e.target === moreSheet) moreSheet.classList.add('hidden'); });

  // Kleine Zaehler an den Reitern (ungelesene Kommentare, offene Umfragen ohne eigene Antwort)
  async function refreshNkBadges() {
    if (!can('nk_polls') && !can('nk_projects')) return;
    let data;
    try { data = await api('/api/nk/summary'); } catch (e) { return; }
    const set = (key, n) => document.querySelectorAll(`[data-badge="${key}"]`).forEach(el => {
      el.textContent = n > 99 ? '99+' : String(n);
      el.classList.toggle('hidden', !n);
    });
    set('nk_polls', data.open_polls);
    set('nk_projects', data.unread_comments);
    const moreBtn = document.getElementById('bottom-nav-more');
    if (moreBtn) {
      const hiddenCount = ['nk_polls', 'nk_projects']
        .filter(t => can(t) && !document.querySelector(`#bottom-nav .tab-btn[data-tab="${t}"]`))
        .reduce((sum, t) => sum + (t === 'nk_polls' ? data.open_polls : data.unread_comments), 0);
      set('more', hiddenCount);
    }
  }

  // ================= PEOPLE =================
  const personForm = document.getElementById('person-form');
  const personNameInput = document.getElementById('person-name');
  const personShortCodeInput = document.getElementById('person-short-code');
  // Kuerzel automatisch aus dem Namen vorschlagen, solange es nicht selbst angepasst wurde
  let shortCodeTouched = false;
  personShortCodeInput.addEventListener('input', () => { shortCodeTouched = true; personShortCodeInput.value = personShortCodeInput.value.toUpperCase(); });
  personNameInput.addEventListener('input', () => {
    if (!shortCodeTouched && !editingPersonId) personShortCodeInput.value = personNameInput.value.trim() ? initials(personNameInput.value) : '';
  });
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
          <span class="task-avatar person-avatar" style="background:${p.color}">${escapeHtml(personShort(p))}</span>
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
    personShortCodeInput.value = p.short_code || '';
    shortCodeTouched = true;
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
    shortCodeTouched = false;
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
      short_code: personShortCodeInput.value.trim(),
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
    await loadAccount(); // Kuerzel/Name im Konto-Button aktualisieren
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
    const timeTrackingOptionsHtml = meFirst.map(p => `<option value="${p.id}">${escapeHtml(personLabel(p))}${p.id === currentUser.person_id ? ' (ich)' : ''}</option>`).join('');

    document.getElementById('time-person').innerHTML = timeTrackingOptionsHtml;
    document.getElementById('absence-person').innerHTML = timeTrackingOptionsHtml;
    document.getElementById('timeoff-person').innerHTML = timeTrackingOptionsHtml;
    document.getElementById('time-filter-person').innerHTML = '<option value="">Alle</option>' + timeTrackingOptionsHtml;
    if (currentUser.person_id) {
      ['time-person', 'absence-person', 'timeoff-person'].forEach(id => { document.getElementById(id).value = String(currentUser.person_id); });
    }
    renderTimeMeChip();
    document.getElementById('task-filter-person').innerHTML = '<option value="">Alle Personen</option>' + optionsHtml;
    document.getElementById('qa-person').innerHTML = '<option value="">Zuständig</option>' + optionsHtml;
  }

  // Zeigt in der Zeiterfassung, fuer wen gerade eingetragen wird - standardmaessig die
  // eingeloggte Person (Verknuepfung Konto <-> Person in der Benutzerverwaltung).
  function renderTimeMeChip() {
    const chip = document.getElementById('time-me-chip');
    const me = people.find(p => p.id === currentUser.person_id);
    if (!me) {
      chip.innerHTML = currentUser.is_admin
        ? '<span class="me-chip-text">Dein Konto ist noch mit keiner Person verknüpft – unter <strong>Konto → Benutzer &amp; Freigaben</strong> zuordnen, dann bist du hier automatisch vorausgewählt.</span>'
        : '';
      chip.classList.toggle('hidden', !currentUser.is_admin);
      chip.classList.add('me-chip-warn');
      return;
    }
    chip.classList.remove('hidden', 'me-chip-warn');
    const selectedId = +document.getElementById('time-person').value;
    const selected = people.find(p => p.id === selectedId) || me;
    const isMe = selected.id === me.id;
    chip.innerHTML = `
      <span class="task-avatar" style="background:${selected.color}">${escapeHtml(personShort(selected))}</span>
      <span class="me-chip-text">Erfasst für <strong>${escapeHtml(selected.name)}</strong>${isMe ? ' <span class="me-tag">das bist du</span>' : ''}</span>
      ${!isMe ? '<button type="button" class="ghost" id="time-me-reset">Zurück zu mir</button>' : ''}
    `;
    const resetBtn = document.getElementById('time-me-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      document.getElementById('time-person').value = String(me.id);
      renderTimeMeChip();
    });
  }
  document.getElementById('time-person').addEventListener('change', renderTimeMeChip);

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
  // Kuerzel einer Person: hinterlegtes Kuerzel (z.B. "MR"), sonst Initialen
  function personShort(p) { return (p && p.short_code) || initials((p && p.name) || '?'); }
  function personLabel(p) { return p.short_code ? `${p.short_code} · ${p.name}` : p.name; }
  function avatarHtml(d, extraClass = '') {
    return `<span class="user-avatar ${extraClass}" style="background:${d.color}" title="${escapeHtml(d.name)}">${escapeHtml(d.short)}</span>`;
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
      ? `<div class="task-assignee"><span class="task-avatar" style="background:${t.people[0].color}">${escapeHtml(personShort(t.people[0]))}</span>
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
    renderTimeMeChip();
    if (typeof timeForm.scrollIntoView === 'function') timeForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetTimeForm() {
    editingTimeEntryId = null;
    editingTimeEntryTaskId = null;
    editingTimeEntryNote = null;
    timeForm.reset();
    if (currentUser.person_id && people.some(p => p.id === currentUser.person_id && p.active)) {
      document.getElementById('time-person').value = String(currentUser.person_id);
    }
    document.getElementById('time-date').value = isoDate(new Date());
    timeSubmitBtn.textContent = 'Eintragen';
    timeCancelBtn.classList.add('hidden');
    document.getElementById('time-form-heading').textContent = 'Arbeitszeit eintragen';
    renderTimeMeChip();
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
    if (currentUser.person_id) document.getElementById('absence-person').value = String(currentUser.person_id);
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
    if (currentUser.person_id) document.getElementById('timeoff-person').value = String(currentUser.person_id);
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
  let ycContractEvents = [];
  let ycNkConcerts = [];
  const NK_CONCERT_COLOR = '#8b5cf6';
  const CONTRACT_EVENT_COLOR = '#e11d48';
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
    let allContractEvents;
    [ycEvents, ycExternalEvents, ycSchoolHolidays, ycPublicHolidays, ycExternalCalendars, allContractEvents] = await Promise.all([
      api(`/api/year-events?year=${ycYear}`),
      api(`/api/external-calendar-events?year=${ycYear}`),
      api(`/api/school-holidays?year=${ycYear}`),
      api(`/api/public-holidays?year=${ycYear}`),
      api('/api/external-calendars'),
      api('/api/contract-events'),
    ]);
    ycContractEvents = allContractEvents.filter(e => e.date && e.date.startsWith(String(ycYear)));
    // Konzerte der Neckarsulmer Konzerte (nur fuer Konten mit Zugriff) ebenfalls anzeigen
    ycNkConcerts = [];
    if (can('nk_projects')) {
      try {
        ycNkConcerts = (await api('/api/nk/concerts')).filter(c => c.date && c.date.startsWith(String(ycYear)) && c.status !== 'Abgesagt');
      } catch (e) { /* optional */ }
    }
  }

  // Veranstaltungen aus dem Vertraege-Bereich erscheinen automatisch im Jahreskalender
  // (nur lesend - bearbeitet werden sie weiter im Vertraege-Tab).
  function ycContractEventLabel(e) {
    return `🎪 ${e.time ? e.time.slice(0, 5) + ' ' : ''}${e.title}`;
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
      const dayContract = ycContractEvents.filter(e => e.date === dateIso);
      const allDayItems = [
        ...ycNkConcerts.filter(c => c.date === dateIso).map(c => ({ title: `🎵 ${c.time ? c.time.slice(0, 5) + ' ' : ''}${c.title}`, color: NK_CONCERT_COLOR })),
        ...dayContract.map(e => ({ title: ycContractEventLabel(e), color: CONTRACT_EVENT_COLOR })),
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
    const dayContract = ycContractEvents.filter(e => e.date === dateIso);
    const body = document.getElementById('yc-day-modal-body');

    const notes = [];
    if (ycPublicHolidays.includes(dateIso)) notes.push('<div class="hint">Gesetzlicher Feiertag</div>');
    if (isSchoolHoliday(dateIso)) notes.push('<div class="hint">Schulferien (Baden-Württemberg)</div>');

    const rows = [
      ...ycNkConcerts.filter(c => c.date === dateIso).map(c => `
        <div class="yc-day-event-row">
          <span><span class="color-dot" style="background:${NK_CONCERT_COLOR}"></span> 🎵 ${c.time ? c.time.slice(0, 5) + ' ' : ''}${escapeHtml(c.title)} · <span class="task-meta">Neckarsulmer Konzerte</span></span>
          <span class="row-actions"><button type="button" class="ghost" data-open-nk-concert="${c.id}">Öffnen</button></span>
        </div>
      `),
      ...dayContract.map(e => `
        <div class="yc-day-event-row">
          <span><span class="color-dot" style="background:${CONTRACT_EVENT_COLOR}"></span> ${escapeHtml(ycContractEventLabel(e))} · <span class="task-meta">Veranstaltung</span></span>
          <span class="row-actions">
            ${can('contracts') ? `<button type="button" class="ghost" data-open-contract-event="${e.id}">Öffnen</button>` : ''}
          </span>
        </div>
      `),
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

    body.querySelectorAll('[data-open-nk-concert]').forEach(b => b.addEventListener('click', () => {
      closeYcDayModal();
      switchTab('nk_projects');
      openNkConcert(+b.dataset.openNkConcert);
    }));
    body.querySelectorAll('[data-open-contract-event]').forEach(b => b.addEventListener('click', () => {
      closeYcDayModal();
      document.querySelector('[data-tab="contracts"]').click();
      openContractDetail(+b.dataset.openContractEvent);
    }));
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

  // ---------- Benutzerverwaltung & Freigaben ----------
  const usersModal = document.getElementById('users-modal-overlay');
  const usersError = document.getElementById('users-error');
  const TAB_LABELS = [
    ['tasks', 'Aufgaben'], ['calendar', 'Wochenplanung'], ['people', 'Personen/Projekte'],
    ['timetracking', 'Zeiterfassung'], ['yearcalendar', 'Jahreskalender'], ['contracts', 'Verträge'],
    ['nk_polls', 'NK · Terminfindung'], ['nk_projects', 'NK · Projekte'],
  ];
  const TAB_PRESETS = {
    nk: ['nk_polls', 'nk_projects'],
    office: ['tasks', 'calendar', 'people', 'timetracking', 'yearcalendar', 'contracts'],
    all: TAB_LABELS.map(t => t[0]),
  };

  function tabChecksHtml(selected, name) {
    return TAB_LABELS.map(([key, label]) => `
      <label class="tab-check ${key.startsWith('nk_') ? 'tab-check-nk' : ''}">
        <input type="checkbox" name="${name}" value="${key}" ${selected.includes(key) ? 'checked' : ''}>
        <span>${escapeHtml(label)}</span>
      </label>`).join('');
  }
  function readTabChecks(container) {
    return [...container.querySelectorAll('input[type="checkbox"][value]:checked')].map(cb => cb.value);
  }
  function personOptionsHtml(selectedId, excludeIds) {
    return '<option value="">— keine —</option>' + people.filter(p => p.active || p.id === selectedId)
      .filter(p => p.id === selectedId || !excludeIds.has(p.id))
      .map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(personLabel(p))}</option>`).join('');
  }

  function showUsersError(msg) {
    usersError.textContent = msg;
    usersError.classList.remove('hidden');
    usersError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadUsers() {
    const users = await api('/api/users');
    const linked = new Set(users.filter(u => u.person_id).map(u => u.person_id));
    const container = document.getElementById('users-list');
    container.innerHTML = users.map(u => `
      <div class="user-card" data-user-card="${u.id}">
        <div class="user-card-head">
          ${avatarHtml(u.display)}
          <div class="user-card-title">
            <strong>${escapeHtml(u.display.name)}</strong>
            <span class="task-meta">@${escapeHtml(u.username)}${u.is_me ? ' · du' : ''}</span>
          </div>
          ${u.is_admin ? '<span class="role-pill">Admin</span>' : ''}
        </div>
        <div class="user-card-body">
          <div class="time-row">
            <label>Anzeigename <input type="text" data-field="display_name" value="${escapeHtml(u.display_name || '')}" placeholder="${escapeHtml(u.person_name || u.username)}"></label>
            <label>Verknüpfte Person (Zeiterfassung)
              <select data-field="person_id">${personOptionsHtml(u.person_id, new Set([...linked].filter(id => id !== u.person_id)))}</select>
            </label>
          </div>
          <label class="inline-check"><input type="checkbox" data-field="is_admin" ${u.is_admin ? 'checked' : ''} ${u.is_me ? 'disabled title="Eigene Admin-Rechte können nicht entfernt werden"' : ''}> Admin</label>
          <div class="tab-presets">
            <span class="hint">Freigegebene Reiter:</span>
            <button type="button" class="ghost" data-preset="nk">Nur NK</button>
            <button type="button" class="ghost" data-preset="office">Büro</button>
            <button type="button" class="ghost" data-preset="all">Alles</button>
          </div>
          <div class="tab-check-grid">${tabChecksHtml(u.tabs, 'tabs-' + u.id)}</div>
          <div class="user-card-actions">
            <button type="button" data-save-user="${u.id}">Speichern</button>
            <button type="button" class="ghost" data-reset-user="${u.id}">Passwort setzen</button>
            ${u.is_me ? '' : `<button type="button" class="danger" data-delete-user="${u.id}">Löschen</button>`}
            <span class="save-feedback hidden" data-saved="${u.id}">✓ Gespeichert</span>
          </div>
          <div class="user-reset-row hidden" data-reset-row="${u.id}">
            <input type="password" placeholder="Neues Passwort (mind. 6 Zeichen)" autocomplete="new-password">
            <button type="button" data-reset-save="${u.id}">Passwort speichern</button>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
      const card = b.closest('.user-card');
      const preset = TAB_PRESETS[b.dataset.preset];
      card.querySelectorAll('.tab-check-grid input').forEach(cb => { cb.checked = preset.includes(cb.value); });
    }));
    container.querySelectorAll('[data-save-user]').forEach(b => b.addEventListener('click', async () => {
      const card = b.closest('.user-card');
      const id = +b.dataset.saveUser;
      usersError.classList.add('hidden');
      try {
        await api(`/api/users/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            display_name: card.querySelector('[data-field="display_name"]').value,
            person_id: +card.querySelector('[data-field="person_id"]').value || null,
            is_admin: card.querySelector('[data-field="is_admin"]').checked,
            tabs: readTabChecks(card.querySelector('.tab-check-grid')),
          }),
        });
        await loadUsers();
        const fb = container.querySelector(`[data-saved="${id}"]`);
        if (fb) { fb.classList.remove('hidden'); setTimeout(() => fb.classList.add('hidden'), 2500); }
        if (id === currentUser.id) { await loadAccount(); fillPersonSelects(); }
      } catch (err) { showUsersError(err.message); }
    }));
    container.querySelectorAll('[data-reset-user]').forEach(b => b.addEventListener('click', () => {
      const row = container.querySelector(`[data-reset-row="${b.dataset.resetUser}"]`);
      row.classList.toggle('hidden');
      if (!row.classList.contains('hidden')) row.querySelector('input').focus();
    }));
    container.querySelectorAll('[data-reset-save]').forEach(b => b.addEventListener('click', async () => {
      const row = container.querySelector(`[data-reset-row="${b.dataset.resetSave}"]`);
      const input = row.querySelector('input');
      usersError.classList.add('hidden');
      try {
        await api(`/api/users/${b.dataset.resetSave}/password`, { method: 'PUT', body: JSON.stringify({ new_password: input.value }) });
        input.value = '';
        row.classList.add('hidden');
        alert('Passwort wurde geändert.');
      } catch (err) { showUsersError(err.message); }
    }));
    container.querySelectorAll('[data-delete-user]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Dieses Benutzerkonto wirklich löschen? Kommentare bleiben erhalten, Abstimmungen dieses Kontos werden entfernt.')) return;
      try {
        await api(`/api/users/${b.dataset.deleteUser}`, { method: 'DELETE' });
        await loadUsers();
      } catch (err) { showUsersError(err.message); }
    }));
    return users;
  }

  function resetNewUserForm(users) {
    document.getElementById('new-user-username').value = '';
    document.getElementById('new-user-password').value = '';
    document.getElementById('new-user-display').value = '';
    document.getElementById('new-user-admin').checked = false;
    const linked = new Set((users || []).filter(u => u.person_id).map(u => u.person_id));
    document.getElementById('new-user-person').innerHTML = personOptionsHtml(null, linked);
    document.getElementById('new-user-tabs').innerHTML = tabChecksHtml(TAB_PRESETS.office, 'new-user-tabs');
  }

  document.querySelectorAll('[data-new-preset]').forEach(b => b.addEventListener('click', () => {
    const preset = TAB_PRESETS[b.dataset.newPreset];
    document.querySelectorAll('#new-user-tabs input').forEach(cb => { cb.checked = preset.includes(cb.value); });
  }));

  document.getElementById('manage-users-btn').addEventListener('click', async () => {
    accountDropdown.classList.add('hidden');
    usersError.classList.add('hidden');
    document.getElementById('user-new-card').open = false;
    usersModal.classList.remove('hidden');
    const users = await loadUsers();
    resetNewUserForm(users);
  });
  document.getElementById('users-modal-close').addEventListener('click', () => usersModal.classList.add('hidden'));
  usersModal.addEventListener('click', (e) => { if (e.target === usersModal) usersModal.classList.add('hidden'); });
  document.getElementById('users-add-confirm').addEventListener('click', async () => {
    usersError.classList.add('hidden');
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('new-user-username').value.trim(),
          password: document.getElementById('new-user-password').value,
          display_name: document.getElementById('new-user-display').value,
          person_id: +document.getElementById('new-user-person').value || null,
          is_admin: document.getElementById('new-user-admin').checked,
          tabs: readTabChecks(document.getElementById('new-user-tabs')),
        }),
      });
      const users = await loadUsers();
      resetNewUserForm(users);
      document.getElementById('user-new-card').open = false;
    } catch (err) { showUsersError(err.message); }
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

  let currentUser = { id: null, username: null, person_id: null, person_name: null, is_admin: false, tabs: null };

  async function loadAccount() {
    try {
      const me = await api('/api/me');
      currentUser = me;
      const avatar = document.getElementById('account-avatar');
      avatar.textContent = me.short_code;
      avatar.style.background = me.color;
      document.getElementById('account-username').textContent = me.display_name;
      document.getElementById('account-dropdown-head').innerHTML = `
        <strong>${escapeHtml(me.display_name)}</strong>
        <span>@${escapeHtml(me.username)}${me.is_admin ? ' · Admin' : ''}</span>
        ${me.person_name ? `<span>Zeiterfassung als ${escapeHtml(me.person_name)}</span>` : ''}`;
      applyRoleRestrictions();
    } catch (e) { /* Redirect passiert bereits in api() bei 401 */ }
  }

  // Nicht-Admin-Logins (an eine Person gebunden) duerfen in der Zeiterfassung nur die
  // eigene Person sehen/bearbeiten (serverseitig ohnehin erzwungen); hier wird das
  // Frontend passend eingeschraenkt, damit gar nicht erst versucht wird, andere
  // auszuwaehlen. In Aufgaben/Kalender/Dashboard liegt nur der Fokus auf der eigenen
  // Person (voreingestellter Filter), der Rest bleibt einsehbar.
  function applyRoleRestrictions() {
    document.getElementById('manage-users-btn').classList.toggle('hidden', !currentUser.is_admin);
    document.getElementById('backup-now-btn').classList.toggle('hidden', !currentUser.is_admin);
    if (currentUser.is_admin) return;

    ['time-person', 'time-filter-person', 'timeoff-person'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<option value="${currentUser.person_id || ''}">${escapeHtml(currentUser.person_name || '— keine Person verknüpft —')}</option>`;
      el.disabled = true;
    });

    // Fokus auf eigene Person im Aufgaben-Filter (bleibt umschaltbar)
    const taskPersonFilter = document.getElementById('task-filter-person');
    if (taskPersonFilter && currentUser.person_id) {
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
        <div class="cec-head">
          <span class="cec-date">${fmtDateDE(e.date)}${e.time ? ' · ' + e.time.slice(0, 5) : ''}</span>
          <span class="cec-title">${escapeHtml(e.title)}</span>
        </div>
        ${e.location ? `<div class="cec-meta">${escapeHtml(e.location)}</div>` : ''}
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
    document.getElementById('contract-detail-title').innerHTML =
      `<span class="contract-detail-date">${fmtDateDE(e.date)}${e.time ? ' · ' + e.time.slice(0, 5) + ' Uhr' : ''}</span> ${escapeHtml(e.title)}`;
    document.getElementById('contract-detail-meta').innerHTML =
      (e.location ? escapeHtml(e.location) : '') + (e.notes ? `<p class="hint">${escapeHtml(e.notes)}</p>` : '');

    const jpmrBtn = document.getElementById('contract-jpmr-btn');
    jpmrBtn.disabled = !!e.jpmr_termin_id;
    jpmrBtn.textContent = e.jpmr_termin_id ? '✓ Bereits ins JPMR-Tool übernommen' : 'Ins JPMR-Tool übernehmen';

    const filesList = document.getElementById('contract-detail-files-list');
    filesList.innerHTML = e.files.length
      ? e.files.map(f => `
          <div class="contract-file-row">
            <span>${escapeHtml(f.category)}: ${f.dropbox_path ? `<a href="/api/contract-events/${e.id}/files/${f.id}/download" target="_blank" rel="noopener" class="file-name">${escapeHtml(f.filename)}</a>` : escapeHtml(f.filename)}</span>
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

  document.getElementById('contract-jpmr-btn').addEventListener('click', async () => {
    const e = currentContractDetail;
    if (!confirm(`„${e.title}“ am ${fmtDateDE(e.date)} als Termin im JPMR-Tool anlegen?\n\nDas ist eine einmalige Kopie – spätere Änderungen hier werden dort nicht übernommen.`)) return;
    const btn = document.getElementById('contract-jpmr-btn');
    btn.disabled = true;
    try {
      currentContractDetail = await api(`/api/contract-events/${e.id}/jpmr`, { method: 'POST', body: JSON.stringify({}) });
      renderContractDetail();
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
  });

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
        <p class="empty-state">Noch keine Punkte im Ablauf — manuell hinzufügen.</p>
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


  // ================= NECKARSULMER KONZERTE =================
  const WD_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  function fmtWeekdayDate(iso, withYear) {
    if (!iso) return '';
    const d = isoToDate(iso);
    return `${WD_SHORT[d.getDay()]}, ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${withYear ? d.getFullYear() : ''}`;
  }
  function fmtTimeRange(o) {
    if (!o.start_time) return 'ganztägig';
    return o.end_time ? `${o.start_time.slice(0, 5)}–${o.end_time.slice(0, 5)}` : `${o.start_time.slice(0, 5)} Uhr`;
  }
  // SQLite speichert datetime('now') in UTC - fuer die Anzeige in deutsche Zeit umrechnen
  function fmtTimestamp(ts) {
    if (!ts) return '';
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  }
  function fmtBytes(n) {
    if (!n) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  }
  function dateBlockHtml(iso) {
    if (!iso) return '<div class="date-block date-block-empty"><span>Datum</span><strong>offen</strong></div>';
    const d = isoToDate(iso);
    return `<div class="date-block"><span>${MONTH_SHORT[d.getMonth()]}</span><strong>${d.getDate()}</strong><span>${d.getFullYear()}</span></div>`;
  }
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- Terminfindung ----------
  let nkPolls = [];
  let nkPollDetail = null;
  const ANSWER_META = {
    yes: { icon: '✓', label: 'Kann', cls: 'ans-yes' },
    maybe: { icon: '?', label: 'Vielleicht', cls: 'ans-maybe' },
    no: { icon: '✕', label: 'Kann nicht', cls: 'ans-no' },
  };

  function showNkPollList() {
    document.getElementById('nk-polls-list-view').classList.remove('hidden');
    document.getElementById('nk-poll-detail-view').classList.add('hidden');
    nkPollDetail = null;
  }

  async function loadNkPolls() {
    nkPolls = await api('/api/nk/polls');
    const open = nkPolls.filter(p => !p.closed);
    const closed = nkPolls.filter(p => p.closed);
    const list = document.getElementById('nk-polls-list');
    list.innerHTML = open.length ? open.map(nkPollCardHtml).join('') : `
      <div class="empty-card">
        <div class="empty-card-icon">📅</div>
        <strong>Noch keine offene Terminumfrage</strong>
        <span>Lege eine Umfrage mit mehreren Terminvorschlägen an – alle können dann ankreuzen, wann sie Zeit haben.</span>
      </div>`;
    document.getElementById('nk-polls-closed-card').classList.toggle('hidden', !closed.length);
    document.getElementById('nk-polls-closed-count').textContent = `Abgeschlossen (${closed.length})`;
    document.getElementById('nk-polls-closed-list').innerHTML = closed.map(nkPollCardHtml).join('');
    document.querySelectorAll('[data-poll-card]').forEach(c => c.addEventListener('click', () => openNkPoll(+c.dataset.pollCard)));
    refreshNkBadges();
  }

  function nkPollCardHtml(p) {
    const range = p.first_date
      ? (p.first_date === p.last_date ? fmtWeekdayDate(p.first_date, true) : `${fmtWeekdayDate(p.first_date)} – ${fmtWeekdayDate(p.last_date, true)}`)
      : '–';
    let highlight = '';
    if (p.closed && p.final_option) {
      highlight = `<div class="poll-card-best final"><span>Festgelegt</span><strong>${fmtWeekdayDate(p.final_option.date, true)} · ${fmtTimeRange(p.final_option)}</strong></div>`;
    } else if (p.best) {
      highlight = `<div class="poll-card-best"><span>★ Meiste Zusagen</span><strong>${fmtWeekdayDate(p.best.date)} · ${fmtTimeRange(p.best)}</strong><em>✓ ${p.best.yes}${p.best.maybe ? ` · ? ${p.best.maybe}` : ''}</em></div>`;
    }
    const status = p.closed
      ? '<span class="pill pill-muted">Abgeschlossen</span>'
      : (p.i_voted ? '<span class="pill pill-ok">✓ Abgestimmt</span>' : '<span class="pill pill-accent">Deine Antwort fehlt</span>');
    return `
      <button type="button" class="nk-card poll-card ${p.closed ? 'is-closed' : ''}" data-poll-card="${p.id}">
        <div class="nk-card-top">${status}</div>
        <div class="nk-card-title">${escapeHtml(p.title)}</div>
        <div class="nk-card-meta">${range} · ${p.option_count} Termin${p.option_count === 1 ? '' : 'e'} · ${p.voter_count} Antwort${p.voter_count === 1 ? '' : 'en'}</div>
        ${highlight}
      </button>`;
  }

  document.getElementById('nk-polls-closed-toggle').addEventListener('click', () => {
    const list = document.getElementById('nk-polls-closed-list');
    document.getElementById('nk-polls-closed-chevron').classList.toggle('collapsed', list.classList.toggle('hidden'));
  });

  async function openNkPoll(id) {
    nkPollDetail = await api(`/api/nk/polls/${id}`);
    document.getElementById('nk-polls-list-view').classList.add('hidden');
    document.getElementById('nk-poll-detail-view').classList.remove('hidden');
    renderNkPollDetail();
    window.scrollTo({ top: 0 });
  }

  function optionStats(o) {
    return {
      yes: o.votes.filter(v => v.answer === 'yes').length,
      maybe: o.votes.filter(v => v.answer === 'maybe').length,
      no: o.votes.filter(v => v.answer === 'no').length,
    };
  }

  function renderNkPollDetail() {
    const p = nkPollDetail;
    const view = document.getElementById('nk-poll-detail-view');
    const me = currentUser.id;
    const members = [...p.members].sort((a, b) => (a.user_id === me ? -1 : b.user_id === me ? 1 : a.name.localeCompare(b.name, 'de')));
    const answerOf = (o, uid) => (o.votes.find(v => v.user_id === uid) || {}).answer || null;
    const respondedIds = new Set(p.options.flatMap(o => o.votes.map(v => v.user_id)));
    const missing = members.filter(m => !respondedIds.has(m.user_id));
    const maxYes = Math.max(0, ...p.options.map(o => optionStats(o).yes));
    const ranked = [...p.options].map(o => ({ o, st: optionStats(o) }))
      .sort((a, b) => b.st.yes - a.st.yes || b.st.maybe - a.st.maybe || (a.o.date < b.o.date ? -1 : 1));
    const memberCount = Math.max(members.length, 1);
    const locked = !!p.closed;

    const myButtons = (o, big) => ['yes', 'maybe', 'no'].map(a => `
      <button type="button" class="ans-btn ${ANSWER_META[a].cls} ${answerOf(o, me) === a ? 'on' : ''} ${big ? 'big' : ''}"
        data-vote-option="${o.id}" data-vote-answer="${a}" title="${ANSWER_META[a].label}" ${locked ? 'disabled' : ''}>
        ${ANSWER_META[a].icon}${big ? `<span>${ANSWER_META[a].label}</span>` : ''}
      </button>`).join('');

    const colClass = (o) => [
      p.final_option_id === o.id ? 'col-final' : '',
      !p.final_option_id && maxYes > 0 && optionStats(o).yes === maxYes ? 'col-best' : '',
    ].join(' ');

    const matrix = `
      <div class="poll-matrix-wrap">
        <table class="poll-matrix">
          <thead>
            <tr>
              <th class="pm-name-col"></th>
              ${p.options.map(o => {
                const d = isoToDate(o.date);
                return `<th class="${colClass(o)}">
                  <div class="pm-head">
                    <span class="pm-month">${MONTH_SHORT[d.getMonth()]}</span>
                    <span class="pm-day">${d.getDate()}</span>
                    <span class="pm-wd">${WD_SHORT[d.getDay()]}</span>
                    <span class="pm-time">${fmtTimeRange(o)}</span>
                  </div>
                </th>`;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${members.map(m => `
              <tr class="${m.user_id === me ? 'pm-me' : ''}">
                <td class="pm-name-col"><div class="pm-person">${avatarHtml(m)}<span>${escapeHtml(m.name)}</span>${m.user_id === me ? '<em>du</em>' : ''}</div></td>
                ${p.options.map(o => {
                  if (m.user_id === me) return `<td class="${colClass(o)} pm-mycell"><div class="ans-group">${myButtons(o, false)}</div></td>`;
                  const a = answerOf(o, m.user_id);
                  return `<td class="${colClass(o)}">${a ? `<span class="ans-mark ${ANSWER_META[a].cls}" title="${ANSWER_META[a].label}">${ANSWER_META[a].icon}</span>` : '<span class="ans-mark ans-none">·</span>'}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="pm-name-col">Zusagen</td>
              ${p.options.map(o => {
                const st = optionStats(o);
                return `<td class="${colClass(o)}"><strong class="pm-count">${st.yes}</strong>${st.maybe ? `<span class="pm-maybe">+${st.maybe}?</span>` : ''}${p.final_option_id === o.id ? '<div class="pm-flag">Festgelegt</div>' : (!p.final_option_id && maxYes > 0 && st.yes === maxYes ? '<div class="pm-flag">★ Top</div>' : '')}</td>`;
              }).join('')}
            </tr>
          </tfoot>
        </table>
      </div>`;

    const mobileCards = `
      <div class="poll-option-cards">
        ${p.options.map(o => {
          const st = optionStats(o);
          const yesPeople = members.filter(m => answerOf(o, m.user_id) === 'yes');
          const maybePeople = members.filter(m => answerOf(o, m.user_id) === 'maybe');
          const noPeople = members.filter(m => answerOf(o, m.user_id) === 'no');
          return `
            <div class="poll-option-card ${colClass(o)}">
              <div class="poc-head">
                <div><strong>${fmtWeekdayDate(o.date, true)}</strong><span>${fmtTimeRange(o)}</span></div>
                <div class="poc-score">${p.final_option_id === o.id ? '<span class="pill pill-ok">Festgelegt</span>' : (!p.final_option_id && maxYes > 0 && st.yes === maxYes ? '<span class="pill pill-accent">★ Top</span>' : '')}<strong>✓ ${st.yes}</strong></div>
              </div>
              <div class="score-bar"><span class="sb-yes" style="width:${(st.yes / memberCount) * 100}%"></span><span class="sb-maybe" style="width:${(st.maybe / memberCount) * 100}%"></span></div>
              <div class="poc-people">
                ${yesPeople.map(m => avatarHtml(m, 'sm ring-yes')).join('')}
                ${maybePeople.map(m => avatarHtml(m, 'sm ring-maybe')).join('')}
                ${noPeople.map(m => avatarHtml(m, 'sm faded')).join('')}
              </div>
              <div class="ans-group ans-group-big">${myButtons(o, true)}</div>
            </div>`;
        }).join('')}
      </div>`;

    const ranking = ranked.slice(0, 3).filter(r => r.st.yes + r.st.maybe > 0);

    view.innerHTML = `
      <button type="button" class="back-link" id="nk-poll-back">← Alle Terminumfragen</button>
      <div class="card detail-hero">
        <div class="detail-hero-main">
          <div class="detail-hero-kicker">${locked ? '<span class="pill pill-muted">Abgeschlossen</span>' : '<span class="pill pill-accent">Abstimmung läuft</span>'}</div>
          <h2 class="detail-title">${escapeHtml(p.title)}</h2>
          <div class="detail-meta">
            ${p.location ? `<span>📍 ${escapeHtml(p.location)}</span>` : ''}
            <span>Angelegt von ${escapeHtml(p.created_by_display.name)} · ${fmtTimestamp(p.created_at)}</span>
          </div>
          ${p.description ? `<p class="detail-notes">${escapeHtml(p.description)}</p>` : ''}
        </div>
        ${p.can_manage ? `
          <div class="detail-actions">
            ${locked
              ? '<button type="button" class="ghost" id="nk-poll-reopen">Wieder öffnen</button>'
              : '<button type="button" class="ghost" id="nk-poll-edit">Bearbeiten</button>'}
            <button type="button" class="danger" id="nk-poll-delete">Löschen</button>
          </div>` : ''}
      </div>

      ${locked && p.final_option_id ? (() => {
        const fo = p.options.find(o => o.id === p.final_option_id);
        return fo ? `<div class="final-banner">✓ Festgelegter Termin: <strong>${fmtWeekdayDate(fo.date, true)} · ${fmtTimeRange(fo)}</strong></div>` : '';
      })() : ''}

      <div class="poll-summary-row">
        <div class="card poll-ranking">
          <h3>Meiste Treffer</h3>
          ${ranking.length ? ranking.map((r, i) => `
            <div class="rank-row ${i === 0 ? 'rank-first' : ''}">
              <span class="rank-no">${i + 1}</span>
              <div class="rank-body">
                <div class="rank-label"><strong>${fmtWeekdayDate(r.o.date)}</strong> ${fmtTimeRange(r.o)}</div>
                <div class="score-bar"><span class="sb-yes" style="width:${(r.st.yes / memberCount) * 100}%"></span><span class="sb-maybe" style="width:${(r.st.maybe / memberCount) * 100}%"></span></div>
              </div>
              <span class="rank-score">✓ ${r.st.yes}${r.st.maybe ? ` <em>?${r.st.maybe}</em>` : ''}</span>
            </div>`).join('') : '<p class="empty-state">Noch keine Antworten.</p>'}
        </div>
        <div class="card poll-status-card">
          <h3>Rückmeldungen</h3>
          <div class="big-number">${members.length - missing.length}<span>/ ${members.length}</span></div>
          ${missing.length ? `<div class="hint">Noch offen:</div><div class="avatar-row">${missing.map(m => `${avatarHtml(m, 'sm faded')}`).join('')}</div>
            <div class="task-meta">${missing.map(m => escapeHtml(m.name)).join(', ')}</div>` : '<div class="all-read-ok">✓ Alle haben geantwortet</div>'}
          ${p.can_manage && !locked ? `
            <div class="close-poll-box">
              <label>Termin festlegen
                <select id="nk-poll-final-select">
                  ${ranked.map(r => `<option value="${r.o.id}">${fmtWeekdayDate(r.o.date)} ${fmtTimeRange(r.o)} (✓${r.st.yes})</option>`).join('')}
                </select>
              </label>
              <button type="button" id="nk-poll-close">Festlegen &amp; abschließen</button>
            </div>` : ''}
        </div>
      </div>

      <div class="card poll-answer-card">
        <div class="poll-answer-head">
          <h3>${locked ? 'Ergebnis' : 'Wann kannst du?'}</h3>
          ${locked ? '' : `<div class="legend"><span class="ans-mark ans-yes">✓</span> kann <span class="ans-mark ans-maybe">?</span> vielleicht <span class="ans-mark ans-no">✕</span> kann nicht</div>`}
        </div>
        ${locked ? '' : '<p class="hint">Einfach antippen – deine Auswahl wird sofort gespeichert. Nochmal tippen entfernt die Antwort.</p>'}
        ${matrix}
        ${mobileCards}
      </div>
    `;

    document.getElementById('nk-poll-back').addEventListener('click', () => { showNkPollList(); loadNkPolls(); });
    view.querySelectorAll('[data-vote-option]').forEach(b => b.addEventListener('click', async () => {
      const optId = +b.dataset.voteOption;
      const opt = nkPollDetail.options.find(o => o.id === optId);
      const current = answerOf(opt, me);
      const next = current === b.dataset.voteAnswer ? null : b.dataset.voteAnswer;
      try {
        nkPollDetail = await api(`/api/nk/polls/${p.id}/votes`, { method: 'PUT', body: JSON.stringify({ votes: { [optId]: next } }) });
        renderNkPollDetail();
        toast('Antwort gespeichert');
        refreshNkBadges();
      } catch (err) { alert(err.message); }
    }));
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('nk-poll-edit', () => openNkPollModal(nkPollDetail));
    on('nk-poll-delete', async () => {
      if (!confirm(`Umfrage „${p.title}“ mit allen Antworten löschen?`)) return;
      await api(`/api/nk/polls/${p.id}`, { method: 'DELETE' });
      showNkPollList();
      await loadNkPolls();
    });
    on('nk-poll-close', async () => {
      const sel = document.getElementById('nk-poll-final-select');
      nkPollDetail = await api(`/api/nk/polls/${p.id}/close`, { method: 'POST', body: JSON.stringify({ final_option_id: +sel.value }) });
      renderNkPollDetail();
    });
    on('nk-poll-reopen', async () => {
      nkPollDetail = await api(`/api/nk/polls/${p.id}/close`, { method: 'POST', body: JSON.stringify({ reopen: true }) });
      renderNkPollDetail();
    });
  }

  // ---- Umfrage anlegen/bearbeiten ----
  const nkPollModal = document.getElementById('nk-poll-modal-overlay');
  let nkPollEditingId = null;

  function nkOptionRowHtml(o) {
    return `
      <div class="nk-option-row" data-option-id="${o.id || ''}">
        <input type="date" class="nko-date" value="${o.date || ''}" required>
        <input type="time" class="nko-start" value="${o.start_time ? o.start_time.slice(0, 5) : ''}" title="Beginn">
        <span class="nko-sep">–</span>
        <input type="time" class="nko-end" value="${o.end_time ? o.end_time.slice(0, 5) : ''}" title="Ende (optional)">
        <button type="button" class="icon-btn" data-remove-option title="Entfernen">✕</button>
      </div>`;
  }
  function addNkOptionRow(o) {
    const wrap = document.getElementById('nk-poll-options');
    wrap.insertAdjacentHTML('beforeend', nkOptionRowHtml(o));
    const row = wrap.lastElementChild;
    row.querySelector('[data-remove-option]').addEventListener('click', () => {
      if (wrap.children.length <= 1) { row.querySelectorAll('input').forEach(i => { i.value = ''; }); return; }
      row.remove();
    });
    return row;
  }
  function lastOptionValues() {
    const rows = document.querySelectorAll('#nk-poll-options .nk-option-row');
    const last = rows[rows.length - 1];
    if (!last) return {};
    return { date: last.querySelector('.nko-date').value, start_time: last.querySelector('.nko-start').value, end_time: last.querySelector('.nko-end').value };
  }
  document.getElementById('nk-poll-add-option').addEventListener('click', () => {
    const last = lastOptionValues();
    let date = '';
    if (last.date) date = isoDate(addDays(isoToDate(last.date), 1));
    addNkOptionRow({ date, start_time: last.start_time, end_time: last.end_time }).querySelector('.nko-date').focus();
  });
  document.getElementById('nk-poll-add-same-day').addEventListener('click', () => {
    const last = lastOptionValues();
    addNkOptionRow({ date: last.date }).querySelector('.nko-start').focus();
  });

  function openNkPollModal(poll) {
    nkPollEditingId = poll ? poll.id : null;
    document.getElementById('nk-poll-modal-heading').textContent = poll ? 'Umfrage bearbeiten' : 'Neue Terminumfrage';
    document.getElementById('nk-poll-submit').textContent = poll ? 'Speichern' : 'Umfrage anlegen';
    document.getElementById('nk-poll-title').value = poll ? poll.title : '';
    document.getElementById('nk-poll-location').value = poll ? (poll.location || '') : '';
    document.getElementById('nk-poll-description').value = poll ? (poll.description || '') : '';
    document.getElementById('nk-poll-options').innerHTML = '';
    if (poll) poll.options.forEach(addNkOptionRow);
    else { addNkOptionRow({ date: isoDate(addDays(new Date(), 7)), start_time: '19:00' }); }
    nkPollModal.classList.remove('hidden');
    setTimeout(() => document.getElementById('nk-poll-title').focus(), 0);
  }
  document.getElementById('nk-poll-new-btn').addEventListener('click', () => openNkPollModal(null));
  document.getElementById('nk-poll-cancel').addEventListener('click', () => nkPollModal.classList.add('hidden'));
  nkPollModal.addEventListener('click', (e) => { if (e.target === nkPollModal) nkPollModal.classList.add('hidden'); });

  document.getElementById('nk-poll-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const options = [...document.querySelectorAll('#nk-poll-options .nk-option-row')].map(r => ({
      id: r.dataset.optionId ? +r.dataset.optionId : null,
      date: r.querySelector('.nko-date').value,
      start_time: r.querySelector('.nko-start').value || null,
      end_time: r.querySelector('.nko-end').value || null,
    })).filter(o => o.date);
    if (!options.length) { alert('Bitte mindestens einen Terminvorschlag mit Datum eintragen.'); return; }
    if (nkPollEditingId && nkPollDetail) {
      const removedWithVotes = nkPollDetail.options.filter(o => o.votes.length && !options.some(n => n.id === o.id));
      if (removedWithVotes.length && !confirm(`${removedWithVotes.length} Termin(e) mit bereits abgegebenen Antworten werden entfernt. Fortfahren?`)) return;
    }
    const payload = {
      title: document.getElementById('nk-poll-title').value.trim(),
      location: document.getElementById('nk-poll-location').value.trim() || null,
      description: document.getElementById('nk-poll-description').value.trim() || null,
      options,
    };
    try {
      const detail = nkPollEditingId
        ? await api(`/api/nk/polls/${nkPollEditingId}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/nk/polls', { method: 'POST', body: JSON.stringify(payload) });
      nkPollModal.classList.add('hidden');
      await loadNkPolls();
      nkPollDetail = detail;
      document.getElementById('nk-polls-list-view').classList.add('hidden');
      document.getElementById('nk-poll-detail-view').classList.remove('hidden');
      renderNkPollDetail();
    } catch (err) { alert(err.message); }
  });

  // ---------- Projekte (Konzerte) ----------
  let nkConcerts = [];
  let nkConcertDetail = null;
  let nkConcertFolder = 'contracts';
  const NK_STATUSES = ['Idee', 'Planung', 'Bestätigt', 'Abgeschlossen', 'Abgesagt'];
  // Ordnerstruktur je Projekt: "<Datum> <Eventname>" -> Verträge / Sonstige Absprachen / 2Dos
  const NK_FOLDERS = {
    contracts: { name: 'Verträge', icon: '📑', categories: ['Künstlervertrag', 'Mietvertrag', 'Technik/Rider', 'Sonstiger Vertrag'] },
    agreements: { name: 'Sonstige Absprachen', icon: '💬', categories: ['Sonstiges', 'Angebot/Rechnung', 'Protokoll/Notiz'] },
    todos: { name: '2Dos', icon: '☑️' },
  };
  const nkFolderTitle = (c) => `${c.date ? fmtDateDE(c.date) + ' ' : ''}${c.title}`;
  const statusPill = (st) => `<span class="pill status-${(st || 'Planung').toLowerCase().replace(/[^a-zäöü]/g, '')}">${escapeHtml(st || 'Planung')}</span>`;

  function showNkConcertList() {
    document.getElementById('nk-projects-list-view').classList.remove('hidden');
    document.getElementById('nk-concert-detail-view').classList.add('hidden');
    nkConcertDetail = null;
  }

  async function loadNkConcerts() {
    nkConcerts = await api('/api/nk/concerts');
    const archived = (c) => c.status === 'Abgeschlossen' || c.status === 'Abgesagt';
    const active = nkConcerts.filter(c => !archived(c));
    const archive = nkConcerts.filter(archived);
    document.getElementById('nk-concerts-list').innerHTML = active.length ? active.map(nkConcertCardHtml).join('') : `
      <div class="empty-card">
        <div class="empty-card-icon">🎵</div>
        <strong>Noch keine Konzerte angelegt</strong>
        <span>Jedes Konzert bekommt einen Ordner „Datum + Eventname“ mit den Unterordnern Verträge, Sonstige Absprachen und 2Dos.</span>
      </div>`;
    document.getElementById('nk-concerts-archive-card').classList.toggle('hidden', !archive.length);
    document.getElementById('nk-concerts-archive-count').textContent = `Archiv – abgeschlossen/abgesagt (${archive.length})`;
    document.getElementById('nk-concerts-archive-list').innerHTML = archive.map(nkConcertCardHtml).join('');
    document.querySelectorAll('[data-concert-card]').forEach(el => el.addEventListener('click', () => {
      // Neue Kommentare? Dann direkt im Ordner "Sonstige Absprachen" öffnen
      const concert = nkConcerts.find(x => x.id === +el.dataset.concertCard);
      openNkConcert(+el.dataset.concertCard, concert && concert.unread_count ? 'agreements' : null);
    }));
    refreshNkBadges();
  }

  function nkConcertCardHtml(c) {
    const readState = c.comment_count
      ? (c.unread_count ? `<span class="pill pill-accent">${c.unread_count} neu</span>` : (c.all_read ? '<span class="pill pill-ok">✓ Alle gelesen</span>' : '<span class="pill pill-muted">Nicht alle gelesen</span>'))
      : '';
    return `
      <button type="button" class="nk-card concert-card ${c.unread_count ? 'has-unread' : ''}" data-concert-card="${c.id}">
        <div class="folder-glyph" aria-hidden="true">📁</div>
        <div class="concert-card-body">
          <div class="nk-card-top">${statusPill(c.status)}${readState}</div>
          <div class="nk-card-title">${c.date ? `<span class="folder-date">${fmtDateDE(c.date)}</span> ` : '<span class="folder-date folder-date-open">Datum offen</span> '}${escapeHtml(c.title)}</div>
          <div class="nk-card-meta">${[c.date ? WD_SHORT[isoToDate(c.date).getDay()] + (c.time ? ' · ' + c.time.slice(0, 5) + ' Uhr' : '') : '', c.location ? '📍 ' + escapeHtml(c.location) : ''].filter(Boolean).join(' · ') || '&nbsp;'}</div>
          <div class="folder-subs">
            <span>📑 Verträge <em>${c.contract_count}</em></span>
            <span>💬 Sonstige Absprachen <em>${c.file_count - c.contract_count + c.comment_count}</em></span>
            <span class="${c.todo_open ? 'has-open' : ''}">☑️ 2Dos <em>${c.todo_total ? `${c.todo_open} offen` : '0'}</em></span>
          </div>
        </div>
      </button>`;
  }

  document.getElementById('nk-concerts-archive-toggle').addEventListener('click', () => {
    const list = document.getElementById('nk-concerts-archive-list');
    document.getElementById('nk-concerts-archive-chevron').classList.toggle('collapsed', list.classList.toggle('hidden'));
  });

  async function openNkConcert(id, folder) {
    nkConcertDetail = await api(`/api/nk/concerts/${id}`);
    nkConcertFolder = folder || 'contracts';
    document.getElementById('nk-projects-list-view').classList.add('hidden');
    document.getElementById('nk-concert-detail-view').classList.remove('hidden');
    renderNkConcertDetail();
    window.scrollTo({ top: 0 });
  }

  function fileIcon(f) {
    const n = (f.filename || '').toLowerCase();
    if (n.endsWith('.pdf')) return '📄';
    if (/\.(png|jpe?g|gif|webp|heic)$/.test(n)) return '🖼️';
    if (/\.(docx?|odt|pages)$/.test(n)) return '📝';
    if (/\.(xlsx?|csv|numbers)$/.test(n)) return '📊';
    return '📎';
  }

  function renderNkConcertDetail(opts = {}) {
    const c = nkConcertDetail;
    const view = document.getElementById('nk-concert-detail-view');
    const draft = document.getElementById('nk-comment-input') ? document.getElementById('nk-comment-input').value : '';
    const me = currentUser.id;
    const members = c.members;
    const unreadMine = c.comments.filter(cm => !cm.read_by_me).length;
    const behind = members.filter(m => c.comments.some(cm => !cm.read_by.includes(m.user_id)));

    const commentsHtml = c.comments.length ? c.comments.map(cm => {
      const readers = members.filter(m => cm.read_by.includes(m.user_id));
      const notYet = members.filter(m => !cm.read_by.includes(m.user_id));
      const isFile = cm.kind === 'file';
      return `
        <div class="comment ${cm.read_by_me ? '' : 'is-unread'} ${isFile ? 'is-system' : ''}" data-comment="${cm.id}">
          ${avatarHtml(cm.author)}
          <div class="comment-main">
            <div class="comment-head">
              <strong>${escapeHtml(cm.author.name)}</strong>
              <span class="comment-time">${fmtTimestamp(cm.created_at)}</span>
              ${cm.read_by_me ? '' : '<span class="pill pill-accent pill-xs">neu</span>'}
              ${cm.can_delete ? `<button type="button" class="icon-btn comment-del" data-delete-comment="${cm.id}" title="Kommentar löschen">✕</button>` : ''}
            </div>
            <div class="comment-body">${isFile ? '📎 ' : ''}${escapeHtml(cm.body)}</div>
            <div class="comment-foot">
              <div class="read-state" title="${readers.length ? 'Gelesen von: ' + escapeHtml(readers.map(r => r.name).join(', ')) : ''}${notYet.length ? ' · Noch nicht gelesen: ' + escapeHtml(notYet.map(r => r.name).join(', ')) : ''}">
                ${readers.map(m => avatarHtml(m, 'xs')).join('')}${notYet.map(m => avatarHtml(m, 'xs faded')).join('')}
                <span class="read-label">${notYet.length ? `gelesen ${readers.length}/${members.length}` : '✓ alle gelesen'}</span>
              </div>
              ${cm.read_by_me
                ? (cm.user_id !== me ? `<button type="button" class="link-btn" data-unread-comment="${cm.id}">als ungelesen markieren</button>` : '')
                : `<button type="button" class="read-btn" data-read-comment="${cm.id}">✓ Gelesen</button>`}
            </div>
          </div>
        </div>`;
    }).join('') : '<p class="empty-state">Noch keine Kommentare. Schreib den ersten!</p>';

    const fileRowHtml = (f) => `
      <div class="file-row">
        <span class="file-icon">${fileIcon(f)}</span>
        <div class="file-main">
          <a href="/api/nk/concerts/${c.id}/files/${f.id}/download" target="_blank" rel="noopener" class="file-name">${escapeHtml(f.filename)}</a>
          <div class="file-meta">${escapeHtml(f.category || 'Sonstiges')} · ${fmtBytes(f.size_bytes)} · ${escapeHtml(f.uploaded_by.short)} · ${fmtTimestamp(f.uploaded_at)}${f.in_dropbox ? ' · in Dropbox gesichert' : ''}</div>
        </div>
        <a class="icon-btn" href="/api/nk/concerts/${c.id}/files/${f.id}/download?download=1" title="Herunterladen">⤓</a>
        ${f.can_delete ? `<button type="button" class="icon-btn" data-delete-file="${f.id}" title="Entfernen">✕</button>` : ''}
      </div>`;
    const contractFiles = c.files.filter(f => f.folder === 'Verträge');
    const otherFiles = c.files.filter(f => f.folder !== 'Verträge');
    const openTodos = c.todos.filter(t => !t.done);
    const doneTodos = c.todos.filter(t => t.done);
    const folder = NK_FOLDERS[nkConcertFolder] ? nkConcertFolder : 'contracts';

    const filesCardHtml = (key, files, emptyText) => `
      <div class="card concert-files">
        <div class="section-card-head"><h3>${key === 'contracts' ? 'Verträge' : 'Dokumente'} <span class="count-chip">${files.length}</span></h3></div>
        <div class="file-list">${files.length ? files.map(fileRowHtml).join('') : `<p class="empty-state">${emptyText}</p>`}</div>
        <div class="upload-box">
          <select id="nk-file-category">${NK_FOLDERS[key].categories.map(cat => `<option>${cat}</option>`).join('')}</select>
          <label class="file-drop" id="nk-file-drop">
            <input type="file" id="nk-file-input" multiple>
            <span id="nk-file-drop-text"><strong>Datei auswählen</strong> oder hierher ziehen<br><small>PDF, Word, Bilder … max. 18 MB</small></span>
          </label>
          <button type="button" id="nk-file-upload">In „${NK_FOLDERS[key].name}“ hochladen</button>
        </div>
      </div>`;

    const commentsCardHtml = `
      <div class="card concert-comments">
        <div class="section-card-head">
          <h3>Kommentare <span class="count-chip">${c.comments.length}</span></h3>
          ${unreadMine ? `<button type="button" class="ghost" id="nk-read-all">✓ Alle ${unreadMine} als gelesen markieren</button>` : ''}
        </div>
        ${c.comments.length ? (behind.length
          ? `<div class="sync-state sync-behind">Noch nicht alle auf dem gleichen Stand – offen bei: ${behind.map(m => `${avatarHtml(m, 'xs')} ${escapeHtml(m.name)}`).join(', ')}</div>`
          : '<div class="sync-state sync-ok">✓ Alle sind auf dem gleichen Stand</div>') : ''}
        <div class="comment-list">${commentsHtml}</div>
        <form id="nk-comment-form" class="comment-form">
          ${avatarHtml({ name: currentUser.display_name, short: currentUser.short_code, color: currentUser.color })}
          <div class="comment-form-main">
            <textarea id="nk-comment-input" rows="2" placeholder="Absprache / Kommentar schreiben … (⌘/Strg + Enter zum Senden)"></textarea>
            <div class="comment-form-actions"><button type="submit">Kommentieren</button></div>
          </div>
        </form>
      </div>`;

    const todayIso = new Date().toISOString().slice(0, 10);
    const todoRowHtml = (t) => `
      <div class="nk-todo ${t.done ? 'is-done' : ''}">
        <input type="checkbox" class="task-done-checkbox" data-todo-toggle="${t.id}" ${t.done ? 'checked' : ''} title="${t.done ? 'Wieder öffnen' : 'Erledigt'}">
        <div class="nk-todo-main">
          <div class="nk-todo-title">${escapeHtml(t.title)}</div>
          <div class="file-meta">
            ${t.assignee ? `${avatarHtml(t.assignee, 'xs')} ${escapeHtml(t.assignee.name)}` : 'Niemand zugeordnet'}
            ${t.due_date ? ` · <span class="${!t.done && t.due_date < todayIso ? 'todo-overdue' : ''}">fällig ${fmtWeekdayDate(t.due_date, true)}</span>` : ''}
            ${t.done && t.done_by_display ? ` · erledigt von ${escapeHtml(t.done_by_display.short)} ${fmtTimestamp(t.done_at)}` : ''}
          </div>
        </div>
        ${t.can_delete ? `<button type="button" class="icon-btn" data-todo-delete="${t.id}" title="2Do löschen">✕</button>` : ''}
      </div>`;
    const todosCardHtml = `
      <div class="card nk-todos-card">
        <div class="section-card-head"><h3>2Dos <span class="count-chip">${openTodos.length} offen</span></h3></div>
        <form id="nk-todo-form" class="nk-todo-form">
          <input type="text" id="nk-todo-title" placeholder="Neues 2Do, z.B. GEMA anmelden" required>
          <select id="nk-todo-assignee"><option value="">Wer?</option>${members.map(m => `<option value="${m.user_id}">${escapeHtml(m.name)}</option>`).join('')}</select>
          <input type="date" id="nk-todo-due" title="Fällig bis">
          <button type="submit">+ Hinzufügen</button>
        </form>
        <div class="nk-todo-list">${openTodos.length ? openTodos.map(todoRowHtml).join('') : '<p class="empty-state">Keine offenen 2Dos.</p>'}</div>
        ${doneTodos.length ? `
          <details class="nk-todo-done">
            <summary>Erledigt (${doneTodos.length})</summary>
            <div class="nk-todo-list">${doneTodos.map(todoRowHtml).join('')}</div>
          </details>` : ''}
      </div>`;

    const folderCounts = {
      contracts: contractFiles.length,
      agreements: otherFiles.length + c.comments.length,
      todos: openTodos.length,
    };
    const folderContent = folder === 'contracts'
      ? filesCardHtml('contracts', contractFiles, 'Noch keine Verträge in diesem Ordner.')
      : folder === 'agreements'
        ? `<div class="concert-grid">${commentsCardHtml}${filesCardHtml('agreements', otherFiles, 'Noch keine Dokumente in diesem Ordner.')}</div>`
        : todosCardHtml;

    view.innerHTML = `
      <nav class="folder-path">
        <button type="button" class="link-btn" id="nk-concert-back">📁 Projekte</button>
        <span>›</span><span>${escapeHtml(nkFolderTitle(c))}</span>
        <span>›</span><strong>${NK_FOLDERS[folder].name}</strong>
      </nav>
      <div class="card detail-hero concert-hero">
        ${dateBlockHtml(c.date)}
        <div class="detail-hero-main">
          <div class="detail-hero-kicker">
            <select id="nk-concert-status-quick" class="status-select" title="Status ändern">
              ${NK_STATUSES.map(st => `<option ${st === c.status ? 'selected' : ''}>${st}</option>`).join('')}
            </select>
          </div>
          <h2 class="detail-title">📁 ${escapeHtml(nkFolderTitle(c))}</h2>
          <div class="detail-meta">
            ${c.date ? `<span>📅 ${fmtWeekdayDate(c.date, true)}${c.time ? ' · ' + c.time.slice(0, 5) + ' Uhr' : ''}</span>` : '<span>📅 Datum noch offen</span>'}
            ${c.location ? `<span>📍 ${escapeHtml(c.location)}</span>` : ''}
          </div>
          ${c.notes ? `<p class="detail-notes">${escapeHtml(c.notes)}</p>` : ''}
        </div>
        <div class="detail-actions">
          <button type="button" class="ghost" id="nk-concert-edit">Bearbeiten</button>
          ${c.can_manage ? '<button type="button" class="danger" id="nk-concert-delete">Löschen</button>' : ''}
        </div>
      </div>

      <div class="folder-tabs" role="tablist">
        ${Object.entries(NK_FOLDERS).map(([key, f]) => `
          <button type="button" role="tab" class="folder-tab ${key === folder ? 'active' : ''}" data-nk-folder="${key}" aria-selected="${key === folder}">
            <span class="folder-tab-icon">${key === folder ? '📂' : '📁'}</span>
            <span class="folder-tab-name">${f.name}</span>
            <span class="count-chip">${key === 'todos' ? `${folderCounts[key]} offen` : folderCounts[key]}</span>
            ${key === 'agreements' && unreadMine ? `<span class="pill pill-accent pill-xs">${unreadMine} neu</span>` : ''}
          </button>`).join('')}
      </div>

      ${folderContent}
    `;

    const commentInput = document.getElementById('nk-comment-input');
    if (commentInput) {
      commentInput.value = draft;
      if (opts.focusComment) commentInput.focus();
    }
    if (opts.scrollToEnd) {
      const list = view.querySelector('.comment-list');
      if (list && list.lastElementChild) list.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    view.querySelectorAll('[data-nk-folder]').forEach(b => b.addEventListener('click', () => {
      nkConcertFolder = b.dataset.nkFolder;
      renderNkConcertDetail();
    }));

    const refresh = async (promise, o) => {
      try { nkConcertDetail = await promise; renderNkConcertDetail(o); refreshNkBadges(); } catch (err) { alert(err.message); }
    };
    document.getElementById('nk-concert-back').addEventListener('click', () => { showNkConcertList(); loadNkConcerts(); });
    document.getElementById('nk-concert-edit').addEventListener('click', () => openNkConcertModal(nkConcertDetail));
    const del = document.getElementById('nk-concert-delete');
    if (del) del.addEventListener('click', async () => {
      if (!confirm(`Konzert „${c.title}“ mit allen Kommentaren löschen?\n\nHochgeladene Dateien bleiben als Sicherung auf dem Server bzw. in Dropbox erhalten.`)) return;
      await api(`/api/nk/concerts/${c.id}`, { method: 'DELETE' });
      showNkConcertList();
      await loadNkConcerts();
    });
    document.getElementById('nk-concert-status-quick').addEventListener('change', (e) =>
      refresh(api(`/api/nk/concerts/${c.id}`, { method: 'PUT', body: JSON.stringify({ status: e.target.value }) })));
    const readAll = document.getElementById('nk-read-all');
    if (readAll) readAll.addEventListener('click', () => refresh(api(`/api/nk/concerts/${c.id}/read-all`, { method: 'POST' })));
    view.querySelectorAll('[data-read-comment]').forEach(b => b.addEventListener('click', () =>
      refresh(api(`/api/nk/concerts/${c.id}/comments/${b.dataset.readComment}/read`, { method: 'POST' }))));
    view.querySelectorAll('[data-unread-comment]').forEach(b => b.addEventListener('click', () =>
      refresh(api(`/api/nk/concerts/${c.id}/comments/${b.dataset.unreadComment}/read`, { method: 'POST', body: JSON.stringify({ unread: true }) }))));
    view.querySelectorAll('[data-delete-comment]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Diesen Kommentar löschen?')) return;
      refresh(api(`/api/nk/concerts/${c.id}/comments/${b.dataset.deleteComment}`, { method: 'DELETE' }));
    }));
    view.querySelectorAll('[data-delete-file]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Dieses Dokument aus dem Projekt entfernen?')) return;
      refresh(api(`/api/nk/concerts/${c.id}/files/${b.dataset.deleteFile}`, { method: 'DELETE' }));
    }));

    const todoForm = document.getElementById('nk-todo-form');
    if (todoForm) todoForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('nk-todo-title').value.trim();
      if (!title) return;
      await refresh(api(`/api/nk/concerts/${c.id}/todos`, { method: 'POST', body: JSON.stringify({
        title,
        assignee_id: document.getElementById('nk-todo-assignee').value || null,
        due_date: document.getElementById('nk-todo-due').value || null,
      }) }));
      const again = document.getElementById('nk-todo-title');
      if (again) again.focus();
    });
    view.querySelectorAll('[data-todo-toggle]').forEach(cb => cb.addEventListener('change', () =>
      refresh(api(`/api/nk/concerts/${c.id}/todos/${cb.dataset.todoToggle}`, { method: 'PUT', body: JSON.stringify({ done: cb.checked }) }))));
    view.querySelectorAll('[data-todo-delete]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Dieses 2Do löschen?')) return;
      refresh(api(`/api/nk/concerts/${c.id}/todos/${b.dataset.todoDelete}`, { method: 'DELETE' }));
    }));

    const form = document.getElementById('nk-comment-form');
    const submitComment = async () => {
      const body = commentInput.value.trim();
      if (!body) return;
      commentInput.value = '';
      await refresh(api(`/api/nk/concerts/${c.id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }), { scrollToEnd: true });
    };
    if (form) {
      form.addEventListener('submit', (e) => { e.preventDefault(); submitComment(); });
      commentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComment(); } });
    }

    const fileInput = document.getElementById('nk-file-input');
    if (!fileInput) return;
    const drop = document.getElementById('nk-file-drop');
    const dropText = document.getElementById('nk-file-drop-text');
    const showSelected = () => {
      const files = [...fileInput.files];
      dropText.innerHTML = files.length ? `<strong>${files.map(f => escapeHtml(f.name)).join(', ')}</strong><br><small>bereit zum Hochladen</small>` : '<strong>Datei auswählen</strong> oder hierher ziehen<br><small>PDF, Word, Bilder … max. 18 MB</small>';
      drop.classList.toggle('has-file', !!files.length);
    };
    fileInput.addEventListener('change', showSelected);
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('drag-over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); fileInput.files = e.dataTransfer.files; showSelected(); });
    document.getElementById('nk-file-upload').addEventListener('click', async (e) => {
      const files = [...fileInput.files];
      if (!files.length) { fileInput.click(); return; }
      const tooBig = files.find(f => f.size > 18 * 1024 * 1024);
      if (tooBig) { alert(`„${tooBig.name}“ ist größer als 18 MB.`); return; }
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Lädt hoch …';
      const category = document.getElementById('nk-file-category').value;
      try {
        for (const f of files) {
          const base64 = await fileToBase64(f);
          const res = await api(`/api/nk/concerts/${c.id}/files`, {
            method: 'POST', body: JSON.stringify({ category, filename: f.name, file_base64: base64, mime_type: f.type || null }),
          });
          nkConcertDetail = res.detail;
        }
        renderNkConcertDetail();
        toast(files.length === 1 ? 'Dokument hochgeladen' : `${files.length} Dokumente hochgeladen`);
      } catch (err) {
        alert('Upload fehlgeschlagen: ' + err.message);
        btn.disabled = false;
        btn.textContent = `In „${NK_FOLDERS[folder].name}“ hochladen`;
      }
    });
  }

  // ---- Konzert anlegen/bearbeiten ----
  const nkConcertModal = document.getElementById('nk-concert-modal-overlay');
  let nkConcertEditingId = null;
  document.getElementById('nk-concert-status').innerHTML = NK_STATUSES.map(st => `<option>${st}</option>`).join('');

  function openNkConcertModal(c) {
    nkConcertEditingId = c ? c.id : null;
    document.getElementById('nk-concert-modal-heading').textContent = c ? 'Konzert bearbeiten' : 'Neues Konzert';
    document.getElementById('nk-concert-submit').textContent = c ? 'Speichern' : 'Anlegen';
    document.getElementById('nk-concert-title').value = c ? c.title : '';
    document.getElementById('nk-concert-date').value = c ? (c.date || '') : '';
    document.getElementById('nk-concert-time').value = c && c.time ? c.time.slice(0, 5) : '';
    document.getElementById('nk-concert-location').value = c ? (c.location || '') : '';
    document.getElementById('nk-concert-status').value = c ? (c.status || 'Planung') : 'Planung';
    document.getElementById('nk-concert-notes').value = c ? (c.notes || '') : '';
    nkConcertModal.classList.remove('hidden');
    setTimeout(() => document.getElementById('nk-concert-title').focus(), 0);
  }
  document.getElementById('nk-concert-new-btn').addEventListener('click', () => openNkConcertModal(null));
  document.getElementById('nk-concert-cancel').addEventListener('click', () => nkConcertModal.classList.add('hidden'));
  nkConcertModal.addEventListener('click', (e) => { if (e.target === nkConcertModal) nkConcertModal.classList.add('hidden'); });
  document.getElementById('nk-concert-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      title: document.getElementById('nk-concert-title').value.trim(),
      date: document.getElementById('nk-concert-date').value || null,
      time: document.getElementById('nk-concert-time').value || null,
      location: document.getElementById('nk-concert-location').value.trim() || null,
      status: document.getElementById('nk-concert-status').value,
      notes: document.getElementById('nk-concert-notes').value.trim() || null,
    };
    if (!payload.title) return;
    try {
      if (!nkConcertEditingId) nkConcertFolder = 'contracts';
      nkConcertDetail = nkConcertEditingId
        ? await api(`/api/nk/concerts/${nkConcertEditingId}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/nk/concerts', { method: 'POST', body: JSON.stringify(payload) });
      nkConcertModal.classList.add('hidden');
      document.getElementById('nk-projects-list-view').classList.add('hidden');
      document.getElementById('nk-concert-detail-view').classList.remove('hidden');
      renderNkConcertDetail();
    } catch (err) { alert(err.message); }
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
    // Fenster fuer die zweite Jahreshaelfte sofort auf den Jahreskalender stellen, nicht erst
    // nachdem alle anderen Bereiche geladen sind - sonst sieht man vorher kurz andere Seiten.
    if (ycHalf === 'h2') switchTab('yearcalendar', { restore: true });
    await loadAccount();
    applyTabPermissions();
    await loadPeople();
    // Nur laden, was fuer die freigegebenen Reiter gebraucht wird (Server lehnt den Rest ohnehin ab)
    if (can('people') || can('timetracking')) await loadToolStartDate();
    if (['tasks', 'calendar', 'people', 'yearcalendar'].some(can)) await loadProjects();
    if (can('tasks') || can('timetracking')) await loadActiveTimers();
    if (can('tasks') || can('calendar') || can('contracts')) await loadTasks();
    if (can('timetracking')) { await loadTimeEntries(); await loadWarnings(); }
    applyRoleRestrictions();
    resetTimeForm();

    const allowed = MOBILE_TAB_ORDER.filter(can);
    if (ycHalf === 'h2' && can('yearcalendar')) {
      // bereits oben aktiviert
    } else if (!allowed.length) {
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('page-title').textContent = 'Keine Bereiche freigegeben';
      document.querySelector('main').insertAdjacentHTML('afterbegin', '<div class="empty-card"><div class="empty-card-icon">🔒</div><strong>Für dein Konto sind noch keine Bereiche freigegeben.</strong><span>Bitte an einen Admin wenden.</span></div>');
    } else {
      let last = null;
      try { last = localStorage.getItem('office_last_tab'); } catch (e) { /* egal */ }
      const sidebarOrder = [...document.querySelectorAll('.sidebar .tab-btn')].map(b => b.dataset.tab).filter(can);
      const start = last && can(last) ? last : sidebarOrder[0];
      switchTab(start, { restore: true, noScroll: true });
    }
    refreshNkBadges();
    setInterval(refreshNkBadges, 60000);
  }
  init();
})();
