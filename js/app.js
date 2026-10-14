(function (TV) {
  'use strict';
  if (typeof document === 'undefined' || !TV.store || !TV.util) return;

  const U = TV.util;
  const el = U.el;
  const store = TV.store;
  const $ = (id) => document.getElementById(id);

  const SIDE_MIN = 300, SIDE_MAX = 640, SIDE_DEFAULT = 380;
  const MIN_DURS = [0, 1, 5, 10, 50, 100];
  const THEMES = ['auto', 'light', 'dark'];
  const GROUP_SHORT = { service: 'Service', namespace: 'Namespace', scope: 'Scope' };
  const GROUP_NOUN = { service: ['service', 'services'], namespace: ['namespace', 'namespaces'], scope: ['scope', 'scopes'] };
  const TAB_COUNTS = { svc: (m) => m.stats.groupCount, tree: (m) => m.stats.spanCount };

  // ---------------------------------------------------------------- helpers

  function lsGet(k) { try { return localStorage.getItem('tv.' + k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem('tv.' + k, String(v)); } catch (e) { /* storage blocked */ } }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const plural = (n, one, many) => U.fmtCount(n) + ' ' + (n === 1 ? one : many);

  const ICONS = {
    copy: ['M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z', 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    search: ['M17 11a6 6 0 1 1-12 0a6 6 0 1 1 12 0z', 'M20 20l-4.5-4.5'],
    sun: ['M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0z', 'M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4'],
    moon: ['M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z'],
    auto: ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z', { d: 'M12 3a9 9 0 0 1 0 18z', fill: true }],
    panel: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M15 5v14'],
    x: ['M7 7l10 10M17 7L7 17'],
    upload: ['M12 15V4', 'M7.5 8.5L12 4l4.5 4.5', 'M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4'],
    logo: ['M4 6.5h9', 'M7 11h12', 'M10 15.5h7', 'M4 20h16'],
  };

  function icon(name, size) {
    const s = U.svg('svg', {
      viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'app-icon',
    });
    for (const p of ICONS[name] || []) {
      if (typeof p === 'string') s.appendChild(U.svg('path', { d: p }));
      else s.appendChild(U.svg('path', { d: p.d, fill: 'currentColor', stroke: 'none' }));
    }
    return s;
  }

  function isTypingTarget(t) {
    if (!t || t === document.body) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = (t.type || 'text').toLowerCase();
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
    }
    return false;
  }

  // ---------------------------------------------------------------- DOM refs

  const R = {
    app: $('app'), meta: $('app-meta'), trace: $('app-trace'), groupby: $('app-groupby'),
    open: $('app-open'), paste: $('app-paste'), theme: $('app-theme'), file: $('app-file'),
    banner: $('app-banner'), toolbar: $('app-toolbar'), search: $('app-search'), cats: $('app-cats'),
    errors: $('app-errors'), mindur: $('app-mindur'), focus: $('app-focus'), clear: $('app-clear'), match: $('app-match'),
    tablist: $('app-tablist'), sideToggle: $('app-side-toggle'),
    body: $('app-body'), main: $('app-main'), resizer: $('app-resizer'), side: $('app-side'), empty: $('app-empty'),
    drop: $('app-drop'), dialog: $('app-paste-dialog'), dialogForm: $('app-paste-form'), dialogText: $('app-paste-text'),
    dialogError: $('app-paste-error'), dialogCancel: $('app-paste-cancel'),
  };
  if (!R.app) return;

  // ---------------------------------------------------------------- views + api

  const mainDefs = TV.views.list().filter((d) => d.slot !== 'side');
  const sideDef = TV.views.list().find((d) => d.slot === 'side') || null;
  const instances = new Map(); // id → { def, container, handle, failed }
  let activeId = null;
  let sideFresh = true; // side panel needs a full render on next update

  const api = TV.createApi(store, {
    showView: (id) => showView(id),
    onSelectSpan: () => {},
  });

  function shortcutOf(def, i) { return def.shortcut ? String(def.shortcut) : (i < 9 ? String(i + 1) : ''); }

  function resolveView(id) {
    if (mainDefs.some((d) => d.id === id)) return id;
    return mainDefs.length ? mainDefs[0].id : null;
  }

  function showView(id) {
    const v = resolveView(id);
    if (v) store.set({ view: v });
  }

  function viewFailed(container, def, err) {
    console.error('[Trace Lens] view "' + def.id + '" failed:', err);
    U.clear(container);
    container.appendChild(el('div', { class: 'tv-empty' },
      el('strong', { class: 'tv-secondary' }, 'The ' + (def.title || def.id) + ' view hit an error'),
      el('span', { class: 'tv-mono' }, String((err && err.message) || err))));
  }

  function ensureMounted(def, host) {
    let inst = instances.get(def.id);
    if (inst) return inst;
    const container = el('div', { class: 'app-view app-view--' + def.id, dataset: { view: def.id } });
    host.appendChild(container);
    inst = { def, container, handle: null, failed: false };
    instances.set(def.id, inst);
    try { inst.handle = def.mount(container, api) || {}; } catch (e) { inst.failed = true; viewFailed(container, def, e); }
    return inst;
  }

  function updateInst(inst, state, changed) {
    if (!inst || inst.failed || !inst.handle || typeof inst.handle.update !== 'function') return;
    try { inst.handle.update(state, changed); } catch (e) { inst.failed = true; viewFailed(inst.container, inst.def, e); }
  }

  function activate(id, state) {
    const def = mainDefs.find((d) => d.id === id);
    if (!def) return;
    U.tooltip.hide();
    for (const inst of instances.values()) if (inst.def.slot !== 'side') inst.container.hidden = inst.def.id !== id;
    const inst = ensureMounted(def, R.main);
    inst.container.hidden = false;
    activeId = id;
    updateInst(inst, state, new Set(['*']));
  }

  // ---------------------------------------------------------------- header

  let copyTimer = 0;
  function copyButton(text, label) {
    const btn = el('button', {
      type: 'button', class: 'tv-btn tv-btn--ghost tv-btn--icon app-copy', title: 'Copy ' + label,
      attrs: { 'aria-label': 'Copy ' + label },
    }, icon('copy', 14));
    btn.addEventListener('click', () => {
      U.copyText(text).then(() => {
        U.clear(btn); btn.appendChild(icon('check', 14)); btn.classList.add('is-done'); btn.title = 'Copied';
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { U.clear(btn); btn.appendChild(icon('copy', 14)); btn.classList.remove('is-done'); btn.title = 'Copy ' + label; }, 1400);
      }, () => {});
    });
    return btn;
  }

  function metaItem(value, label, extraClass) {
    return el('span', { class: 'app-meta-item' + (extraClass ? ' ' + extraClass : '') },
      el('strong', { class: 'tv-num' }, value), label ? ' ' + label : null);
  }

  function renderHeader(s) {
    R.trace.hidden = true;
    R.app.appendChild(R.trace);
    U.clear(R.meta);
    const m = s.model;
    if (!m) {
      R.meta.appendChild(el('span', { class: 'app-meta-item tv-muted' }, 'No trace loaded'));
      return;
    }
    const id = m.traceId || '';
    const traces = (s.parse && s.parse.traces) || [];
    const multi = traces.length > 1;
    R.trace.hidden = !multi;
    R.meta.appendChild(el('span', { class: 'app-meta-item app-meta-trace' },
      el('span', { class: 'tv-muted' }, multi ? 'trace ' + ((s.traceIndex || 0) + 1) + '/' + traces.length : 'trace'),
      multi ? R.trace : el('span', { class: 'tv-mono app-trace-id', title: id }, id.length > 12 ? id.slice(0, 8) + '…' : id || '—'),
      id ? copyButton(id, 'trace id ' + id) : null));
    if (m.t0Epoch) {
      const full = U.fmtEpoch(m.t0Epoch);
      R.meta.appendChild(el('span', { class: 'app-meta-item app-meta-time tv-num', title: 'Trace start (local time): ' + full },
        full.replace(/ \d{4} /, ' ').replace(/\.\d+$/, '')));
    }
    R.meta.appendChild(metaItem(U.fmtMs(m.duration), ''));
    R.meta.appendChild(metaItem(U.fmtCount(m.stats.spanCount), m.stats.spanCount === 1 ? 'span' : 'spans'));
    const noun = GROUP_NOUN[m.groupBy] || GROUP_NOUN.service;
    R.meta.appendChild(metaItem(U.fmtCount(m.stats.groupCount), m.stats.groupCount === 1 ? noun[0] : noun[1]));

    const ec = m.stats.errorCount;
    if (ec > 0) {
      const errBtn = el('button', {
        type: 'button', class: 'app-meta-item app-meta-errors',
        title: s.filters.errorsOnly ? 'Showing error spans only — click to show all' : 'Show error spans only',
        attrs: { 'aria-pressed': s.filters.errorsOnly ? 'true' : 'false' },
        on: { click: () => setFilter({ errorsOnly: !store.get().filters.errorsOnly }) },
      }, el('span', { class: 'tv-status tv-status--critical', attrs: { 'aria-hidden': 'true' } }, '!'),
      el('strong', { class: 'tv-num' }, U.fmtCount(ec)), ec === 1 ? ' error' : ' errors');
      R.meta.appendChild(errBtn);
    } else {
      R.meta.appendChild(el('span', { class: 'app-meta-item tv-muted' }, '0 errors'));
    }

    const warnings = Array.from(new Set([].concat((s.parse && s.parse.warnings) || [], m.warnings || [])));
    if (warnings.length) {
      R.meta.appendChild(el('span', { class: 'app-meta-item' },
        el('span', { class: 'tv-badge tv-badge--warning', title: warnings.slice(0, 12).join('\n') },
          plural(warnings.length, 'warning', 'warnings'))));
    }
    if (s.sourceName) {
      R.meta.appendChild(el('span', { class: 'app-meta-item app-meta-source tv-muted tv-ellipsis', title: s.sourceName }, s.sourceName));
    }
  }

  let traceSelFor = null;
  function renderTraceSelect(s) {
    const traces = (s.parse && s.parse.traces) || [];
    R.trace.hidden = traces.length < 2;
    if (traces.length < 2) { traceSelFor = null; return; }
    if (traceSelFor !== s.parse) {
      traceSelFor = s.parse;
      U.clear(R.trace);
      traces.forEach((t, i) => {
        R.trace.appendChild(el('option', { value: String(i), title: t.traceId || '' },
          String(t.traceId || '?').slice(0, 8) + '… · ' + plural(t.spans.length, 'span', 'spans')));
      });
    }
    R.trace.value = String(s.traceIndex || 0);
  }

  function buildGroupBy() {
    const groupings = TV.GROUPINGS || [{ id: 'service', label: 'Service' }];
    for (const g of groupings) {
      R.groupby.appendChild(el('button', {
        type: 'button', dataset: { group: g.id }, title: 'Group by ' + g.label,
        on: { click: () => store.set({ groupBy: g.id }) },
      }, GROUP_SHORT[g.id] || g.label));
    }
  }
  function renderGroupBy(s) {
    for (const b of R.groupby.children) b.setAttribute('aria-pressed', b.dataset.group === s.groupBy ? 'true' : 'false');
  }

  function renderTheme(s) {
    const t = s.theme || 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    U.clear(R.theme);
    R.theme.appendChild(icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'auto'));
    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    R.theme.title = 'Theme: ' + t + ' (click for ' + next + ')';
    R.theme.setAttribute('aria-label', R.theme.title);
  }

  // ---------------------------------------------------------------- toolbar

  function setFilter(patch) {
    store.set({ filters: Object.assign({}, store.get().filters, patch) });
  }

  const catChips = new Map();
  function buildToolbar() {
    for (const c of U.CATEGORIES) {
      const count = el('span', { class: 'app-cat-count tv-num' });
      const chip = el('button', {
        type: 'button', class: 'tv-chip app-cat', dataset: { cat: c.id },
        on: { click: (e) => toggleCategory(c.id, e.altKey) },
      }, el('span', { class: 'tv-key ' + U.catClass(c.id), attrs: { 'aria-hidden': 'true' } }), c.label, count);
      catChips.set(c.id, { chip, count, label: c.label });
      R.cats.appendChild(chip);
    }
    for (const ms of MIN_DURS) R.mindur.appendChild(el('option', { value: String(ms) }, ms ? '≥ ' + ms + ' ms' : 'Any'));
    R.mindur.addEventListener('change', () => setFilter({ minDuration: +R.mindur.value || 0 }));
    R.errors.addEventListener('change', () => setFilter({ errorsOnly: R.errors.checked }));
    R.clear.addEventListener('click', clearFilters);

    const pushSearch = U.debounce(() => store.set({ search: R.search.value }), 120);
    R.search.addEventListener('input', pushSearch);
    R.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') store.set({ search: R.search.value });
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (R.search.value) { R.search.value = ''; store.set({ search: '' }); } else R.search.blur();
      }
    });
  }

  function toggleCategory(id, solo) {
    const cur = store.get().filters.categories || [];
    let next;
    if (solo) next = cur.length === 1 && cur[0] === id ? [] : [id];
    else next = cur.includes(id) ? cur.filter((c) => c !== id) : cur.concat([id]);
    if (next.length === U.CATEGORIES.length) next = [];
    setFilter({ categories: next });
  }

  function clearFilters() {
    R.search.value = '';
    store.set({ search: '', filters: { categories: [], errorsOnly: false, minDuration: 0 }, selectedGroups: [] });
  }

  function renderToolbar(s) {
    const m = s.model;
    const f = s.filters || {};
    const active = f.categories || [];
    for (const [id, c] of catChips) {
      const n = m ? m.stats.byCategory[id] || 0 : 0;
      c.count.textContent = U.fmtCount(n);
      const on = active.includes(id);
      c.chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      c.chip.classList.toggle('is-off', active.length > 0 && !on);
      c.chip.classList.toggle('is-zero', n === 0);
      c.chip.title = (active.length === 0 ? 'Show only ' : on ? 'Hide ' : 'Also show ') + c.label + ' spans · ' +
        plural(n, 'span', 'spans') + ' (Alt+click: solo)';
    }
    R.errors.checked = !!f.errorsOnly;
    R.mindur.value = String(MIN_DURS.includes(f.minDuration) ? f.minDuration : 0);
    if (document.activeElement !== R.search && R.search.value !== (s.search || '')) R.search.value = s.search || '';

    const groups = s.selectedGroups || [];
    R.focus.hidden = !groups.length;
    U.clear(R.focus);
    if (groups.length) {
      const noun = GROUP_NOUN[s.groupBy] || GROUP_NOUN.service;
      R.focus.appendChild(el('span', { class: 'app-label' }, 'Focused ' + (groups.length === 1 ? noun[0] : noun[1])));
      for (const key of groups) {
        R.focus.appendChild(el('button', {
          type: 'button', class: 'tv-chip app-focus-chip', title: 'Remove ' + key + ' from focus',
          attrs: { 'aria-pressed': 'true' },
          on: { click: () => api.selectGroup(key, { additive: true }) },
        }, el('span', { class: 'tv-ellipsis' }, key), el('span', { class: 'tv-chip-x' }, icon('x', 12))));
      }
    }

    const filtering = store.isFiltering();
    R.clear.hidden = !filtering;
    R.match.hidden = !(filtering && m);
    if (filtering && m) {
      let n = 0;
      for (const sp of m.spans) if (store.matches(sp)) n++;
      R.match.textContent = U.fmtCount(n) + ' of ' + plural(m.spans.length, 'span', 'spans') + ' match';
      R.match.classList.toggle('is-none', n === 0);
    }
  }

  // ---------------------------------------------------------------- tabs

  const tabs = new Map();
  function buildTabs() {
    mainDefs.forEach((def, i) => {
      const sc = shortcutOf(def, i);
      const badge = el('span', { class: 'tv-badge app-tab-badge tv-num', hidden: true });
      const tab = el('button', {
        type: 'button', class: 'app-tab', id: 'app-tab-' + def.id,
        attrs: { role: 'tab', 'aria-selected': 'false', 'aria-controls': 'app-main' },
        title: (def.title || def.id) + (sc ? ' (' + sc + ')' : ''),
        on: { click: () => showView(def.id) },
      }, el('span', null, def.title || def.id), badge, sc ? el('kbd', { class: 'app-kbd' }, sc) : null);
      tabs.set(def.id, { tab, badge });
      R.tablist.appendChild(tab);
    });
  }

  function renderTabs(s) {
    const m = s.model;
    for (const [id, t] of tabs) {
      const sel = id === s.view;
      t.tab.setAttribute('aria-selected', sel ? 'true' : 'false');
      t.tab.tabIndex = sel ? 0 : -1;
      let n = null, critical = false;
      if (m && id === 'insights') {
        n = (m.insights || []).length;
        critical = (m.insights || []).some((x) => x.severity === 'critical');
      } else if (m && TAB_COUNTS[id]) n = TAB_COUNTS[id](m);
      t.badge.hidden = n == null;
      if (n != null) t.badge.textContent = U.fmtCount(n);
      t.badge.classList.toggle('tv-badge--critical', critical);
      if (id === 'insights' && n != null) t.badge.title = plural(n, 'insight', 'insights') + (critical ? ' (includes critical)' : '');
    }
  }

  R.tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ids = mainDefs.map((d) => d.id);
    const i = ids.indexOf(store.get().view);
    const next = ids[(i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
    showView(next);
    const t = tabs.get(next);
    if (t) t.tab.focus();
    e.preventDefault();
  });

  // ---------------------------------------------------------------- side panel

  let sideWidth = clamp(+lsGet('sideWidth') || SIDE_DEFAULT, SIDE_MIN, SIDE_MAX);
  function applySideWidth(w) {
    sideWidth = clamp(Math.round(w), SIDE_MIN, SIDE_MAX);
    R.app.style.setProperty('--app-side-w', sideWidth + 'px');
    R.resizer.setAttribute('aria-valuenow', String(sideWidth));
    R.resizer.setAttribute('aria-valuemin', String(SIDE_MIN));
    R.resizer.setAttribute('aria-valuemax', String(SIDE_MAX));
  }

  function renderSideToggle(s) {
    const open = !!(s.sidePanelOpen && sideDef);
    R.app.classList.toggle('is-side-closed', !open);
    R.sideToggle.hidden = !sideDef;
    U.clear(R.sideToggle);
    R.sideToggle.appendChild(icon('panel', 14));
    R.sideToggle.appendChild(document.createTextNode(open ? 'Hide details' : 'Show details'));
    R.sideToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  R.sideToggle.addEventListener('click', () => {
    const open = !store.get().sidePanelOpen;
    lsSet('sideOpen', open ? '1' : '0');
    store.set({ sidePanelOpen: open });
  });

  (function initResizer() {
    let dragging = false;
    R.resizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      R.resizer.setPointerCapture(e.pointerId);
      R.app.classList.add('is-resizing');
      e.preventDefault();
    });
    R.resizer.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = R.body.getBoundingClientRect();
      applySideWidth(rect.right - e.clientX);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { R.resizer.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      R.app.classList.remove('is-resizing');
      lsSet('sideWidth', sideWidth);
    };
    R.resizer.addEventListener('pointerup', end);
    R.resizer.addEventListener('pointercancel', end);
    R.resizer.addEventListener('dblclick', () => { applySideWidth(SIDE_DEFAULT); lsSet('sideWidth', sideWidth); });
    R.resizer.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      if (e.key === 'ArrowLeft') applySideWidth(sideWidth + step);
      else if (e.key === 'ArrowRight') applySideWidth(sideWidth - step);
      else return;
      lsSet('sideWidth', sideWidth);
      e.preventDefault();
    });
  })();

  // ---------------------------------------------------------------- banner, empty state

  function showBanner(title, message) {
    U.clear(R.banner);
    R.banner.appendChild(el('span', { class: 'tv-status tv-status--critical', attrs: { 'aria-hidden': 'true' } }, '!'));
    R.banner.appendChild(el('div', { class: 'app-banner-text' }, el('strong', null, title), message ? el('span', { class: 'tv-secondary' }, message) : null));
    R.banner.appendChild(el('button', {
      type: 'button', class: 'tv-btn tv-btn--ghost tv-btn--icon', title: 'Dismiss', attrs: { 'aria-label': 'Dismiss' },
      on: { click: hideBanner },
    }, icon('x', 14)));
    R.banner.hidden = false;
  }
  function hideBanner() { R.banner.hidden = true; U.clear(R.banner); }

  function buildEmpty() {
    const sample = typeof window.TV_SAMPLE_TRACE !== 'undefined' && window.TV_SAMPLE_TRACE;
    R.empty.appendChild(el('div', { class: 'app-empty-card' },
      el('div', { class: 'app-empty-icon' }, icon('upload', 28)),
      el('h1', { class: 'app-empty-title' }, 'Drop a trace JSON file here'),
      el('p', { class: 'tv-secondary app-empty-sub' }, 'Explore a Grafana Tempo trace grouped by service: flow map, swimlanes, critical path and insights. Everything stays in this browser tab.'),
      el('div', { class: 'app-empty-actions' },
        el('button', { type: 'button', class: 'tv-btn app-btn-primary', on: { click: () => R.file.click() } }, 'Open file…'),
        el('button', { type: 'button', class: 'tv-btn', on: { click: openPasteDialog } }, 'Paste JSON'),
        sample ? el('button', { type: 'button', class: 'tv-btn tv-btn--ghost', on: { click: () => loadObject(window.TV_SAMPLE_TRACE, window.TV_SAMPLE_NAME || 'sample trace') } }, 'Load sample trace') : null),
      el('ol', { class: 'app-empty-steps tv-secondary' },
        el('li', null, 'In Grafana: ', el('strong', null, 'Explore → Tempo'), ' → open a trace'),
        el('li', null, el('strong', null, 'Download → JSON'), ' (OTLP) — Jaeger JSON works too'),
        el('li', null, 'Drop the file anywhere, or press ', el('kbd', { class: 'app-kbd' }, '⌘/Ctrl V'), ' to paste'))));
  }

  // ---------------------------------------------------------------- loading

  function fail(name, message) {
    showBanner('Couldn’t load ' + (name || 'trace') + '.', message);
    return { ok: false, error: message };
  }

  function loadObject(obj, name) {
    let parsed;
    try {
      parsed = TV.parse(obj);
      if (!parsed || !parsed.traces || !parsed.traces.length) throw new Error('No spans found in this file.');
    } catch (e) {
      return fail(name, (e && e.message) || String(e));
    }
    try {
      R.search.value = '';
      store.set({
        parse: parsed, sourceName: name == null ? '' : String(name), traceIndex: 0,
        search: '', filters: { categories: [], errorsOnly: false, minDuration: 0 }, selectedSpanId: null,
      });
    } catch (e) {
      console.error('[Trace Lens] model build failed:', e);
      return fail(name, 'The trace parsed but could not be analysed: ' + ((e && e.message) || e));
    }
    hideBanner();
    const m = store.get().model;
    return { ok: true, format: parsed.format, traces: parsed.traces.length, spans: m ? m.spans.length : 0 };
  }

  function loadText(text, name) {
    let obj;
    const src = String(text == null ? '' : text).replace(/^﻿/, '');
    if (!src.trim()) return fail(name, 'The input is empty.');
    try { obj = JSON.parse(src); } catch (e) { return fail(name, 'Not valid JSON — ' + e.message); }
    return loadObject(obj, name);
  }

  function loadFile(file) {
    if (!file) return;
    file.text().then((t) => loadText(t, file.name), (e) => fail(file.name, (e && e.message) || 'Could not read the file.'));
  }

  R.open.addEventListener('click', () => R.file.click());
  R.file.addEventListener('change', () => {
    const f = R.file.files && R.file.files[0];
    R.file.value = '';
    loadFile(f);
  });

  // paste dialog
  function openPasteDialog() {
    R.dialogError.hidden = true;
    R.dialogText.value = '';
    if (typeof R.dialog.showModal === 'function') R.dialog.showModal();
    else R.dialog.setAttribute('open', '');
    R.dialogText.focus();
  }
  function closePasteDialog() {
    if (typeof R.dialog.close === 'function') R.dialog.close(); else R.dialog.removeAttribute('open');
  }
  R.paste.addEventListener('click', openPasteDialog);
  R.dialogCancel.addEventListener('click', closePasteDialog);
  R.dialogForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const res = loadText(R.dialogText.value, 'pasted JSON');
    if (res.ok) { closePasteDialog(); return; }
    hideBanner();
    R.dialogError.textContent = res.error;
    R.dialogError.hidden = false;
  });
  R.dialogText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); R.dialogForm.requestSubmit(); }
  });

  // Cmd/Ctrl+V anywhere outside inputs
  document.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target) || R.dialog.open) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (!text) return;
    const t = text.trim();
    if (t[0] !== '{' && t[0] !== '[') { fail('pasted text', 'The clipboard doesn’t contain trace JSON.'); return; }
    e.preventDefault();
    loadText(text, 'pasted JSON');
  });

  // drag & drop
  (function initDrop() {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      R.drop.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) R.drop.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      R.drop.hidden = true;
      const files = Array.from(e.dataTransfer.files || []);
      const f = files.find((x) => /\.json$/i.test(x.name) || /json/.test(x.type)) || files[0];
      loadFile(f);
    });
  })();

  // ---------------------------------------------------------------- keyboard

  function stepSpan(dir) {
    const s = store.get();
    const m = s.model;
    if (!m || !m.spans.length) return;
    const filtering = store.isFiltering();
    const cur = s.selectedSpanId && m.byId.get(s.selectedSpanId);
    let i = cur ? cur.index : (dir > 0 ? -1 : m.spans.length);
    for (;;) {
      i += dir;
      if (i < 0 || i >= m.spans.length) return;
      const sp = m.spans[i];
      if (!filtering || store.matches(sp)) { api.selectSpan(sp.id, { reveal: true }); return; }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || R.dialog.open) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const s = store.get();
    if (e.key === '/') {
      if (!s.model) return;
      e.preventDefault();
      R.search.focus();
      R.search.select();
      return;
    }
    if (e.key === 'Escape') {
      if (s.selectedSpanId) { api.selectSpan(null); e.preventDefault(); } else if (s.selectedGroups && s.selectedGroups.length) { api.selectGroup(null); e.preventDefault(); }
      U.tooltip.hide();
      return;
    }
    if (!s.model) return;
    if (e.key === '[' || e.key === ']') { e.preventDefault(); stepSpan(e.key === ']' ? 1 : -1); return; }
    const idx = mainDefs.findIndex((d, i) => shortcutOf(d, i) === e.key);
    if (idx >= 0) { e.preventDefault(); showView(mainDefs[idx].id); }
  });

  // ---------------------------------------------------------------- render loop

  const HEADER_KEYS = ['parse', 'model', 'traceIndex', 'sourceName', 'groupBy', 'filters', '*'];
  const TOOLBAR_KEYS = ['model', 'filters', 'search', 'selectedGroups', 'groupBy', '*'];
  const has = (changed, keys) => keys.some((k) => changed.has(k));

  function render(s, changed) {
    if (has(changed, ['theme', '*'])) { renderTheme(s); lsSet('theme', s.theme); }
    if (has(changed, HEADER_KEYS)) { renderTraceSelect(s); renderHeader(s); }
    if (has(changed, ['groupBy', '*'])) { renderGroupBy(s); lsSet('groupBy', s.groupBy); }
    if (has(changed, TOOLBAR_KEYS)) renderToolbar(s);
    if (has(changed, ['model', 'view', '*'])) renderTabs(s);
    if (has(changed, ['sidePanelOpen', '*'])) renderSideToggle(s);
    if (has(changed, ['view', '*'])) {
      lsSet('view', s.view);
      if (location.hash.slice(1) !== s.view) {
        try { history.replaceState(null, '', '#' + s.view); } catch (e) { /* file:// quirks */ }
      }
    }

    const hasModel = !!s.model;
    R.app.classList.toggle('is-empty', !hasModel);
    R.empty.hidden = hasModel;
    if (!hasModel) {
      U.tooltip.hide();
      for (const inst of instances.values()) inst.container.hidden = true;
      activeId = null;
      sideFresh = true;
      return;
    }

    if (!mainDefs.length) {
      if (!R.main.querySelector('.app-noviews')) {
        R.main.appendChild(el('div', { class: 'tv-empty app-noviews' }, 'No views are available — the view scripts failed to load.'));
      }
    } else if (activeId !== s.view || changed.has('*')) {
      activate(resolveView(s.view), s);
    } else {
      updateInst(instances.get(activeId), s, changed);
    }

    if (sideDef) {
      if (!s.sidePanelOpen) { sideFresh = true; return; }
      const inst = ensureMounted(sideDef, R.side);
      inst.container.hidden = false;
      if (sideFresh) { sideFresh = false; updateInst(inst, s, new Set(['*'])); } else updateInst(inst, s, changed);
    }
  }

  store.subscribe((s, changed) => {
    try {
      if (changed.has('view') && resolveView(s.view) !== s.view && mainDefs.length) { showView(s.view); return; }
      render(s, changed);
    } catch (e) {
      console.error('[Trace Lens] shell render failed:', e);
    }
  });

  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== store.get().view) showView(id);
  });

  // ---------------------------------------------------------------- boot

  buildGroupBy();
  buildToolbar();
  buildTabs();
  buildEmpty();
  applySideWidth(sideWidth);
  R.theme.addEventListener('click', () => {
    const t = store.get().theme || 'auto';
    store.set({ theme: THEMES[(THEMES.indexOf(t) + 1) % THEMES.length] });
  });
  R.trace.addEventListener('change', () => store.set({ traceIndex: +R.trace.value || 0 }));
  R.app.querySelector('.app-logo').appendChild(icon('logo', 18));

  const savedTheme = lsGet('theme');
  const savedGroup = lsGet('groupBy');
  const hashView = decodeURIComponent(location.hash.slice(1) || '');
  const initial = {
    theme: THEMES.includes(savedTheme) ? savedTheme : 'auto',
    groupBy: (TV.GROUPINGS || []).some((g) => g.id === savedGroup) ? savedGroup : 'service',
    view: resolveView(hashView || lsGet('view') || 'map') || 'map',
    sidePanelOpen: lsGet('sideOpen') !== '0',
  };
  store.set(initial);
  render(store.get(), new Set(['*']));

  // data/local-trace.js (your own trace, gitignored) wins over the bundled demo trace.
  if (typeof window.TV_LOCAL_TRACE !== 'undefined' && window.TV_LOCAL_TRACE) {
    loadObject(window.TV_LOCAL_TRACE, window.TV_LOCAL_NAME || 'local trace');
  } else if (typeof window.TV_SAMPLE_TRACE !== 'undefined' && window.TV_SAMPLE_TRACE) {
    loadObject(window.TV_SAMPLE_TRACE, window.TV_SAMPLE_NAME || 'sample trace');
  }

  TV.app = { loadText, loadObject, showView, api, clearFilters };
})(globalThis.TV = globalThis.TV || {});
