(function (TV) {
  'use strict';

  const SEVERITIES = [
    { id: 'critical', label: 'Critical', plural: 'critical', icon: '!' },
    { id: 'warning', label: 'Warning', plural: 'warnings', icon: '!' },
    { id: 'info', label: 'Info', plural: 'info', icon: 'i' },
  ];
  const KINDS = {
    error: { label: 'Error', metric: 'duration' },
    'slow-hop': { label: 'Slow hop', metric: 'queue' },
    orphan: { label: 'Orphan span', metric: 'duration' },
    'async-wait': { label: 'Async wait', metric: 'wait' },
    'repeated-query': { label: 'Repeated query', metric: 'executions', count: true },
    'repeated-consume': { label: 'Repeated consume', metric: 'deliveries', count: true },
    'fan-out': { label: 'Fan-out', metric: 'consumer services', count: true },
    'scope-crossing': { label: 'Scope crossing', metric: 'hops', count: true },
    hotspot: { label: 'Hotspot', metric: 'on journey' },
    skew: { label: 'Clock skew', metric: 'skew' },
  };
  // insights whose interesting span is the one reached last (e.g. the consumer that waited)
  const REACHED_KINDS = new Set(['slow-hop', 'async-wait', 'skew']);
  const SECTION_CAP = 100;
  const CHIP_CAP = 6;

  function kindInfo(kind) {
    return KINDS[kind] || { label: String(kind || 'other').replace(/-/g, ' '), metric: '' };
  }

  function mount(container, api) {
    const u = api.util;
    const el = u.el;
    const store = api.store;

    const root = el('div', { class: 'ins' });
    const head = el('div', { class: 'ins-head' });
    const body = el('div', { class: 'ins-body' });
    root.appendChild(head);
    root.appendChild(body);
    container.appendChild(root);

    const ui = { kinds: new Set(), expanded: new Set() };
    let cards = [];
    let builtFor = null;

    function resolveSpans(model, ins) {
      const out = [];
      for (const id of ins.spanIds || []) {
        const s = model.byId.get(id);
        if (s) out.push(s);
      }
      return out;
    }

    function primarySpan(card) {
      const spans = card.spans;
      if (!spans.length) return null;
      let best = spans[0];
      const reached = REACHED_KINDS.has(card.ins.kind);
      for (const s of spans) {
        if (reached ? s.start > best.start : s.start < best.start) best = s;
      }
      // errors / orphans: the flagged span itself
      if (card.ins.kind === 'error' || card.ins.kind === 'orphan') {
        const own = spans.find((s) => s.isError || s.isOrphan);
        if (own) best = own;
      }
      return best;
    }

    function fmtMetric(ins) {
      const k = kindInfo(ins.kind);
      if (ins.metric == null || !isFinite(ins.metric)) return '–';
      return k.count ? u.fmtCount(ins.metric) + (ins.kind === 'repeated-query' || ins.kind === 'repeated-consume' ? '×' : '') : u.fmtMs(ins.metric);
    }

    function focusGroups(keys) {
      if (!keys.length) return;
      if (keys.length === 1) {
        const cur = store.get().selectedGroups || [];
        if (!(cur.length === 1 && cur[0] === keys[0])) api.selectGroup(keys[0]);
      } else {
        // one batched update instead of N additive selectGroup calls
        store.set({ selectedGroups: keys.slice() });
      }
    }

    function sevIcon(sev) {
      const s = SEVERITIES.find((x) => x.id === sev) || SEVERITIES[2];
      return el('span', { class: ['tv-status', 'tv-status--' + s.id, 'ins-icon'], attrs: { 'aria-hidden': 'true' } }, s.icon);
    }

    function buildCard(model, ins) {
      const card = { ins, spans: resolveSpans(model, ins), keys: (ins.groupKeys || []).filter((k) => model.groupByKey.has(k)), node: null };
      card.idSet = new Set(ins.spanIds || []);
      const k = kindInfo(ins.kind);
      const sev = SEVERITIES.find((x) => x.id === ins.severity) || SEVERITIES[2];
      const prim = primarySpan(card);
      card.primary = prim;

      const chips = el('div', { class: 'ins-svcs' });
      card.keys.slice(0, CHIP_CAP).forEach((key) => {
        chips.appendChild(el('button', {
          class: 'tv-svc ins-svc',
          attrs: { type: 'button', title: key + ' — click to focus (Shift/Cmd to add)' },
          on: { click: (e) => api.selectGroup(key, { additive: e.shiftKey || e.metaKey || e.ctrlKey }) },
        }, el('span', { class: 'tv-ellipsis' }, key)));
      });
      if (card.keys.length > CHIP_CAP) chips.appendChild(el('span', { class: 'tv-muted ins-more', attrs: { title: card.keys.slice(CHIP_CAP).join(', ') } }, '+' + (card.keys.length - CHIP_CAP) + ' more'));

      const actions = el('div', { class: 'ins-actions' },
        prim ? el('button', {
          class: 'tv-btn tv-btn--sm',
          attrs: { type: 'button', title: 'Select ' + prim.name + ' and open the timeline' },
          on: { click: () => { api.selectSpan(prim.id); api.showView('timeline'); } },
        }, 'Show span') : null,
        card.keys.length ? el('button', {
          class: 'tv-btn tv-btn--sm',
          attrs: { type: 'button', title: 'Filter all views to ' + card.keys.join(', ') },
          on: { click: () => focusGroups(card.keys) },
        }, card.keys.length > 1 ? 'Focus ' + card.keys.length + ' services' : 'Focus service') : null,
        prim ? el('button', {
          class: 'tv-btn tv-btn--sm tv-btn--ghost',
          attrs: { type: 'button', title: 'Explain where the time went up to ' + prim.name },
          on: { click: () => api.setPathTarget(prim.id) },
        }, 'Path to here') : null);

      const metric = el('div', { class: 'ins-metric' },
        el('div', { class: 'ins-metric-val tv-num' }, fmtMetric(ins)),
        k.metric ? el('div', { class: 'ins-metric-label' }, k.metric) : null);
      metric.addEventListener('mouseenter', (e) => u.tooltip.show(e.clientX, e.clientY, [
        ins.title,
        [fmtMetric(ins), k.metric || 'metric'],
        [sev.label, 'severity'],
        [k.label, 'kind'],
        card.spans.length ? [u.fmtCount(card.spans.length), 'spans involved'] : null,
      ]));
      metric.addEventListener('mousemove', (e) => u.tooltip.move(e.clientX, e.clientY));
      metric.addEventListener('mouseleave', () => u.tooltip.hide());

      const node = el('article', { class: ['ins-card', 'ins-card--' + sev.id], dataset: { kind: ins.kind } },
        sevIcon(sev.id),
        el('div', { class: 'ins-main' },
          el('div', { class: 'ins-meta' },
            el('span', { class: 'ins-sev' }, sev.label),
            el('span', { class: 'ins-dot', attrs: { 'aria-hidden': 'true' } }, '·'),
            el('span', { class: 'ins-kind' }, k.label)),
          el('h3', { class: 'ins-title' }, ins.title),
          ins.detail ? el('p', { class: 'ins-detail' }, ins.detail) : null,
          card.keys.length ? chips : null,
          actions),
        metric);
      if (prim) {
        node.addEventListener('mouseenter', () => { if (store.get().hoverSpanId !== prim.id) store.set({ hoverSpanId: prim.id }); });
        node.addEventListener('mouseleave', () => { if (store.get().hoverSpanId === prim.id) store.set({ hoverSpanId: null }); });
      }
      card.node = node;
      return card;
    }

    function renderEmpty(title, text) {
      u.clear(head);
      u.clear(body);
      body.appendChild(el('div', { class: 'tv-empty' },
        el('span', { class: 'tv-status tv-status--good ins-empty-icon', attrs: { 'aria-hidden': 'true' } }, '✓'),
        el('strong', { class: 'ins-empty-title' }, title),
        text ? el('span', null, text) : null));
    }

    function renderHead(model, all) {
      u.clear(head);
      const counts = { critical: 0, warning: 0, info: 0 };
      for (const i of all) counts[i.severity] = (counts[i.severity] || 0) + 1;
      const summary = el('div', { class: 'ins-summary' },
        el('h2', { class: 'ins-h' }, 'Insights'),
        el('div', { class: 'ins-counts' }, SEVERITIES.filter((s) => counts[s.id]).map((s) =>
          el('span', { class: 'ins-count' }, sevIcon(s.id),
            el('strong', { class: 'tv-num' }, u.fmtCount(counts[s.id])), ' ' + (counts[s.id] === 1 && s.id === 'warning' ? 'warning' : s.plural)))));
      head.appendChild(summary);

      const byKind = new Map();
      for (const i of all) byKind.set(i.kind, (byKind.get(i.kind) || 0) + 1);
      const chips = el('div', { class: 'ins-chips', attrs: { role: 'group', 'aria-label': 'Filter by kind' } });
      const allChip = el('button', {
        class: 'tv-chip',
        attrs: { type: 'button', 'aria-pressed': String(!ui.kinds.size) },
        on: { click: () => { ui.kinds.clear(); renderList(); renderHead(model, all); } },
      }, 'All', el('span', { class: 'tv-num tv-muted' }, u.fmtCount(all.length)));
      chips.appendChild(allChip);
      for (const [kind, n] of byKind) {
        const on = ui.kinds.has(kind);
        chips.appendChild(el('button', {
          class: ['tv-chip', ui.kinds.size && !on ? 'is-off' : null],
          attrs: { type: 'button', 'aria-pressed': String(on), title: on ? 'Remove filter' : 'Show only ' + kindInfo(kind).label },
          on: {
            click: (e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) { if (on) ui.kinds.delete(kind); else ui.kinds.add(kind); } else if (on && ui.kinds.size === 1) ui.kinds.clear(); else { ui.kinds.clear(); ui.kinds.add(kind); }
              renderList();
              renderHead(model, all);
            },
          },
        }, kindInfo(kind).label, el('span', { class: 'tv-num tv-muted' }, u.fmtCount(n))));
      }
      head.appendChild(chips);
    }

    function renderList() {
      u.clear(body);
      const visible = cards.filter((c) => !ui.kinds.size || ui.kinds.has(c.ins.kind));
      for (const sev of SEVERITIES) {
        const list = visible.filter((c) => c.ins.severity === sev.id);
        if (!list.length) continue;
        const open = ui.expanded.has(sev.id);
        const sec = el('section', { class: 'ins-sec' },
          el('h3', { class: 'ins-sec-title' }, sevIcon(sev.id),
            el('span', { class: 'tv-section-title' }, sev.label),
            el('span', { class: 'ins-sec-count tv-num' }, u.fmtCount(list.length))));
        const shown = open ? list : list.slice(0, SECTION_CAP);
        shown.forEach((c) => sec.appendChild(c.node));
        if (list.length > shown.length) {
          sec.appendChild(el('button', {
            class: 'tv-btn tv-btn--sm tv-btn--ghost ins-showmore',
            attrs: { type: 'button' },
            on: { click: () => { ui.expanded.add(sev.id); renderList(); } },
          }, 'Show ' + u.fmtCount(list.length - shown.length) + ' more'));
        }
        body.appendChild(sec);
      }
      applyDim();
      applySel(store.get());
    }

    function applyDim() {
      const filtering = store.isFiltering ? store.isFiltering() : false;
      for (const c of cards) {
        let dim = false;
        if (filtering) dim = !(c.spans.some((s) => store.matches(s)) || c.keys.some((k) => store.groupMatches(k)));
        c.node.classList.toggle('is-dimmed', dim);
      }
    }

    function applySel(state) {
      const id = state.selectedSpanId;
      for (const c of cards) c.node.classList.toggle('is-selected', !!id && c.idSet.has(id));
    }

    function rebuild(state) {
      u.tooltip.hide();
      const model = state.model;
      builtFor = model;
      cards = [];
      if (!model) {
        renderEmpty('No trace loaded', 'Load a Tempo JSON export to see insights.');
        return;
      }
      const all = model.insights || [];
      if (!all.length) {
        renderEmpty('No issues detected', 'No errors, slow hops, orphans or repeated work were found in this trace.');
        return;
      }
      for (const k of Array.from(ui.kinds)) if (!all.some((i) => i.kind === k)) ui.kinds.delete(k);
      cards = all.map((ins) => buildCard(model, ins));
      renderHead(model, all);
      renderList();
    }

    return {
      update(state, changed) {
        const all = !changed || changed.has('*');
        if (all || changed.has('model') || state.model !== builtFor) { rebuild(state); return; }
        if (changed.has('search') || changed.has('filters') || changed.has('selectedGroups')) applyDim();
        if (changed.has('selectedSpanId')) applySel(state);
      },
      destroy() {
        u.tooltip.hide();
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };
  }

  TV.views.register({ id: 'insights', title: 'Insights', order: 6, slot: 'main', shortcut: '6', mount });
})(globalThis.TV = globalThis.TV || {});
