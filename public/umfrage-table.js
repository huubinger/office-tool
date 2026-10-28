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

  // Zeilen in Rollen-Reihenfolge; Rollen ohne Antwort bleiben als leere Zeile sichtbar
  function rows(s) {
    const out = [];
    (s.roles || []).forEach(role => {
      const rs = s.responses.filter(r => r.role === role);
      if (!rs.length) out.push({ role, name: '', response: null });
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
        const r = p.response;
        const attrs = r && opts.clickable ? ` class="sv-click" data-sv-response="${r.id}" tabindex="0"` : '';
        const own = r && opts.ownId === r.id ? ' sv-own' : '';
        return `<tr${attrs}>
          <th class="sv-name${r ? '' : ' sv-open'}${own}">${p.role ? `<strong>${esc(p.role)}</strong>` : ''}${p.role && p.name ? ' ' : ''}${p.name ? `<span>${esc(p.name)}</span>` : ''}${r && r.comment ? ` <span class="sv-comment" title="${esc(r.comment)}">💬</span>` : ''}</th>
          ${sec.options.map(o => {
            const v = r ? r.answers[o.id] : null;
            return `<td class="sv-cell ${v ? 'sv-' + v : ''}">${v ? SYMBOL[v] : ''}</td>`;
          }).join('')}
        </tr>`;
      }).join('') : `<tr><th class="sv-name sv-open">Noch keine Antworten</th>${sec.options.map(() => '<td></td>').join('')}</tr>`;
      const count = (o, v) => s.responses.filter(r => r.answers[o.id] === v).length;
      const foot = `<tr class="sv-sum"><th class="sv-name">Zusagen</th>${sec.options.map(o => {
        const maybe = count(o, 'maybe');
        return `<td>${count(o, 'yes')}${maybe ? `<small>+${maybe}?</small>` : ''}</td>`;
      }).join('')}</tr>`;
      return `<div class="sv-table-wrap"><table class="sv-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
    }).join('');
  }

  window.SurveyTable = { render, sections, fmtDate, weekday, esc };
})();
