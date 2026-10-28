// Ergebnistabelle einer Umfrage (Rollen bzw. Teilnehmer x Termine) – genutzt im Reiter
// "Umfragen" und auf der oeffentlichen Seite /u/<token>.
(function () {
  const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const SYMBOL = { yes: '✓', maybe: '?', no: '✗' };
  const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}` : '');
  const weekday = (iso) => (iso ? WEEKDAYS[new Date(iso + 'T00:00:00').getDay()] : '');

  // Ersatztermin: "Ersatz" steht im Abschnitt oder in der Bezeichnung
  const isErsatz = (o) => /ersatz/i.test(o.section || '') || /ersatz/i.test(o.label || '');
  const isShowSection = (name) => /auff[üu]hrung|show|vorstellung/i.test(name || '');

  // Abschnitte in Reihenfolge; Ersatztermine laufen chronologisch zwischen den Aufführungen mit
  function sections(options) {
    const out = [];
    options.forEach(o => {
      const key = o.section || '';
      let sec = out.find(x => x.name === key);
      if (!sec) out.push(sec = { name: key, options: [] });
      sec.options.push(o);
    });
    const ersatzSec = (sec) => /ersatz/i.test(sec.name);
    const main = out.find(sec => isShowSection(sec.name) && !ersatzSec(sec)) || out.find(sec => !ersatzSec(sec));
    if (main) {
      out.filter(ersatzSec).forEach(sec => { main.options.push(...sec.options); out.splice(out.indexOf(sec), 1); });
    }
    out.forEach(sec => {
      // nach Datum (stabil), damit nachgetragene Termine an der richtigen Stelle stehen; ohne Datum bleiben hinten
      sec.options = sec.options.map((o, i) => ({ o, i })).sort((a, b) => {
        if (a.o.date && b.o.date) return a.o.date < b.o.date ? -1 : a.o.date > b.o.date ? 1 : a.i - b.i;
        if (a.o.date || b.o.date) return a.o.date ? -1 : 1;
        return a.i - b.i;
      }).map(x => x.o);
    });
    return out;
  }
  const ordered = (options) => sections(options).flatMap(sec => sec.options);

  // Besetzung einer Rolle ("SONJA: Anna / Berta"): wer spielt welchen Termin
  // Bei Ersatzterminen duerfen mehrere eingetragen sein ("Anna/Berta")
  const castOf = (s, role) => (s.cast || {})[role] || null;
  const castCell = (s, role, oid) => ((s.cast_cells || {})[role] || {})[oid] || '';
  const castPeople = (s, role, oid) => castCell(s, role, oid).split('/').filter(Boolean);
  // Shows je Person - Ersatztermine zaehlen nicht mit
  const castCount = (s, role, name, ersatz = false) => s.options.filter(o => isErsatz(o) === ersatz && castPeople(s, role, o.id).includes(name)).length;
  const castFilled = (s, oid) => Object.keys(s.cast_cells || {}).reduce((n, role) => n + castPeople(s, role, oid).length, 0);
  // Namen mit Zaehler, z.B. "Anna 9 · Berta 8"; Farbe je Person wie in den Zellen
  const castNamesHtml = (s, role) => castOf(s, role).map((n, i) => {
    const e = castCount(s, role, n, true);
    return `<span class="sv-cast-p sv-cast-i${i % 4}">${esc(n)} <small class="sv-cast-n">${castCount(s, role, n)}</small>${e ? `<small class="sv-cast-e">+${e} Ersatz</small>` : ''}</span>`;
  }).join(' ');
  const castClass = (s, role, people) => (people.length > 1 ? ' sv-cast-set sv-cast-both' : people.length ? ` sv-cast-set sv-cast-i${castOf(s, role).indexOf(people[0]) % 4}` : '');
  // Zelle der Besetzung: Auswahl der Namen (bearbeitbar) oder nur der Name
  function castCellHtml(s, role, ri, o, editable) {
    const names = castOf(s, role);
    const people = castPeople(s, role, o.id);
    const v = people.join('/');
    const text = people.length > 1 ? (people.length === names.length ? (names.length === 2 ? 'beide' : 'alle') : people.join(' + ')) : v;
    const cls = `sv-cell sv-cast${castClass(s, role, people)}${isErsatz(o) ? ' sv-ersatz' : ''}`;
    if (!editable || !o.id) return `<td class="${cls}" title="${esc(people.join(' + '))}">${esc(text)}</td>`;
    const choices = names.map(n => [n, n]);
    if (isErsatz(o) && names.length > 1) choices.push([names.join('/'), names.length === 2 ? 'beide' : 'alle']);
    if (v && !choices.some(([val]) => val === v)) choices.push([v, people.join(' + ')]);
    return `<td class="${cls}" title="${esc(people.join(' + '))}"><select data-sv-cast="${ri}:${o.id}" aria-label="${esc(role)}: wer spielt?">
      <option value="">–</option>${choices.map(([val, label]) => `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></td>`;
  }

  // Zeilen in Rollen-Reihenfolge; Rollen ohne Antwort bleiben als leere Zeile sichtbar
  function rows(s) {
    const out = [];
    (s.roles || []).forEach((role, ri) => {
      const rs = s.responses.filter(r => r.role === role);
      if (castOf(s, role)) out.push({ role, ri, cast: true });
      else if (!rs.length) out.push({ role, name: '', response: null });
      rs.forEach(r => out.push({ role, name: r.name, response: r }));
    });
    s.responses.filter(r => !r.role || !(s.roles || []).includes(r.role)).forEach(r => out.push({ role: '', name: r.name, response: r }));
    return out;
  }

  const ec = (o) => (isErsatz(o) ? 'sv-ersatz' : '');
  function render(s, opts = {}) {
    if (!s.options.length) return '<p class="empty-state">Noch keine Termine angelegt.</p>';
    const people = rows(s);
    return sections(s.options).map(sec => {
      const hasTime = sec.options.some(o => o.time);
      const head = `
        <tr class="sv-h-label"><th class="sv-name">${esc(sec.name)}</th>${sec.options.map(o => `<th class="${ec(o)}" title="${esc([o.section, o.label, o.note].filter(Boolean).join(' · '))}">${esc(o.label || '')}</th>`).join('')}</tr>
        <tr class="sv-h-date"><th class="sv-name"></th>${sec.options.map(o => `<th class="${ec(o)}">${fmtDate(o.date).slice(0, 6)}</th>`).join('')}</tr>
        <tr class="sv-h-day"><th class="sv-name"></th>${sec.options.map(o => `<th class="${ec(o)}">${esc(weekday(o.date).slice(0, 2))}</th>`).join('')}</tr>
        ${hasTime ? `<tr class="sv-h-time"><th class="sv-name"></th>${sec.options.map(o => `<th class="${ec(o)}">${esc(o.time || '')}</th>`).join('')}</tr>` : ''}`;
      const body = people.length ? people.map(p => {
        if (p.cast) {
          return `<tr class="sv-cast-row"><th class="sv-name"><strong>${esc(p.role)}</strong> <span class="sv-cast-names">${castNamesHtml(s, p.role)}</span></th>
            ${sec.options.map(o => castCellHtml(s, p.role, p.ri, o, opts.canEditCast)).join('')}</tr>`;
        }
        const r = p.response;
        // opts.clickable: Name oeffnet die Antwort; opts.canEdit(r): Zellen per Klick umschalten;
        // opts.claim: leere Rollen-Zeilen bekommen einen "eintragen"-Knopf
        const nameAttrs = r && opts.clickable ? ` data-sv-response="${r.id}" tabindex="0"` : '';
        const own = r && opts.ownId === r.id ? ' sv-own' : '';
        const editable = r && opts.canEdit && opts.canEdit(r);
        return `<tr class="${editable ? 'sv-row-edit' : ''}">
          <th class="sv-name${r ? '' : ' sv-open'}${own}${nameAttrs ? ' sv-click' : ''}"${nameAttrs}>${p.role ? `<strong>${esc(p.role)}</strong>` : ''}${p.role && p.name ? ' ' : ''}${p.name ? `<span>${esc(p.name)}</span>` : ''}${r && r.comment ? ` <span class="sv-comment" title="${esc(r.comment)}">💬</span>` : ''}${!r && opts.claim ? ` <button type="button" class="sv-claim" data-sv-claim="${esc(p.role)}">eintragen</button>` : ''}</th>
          ${sec.options.map(o => {
            const v = r ? r.answers[o.id] : null;
            return `<td class="sv-cell ${v ? 'sv-' + v : ''}${editable ? ' sv-editable' : ''} ${ec(o)}"${editable ? ` data-sv-cell="${r.id}:${o.id}" tabindex="0"` : ''}>${v ? SYMBOL[v] : ''}</td>`;
          }).join('')}
        </tr>`;
      }).join('') : `<tr><th class="sv-name sv-open">Noch keine Antworten</th>${sec.options.map(() => '<td></td>').join('')}</tr>`;
      const count = (o, v) => s.responses.filter(r => r.answers[o.id] === v).length;
      const foot = `<tr class="sv-sum"><th class="sv-name">Zusagen</th>${sec.options.map(o => {
        const maybe = count(o, 'maybe');
        return `<td>${count(o, 'yes') + castFilled(s, o.id)}${maybe ? `<small>+${maybe}?</small>` : ''}</td>`;
      }).join('')}</tr>`;
      return `<div class="sv-table-wrap"><table class="sv-table sv-fit" style="--sv-cols:${sec.options.length}"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
    }).join('');
  }

  // Klick auf eine Zelle: leer → ✓ → ? → ✗ → leer
  function nextValue(v, allowMaybe) {
    const order = allowMaybe ? ['', 'yes', 'maybe', 'no'] : ['', 'yes', 'no'];
    return order[(order.indexOf(v || '') + 1) % order.length] || undefined;
  }

  // ---- Auswertung je Person: Anzahl Shows, Wochentage, mit wem wie oft ----
  // Gezaehlt werden die Termine im Abschnitt "Aufführungen"/"Shows" (gibt es keinen, alle Termine).
  function showOptions(s) {
    const regular = s.options.filter(o => !isErsatz(o));
    const shows = regular.filter(o => isShowSection(o.section));
    return shows.length ? shows : regular;
  }
  const DAY_ORDER = [4, 5, 6, 0, 1, 2, 3]; // Do, Fr, Sa, So zuerst
  // Alle Personen: Teilnehmer (Zusagen) und Besetzung (eingetragen in der Rollen-Zeile)
  function people(s) {
    const out = s.responses.map(r => ({ key: 'r' + r.id, name: r.name, role: r.role, plays: (o) => r.answers[o.id] === 'yes', maybe: (o) => r.answers[o.id] === 'maybe' }));
    (s.roles || []).forEach(role => (castOf(s, role) || []).forEach(n => out.push({
      key: `c:${role}:${n}`, name: n, role, plays: (o) => castPeople(s, role, o.id).includes(n), maybe: () => false,
    })));
    return out;
  }
  const hasPerson = (s, key) => !!key && people(s).some(p => p.key === key);
  function statsBody(s, key) {
    const all = people(s);
    const me = all.find(p => p.key === key);
    if (!me) return '<p class="empty-state">Namen auswählen.</p>';
    const shows = showOptions(s);
    const mine = shows.filter(o => me.plays(o));
    const maybe = shows.filter(o => me.maybe(o)).length;
    const ersatz = s.options.filter(o => isErsatz(o) && me.plays(o)).length;
    const days = {};
    mine.forEach(o => { const d = o.date ? new Date(o.date + 'T00:00:00').getDay() : 'x'; days[d] = (days[d] || 0) + 1; });
    const tiles = DAY_ORDER.filter(d => d >= 4 || d === 0 || days[d]).map(d => `<div><strong>${days[d] || 0}</strong><span>${WEEKDAYS[d]}</span></div>`);
    if (days.x) tiles.push(`<div><strong>${days.x}</strong><span>ohne Datum</span></div>`);
    const partners = all.filter(p => p.key !== me.key)
      .map(r => ({ r, n: mine.filter(o => r.plays(o)).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n || a.r.name.localeCompare(b.r.name, 'de'));
    const max = partners.length ? partners[0].n : 1;
    return `
      <div class="sv-stat-tiles">
        <div class="sv-stat-main"><strong>${mine.length}</strong><span>von ${shows.length} Shows${maybe ? ` · ${maybe} vielleicht` : ''}${ersatz ? ` · dazu ${ersatz} Ersatz` : ''}</span></div>
        ${tiles.join('')}
      </div>
      <h4 class="sv-stat-head">Mit wem wie oft</h4>
      ${partners.length ? `<div class="sv-partners">${partners.map(x => `
        <div class="sv-partner"><span class="sv-partner-name"><strong>${esc(x.r.name)}</strong>${x.r.role ? ` <small>${esc(x.r.role)}</small>` : ''}</span>
          <span class="sv-partner-bar"><i style="width:${Math.round(x.n / max * 100)}%"></i></span><span class="sv-partner-n">${x.n}×</span></div>`).join('')}</div>`
        : '<p class="empty-state">Noch keine gemeinsamen Shows.</p>'}`;
  }
  function statsHtml(s, key) {
    const all = people(s);
    if (!all.length) return '';
    const sorted = all.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return `<div class="sv-stats">
      <div class="sv-stats-head"><h3>📊 Auswertung</h3>
        <select data-sv-stats aria-label="Name auswählen"><option value="">— Namen auswählen —</option>${sorted.map(p =>
          `<option value="${esc(p.key)}" ${p.key === key ? 'selected' : ''}>${esc(p.name)}${p.role ? ` (${esc(p.role)})` : ''}</option>`).join('')}</select></div>
      <div data-sv-stats-body>${key ? statsBody(s, key) : '<p class="empty-state">Namen auswählen, um zu sehen, wie viele Shows man spielt, an welchen Wochentagen und mit wem wie oft.</p>'}</div>
    </div>`;
  }
  // Auswahl verdrahten; onPick merkt sich die Auswahl beim Neuaufbau
  function bindStats(root, s, onPick) {
    const sel = root.querySelector('[data-sv-stats]');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const key = sel.value || null;
      root.querySelector('[data-sv-stats-body]').innerHTML = key ? statsBody(s, key) : '';
      if (onPick) onPick(key);
    });
  }

  window.SurveyTable = { render, sections, fmtDate, weekday, esc, nextValue, SYMBOL, statsHtml, bindStats, hasPerson, castOf, castCellHtml, castNamesHtml, castFilled, isErsatz, ordered };
})();
