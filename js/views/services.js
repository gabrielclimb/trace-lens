(function (TV) {
  'use strict';

  const TABS = [
    { id: 'svcs', label: 'Services' },
    { id: 'topics', label: 'Topics' },
    { id: 'dbs', label: 'Databases' },
  ];
  const LS_KEY = 'tv.svc.tab';
  const RENDER_KEYS = ['*', 'model', 'search', 'filters', 'selectedGroups', 'journey', 'groupBy', 'selectedSpanId'];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function round3(n) { return n == null || !isFinite(n) ? '' : Math.round(n * 1000) / 1000; }
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function plural(n, word) { return TV.util.fmtCount(n) + ' ' + word + (n === 1 ? '' : 's'); }
  function isAdditive(e) { return !!(e && (e.shiftKey || e.metaKey || e.ctrlKey)); }

  function mount(container, api) {
    const util = api.util;
    const el = util.el;
    const store = api.store;

    let state = null;
    const saved = lsGet(LS_KEY);
    let tab = TABS.some((t) => t.id === saved) ? saved : 'svcs';
    const sorts = {
      svcs: { key: 'first', dir: 1 },
      topics: { key: 'deliveries', dir: -1 },
      dbs: { key: 'time', dir: -1 },
    };
    const expanded = new Set();
    let rowByKey = new Map();
    let csvSource = null;
    let matchCache = new Map();
    const searchCache = new WeakMap();
    let lastModel = null;
    let copyTimer = 0;

    // ---------------------------------------------------------------- chrome
    const segBtns = {};
    const seg = el('div', { class: 'tv-seg', attrs: { role: 'group', 'aria-label': 'Table' } });
    for (const t of TABS) {
      const count = el('span', { class: 'svc-seg-count tv-num' });
      const b = el('button', { attrs: { type: 'button', 'aria-pressed': String(t.id === tab) }, on: { click: () => setTab(t.id) } }, t.label, count);
      segBtns[t.id] = { b, count };
      seg.appendChild(b);
    }
    const copyBtn = el('button', {
      class: 'tv-btn tv-btn--sm', attrs: { type: 'button' },
      title: 'Copy the visible rows of this table as CSV', on: { click: copyCsv },
    }, 'Copy CSV');
    const headInfo = el('div', { class: 'svc-head-info' });
    const head = el('div', { class: 'svc-head' }, seg, headInfo, el('div', { class: 'svc-spacer' }), copyBtn);
    const scroll = el('div', { class: 'svc-scroll' });
    const footInfo = el('div', { class: 'svc-foot-info tv-num' });
    const footLegend = el('div', { class: 'svc-legend', attrs: { 'aria-label': 'Self-time mix legend' } },
      el('span', { class: 'svc-legend-title' }, 'Self-time mix'),
      util.CATEGORIES.map((c) => el('span', { class: 'svc-legend-item' },
        el('span', { class: 'tv-key ' + util.catClass(c.id) }), c.label)));
    const foot = el('div', { class: 'svc-foot' }, footInfo, footLegend);
    const root = el('div', { class: 'svc-root' }, head, scroll, foot);
    container.appendChild(root);

    // Width drives which service columns show and how many characters long names get (middle-truncated).
    const NARROW_W = 1240;
    let narrow = false;
    let renderedW = 0;
    const MONO_CH = 7.3; // px per char, 12px monospace
    const rerender = util.rafThrottle(() => { if (state) render(); });
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver((entries) => {
        const w = entries[0] && entries[0].contentRect.width;
        if (!w || !state) return;
        const widthSensitive = tab !== 'svcs' || expanded.size > 0;
        if ((w < NARROW_W) !== narrow || (widthSensitive && Math.abs(w - renderedW) > 24)) rerender();
      });
      ro.observe(root);
    }
    function fitMiddle(text, px, chPx) {
      return util.truncateMiddle(text, Math.max(12, Math.floor(px / (chPx || MONO_CH))));
    }

    function setTab(id) {
      if (id === tab) return;
      tab = id;
      lsSet(LS_KEY, id);
      scroll.scrollTop = 0;
      render();
    }

    // ---------------------------------------------------------------- tooltips
    function tip(node, content) {
      node.addEventListener('mouseenter', (e) => util.tooltip.show(e.clientX, e.clientY, content()));
      node.addEventListener('mousemove', (e) => util.tooltip.move(e.clientX, e.clientY));
      node.addEventListener('mouseleave', () => util.tooltip.hide());
      return node;
    }
    function ttBlock(title, rows) {
      return el('div', null,
        el('div', { class: 'tv-tt-title' }, title),
        el('div', { class: 'tv-tt-rows' }, rows));
    }
    function ttRow(value, label, catId, strong) {
      return [
        el('span', { class: 'tv-tt-value' + (strong ? ' svc-tt-strong' : '') }, value),
        el('span', { class: 'tv-tt-label' }, catId ? el('span', { class: 'tv-tt-key ' + util.catClass(catId) }) : null, label),
      ];
    }

    // ---------------------------------------------------------------- filtering
    // Same predicate as TV.store.matches, minus the selectedGroups focus, so unfocused services stay visible (muted).
    function searchText(span) {
      let t = searchCache.get(span);
      if (t === undefined) {
        const parts = [span.id, span.name, span.group, span.service, span.op ? span.op.summary : ''];
        for (const k of Object.keys(span.attrs || {})) {
          const v = span.attrs[k];
          if (v == null) continue;
          parts.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        t = parts.join('\n').toLowerCase();
        searchCache.set(span, t);
      }
      return t;
    }
    function localMatch(span) {
      let m = matchCache.get(span);
      if (m !== undefined) return m;
      const f = state.filters || {};
      const q = (state.search || '').trim().toLowerCase();
      m = !((f.categories && f.categories.length && !f.categories.includes(span.category)) ||
        (f.errorsOnly && !span.isError) ||
        (f.minDuration && !(span.duration >= f.minDuration)) ||
        (q && !searchText(span).includes(q)));
      matchCache.set(span, m);
      return m;
    }
    function filtering() {
      return store.isFiltering ? store.isFiltering() : true;
    }
    function groupVisible(g) {
      const sel = state.selectedGroups || [];
      if (!sel.length) return store.groupMatches(g.key);
      if (sel.includes(g.key)) return store.groupMatches(g.key);
      return g.spans.some(localMatch);
    }
    function spansVisible(spans) {
      if (!filtering()) return true;
      for (const s of spans) if (store.matches(s)) return true;
      return false;
    }

    // ---------------------------------------------------------------- shared cell helpers
    function nil(text) { return el('span', { class: 'svc-nil' }, text || '–'); }
    function msCell(v) { return v > 0 ? util.fmtMs(v) : nil(); }
    function svcChip(key) {
      return el('span', {
        class: 'tv-svc svc-chip', title: key + ' — click to focus (Shift/Cmd to add)',
        attrs: { role: 'button', tabindex: '0' },
        on: {
          click: (e) => { e.stopPropagation(); api.selectGroup(key, { additive: isAdditive(e) }); },
          keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); api.selectGroup(key, { additive: isAdditive(e) }); } },
          mousedown: (e) => { if (e.shiftKey) e.preventDefault(); },
        },
      }, key);
    }
    // Chips that don't fit wrap onto a clipped second line; the count + title carry the full list.
    function chipList(keys, emptyText) {
      if (!keys || !keys.length) return nil(emptyText);
      const chips = el('div', { class: 'svc-chips', title: keys.join('\n') }, keys.slice(0, 12).map(svcChip));
      if (keys.length === 1) return chips;
      return el('div', { class: 'svc-countchips' }, el('span', { class: 'svc-count tv-num' }, String(keys.length)), chips);
    }

    // ---------------------------------------------------------------- services table
    function journeyMap() {
      const m = new Map();
      const j = state.journey || (state.model && state.model.journey);
      if (j && j.byGroup) for (const r of j.byGroup) m.set(r.group, r.total);
      return m;
    }

    // Only the minority scope (e.g. "forest" among "platform" services) is worth a badge.
    const majorityCache = new WeakMap();
    function majorityScope(model) {
      if (majorityCache.has(model)) return majorityCache.get(model);
      const counts = new Map();
      for (const grp of model.groups) counts.set(grp.deployScope, (counts.get(grp.deployScope) || 0) + 1);
      let best = null, bestN = -1;
      counts.forEach((n, k) => { if (n > bestN) { best = k; bestN = n; } });
      majorityCache.set(model, best);
      return best;
    }

    function badgesFor(g) {
      const by = state.model.groupBy || state.groupBy;
      const out = [];
      if (by === 'service') {
        if (g.namespaces.length > 1) out.push(el('span', { class: 'tv-badge', title: g.namespaces.join('\n') }, g.namespaces.length + ' namespaces'));
        else if (g.namespaces[0] && g.namespaces[0] !== g.key) out.push(el('span', { class: 'tv-badge', title: 'Namespace' }, g.namespaces[0]));
      } else if (g.services.length > 1) {
        out.push(el('span', { class: 'tv-badge', title: g.services.join('\n') }, g.services.length + ' services'));
      } else if (g.services[0] && g.services[0] !== g.key) {
        out.push(el('span', { class: 'tv-badge', title: 'Service' }, g.services[0]));
      }
      if (by !== 'scope' && g.deployScope && g.deployScope !== 'unknown' && g.deployScope !== majorityScope(state.model)) {
        out.push(el('span', { class: 'tv-badge', title: 'Deploy scope' + (g.scopes.length > 1 ? ': ' + g.scopes.join(', ') : '') }, g.deployScope));
      }
      return out;
    }

    function activityStrip(g, dur) {
      const strip = el('div', { class: 'svc-strip', attrs: { role: 'img', 'aria-label': 'Activity of ' + g.key } });
      const d = dur > 0 ? dur : 1;
      for (const iv of g.intervals) {
        const left = (iv[0] / d) * 100;
        const width = ((iv[1] - iv[0]) / d) * 100;
        strip.appendChild(el('span', { style: { left: left + '%', width: width + '%' } }));
      }
      return tip(strip, () => ttBlock(g.key + ' · activity', [
        ttRow(util.fmtMs(g.activeTime), 'active (' + util.pct(g.activeTime, dur) + ' of trace)'),
        ttRow(util.fmtCount(g.intervals.length), g.intervals.length === 1 ? 'burst' : 'bursts'),
        ttRow(util.fmtOffset(g.first), 'first span starts'),
        ttRow(util.fmtOffset(g.last), 'last span ends'),
      ]));
    }

    function mixBar(g) {
      const bar = el('div', { class: 'svc-mix', attrs: { role: 'img', 'aria-label': 'Self time by category for ' + g.key } });
      const total = g.selfTime;
      if (!(total > 0)) return nil();
      for (const c of util.CATEGORIES) {
        const v = g.categoryTime[c.id] || 0;
        if (!(v > 0)) continue;
        const seg = el('span', { class: util.catClass(c.id), style: { flexGrow: String(v) } });
        tip(seg, () => ttBlock(g.key + ' · self time ' + util.fmtMs(total),
          util.CATEGORIES.filter((k) => (g.categoryTime[k.id] || 0) > 0).map((k) =>
            ttRow(util.fmtMs(g.categoryTime[k.id]) + ' · ' + util.pct(g.categoryTime[k.id], total),
              k.label + ' (' + plural(g.categoryCount[k.id] || 0, 'span') + ')', k.id, k.id === c.id))));
        bar.appendChild(seg);
      }
      return bar;
    }

    function svcColumns(jt, dur) {
      return [
        { id: 'name', label: 'Service', str: true, val: (g) => g.key, render: nameCell, cls: 'svc-col-name',
          csv: [['svc', (g) => g.key], ['namespaces', (g) => g.namespaces.join(';')], ['scope', (g) => g.deployScope]] },
        { id: 'spans', label: 'Spans', num: true, w: 64, val: (g) => g.spanCount, render: (g) => util.fmtCount(g.spanCount) },
        { id: 'errors', label: 'Errors', num: true, w: 64, val: (g) => g.errorCount,
          render: (g) => g.errorCount ? el('span', { class: 'svc-err' }, util.statusIcon('error'), util.fmtCount(g.errorCount)) : nil('0') },
        { id: 'first', label: 'First', num: true, w: 76, title: 'Start of the first span (t+ from trace start)', val: (g) => g.first,
          render: (g) => util.fmtOffset(g.first), csv: [['first_ms', (g) => round3(g.first)]] },
        { id: 'last', label: 'Last', num: true, w: 76, hideNarrow: true, title: 'End of the last span (t+ from trace start)', val: (g) => g.last,
          render: (g) => util.fmtOffset(g.last), csv: [['last_ms', (g) => round3(g.last)]] },
        { id: 'active', label: 'Active', num: true, w: 76, hideNarrow: true, title: 'Union of span intervals (wall time with at least one span open)', val: (g) => g.activeTime,
          render: (g) => msCell(g.activeTime), csv: [['active_ms', (g) => round3(g.activeTime)]] },
        { id: 'self', label: 'Self time', num: true, w: 80, title: 'Sum of span self time (duration minus children)', val: (g) => g.selfTime,
          render: (g) => msCell(g.selfTime), csv: [['self_ms', (g) => round3(g.selfTime)]] },
        { id: 'journey', label: 'Journey', num: true, w: 80, title: 'Time attributed to this service on the current critical path', val: (g) => jt.get(g.key) || 0,
          render: (g) => msCell(jt.get(g.key) || 0), csv: [['journey_ms', (g) => round3(jt.get(g.key) || 0)]] },
        { id: 'db', label: 'DB calls · time', num: true, w: 108, title: 'Database spans and their summed duration (sorts by time)', val: (g) => g.dbTime,
          render: (g) => g.dbCalls ? el('span', null, util.fmtCount(g.dbCalls), el('span', { class: 'svc-sep' }, ' · '), util.fmtMs(g.dbTime)) : nil(),
          csv: [['db_calls', (g) => g.dbCalls], ['db_ms', (g) => round3(g.dbTime)]] },
        { id: 'topics', label: 'Topics out/in', num: true, w: 96, title: 'Kafka topics produced / consumed', val: (g) => g.topicsProduced.length + g.topicsConsumed.length,
          render: (g) => (g.topicsProduced.length || g.topicsConsumed.length)
            ? el('span', null, String(g.topicsProduced.length), el('span', { class: 'svc-sep' }, ' / '), String(g.topicsConsumed.length)) : nil(),
          csv: [['topics_out', (g) => g.topicsProduced.join(';')], ['topics_in', (g) => g.topicsConsumed.join(';')]] },
        { id: 'activity', label: 'Activity · 0 – ' + util.fmtMs(dur), w: 130, title: 'When this service had spans open, across the whole trace', sortable: false,
          render: (g) => activityStrip(g, dur), cls: 'svc-col-strip', csv: [] },
        { id: 'mix', label: 'Self-time mix', w: 96, title: 'Self time split by span category', sortable: false, render: mixBar, cls: 'svc-col-mix',
          csv: util.CATEGORIES.map((c) => ['self_' + c.id + '_ms', (g) => round3(g.categoryTime[c.id] || 0)]) },
      ];
    }

    function nameCell(g) {
      const open = expanded.has(g.key);
      const caret = el('button', {
        class: 'svc-caret', attrs: { type: 'button', 'aria-expanded': String(open), 'aria-label': (open ? 'Collapse ' : 'Expand ') + g.key },
        title: open ? 'Collapse details' : 'Expand details',
        on: { click: (e) => { e.stopPropagation(); toggleExpand(g.key); } },
      });
      return el('div', { class: 'svc-namecell' }, caret,
        el('div', { class: 'svc-namewrap' }, el('span', { class: 'svc-name tv-ellipsis', title: g.key }, g.key), badgesFor(g)));
    }

    function toggleExpand(key) {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render();
    }

    function expandContent(g, ncols) {
      const sec = (title, body) => el('section', { class: 'svc-xsec' }, el('h4', { class: 'tv-section-title' }, title), body);
      const empty = (t) => el('div', { class: 'svc-xempty' }, t);

      // approximate section widths (grid fractions 1.3 / .9 / 1.1 / 1.5, or 2 columns when narrow)
      const inner = Math.max(400, renderedW - 42 - 12);
      const fr = root.classList.contains('svc-root--narrow') ? (inner - 24) / 2 / 1.4 : (inner - 72) / 4.8;
      const topicPx = fr * 1.3 - 40, edgePx = fr * 1.5 - 44;

      // topics
      const topicItems = [];
      for (const t of g.topicsProduced) topicItems.push(el('div', { class: 'svc-li svc-li--2' },
        el('span', { class: 'svc-dir', title: 'Produced' }, 'out'), el('span', { class: 'tv-mono tv-ellipsis', title: t }, fitMiddle(t, topicPx))));
      for (const t of g.topicsConsumed) topicItems.push(el('div', { class: 'svc-li svc-li--2' },
        el('span', { class: 'svc-dir', title: 'Consumed' }, 'in'), el('span', { class: 'tv-mono tv-ellipsis', title: t }, fitMiddle(t, topicPx))));

      // DB tables
      const tables = new Map();
      for (const s of g.spans) {
        if (s.category !== 'db') continue;
        const op = s.op || {};
        const k = op.table || op.name || op.system || s.name;
        let t = tables.get(k);
        if (!t) tables.set(k, (t = { name: k, system: op.system, count: 0, time: 0 }));
        t.count++; t.time += s.duration;
      }
      const tableRows = Array.from(tables.values()).sort((a, b) => b.time - a.time || cmp(a.name, b.name)).slice(0, 8)
        .map((t) => el('div', { class: 'svc-li svc-li--3' },
          el('span', { class: 'tv-mono tv-ellipsis', title: (t.system ? t.system + ' · ' : '') + t.name }, t.name),
          el('span', { class: 'svc-n tv-num' }, '×' + util.fmtCount(t.count)),
          el('span', { class: 'svc-n tv-num' }, util.fmtMs(t.time))));

      // top operations
      const ops = new Map();
      for (const s of g.spans) {
        const k = (s.op && s.op.summary) || s.name;
        let o = ops.get(k);
        if (!o) ops.set(k, (o = { name: k, cat: s.category, count: 0, total: 0, longest: s }));
        o.count++; o.total += s.duration;
        if (s.duration > o.longest.duration) o.longest = s;
      }
      const opRows = Array.from(ops.values()).sort((a, b) => b.total - a.total || cmp(a.name, b.name)).slice(0, 5).map((o) =>
        el('button', {
          class: 'svc-li svc-li--op' + (state.selectedSpanId === o.longest.id ? ' is-selected' : ''),
          attrs: { type: 'button' },
          title: o.name + '\nClick to select the longest instance (' + util.fmtMs(o.longest.duration) + ')',
          on: {
            click: (e) => { e.stopPropagation(); api.selectSpan(o.longest.id); },
            mouseenter: () => { if (store.get().hoverSpanId !== o.longest.id) store.set({ hoverSpanId: o.longest.id }); },
            mouseleave: () => { if (store.get().hoverSpanId) store.set({ hoverSpanId: null }); },
          },
        },
        el('span', { class: 'tv-dot ' + util.catClass(o.cat) }),
        el('span', { class: 'tv-ellipsis' }, o.name),
        el('span', { class: 'svc-n tv-num' }, '×' + util.fmtCount(o.count)),
        el('span', { class: 'svc-n tv-num' }, util.fmtMs(o.total))));

      // edges
      const edgeRow = (e, dir) => el('div', { class: 'svc-edge' },
        el('div', { class: 'svc-li svc-li--edge' },
          el('span', { class: 'svc-dir' }, dir === 'in' ? 'from' : 'to'),
          el('span', { class: 'svc-edge-main' },
            svcChip(dir === 'in' ? e.from : e.to),
            el('span', { class: 'tv-badge' }, util.hopTypeLabel(e.type))),
          el('span', { class: 'svc-n tv-num', title: 'Hops' }, '×' + util.fmtCount(e.count))),
        el('div', { class: 'svc-edge-sub' },
          el('span', { class: 'svc-edge-label tv-mono', title: e.label || '' }, e.label ? fitMiddle(e.label, edgePx - 92, 6.7) : ''),
          el('span', { class: 'svc-n tv-num', title: 'Latency avg / max (child start − parent start)' },
            util.fmtMs(e.latencyAvg), el('span', { class: 'svc-sep' }, ' / '), util.fmtMs(e.latencyMax))));
      const EDGE_MAX = 6;
      const edgeList = (list, dir) => {
        const sorted = list.slice().sort((a, b) => b.count - a.count || b.latencyMax - a.latencyMax || cmp(a.label, b.label));
        const out = sorted.slice(0, EDGE_MAX).map((e) => edgeRow(e, dir));
        if (sorted.length > EDGE_MAX) {
          const rest = sorted.slice(EDGE_MAX);
          out.push(el('div', { class: 'svc-more', title: rest.map((e) => (dir === 'in' ? e.from : e.to) + ' · ' + e.label).join('\n') },
            '+' + (rest.length) + ' more ' + (dir === 'in' ? 'incoming' : 'outgoing') + ' (' + plural(rest.reduce((a, e) => a + e.count, 0), 'hop') + ')'));
        }
        return out;
      };
      const edgeRows = edgeList(g.inEdges, 'in').concat(edgeList(g.outEdges, 'out'));

      const box = el('div', { class: 'svc-x' },
        sec('Topics', topicItems.length ? topicItems : empty('No Kafka topics')),
        sec('Database tables', tableRows.length ? tableRows : empty('No database calls')),
        sec('Top operations', opRows.length ? opRows : empty('No spans')),
        sec('Calls in / out · avg / max latency', edgeRows.length ? edgeRows : empty('No cross-service calls')));
      return el('tr', { class: 'svc-xrow' }, el('td', { attrs: { colspan: String(ncols) } }, box));
    }

    function renderSvcs(model) {
      const jt = journeyMap();
      const allCols = svcColumns(jt, model.duration);
      const cols = allCols.filter((c) => !(narrow && c.hideNarrow));
      const sel = state.selectedGroups || [];
      const visible = [];
      let hidden = 0;
      for (const g of model.groups) {
        if (groupVisible(g)) visible.push(g); else hidden++;
      }
      sortRows(visible, cols, sorts.svcs);
      const tbody = el('tbody');
      rowByKey = new Map();
      for (const g of visible) {
        const selected = sel.includes(g.key);
        const tr = el('tr', {
          class: ['svc-row', selected && 'is-selected', sel.length && !selected && 'is-muted', state.hoverGroup === g.key && 'is-hover', g.errorCount && 'has-error'],
          attrs: { tabindex: '0', 'aria-selected': String(selected) },
          dataset: { key: g.key },
          on: {
            click: (e) => api.selectGroup(g.key, { additive: isAdditive(e) }),
            mousedown: (e) => { if (e.shiftKey) e.preventDefault(); },
            keydown: (e) => {
              if (e.target !== tr) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.selectGroup(g.key, { additive: isAdditive(e) }); }
              else if (e.key === 'ArrowRight' && !expanded.has(g.key)) { e.preventDefault(); toggleExpand(g.key); }
              else if (e.key === 'ArrowLeft' && expanded.has(g.key)) { e.preventDefault(); toggleExpand(g.key); }
              else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const rows = Array.from(tbody.querySelectorAll('tr.svc-row'));
                const i = rows.indexOf(tr) + (e.key === 'ArrowDown' ? 1 : -1);
                if (rows[i]) rows[i].focus();
              }
            },
            mouseenter: () => { if (store.get().hoverGroup !== g.key) store.set({ hoverGroup: g.key }); },
          },
        }, cols.map((c) => el('td', { class: [c.num && 'num', c.cls] }, c.render(g))));
        rowByKey.set(g.key, tr);
        tbody.appendChild(tr);
        if (expanded.has(g.key)) tbody.appendChild(expandContent(g, cols.length));
      }
      tbody.addEventListener('mouseleave', () => { if (store.get().hoverGroup) store.set({ hoverGroup: null }); });
      if (!visible.length) tbody.appendChild(emptyRow(cols.length, 'No services match the current filters'));
      mountTable('svcs', cols, tbody, 'svc-table--svcs');
      csvSource = { name: 'svcs', cols: allCols, rows: visible };
      return { visible: visible.length, hidden, noun: 'services' };
    }

    // ---------------------------------------------------------------- Topics table
    function topicColumns() {
      const lat = (k) => (t) => t[k] == null ? nil() : util.fmtMs(t[k]);
      return [
        { id: 'name', label: 'Topic', str: true, val: (t) => t.name, cls: 'svc-col-topic',
          render: (t) => el('span', { class: 'svc-topic' },
            el('span', { class: 'tv-mono tv-ellipsis', title: t.name }, fitMiddle(t.name, topicColPx - (t.system && t.system !== 'kafka' ? 70 : 0))),
            t.system && t.system !== 'kafka' ? el('span', { class: 'tv-badge' }, t.system) : null),
          csv: [['topic', (t) => t.name], ['system', (t) => t.system]] },
        { id: 'producers', label: 'Producers', w: 200, val: (t) => t.producerGroups.length, render: (t) => chipList(t.producerGroups),
          csv: [['producer_services', (t) => t.producerGroups.join(';')]] },
        { id: 'consumers', label: 'Consumer services', w: 280, val: (t) => t.consumerGroups.length,
          render: (t) => chipList(t.consumerGroups, 'none'),
          csv: [['consumer_count', (t) => t.consumerGroups.length], ['consumer_services', (t) => t.consumerGroups.join(';')]] },
        { id: 'deliveries', label: 'Deliveries', num: true, w: 84, title: 'Producer → consumer hops on this topic', val: (t) => t.deliveries.length,
          render: (t) => t.deliveries.length ? util.fmtCount(t.deliveries.length) : nil('0') },
        { id: 'latencyMin', label: 'Latency min', num: true, w: 92, val: (t) => t.latencyMin == null ? -1 : t.latencyMin, render: lat('latencyMin'),
          csv: [['latency_min_ms', (t) => round3(t.latencyMin)]] },
        { id: 'latencyAvg', label: 'avg', num: true, w: 76, val: (t) => t.latencyAvg == null ? -1 : t.latencyAvg, render: lat('latencyAvg'),
          csv: [['latency_avg_ms', (t) => round3(t.latencyAvg)]] },
        { id: 'latencyMax', label: 'max', num: true, w: 76, val: (t) => t.latencyMax == null ? -1 : t.latencyMax, render: lat('latencyMax'),
          csv: [['latency_max_ms', (t) => round3(t.latencyMax)]] },
      ];
    }

    let topicColPx = 300;
    function renderTopics(model) {
      const cols = topicColumns();
      topicColPx = Math.max(220, renderedW - 12 - cols.reduce((a, c) => a + (c.w || 0), 0)) - 22;
      const visible = [];
      let hidden = 0;
      for (const t of model.topics) {
        if (spansVisible(t.producers.concat(t.consumers))) visible.push(t); else hidden++;
      }
      sortRows(visible, cols, sorts.topics);
      const tbody = el('tbody');
      for (const t of visible) {
        const target = t.producers[0] || t.consumers[0] || null;
        const isSel = !!state.selectedSpanId && (t.producers.some((s) => s.id === state.selectedSpanId) || t.consumers.some((s) => s.id === state.selectedSpanId));
        tbody.appendChild(el('tr', {
          class: ['svc-row', isSel && 'is-selected'], attrs: { tabindex: '0' },
          title: target ? 'Click to select the first ' + (t.producers[0] ? 'producer' : 'consumer') + ' span' : null,
          on: {
            click: () => { if (target) api.selectSpan(target.id); },
            keydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && target) { e.preventDefault(); api.selectSpan(target.id); } },
          },
        }, cols.map((c) => el('td', { class: [c.num && 'num', c.cls] }, c.render(t)))));
      }
      if (!visible.length) tbody.appendChild(emptyRow(cols.length, model.topics.length ? 'No topics match the current filters' : 'No Kafka topics in this trace'));
      mountTable('topics', cols, tbody, 'svc-table--topics');
      csvSource = { name: 'topics', cols, rows: visible };
      return { visible: visible.length, hidden, noun: 'topics' };
    }

    // ---------------------------------------------------------------- Databases table
    function dbColumns() {
      return [
        { id: 'name', label: 'Database', str: true, w: 130, val: (d) => d.name || d.key,
          render: (d) => el('span', { class: 'tv-mono tv-ellipsis svc-dbname', title: d.key }, d.name || d.key),
          csv: [['db_key', (d) => d.key], ['name', (d) => d.name]] },
        { id: 'system', label: 'System', str: true, w: 104, val: (d) => d.system || '', render: (d) => d.system ? el('span', { class: 'tv-badge' }, d.system) : nil() },
        { id: 'host', label: 'Host', str: true, w: 236, val: (d) => d.host || '',
          render: (d) => d.host ? el('span', { class: 'tv-mono svc-host', title: d.host }, util.truncateMiddle(d.host, 30)) : nil() },
        { id: 'svcs', label: 'Services', w: 190, val: (d) => d.groups.length, render: (d) => chipList(d.groups),
          csv: [['svcs', (d) => d.groups.join(';')]] },
        { id: 'count', label: 'Queries', num: true, w: 80, val: (d) => d.count, render: (d) => util.fmtCount(d.count) },
        { id: 'time', label: 'Total time', num: true, w: 92, val: (d) => d.time, render: (d) => msCell(d.time), csv: [['total_ms', (d) => round3(d.time)]] },
        { id: 'tables', label: 'Top tables', val: (d) => d.tables.length, cls: 'svc-col-tables',
          render: (d) => d.tables.length
            ? el('div', { class: 'svc-tables', title: d.tables.map((t) => t.table + '  ×' + t.count + '  ' + util.fmtMs(t.time)).join('\n') },
              d.tables.slice(0, 3).map((t) => el('span', { class: 'svc-table-item' },
                el('span', { class: 'tv-mono tv-ellipsis' }, t.table || '(none)'),
                el('span', { class: 'svc-n tv-num' }, '×' + t.count))),
              d.tables.length > 3 ? el('span', { class: 'tv-badge' }, '+' + (d.tables.length - 3)) : null)
            : nil(),
          csv: [['tables', (d) => d.tables.map((t) => t.table + ':' + t.count + ':' + round3(t.time)).join(';')]] },
      ];
    }

    function renderDbs(model) {
      const cols = dbColumns();
      const visible = [];
      let hidden = 0;
      for (const d of model.databases) {
        if (spansVisible(d.spans)) visible.push(d); else hidden++;
      }
      sortRows(visible, cols, sorts.dbs);
      const tbody = el('tbody');
      for (const d of visible) {
        let slow = null;
        for (const s of d.spans) if (!slow || s.duration > slow.duration) slow = s;
        const isSel = !!state.selectedSpanId && d.spans.some((s) => s.id === state.selectedSpanId);
        tbody.appendChild(el('tr', {
          class: ['svc-row', isSel && 'is-selected'], attrs: { tabindex: '0' },
          title: slow ? 'Click to select the slowest query (' + util.fmtMs(slow.duration) + ')' : null,
          on: {
            click: () => { if (slow) api.selectSpan(slow.id); },
            keydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && slow) { e.preventDefault(); api.selectSpan(slow.id); } },
          },
        }, cols.map((c) => el('td', { class: [c.num && 'num', c.cls] }, c.render(d)))));
      }
      if (!visible.length) tbody.appendChild(emptyRow(cols.length, model.databases.length ? 'No databases match the current filters' : 'No database calls in this trace'));
      mountTable('dbs', cols, tbody, 'svc-table--dbs');
      csvSource = { name: 'databases', cols, rows: visible };
      return { visible: visible.length, hidden, noun: 'databases' };
    }

    // ---------------------------------------------------------------- table plumbing
    function sortRows(rows, cols, sort) {
      const col = cols.find((c) => c.id === sort.key && c.sortable !== false) || cols[0];
      const tie = cols.find((c) => c.id === 'name');
      rows.sort((a, b) => {
        const va = col.val(a), vb = col.val(b);
        const r = col.str ? String(va).localeCompare(String(vb)) : cmp(va, vb);
        if (r) return r * sort.dir;
        return tie && tie !== col ? String(tie.val(a)).localeCompare(String(tie.val(b))) : 0;
      });
    }

    function emptyRow(ncols, text) {
      return el('tr', { class: 'svc-emptyrow' }, el('td', { attrs: { colspan: String(ncols) } }, text));
    }

    function mountTable(tabId, cols, tbody, cls) {
      const sort = sorts[tabId];
      const headRow = el('tr', null, cols.map((c) => {
        const sortable = c.sortable !== false;
        const active = sortable && sort.key === c.id;
        const th = el('th', {
          class: [c.num && 'num', sortable && 'is-sortable', c.cls],
          attrs: { scope: 'col', 'aria-sort': sortable ? (active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none') : null, tabindex: sortable ? '0' : null },
          title: c.title || null,
        }, c.label);
        if (sortable) {
          const go = () => {
            if (sort.key === c.id) sort.dir = -sort.dir;
            else { sort.key = c.id; sort.dir = c.str || c.id === 'first' || c.id === 'last' ? 1 : -1; }
            render();
          };
          th.addEventListener('click', go);
          th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        }
        return th;
      }));
      const fixed = cols.reduce((a, c) => a + (c.w || 0), 0);
      const colgroup = el('colgroup', null, cols.map((c) => el('col', { style: c.w ? { width: c.w + 'px' } : null })));
      const table = el('table', { class: 'tv-table svc-table ' + cls, style: { minWidth: (fixed + 180) + 'px' } }, colgroup, el('thead', null, headRow), tbody);
      util.clear(scroll);
      scroll.appendChild(table);
    }

    function copyCsv() {
      if (!csvSource) return;
      const fields = [];
      for (const c of csvSource.cols) {
        if (c.csv) for (const f of c.csv) fields.push(f);
        else fields.push([c.id, c.val]);
      }
      const lines = [fields.map((f) => csvCell(f[0])).join(',')];
      for (const r of csvSource.rows) lines.push(fields.map((f) => csvCell(f[1](r))).join(','));
      const done = (ok) => {
        copyBtn.textContent = ok ? 'Copied ' + csvSource.rows.length + ' rows' : 'Copy failed';
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy CSV'; }, 1400);
      };
      Promise.resolve(util.copyText(lines.join('\n') + '\n')).then(() => done(true), () => done(false));
    }

    // ---------------------------------------------------------------- render
    function render() {
      util.tooltip.hide();
      const model = state && state.model;
      for (const t of TABS) segBtns[t.id].b.setAttribute('aria-pressed', String(t.id === tab));
      if (!model) {
        for (const t of TABS) segBtns[t.id].count.textContent = '';
        util.clear(scroll);
        scroll.appendChild(el('div', { class: 'tv-empty' }, 'Load a trace to see services, topics and databases.'));
        footInfo.textContent = '';
        headInfo.textContent = '';
        footLegend.classList.add('is-hidden');
        copyBtn.disabled = true;
        csvSource = null;
        return;
      }
      if (model !== lastModel) {
        lastModel = model;
        for (const k of Array.from(expanded)) if (!model.groupByKey.has(k)) expanded.delete(k);
      }
      matchCache = new Map();
      renderedW = root.clientWidth || 1200;
      narrow = renderedW < NARROW_W;
      root.classList.toggle('svc-root--narrow', renderedW < 900);
      segBtns.svcs.count.textContent = util.fmtCount(model.groups.length);
      segBtns.topics.count.textContent = util.fmtCount(model.topics.length);
      segBtns.dbs.count.textContent = util.fmtCount(model.databases.length);

      // keep keyboard focus across re-renders
      const active = document.activeElement;
      const focusKey = active && root.contains(active) && active.dataset && active.matches(':focus-visible') ? active.dataset.key : null;

      const res = tab === 'topics' ? renderTopics(model) : tab === 'dbs' ? renderDbs(model) : renderSvcs(model);

      if (focusKey && rowByKey.has(focusKey)) rowByKey.get(focusKey).focus({ preventScroll: true });
      const sel = state.selectedGroups || [];
      headInfo.textContent = tab === 'svcs'
        ? (sel.length ? sel.length + ' focused · click again to clear, Shift/Cmd-click to add' : 'Click a row to focus a service · Shift/Cmd-click to add')
        : 'Click a row to select a span';
      util.clear(footInfo);
      footInfo.appendChild(document.createTextNode(util.fmtCount(res.visible) + ' ' + res.noun));
      if (res.hidden) {
        footInfo.appendChild(el('span', { class: 'svc-sep' }, ' · '));
        footInfo.appendChild(el('span', { class: 'svc-hidden' }, util.fmtCount(res.hidden) + ' hidden by filters'));
      }
      footLegend.classList.toggle('is-hidden', tab !== 'svcs');
      copyBtn.disabled = !res.visible;
    }

    function syncHover() {
      const hg = state.hoverGroup;
      for (const [k, tr] of rowByKey) tr.classList.toggle('is-hover', k === hg);
    }

    return {
      update(s, changed) {
        state = s;
        if (RENDER_KEYS.some((k) => changed.has(k))) {
          if (changed.has('selectedSpanId') && changed.size === 1 && tab === 'svcs' && !expanded.size) return;
          render();
        } else if (changed.has('hoverGroup') && tab === 'svcs') {
          syncHover();
        }
      },
      destroy() {
        clearTimeout(copyTimer);
        if (ro) ro.disconnect();
        util.tooltip.hide();
        root.remove();
      },
    };
  }

  TV.views.register({ id: 'services', title: 'Services', order: 4, slot: 'main', shortcut: '4', mount });
})(globalThis.TV = globalThis.TV || {});
