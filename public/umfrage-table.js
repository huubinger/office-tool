// Ergebnistabelle einer Umfrage (Rollen bzw. Teilnehmer x Termine) – genutzt im Reiter
// "Umfragen" und auf der oeffentlichen Seite /u/<token>.
(function () {
  const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const SYMBOL = { yes: '✓', maybe: '?', no: '✗' };
  const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}` : '');
  const weekday = (iso) => (iso ? WEEKDAYS[new Date(iso + 'T00:00:00').getDay()] : '');

  function sections(options) {
    const out = [];
    options.forEach(o => {
      const key = o.section || '';
      let sec = out.find(x => x.name === key);
      if (!sec) out.push(sec = { name: key, options: [] });
      sec.options.push(o);
    });
    return out;
  }

  // Besetzung einer Rolle ("SONJA: Anna / Berta"): wer spielt welchen Termin
  const castOf = (s, role) => (s.cast || {})[role] || null;
  const castCell = (s, role, oid) => ((s.cast_cells || {})[role] || {})[oid] || '';
  const castCount = (s, role, name) => Object.values((s.cast_cells || {})[role] || {}).filter(n => n === name).length;
  const castFilled = (s, oid) => Object.values(s.cast_cells || {}).filter(c => c[oid]).length;
  // Namen mit Zaehler, z.B. "Anna 9 · Berta 8"
  const castNamesHtml = (s, role) => castOf(s, role).map(n => `${esc(n)} <small class="sv-cast-n">${castCount(s, role, n)}</small>`).join(' · ');
  // Zelle der Besetzung: Auswahl der Namen (bearbeitbar) oder nur der Name
  function castCellHtml(s, role, ri, o, editable) {
    const v = castCell(s, role, o.id);
    if (!editable || !o.id) return `<td class="sv-cell sv-cast${v ? ' sv-cast-set' : ''}">${esc(v)}</td>`;
    return `<td class="sv-cell sv-cast${v ? ' sv-cast-set' : ''}"><select data-sv-cast="${ri}:${o.id}" aria-label="${esc(role)}: wer spielt?">
      <option value="">–</option>${castOf(s, role).map(n => `<option ${v === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></td>`;
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

  function render(s, opts = {}) {
    if (!s.options.length) return '<p class="empty-state">Noch keine Termine angelegt.</p>';
    const people = rows(s);
    return sections(s.options).map(sec => {
      const hasTime = sec.options.some(o => o.time);
      const head = `
        <tr class="sv-h-label"><th class="sv-name">${esc(sec.name)}</th>${sec.options.map(o => `<th title="${esc(o.note || '')}">${esc(o.label || '')}</th>`).join('')}</tr>
        <tr class="sv-h-date"><th class="sv-name"></th>${sec.options.map(o => `<th>${fmtDate(o.date)}</th>`).join('')}</tr>
        <tr class="sv-h-day"><th class="sv-name"></th>${sec.options.map(o => `<th>${esc(weekday(o.date).slice(0, 2))}</th>`).join('')}</tr>
        ${hasTime ? `<tr class="sv-h-time"><th class="sv-name"></th>${sec.options.map(o => `<th>${esc(o.time || '')}</th>`).join('')}</tr>` : ''}`;
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
            return `<td class="sv-cell ${v ? 'sv-' + v : ''}${editable ? ' sv-editable' : ''}"${editable ? ` data-sv-cell="${r.id}:${o.id}" tabindex="0"` : ''}>${v ? SYMBOL[v] : ''}</td>`;
          }).join('')}
        </tr>`;
      }).join('') : `<tr><th class="sv-name sv-open">Noch keine Antworten</th>${sec.options.map(() => '<td></td>').join('')}</tr>`;
      const count = (o, v) => s.responses.filter(r => r.answers[o.id] === v).length;
      const foot = `<tr class="sv-sum"><th class="sv-name">Zusagen</th>${sec.options.map(o => {
        const maybe = count(o, 'maybe');
        return `<td>${count(o, 'yes') + castFilled(s, o.id)}${maybe ? `<small>+${maybe}?</small>` : ''}</td>`;
      }).join('')}</tr>`;
      return `<div class="sv-table-wrap"><table class="sv-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
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
    const shows = s.options.filter(o => /auff[üu]hrung|show|vorstellung/i.test(o.section || ''));
    return shows.length ? shows : s.options;
  }
  const DAY_ORDER = [4, 5, 6, 0, 1, 2, 3]; // Do, Fr, Sa, So zuerst
  // Alle Personen: Teilnehmer (Zusagen) und Besetzung (eingetragen in der Rollen-Zeile)
  function people(s) {
    const out = s.responses.map(r => ({ key: 'r' + r.id, name: r.name, role: r.role, plays: (o) => r.answers[o.id] === 'yes', maybe: (o) => r.answers[o.id] === 'maybe' }));
    (s.roles || []).forEach(role => (castOf(s, role) || []).forEach(n => out.push({
      key: `c:${role}:${n}`, name: n, role, plays: (o) => castCell(s, role, o.id) === n, maybe: () => false,
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
        <div class="sv-stat-main"><strong>${mine.length}</strong><span>von ${shows.length} Shows${maybe ? ` · ${maybe} vielleicht` : ''}</span></div>
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

  window.SurveyTable = { render, sections, fmtDate, weekday, esc, nextValue, SYMBOL, statsHtml, bindStats, hasPerson, castOf, castCellHtml, castNamesHtml, castFilled };
})();
