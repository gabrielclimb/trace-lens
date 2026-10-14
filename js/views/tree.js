(function (TV) {
  'use strict';

  const ROW_H = 26;
  const OVERSCAN = 8;
  const MAX_INDENT = 12;
  const MIN_INDENT = 3;
  const GUIDE_LEVELS = 6;  // only the nearest ancestor levels get guide lines
  const NAME_W_KEY = 'tv.tree.nameW';
  const service_MODE_KEY = 'tv.tree.bySvc';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* optional */ } }

  function catLabel(cat) {
    const c = TV.util.CATEGORIES.find((x) => x.id === cat);
    return c ? c.label : cat;
  }

  // Hop into a span from its structural parent (or the causal hop computed by the model).
  function hopOf(span) {
    if (span.hopIn) return span.hopIn;
    if (span.parent && span.parent.group !== span.group) {
      return { parent: span.parent, child: span, from: span.parent.group, to: span.group, type: 'call',
        label: span.name, latency: span.start - span.parent.start, queue: Math.max(0, span.start - span.parent.end) };
    }
    return null;
  }

  // Maximal same-group subtrees ("segments") of the structural tree.
  function buildSegments(model) {
    const segOf = new Map();
    const segs = [];
    const stack = [];
    for (const s of model.spans) if (!s.parent) stack.push(s);
    while (stack.length) {
      const s = stack.pop();
      let seg = s.parent && s.parent.group === s.group ? segOf.get(s.parent.id) : null;
      if (!seg) {
        seg = { root: s, group: s.group, spans: [], exits: [], errors: 0, _union: null };
        segs.push(seg);
        if (s.parent) segOf.get(s.parent.id).exits.push(s);
      }
      segOf.set(s.id, seg);
      seg.spans.push(s);
      if (s.isError) seg.errors++;
      for (let i = s.children.length - 1; i >= 0; i--) stack.push(s.children[i]);
    }
    for (const seg of segs) {
      seg.exits.sort((a, b) => a.start - b.start || a.index - b.index);
      let first = Infinity, last = -Infinity;
      for (const s of seg.spans) { if (s.start < first) first = s.start; if (s.end > last) last = s.end; }
      seg.first = first; seg.last = last;
    }
    return { segOf, segs };
  }

  function segUnion(seg) {
    if (!seg._union) seg._union = TV.util.mergeIntervals(seg.spans.map((s) => [s.start, s.end]));
    return seg._union;
  }

  function chevron() {
    const s = TV.util.svg('svg', { class: 'tr-chev', viewBox: '0 0 10 10', width: 10, height: 10, 'aria-hidden': 'true' },
      TV.util.svg('path', { d: 'M3.5 2 L7 5 L3.5 8', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return s;
  }

  function mount(container, api) {
    const U = TV.util;
    const store = api.store;
    const el = U.el;

    // ---------------------------------------------------------------- state local to the view
    let model = null;
    let segInfo = null;
    let bySvc = lsGet(service_MODE_KEY) === '1';
    let expNormal = new Set();
    let expSvc = new Set();
    let svcOpen = new Set();       // segment roots shown as spans instead of a summary row
    let keep = null;               // Uint8Array by span.index (match or ancestor of match) when filtering
    let filtering = false;
    let segMatchCache = new Map();
    let rows = [];
    let rowIndexById = new Map();
    let indent = MAX_INDENT;
    let gen = 0;
    let cache = new Map();         // row key → element (valid for current gen)
    let lastRange = '';
    let nameW = parseInt(lsGet(NAME_W_KEY), 10) || 0;
    let wfW = 400;
    let domain = [0, 1];
    let hoverId = null;
    let selectedId = null;
    let lastFilterSig = '';

    // ---------------------------------------------------------------- DOM skeleton
    const btnSvc = el('button', { class: 'tv-chip tr-svc-toggle', attrs: { 'aria-pressed': String(bySvc), title: 'Collapse each same-service subtree into one summary row' },
      on: { click: () => setSvcMode(!bySvc) } }, el('span', { class: 'tr-toggle-box', attrs: { 'aria-hidden': 'true' } }), 'Collapse by service');
    const btnExpand = el('button', { class: 'tv-btn tv-btn--sm', on: { click: expandAll } }, 'Expand all');
    const btnCollapse = el('button', { class: 'tv-btn tv-btn--sm', on: { click: collapseAll } }, 'Collapse all');
    const statusEl = el('span', { class: 'tr-status tv-num' });
    const zoomEl = el('span', { class: 'tr-zoom tv-num' });
    const legend = el('span', { class: 'tr-legend', attrs: { 'aria-label': 'Bar color = span category' } },
      U.CATEGORIES.map((c) => el('span', { class: 'tr-legend-item' }, el('span', { class: 'tv-key ' + U.catClass(c.id) }), c.label.replace(' / messaging', ''))));
    const toolbar = el('div', { class: 'tr-toolbar' }, btnSvc, btnExpand, btnCollapse, statusEl, zoomEl, el('span', { class: 'tr-spacer-x' }), legend);

    const axisEl = el('div', { class: 'tr-axis', attrs: { title: 'Drag to zoom · double-click to reset' } });
    const resizer = el('div', { class: 'tr-resizer', attrs: { role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' } });
    const header = el('div', { class: 'tr-header' },
      el('div', { class: 'tr-hname' }, el('span', null, 'Span'), el('span', { class: 'tv-muted' }, '· service')), resizer, axisEl);

    const gridEl = el('div', { class: 'tr-grid', attrs: { 'aria-hidden': 'true' } });
    const brushEl = el('div', { class: 'tr-brush is-hidden' });
    const spacer = el('div', { class: 'tr-spacer' });
    const rowsEl = el('div', { class: 'tr-rows', attrs: { role: 'tree', 'aria-label': 'Span tree' } });
    const scroller = el('div', { class: 'tr-scroll', attrs: { tabindex: '0' } }, spacer, rowsEl);
    const emptyEl = el('div', { class: 'tv-empty tr-empty is-hidden' });
    const body = el('div', { class: 'tr-body' }, gridEl, brushEl, scroller, emptyEl);
    const root = el('div', { class: 'tr-root' }, toolbar, header, body);
    container.appendChild(root);

    // ---------------------------------------------------------------- expansion helpers
    function exp() { return bySvc ? expSvc : expNormal; }

    function resetExpansion() {
      expNormal = new Set();
      expSvc = new Set();
      svcOpen = new Set();
      if (!model) return;
      const all = model.spans.length <= 500;
      for (const s of model.spans) {
        if (!s.children.length) continue;
        expSvc.add(s.id);
        if (all || s.depth < 3) expNormal.add(s.id);
      }
    }

    function setSvcMode(on) {
      bySvc = !!on;
      lsSet(service_MODE_KEY, bySvc ? '1' : '0');
      btnSvc.setAttribute('aria-pressed', String(bySvc));
      rebuild();
      reveal(selectedId, true);
    }

    function expandAll() {
      if (!model) return;
      const set = exp();
      for (const s of model.spans) if (s.children.length) set.add(s.id);
      if (bySvc && segInfo) for (const seg of segInfo.segs) if (seg.spans.length > 1) svcOpen.add(seg.root.id);
      rebuild();
    }

    function collapseAll() {
      if (bySvc) { svcOpen.clear(); }
      else expNormal.clear();
      rebuild();
      scroller.scrollTop = 0;
    }

    // ---------------------------------------------------------------- filtering
    function computeKeep() {
      filtering = !!(model && store.isFiltering());
      segMatchCache = new Map();
      if (!filtering) { keep = null; return; }
      keep = new Uint8Array(model.spans.length);
      // post-order: children before parents (iterative)
      const order = [];
      const stack = [];
      for (const s of model.spans) if (!s.parent) stack.push(s);
      while (stack.length) {
        const s = stack.pop();
        order.push(s);
        for (const c of s.children) stack.push(c);
      }
      for (let i = order.length - 1; i >= 0; i--) {
        const s = order[i];
        if (store.matches(s)) keep[s.index] = 1;
        if (keep[s.index] && s.parent) keep[s.parent.index] = 1;
      }
      // reveal matches: expand ancestors that lead to kept spans
      const set = exp();
      for (const s of model.spans) {
        if (keep[s.index] && s.children.length && s.children.some((c) => keep[c.index])) set.add(s.id);
      }
      if (bySvc) {
        for (const s of model.spans) if (keep[s.index] && s.children.length) expSvc.add(s.id);
      }
    }

    function segMatches(seg) {
      let n = segMatchCache.get(seg);
      if (n === undefined) {
        n = 0;
        for (const s of seg.spans) if (store.matches(s)) n++;
        segMatchCache.set(seg, n);
      }
      return n;
    }

    function kept(s) { return !filtering || keep[s.index] === 1; }

    // ---------------------------------------------------------------- flatten
    function flatten() {
      rows = [];
      rowIndexById = new Map();
      if (!model) return;
      const stack = [];
      for (let i = model.spans.length - 1; i >= 0; i--) {
        const s = model.spans[i];
        if (!s.parent) stack.push({ seg: bySvc, span: s, depth: 0, pr: -1 });
      }
      let maxDepth = 0;
      while (stack.length) {
        const f = stack.pop();
        const span = f.span;
        if (!kept(span)) continue;
        const i = rows.length;
        if (f.depth > maxDepth) maxDepth = f.depth;
        if (f.seg) {
          const seg = segInfo.segOf.get(span.id);
          if (seg.spans.length > 1 && !svcOpen.has(span.id)) {
            const exits = seg.exits.filter(kept);
            rows.push({ type: 'seg', key: 'g' + span.id, span, seg, depth: f.depth, parent: f.pr, hasKids: exits.length > 0,
              ctx: filtering && segMatches(seg) === 0 });
            rowIndexById.set(span.id, i);
            for (let k = exits.length - 1; k >= 0; k--) stack.push({ seg: true, span: exits[k], depth: f.depth + 1, pr: i });
            continue;
          }
        }
        const kids = filtering ? span.children.filter(kept) : span.children;
        const isExp = kids.length > 0 && exp().has(span.id);
        const segRoot = bySvc && segInfo.segOf.get(span.id).root === span && segInfo.segOf.get(span.id).spans.length > 1;
        rows.push({ type: 'span', key: 's' + span.id, span, depth: f.depth, parent: f.pr, hasKids: kids.length > 0, expanded: isExp,
          segRoot, ctx: filtering && !store.matches(span) });
        rowIndexById.set(span.id, i);
        if (isExp) {
          for (let k = kids.length - 1; k >= 0; k--) {
            const c = kids[k];
            stack.push({ seg: bySvc && c.group !== span.group, span: c, depth: f.depth + 1, pr: i });
          }
        }
      }
      const avail = Math.max(80, (nameW || 360) * 0.5);
      indent = maxDepth ? Math.max(MIN_INDENT, Math.min(MAX_INDENT, Math.floor(avail / maxDepth))) : MAX_INDENT;
    }

    // Row index that currently represents a span (its own row, or the summary row of its collapsed segment).
    function rowOf(id) {
      if (!id) return -1;
      if (rowIndexById.has(id)) return rowIndexById.get(id);
      if (bySvc && segInfo && model.byId.has(id)) {
        const seg = segInfo.segOf.get(id);
        if (seg && rowIndexById.has(seg.root.id) && rows[rowIndexById.get(seg.root.id)].type === 'seg') return rowIndexById.get(seg.root.id);
      }
      return -1;
    }

    // ---------------------------------------------------------------- rendering
    function rebuild() {
      flatten();
      gen++;
      cache.forEach((n) => n.remove());
      cache = new Map();
      lastRange = '';
      spacer.style.height = rows.length * ROW_H + 'px';
      renderStatus();
      renderEmpty();
      renderRows();
    }

    function renderEmpty() {
      U.clear(emptyEl);
      if (!model) {
        emptyEl.append(el('strong', null, 'No trace loaded'), el('span', null, 'Load a Tempo trace export to see its span tree.'));
        emptyEl.classList.remove('is-hidden');
      } else if (!rows.length) {
        emptyEl.append(el('strong', null, 'No spans match the current filters'), el('span', null, 'Clear the search or filters to see the tree.'));
        emptyEl.classList.remove('is-hidden');
      } else emptyEl.classList.add('is-hidden');
    }

    function renderStatus() {
      U.clear(statusEl);
      if (!model) return;
      const total = model.spans.length;
      if (filtering) {
        let m = 0;
        for (const s of model.spans) if (store.matches(s)) m++;
        statusEl.append(el('strong', null, U.fmtCount(m)), ' of ' + U.fmtCount(total) + ' spans match · ' + U.fmtCount(total - (keep ? keep.reduce((a, b) => a + b, 0) : total)) + ' hidden by filters');
      } else {
        statusEl.append(el('strong', null, U.fmtCount(total)), ' spans · ' + U.fmtCount(rows.length) + ' rows shown');
      }
    }

    function renderZoom() {
      U.clear(zoomEl);
      const tw = store.get().timeWindow;
      if (!model || !tw) return;
      zoomEl.append('Zoom ' + U.fmtMs(tw[0]) + ' – ' + U.fmtMs(tw[1]) + ' ',
        el('button', { class: 'tv-btn tv-btn--sm tv-btn--ghost', on: { click: () => store.set({ timeWindow: null }) } }, 'Reset'));
    }

    function x(t) { return ((t - domain[0]) / (domain[1] - domain[0])) * wfW; }

    function renderAxis() {
      U.clear(axisEl);
      U.clear(gridEl);
      if (!model) return;
      const ticks = U.niceTicks(domain[0], domain[1], Math.max(2, Math.floor(wfW / 110)));
      gridEl.style.left = (nameW + 5) + 'px';
      gridEl.style.width = wfW + 'px';
      for (const t of ticks) {
        const px = x(t);
        if (px < -0.5 || px > wfW + 0.5) continue;
        const label = t === 0 ? '0' : U.fmtMs(t);
        const tick = el('span', { class: 'tr-tick tv-num', style: { left: px + 'px' } }, label);
        if (px > wfW - 40) tick.classList.add('is-end');
        axisEl.appendChild(tick);
        gridEl.appendChild(el('span', { class: 'tr-gridline', style: { left: px + 'px' } }));
      }
    }

    function renderRows() {
      if (!model) { rowsEl.textContent = ''; return; }
      const top = scroller.scrollTop;
      const h = scroller.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
      const last = Math.min(rows.length - 1, Math.ceil((top + h) / ROW_H) + OVERSCAN);
      const sig = first + ':' + last + ':' + gen;
      if (sig === lastRange) return;
      lastRange = sig;
      const next = new Map();
      for (let i = first; i <= last; i++) {
        const r = rows[i];
        let n = cache.get(r.key);
        if (!n) n = buildRow(r);
        n.style.top = i * ROW_H + 'px';
        n.dataset.i = i;
        if (!n.parentNode) rowsEl.appendChild(n);
        next.set(r.key, n);
      }
      cache.forEach((n, k) => { if (!next.has(k)) n.remove(); });
      cache = next;
    }

    function labelWidth(text) { return text.length * 6.3 + 6; }

    function placeLabel(lab, text, l, r, onBar) {
      const lw = labelWidth(text);
      if (r + 4 + lw <= wfW) { lab.style.left = (r + 4) + 'px'; }
      else if (l - 4 - lw >= 0) { lab.style.left = (l - 4 - lw) + 'px'; lab.classList.add('is-left'); }
      else { lab.style.left = Math.max(0, Math.min(wfW - lw, r - lw - 2)) + 'px'; lab.classList.add(onBar ? 'is-on' : 'is-left'); }
    }

    function buildBar(span) {
      const wf = el('div', { class: 'tr-wf' });
      const text = U.fmtMs(span.duration);
      const l0 = x(span.start), r0 = x(span.end);
      const lab = el('span', { class: 'tr-dur tv-num' }, text);
      if (r0 < 0 || l0 > wfW) {
        lab.textContent = (r0 < 0 ? '◂ ' : '') + text + (l0 > wfW ? ' ▸' : '');
        lab.classList.add('is-out');
        if (r0 < 0) lab.style.left = '2px'; else { lab.style.left = Math.max(0, wfW - labelWidth(lab.textContent) - 2) + 'px'; }
        wf.appendChild(lab);
        return wf;
      }
      const l = Math.max(0, l0), r = Math.min(wfW, Math.max(r0, l0 + 2));
      const bar = el('span', { class: 'tr-bar ' + U.catClass(span.category) + (span.isError ? ' is-error' : ''),
        style: { left: l + 'px', width: Math.max(2, r - l) + 'px' } });
      wf.appendChild(bar);
      placeLabel(lab, text, l, r, true);
      wf.appendChild(lab);
      return wf;
    }

    function buildSegBar(seg) {
      const wf = el('div', { class: 'tr-wf' });
      let lastPx = -Infinity, cur = null;
      for (const iv of segUnion(seg)) {
        let l = x(iv[0]), r = x(iv[1]);
        if (r < 0 || l > wfW) continue;
        l = Math.max(0, l); r = Math.min(wfW, Math.max(r, l + 1.5));
        if (cur && l - lastPx < 1.5) { cur.style.width = (r - parseFloat(cur.style.left)) + 'px'; lastPx = r; continue; }
        cur = el('span', { class: 'tr-segbar', style: { left: l + 'px', width: (r - l) + 'px' } });
        wf.appendChild(cur);
        lastPx = r;
      }
      const active = U.unionLength(segUnion(seg));
      const text = U.fmtMs(active);
      const lab = el('span', { class: 'tr-dur tv-num' }, text);
      const l = Math.max(0, x(seg.first)), r = Math.min(wfW, x(seg.last));
      if (r < 0 || l > wfW) { lab.classList.add('is-out'); lab.style.left = '2px'; }
      else placeLabel(lab, text, l, Math.max(r, l + 2), false);
      wf.appendChild(lab);
      return wf;
    }

    function hopBadge(span) {
      const hop = hopOf(span);
      if (!hop) return null;
      const typeLabel = U.hopTypeLabel(hop.type);
      return el('span', { class: 'tv-badge tr-hop' }, el('span', { class: 'tv-dot ' + U.catClass(U.hopCategory(hop.type)) }),
        el('span', { class: 'tv-ellipsis' }, '→ ' + typeLabel + ' ' + U.fmtMs(hop.latency)));
    }

    function guides(depth) {
      if (!depth) return null;
      const w = depth * indent;
      const g = el('span', { class: 'tr-guides', style: { width: w + 'px' } });
      if (indent >= 8) {
        g.style.backgroundSize = indent + 'px 100%';
        g.style.paddingLeft = Math.max(0, depth - GUIDE_LEVELS) * indent + 'px';
      } else g.classList.add('is-dense');
      return g;
    }

    function caret(r) {
      if (r.type === 'seg') {
        return el('button', { class: 'tr-caret tr-segbtn', dataset: { act: 'seg' }, attrs: { 'aria-label': 'Expand service spans', title: 'Show the ' + r.seg.spans.length + ' spans' } }, '+');
      }
      if (!r.hasKids) return el('span', { class: 'tr-caret is-leaf' });
      const b = el('button', { class: 'tr-caret' + (r.expanded ? ' is-open' : ''), dataset: { act: 'toggle' },
        attrs: { 'aria-label': r.expanded ? 'Collapse' : 'Expand' } }, chevron());
      return b;
    }

    function buildRow(r) {
      const s = r.span;
      const cls = ['tr-row', r.type === 'seg' ? 'is-seg' : '', r.ctx ? 'is-context' : '', s.isError ? 'has-error' : ''];
      const n = el('div', { class: cls.join(' '), dataset: { key: r.key }, attrs: { role: 'treeitem', 'aria-level': r.depth + 1,
        'aria-expanded': r.type === 'seg' ? 'false' : r.hasKids ? String(!!r.expanded) : null } });
      const name = el('div', { class: 'tr-name' });
      { const g = guides(r.depth); if (g) name.appendChild(g); }
      name.appendChild(caret(r));
      if (r.type === 'seg') {
        const seg = r.seg;
        name.appendChild(el('span', { class: 'tr-svc is-strong tv-ellipsis', dataset: { act: 'group' } }, seg.group));
        const meta = U.fmtCount(seg.spans.length) + ' spans · ' + U.fmtMs(U.unionLength(segUnion(seg)));
        name.appendChild(el('span', { class: 'tr-meta tv-num tv-ellipsis' }, meta));
        if (filtering) {
          const m = segMatches(seg);
          if (m) name.appendChild(el('span', { class: 'tv-badge tr-match' }, U.fmtCount(m) + ' match'));
        }
        { const hb = hopBadge(s); if (hb) name.appendChild(hb); }
        if (seg.errors) name.appendChild(el('span', { class: 'tv-badge tv-badge--critical tr-flag' }, el('span', { class: 'tv-status tv-status--critical', attrs: { 'aria-hidden': 'true' } }, '!'), U.fmtCount(seg.errors) + ' error' + (seg.errors > 1 ? 's' : '')));
        if (s.isOrphan) name.appendChild(el('span', { class: 'tv-badge tv-badge--warning tr-flag' }, 'missing parent'));
        n.append(name, el('div', { class: 'tr-gap' }), buildSegBar(seg));
        return n;
      }
      name.appendChild(el('span', { class: 'tv-dot ' + U.catClass(s.category) }));
      name.appendChild(el('span', { class: 'tr-label tv-ellipsis' }, s.name || '(unnamed)'));
      const hop = hopOf(s);
      name.appendChild(el('span', { class: 'tr-svc tv-ellipsis' + (hop || !s.parent ? ' is-strong' : ''), dataset: { act: 'group' } }, s.group));
      if (r.segRoot) name.appendChild(el('button', { class: 'tr-caret tr-segbtn', dataset: { act: 'unseg' }, attrs: { 'aria-label': 'Collapse service into one row', title: 'Collapse this service back into one summary row' } }, '−'));
      { const hb = hopBadge(s); if (hb) name.appendChild(hb); }
      if (s.isOrphan) name.appendChild(el('span', { class: 'tv-badge tv-badge--warning tr-flag' }, 'missing parent'));
      if (s.isError) name.appendChild(el('span', { class: 'tv-status tv-status--critical tr-err', attrs: { role: 'img', 'aria-label': 'Error' } }, '!'));
      n.append(name, el('div', { class: 'tr-gap' }), buildBar(s));
      if (s.id === selectedId) n.classList.add('is-selected');
      if (s.id === hoverId) n.classList.add('is-hover');
      return n;
    }

    function syncMarks() {
      const selRow = rowOf(selectedId);
      const hovRow = rowOf(hoverId);
      cache.forEach((n) => {
        const i = +n.dataset.i;
        n.classList.toggle('is-selected', i === selRow);
        n.classList.toggle('is-hover', i === hovRow && i !== selRow);
        if (i === selRow) n.setAttribute('aria-selected', 'true'); else n.removeAttribute('aria-selected');
      });
    }

    function scrollToRow(i, center) {
      if (i < 0) return;
      const top = i * ROW_H, h = scroller.clientHeight;
      if (top >= scroller.scrollTop && top + ROW_H <= scroller.scrollTop + h) return;
      scroller.scrollTop = center ? Math.max(0, top - h / 2 + ROW_H / 2) : (top < scroller.scrollTop ? top : top + ROW_H - h);
    }

    // Make a span visible (expand ancestors / open its service segment) and scroll it into view.
    function reveal(id, center) {
      if (!model || !id || !model.byId.has(id)) { syncMarks(); return; }
      const span = model.byId.get(id);
      if (filtering && !keep[span.index]) { syncMarks(); return; }
      if (!rowIndexById.has(id)) {
        let changed = false;
        const set = exp();
        for (let p = span.parent; p; p = p.parent) if (!set.has(p.id)) { set.add(p.id); changed = true; }
        if (bySvc) {
          const seg = segInfo.segOf.get(id);
          if (seg && seg.root !== span && !svcOpen.has(seg.root.id)) { svcOpen.add(seg.root.id); changed = true; }
        }
        if (changed) rebuild();
      }
      syncMarks();
      scrollToRow(rowOf(id), center);
      renderRows();
      syncMarks();
    }

    // ---------------------------------------------------------------- tooltips
    // rows are written [value, label] here (values lead); util.tooltip takes [label, value]
    function tipRows(list) { return list.map((row) => (Array.isArray(row) ? [row[1], row[0]] : row)); }

    function tipFor(r) {
      const s = r.span;
      if (r.type === 'seg') {
        const seg = r.seg;
        const rows2 = [
          seg.group,
          [U.fmtCount(seg.spans.length), 'spans in this service subtree'],
          [U.fmtMs(U.unionLength(segUnion(seg))), 'active time'],
          [U.fmtOffset(seg.first) + ' → ' + U.fmtOffset(seg.last), 'window'],
          [U.fmtCount(seg.exits.length), 'calls into other services'],
          seg.errors ? [U.fmtCount(seg.errors), 'errors'] : null,
          [s.name, 'entry span'],
        ];
        const hop = hopOf(s);
        if (hop) rows2.push([U.hopTypeLabel(hop.type) + ' from ' + hop.from + ' · ' + U.fmtMs(hop.latency), 'hop in']);
        return rows2;
      }
      const hop = hopOf(s);
      const out = [
        s.name || '(unnamed)',
        [U.fmtMs(s.duration), 'duration'],
        [U.fmtMs(s.selfTime), 'self time'],
        [U.fmtOffset(s.start), 'start'],
        [s.group, 'service'],
        [catLabel(s.category) + (s.kind ? ' · ' + s.kind : ''), 'category'],
      ];
      if (s.op && s.op.summary && s.op.summary !== s.name) out.push([s.op.summary, 'operation']);
      if (hop) {
        out.push([U.hopTypeLabel(hop.type) + ' from ' + hop.from + (hop.label ? ' · ' + hop.label : ''), 'hop in']);
        out.push([U.fmtMs(hop.latency) + (hop.queue > 0 ? ' (queue ' + U.fmtMs(hop.queue) + ')' : ''), 'hop latency']);
      }
      if (s.isError) out.push([s.statusMessage || 'error', 'status']);
      if (s.isOrphan) out.push([s.parentId || '–', 'missing parent']);
      if (s.children.length) out.push([U.fmtCount(s.children.length), 'children']);
      if (r.ctx) out.push(['shown as context (does not match filters)', '']);
      return out;
    }

    // ---------------------------------------------------------------- events
    function rowFromEvent(e) {
      const n = e.target.closest && e.target.closest('.tr-row');
      if (!n || !rowsEl.contains(n)) return null;
      const i = +n.dataset.i;
      return rows[i] && rows[i].key === n.dataset.key ? { r: rows[i], i, n } : null;
    }

    function toggleRow(r) {
      if (r.type === 'seg') { svcOpen.add(r.span.id); }
      else if (r.hasKids) { const set = exp(); if (set.has(r.span.id)) set.delete(r.span.id); else set.add(r.span.id); }
      else return;
      rebuild();
      syncMarks();
    }

    function onClick(e) {
      const hit = rowFromEvent(e);
      if (!hit) return;
      const actEl = e.target.closest('[data-act]');
      const act = actEl && actEl.dataset.act;
      if (act === 'toggle' || act === 'seg') { toggleRow(hit.r); return; }
      if (act === 'unseg') { svcOpen.delete(hit.r.span.id); rebuild(); syncMarks(); return; }
      if (act === 'group') { api.selectGroup(hit.r.span.group, { additive: e.shiftKey || e.metaKey || e.ctrlKey }); return; }
      scroller.focus({ preventScroll: true });
      api.selectSpan(hit.r.span.id);
    }

    function onDblClick(e) {
      const hit = rowFromEvent(e);
      if (!hit || e.target.closest('[data-act]')) return;
      toggleRow(hit.r);
    }

    function setHover(id) {
      if (id === hoverId) return;
      hoverId = id;
      syncMarks();
      if (store.get().hoverSpanId !== id) store.set({ hoverSpanId: id });
    }

    let tipKey = null;
    function onMove(e) {
      const hit = rowFromEvent(e);
      if (!hit) { onLeave(); return; }
      setHover(hit.r.span.id);
      if (tipKey !== hit.r.key + gen) {
        tipKey = hit.r.key + gen;
        U.tooltip.show(e.clientX, e.clientY, tipRows(tipFor(hit.r)));
      } else U.tooltip.move(e.clientX, e.clientY);
    }
    function onLeave() {
      tipKey = null;
      U.tooltip.hide();
      setHover(null);
    }

    function select(i) {
      if (i < 0 || i >= rows.length) return;
      api.selectSpan(rows[i].span.id);
      scrollToRow(i, false);
      renderRows();
      syncMarks();
    }

    function onKey(e) {
      if (!model || !rows.length) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      let i = rowOf(selectedId);
      const r = rows[i];
      const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
      switch (e.key) {
        case 'ArrowDown': select(i < 0 ? Math.floor(scroller.scrollTop / ROW_H) : Math.min(rows.length - 1, i + 1)); break;
        case 'ArrowUp': select(i < 0 ? Math.floor(scroller.scrollTop / ROW_H) : Math.max(0, i - 1)); break;
        case 'PageDown': select(Math.min(rows.length - 1, Math.max(0, i) + page)); break;
        case 'PageUp': select(Math.max(0, i - page)); break;
        case 'Home': select(0); break;
        case 'End': select(rows.length - 1); break;
        case 'ArrowRight':
          if (!r) return;
          if (r.type === 'seg' || (r.hasKids && !r.expanded)) toggleRow(r);
          else if (r.hasKids) select(i + 1);
          break;
        case 'ArrowLeft':
          if (!r) return;
          if (r.type === 'span' && r.hasKids && r.expanded) toggleRow(r);
          else if (r.segRoot) { svcOpen.delete(r.span.id); rebuild(); select(rowOf(r.span.id)); }
          else if (r.parent >= 0) select(r.parent);
          break;
        case 'Enter': if (r) api.selectSpan(r.span.id); else select(Math.floor(scroller.scrollTop / ROW_H)); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    }

    const onScroll = U.rafThrottle(() => { renderRows(); syncMarks(); });

    rowsEl.addEventListener('click', onClick);
    rowsEl.addEventListener('dblclick', onDblClick);
    rowsEl.addEventListener('mousemove', onMove);
    rowsEl.addEventListener('mouseleave', onLeave);
    scroller.addEventListener('scroll', () => { U.tooltip.hide(); tipKey = null; onScroll(); });
    scroller.addEventListener('keydown', onKey);

    // ---------------------------------------------------------------- column resizer
    function applyNameW() {
      root.style.setProperty('--tr-name-w', nameW + 'px');
      const sb = scroller.offsetWidth - scroller.clientWidth;
      wfW = Math.max(60, (root.clientWidth || 800) - nameW - 5 - 12 - sb);
      root.style.setProperty('--tr-wf-w', wfW + 'px');
      header.style.paddingRight = sb + 'px';
    }

    function clampName(w) {
      const total = root.clientWidth || 800;
      return Math.round(Math.max(200, Math.min(total - 180, w)));
    }

    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = nameW;
      root.classList.add('is-resizing');
      const move = (ev) => { nameW = clampName(w0 + ev.clientX - x0); applyNameW(); relayout(); };
      const up = () => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        resizer.removeEventListener('pointercancel', up);
        root.classList.remove('is-resizing');
        lsSet(NAME_W_KEY, String(nameW));
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
      resizer.addEventListener('pointercancel', up);
    });
    resizer.addEventListener('dblclick', () => { nameW = clampName((root.clientWidth || 800) * 0.46); lsSet(NAME_W_KEY, String(nameW)); applyNameW(); relayout(); });

    // ---------------------------------------------------------------- axis brush (zoom)
    axisEl.addEventListener('pointerdown', (e) => {
      if (!model || e.button !== 0) return;
      e.preventDefault();
      axisEl.setPointerCapture(e.pointerId);
      const rect = axisEl.getBoundingClientRect();
      const px0 = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      let px1 = px0;
      brushEl.style.left = (nameW + 5 + px0) + 'px';
      brushEl.style.width = '0px';
      brushEl.classList.remove('is-hidden');
      const move = (ev) => {
        px1 = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
        brushEl.style.left = (nameW + 5 + Math.min(px0, px1)) + 'px';
        brushEl.style.width = Math.abs(px1 - px0) + 'px';
      };
      const up = () => {
        axisEl.removeEventListener('pointermove', move);
        axisEl.removeEventListener('pointerup', up);
        axisEl.removeEventListener('pointercancel', up);
        brushEl.classList.add('is-hidden');
        if (Math.abs(px1 - px0) < 4) return;
        const t = (px) => domain[0] + (px / rect.width) * (domain[1] - domain[0]);
        store.set({ timeWindow: [t(Math.min(px0, px1)), t(Math.max(px0, px1))] });
      };
      axisEl.addEventListener('pointermove', move);
      axisEl.addEventListener('pointerup', up);
      axisEl.addEventListener('pointercancel', up);
    });
    axisEl.addEventListener('dblclick', () => { if (store.get().timeWindow) store.set({ timeWindow: null }); });
    axisEl.addEventListener('mousemove', (e) => {
      if (!model) return;
      const rect = axisEl.getBoundingClientRect();
      const t = domain[0] + ((e.clientX - rect.left) / rect.width) * (domain[1] - domain[0]);
      U.tooltip.show(e.clientX, e.clientY, tipRows([[U.fmtOffset(t), 'from trace start'], ['drag to zoom · double-click to reset', '']]));
    });
    axisEl.addEventListener('mouseleave', () => U.tooltip.hide());

    // ---------------------------------------------------------------- layout
    function computeDomain() {
      const tw = store.get().timeWindow;
      if (tw && tw[1] > tw[0]) domain = [tw[0], tw[1]];
      else domain = [0, model && model.duration > 0 ? model.duration : 1];
    }

    function relayout() {
      computeDomain();
      renderAxis();
      renderZoom();
      gen++;
      cache.forEach((n) => n.remove());
      cache = new Map();
      lastRange = '';
      renderRows();
      syncMarks();
    }

    const ro = new ResizeObserver(U.rafThrottle(() => {
      if (!root.isConnected) return;
      if (!nameW) nameW = clampName((root.clientWidth || 800) * 0.46);
      else nameW = clampName(nameW);
      applyNameW();
      relayout();
    }));
    ro.observe(root);

    // ---------------------------------------------------------------- update contract
    function update(state, changed) {
      const all = changed.has('*');
      if (all || changed.has('model')) {
        model = state.model;
        segInfo = model ? buildSegments(model) : null;
        resetExpansion();
        scroller.scrollTop = 0;
        lastFilterSig = '';
        hoverId = null;
        if (!nameW) nameW = clampName((root.clientWidth || 800) * 0.46);
        applyNameW();
      }
      selectedId = state.selectedSpanId;
      const filterSig = [state.search, JSON.stringify(state.filters), (state.selectedGroups || []).join('\u0001')].join('\u0002');
      const filterChanged = filterSig !== lastFilterSig;
      let structural = all || changed.has('model');
      if (filterChanged) { lastFilterSig = filterSig; computeKeep(); structural = true; }
      if (all || changed.has('model') || changed.has('timeWindow')) { computeDomain(); renderAxis(); renderZoom(); structural = true; }
      if (structural) rebuild();
      if (all || changed.has('model') || changed.has('selectedSpanId') || filterChanged) {
        reveal(selectedId, true);
      }
      if (changed.has('hoverSpanId') && state.hoverSpanId !== hoverId) { hoverId = state.hoverSpanId; syncMarks(); }
      else if (structural) syncMarks();
    }

    function destroy() {
      ro.disconnect();
      U.tooltip.hide();
      root.remove();
    }

    return { update, destroy };
  }

  TV.views.register({ id: 'tree', title: 'Spans', order: 5, slot: 'main', shortcut: '5', mount });
})(globalThis.TV = globalThis.TV || {});
