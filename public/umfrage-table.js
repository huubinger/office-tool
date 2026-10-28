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
  // Kurzform fuer schmale Spalten: kuerzester eindeutiger Anfang, mindestens zwei Buchstaben
  function castShort(names, n) {
    if (n.length <= 4) return n;
    for (let k = 2; k < n.length; k++) {
      const pre = n.slice(0, k).toLowerCase();
      if (!names.some(x => x !== n && x.toLowerCase().startsWith(pre))) return n.slice(0, k);
    }
    return n;
  }
  // Legende in der Rollen-Zelle: Farbe, Name, Anzahl Shows (+ Ersatztermine)
  const castLegendHtml = (s, role) => `<ul class="sv-legend">${castOf(s, role).map((n, i) => {
    const e = castCount(s, role, n, true);
    return `<li class="sv-cast-i${i % 4}"><i></i><span>${esc(n)}</span><b title="${castCount(s, role, n)} Shows">${castCount(s, role, n)}</b>${e ? `<em title="dazu ${e} Ersatztermin${e === 1 ? '' : 'e'}">+${e}</em>` : ''}</li>`;
  }).join('')}</ul>`;
  const castClass = (s, role, people) => (people.length > 1 ? ' sv-cast-set sv-cast-both' : people.length ? ` sv-cast-set sv-cast-i${castOf(s, role).indexOf(people[0]) % 4}` : '');
  // Zelle der Besetzung: Name (lang/kurz je nach Spaltenbreite), bearbeitbar ueber eine unsichtbare Auswahl darueber
  function castCellHtml(s, role, ri, o, editable, colCls = '') {
    const names = castOf(s, role);
    const people = castPeople(s, role, o.id);
    const v = people.join('/');
    const all = people.length > 1 && people.length === names.length;
    const full = people.length > 1 ? (all ? (names.length === 2 ? 'beide' : 'alle') : people.join(' + ')) : v;
    const short = people.length > 1 ? people.map(n => n[0]).join('+') : (v ? castShort(names, v) : '');
    let select = '';
    if (editable && o.id) {
      const choices = names.map(n => [n, n]);
      if (isErsatz(o) && names.length > 1) choices.push([names.join('/'), names.length === 2 ? 'beide' : 'alle']);
      if (v && !choices.some(([val]) => val === v)) choices.push([v, people.join(' + ')]);
      select = `<select data-sv-cast="${ri}:${o.id}" aria-label="${esc(role)}, ${esc(o.label || fmtDate(o.date))}: wer spielt?">
        <option value="">–</option>${choices.map(([val, label]) => `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    }
    const tip = people.length ? people.join(' + ') : (select ? 'Auswählen, wer spielt' : '');
    return `<td class="sv-cell sv-cast${castClass(s, role, people)}${select ? ' sv-cast-edit' : ''} ${colCls}" title="${esc(tip)}"><div class="sv-cc">${v
      ? `<span class="sv-cc-full">${esc(full)}</span><span class="sv-cc-short">${esc(short)}</span>` : '<span class="sv-cc-empty"></span>'}${select}</div></td>`;
  }

  // Spalten-Klassen: Ersatztermin, Beginn eines neuen Monats (Trennlinie)
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const monthKey = (o) => (o.date || '').slice(0, 7);
  function colClasses(opts) {
    const m = new Map();
    opts.forEach((o, i) => m.set(o, [isErsatz(o) && 'sv-ersatz', i > 0 && monthKey(o) !== monthKey(opts[i - 1]) && 'sv-mstart'].filter(Boolean).join(' ')));
    return m;
  }
  // Monatszeile: aufeinanderfolgende Termine eines Monats zusammengefasst ("März 2027")
  function monthCells(opts, tag = 'th') {
    const groups = [];
    opts.forEach(o => {
      const k = monthKey(o);
      if (groups.length && groups[groups.length - 1].k === k) groups[groups.length - 1].n++;
      else groups.push({ k, n: 1 });
    });
    return groups.map((g, i) => {
      const label = g.k ? `${MONTHS[+g.k.slice(5, 7) - 1]} ${g.k.slice(0, 4)}` : 'ohne Datum';
      const short = g.k ? `${MONTHS[+g.k.slice(5, 7) - 1].slice(0, 3)} ${g.k.slice(2, 4)}` : 'o. D.';
      return `<${tag} class="sv-month${i > 0 ? ' sv-mstart' : ''}" colspan="${g.n}" data-n="${Math.min(g.n, 3)}" title="${esc(label)}"><span class="sv-ml">${esc(label)}</span><span class="sv-ms">${esc(short)}</span></${tag}>`;
    }).join('');
  }
  // Datum im Spaltenkopf: Tag und Monat getrennt, damit in schmalen Spalten nur der Tag stehen kann
  const dateHtml = (iso) => (iso ? `<span class="sv-dd">${iso.slice(8, 10)}.</span><span class="sv-dm">${iso.slice(5, 7)}.</span>` : '');
  // Dichte je nach tatsaechlicher Spaltenbreite (wide / mid / narrow) fuer kompaktere Koepfe
  function fit(root) {
    (root || document).querySelectorAll('table.sv-fit').forEach(t => {
      const cell = t.querySelector('.sv-h-date th, .svg-dates th.svg-date');
      if (!cell) return;
      const w = cell.getBoundingClientRect().width;
      t.dataset.density = w < 50 ? 'narrow' : w < 72 ? 'mid' : 'wide';
    });
  }
  let fitTimer = null;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fit(document), 120); });

  // Gleiche Uhrzeit fuer alle Termine eines Abschnitts: einmal vorne statt in jeder Spalte
  const fmtTime = (t) => (/^\d{1,2}([:.]\d{2})?$/.test(t) ? `${t} Uhr` : t);
  function commonTime(opts) {
    const times = [...new Set(opts.map(o => o.time).filter(Boolean))];
    return times.length === 1 ? times[0] : null;
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
    const tables = sections(s.options).map(sec => {
      const os = sec.options;
      const cc = colClasses(os);
      const one = commonTime(os);
      const timeRow = !one && os.some(o => o.time);
      const head = `
        <tr class="sv-h-month"><th class="sv-name sv-sec" rowspan="${timeRow ? 5 : 4}"><span>${esc(sec.name || 'Termine')}</span>${one ? `<small>jeweils ${esc(fmtTime(one))}</small>` : ''}</th>${monthCells(os)}</tr>
        <tr class="sv-h-label">${os.map(o => `<th class="${cc.get(o)}" title="${esc([o.label, o.note].filter(Boolean).join(' · '))}">${esc(o.label || '')}</th>`).join('')}</tr>
        <tr class="sv-h-date">${os.map(o => `<th class="${cc.get(o)}" title="${esc(o.date ? `${weekday(o.date)}, ${fmtDate(o.date)}` : '')}">${dateHtml(o.date)}</th>`).join('')}</tr>
        <tr class="sv-h-day">${os.map(o => `<th class="${cc.get(o)}">${esc(weekday(o.date).slice(0, 2))}</th>`).join('')}</tr>
        ${timeRow ? `<tr class="sv-h-time">${os.map(o => `<th class="${cc.get(o)}">${esc(o.time || '')}</th>`).join('')}</tr>` : ''}`;
      const body = people.length ? people.map(p => {
        if (p.cast) {
          return `<tr class="sv-cast-row"><th class="sv-name"><div class="sv-role">${esc(p.role)}</div>${castLegendHtml(s, p.role)}</th>
            ${os.map(o => castCellHtml(s, p.role, p.ri, o, opts.canEditCast, cc.get(o))).join('')}</tr>`;
        }
        const r = p.response;
        // opts.clickable: Name oeffnet die Antwort; opts.canEdit(r): Zellen per Klick umschalten;
        // opts.claim: leere Rollen-Zeilen bekommen einen "eintragen"-Knopf
        const nameAttrs = r && opts.clickable ? ` data-sv-response="${r.id}" tabindex="0"` : '';
        const own = r && opts.ownId === r.id ? ' sv-own' : '';
        const editable = r && opts.canEdit && opts.canEdit(r);
        return `<tr class="${editable ? 'sv-row-edit' : ''}">
          <th class="sv-name${r ? '' : ' sv-open'}${own}${nameAttrs ? ' sv-click' : ''}"${nameAttrs}>${p.role ? `<div class="sv-role">${esc(p.role)}</div>` : ''}${p.name ? `<span class="sv-person">${esc(p.name)}</span>` : ''}${r && r.comment ? ` <span class="sv-comment" title="${esc(r.comment)}">💬</span>` : ''}${!r && opts.claim ? ` <button type="button" class="sv-claim" data-sv-claim="${esc(p.role)}">eintragen</button>` : ''}</th>
          ${os.map(o => {
            const v = r ? r.answers[o.id] : null;
            return `<td class="sv-cell ${v ? 'sv-' + v : ''}${editable ? ' sv-editable' : ''} ${cc.get(o)}"${editable ? ` data-sv-cell="${r.id}:${o.id}" tabindex="0"` : ''}>${v ? SYMBOL[v] : ''}</td>`;
          }).join('')}
        </tr>`;
      }).join('') : `<tr><th class="sv-name sv-open">Noch keine Antworten</th>${os.map(o => `<td class="${cc.get(o)}"></td>`).join('')}</tr>`;
      const count = (o, v) => s.responses.filter(r => r.answers[o.id] === v).length;
      const foot = `<tr class="sv-sum"><th class="sv-name">Zusagen</th>${os.map(o => {
        const maybe = count(o, 'maybe');
        return `<td class="${cc.get(o)}">${count(o, 'yes') + castFilled(s, o.id)}${maybe ? `<small>+${maybe}?</small>` : ''}</td>`;
      }).join('')}</tr>`;
      return `<div class="sv-table-wrap"><table class="sv-table sv-fit" style="--sv-cols:${os.length}"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
    }).join('');
    return tables + noteHtml(s);
  }
  // Erklaerung unter der Tabelle (nur wenn es Ersatztermine gibt)
  function noteHtml(s) {
    if (!s.options.some(isErsatz)) return '';
    const cast = Object.keys(s.cast || {}).length;
    return `<p class="sv-note"><span class="sv-swatch"></span>Ersatztermin – zählt nicht zur Showzahl${cast ? '; hier dürfen auch beide eingetragen sein, wenn beide Zeit haben' : ''}.</p>`;
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

  window.SurveyTable = { render, sections, fmtDate, weekday, esc, nextValue, SYMBOL, statsHtml, bindStats, hasPerson, castOf, castCellHtml, castLegendHtml, castFilled, isErsatz, ordered, colClasses, monthCells, commonTime, fmtTime, noteHtml, dateHtml, fit };
})();
