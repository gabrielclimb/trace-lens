(function (TV) {
  'use strict';

  const LABEL_MIN_FRAC = 0.06;
  const SLOW_MS = 25;
  const DARK_INK_CATS = { http: true, internal: true };

  function mount(container, api) {
    const U = api.util || TV.util;
    const store = api.store;
    const el = U.el;

    const root = el('div', { class: 'jn' });
    container.appendChild(root);

    let model = null;
    let pickCache = { model: null, list: [] };
    let spanEls = new Map();      // spanId -> Element[] (selection / hover highlight)
    let groupEls = new Map();     // groupKey -> Element[] (selected group highlight)
    let dimItems = [];            // { node, spans?: Span[], group?: string }
    let curSel = null, curHover = null;

    const ro = new ResizeObserver((entries) => {
      const w = entries[0] ? entries[0].contentRect.width : root.clientWidth;
      root.classList.toggle('jn--narrow', w < 760);
    });
    ro.observe(root);

    // ---------------------------------------------------------------- helpers

    function catLabel(cat) {
      const c = U.CATEGORIES.find((x) => x.id === cat);
      return c ? c.label : cat;
    }

    function setHover(id) {
      if (store.get().hoverSpanId !== id) store.set({ hoverSpanId: id });
    }

    function track(map, key, node) {
      if (key == null) return;
      let arr = map.get(key);
      if (!arr) map.set(key, (arr = []));
      arr.push(node);
    }

    // rows[0] = title, then [label, value] pairs (values lead in the grid)
    function tipContent(rows) {
      const grid = el('div', { class: 'tv-tt-rows' });
      for (const r of rows.slice(1)) {
        if (!r) continue;
        grid.appendChild(el('span', { class: 'tv-tt-value' }, r[1] == null || r[1] === '' ? '–' : String(r[1])));
        grid.appendChild(el('span', { class: 'tv-tt-label' }, r[0]));
      }
      return el('div', null, el('div', { class: 'tv-tt-title' }, rows[0]), grid);
    }

    function tipHandlers(spanId, content) {
      return {
        mouseenter(e) { U.tooltip.show(e.clientX, e.clientY, tipContent(content())); if (spanId) setHover(spanId); },
        mousemove(e) { U.tooltip.move(e.clientX, e.clientY); },
        mouseleave() { U.tooltip.hide(); if (spanId) setHover(null); },
      };
    }

    function additive(e) { return !!(e && (e.shiftKey || e.metaKey || e.ctrlKey)); }

    function svcChip(key, extraClass) {
      const chip = el('button', {
        class: 'tv-svc jn-svc' + (extraClass ? ' ' + extraClass : ''),
        attrs: { type: 'button', title: key + ' — click to focus (Shift/Cmd to add)' },
        on: {
          click(e) { e.stopPropagation(); api.selectGroup(key, { additive: additive(e) }); },
        },
      }, key);
      track(groupEls, key, chip);
      return chip;
    }

    function activate(node, fn) {
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      node.addEventListener('click', fn);
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } });
    }

    function targetOptions() {
      if (pickCache.model === model) return pickCache.list;
      const best = new Map();
      for (const s of model.spans) {
        const b = best.get(s.group);
        if (!b || s.end > b.end || (s.end === b.end && s.start >= b.start)) best.set(s.group, s);
      }
      const list = Array.from(best.values()).sort((a, b) => b.end - a.end);
      pickCache = { model, list };
      return list;
    }

    function optionLabel(s) {
      return s.group + ' — ' + U.truncateMiddle(s.name, 56) + ' (t' + U.fmtOffset(s.end) + ')';
    }

    function tickLabel(v) { return v === 0 ? '0' : U.fmtMs(v); }

    function axis(t0, t1, count, cls) {
      const span = Math.max(t1 - t0, 1e-9);
      const ax = el('div', { class: 'jn-axis' + (cls ? ' ' + cls : '') });
      for (const t of U.niceTicks(t0, t1, count)) {
        if (t < t0 - 1e-9 || t > t1 + 1e-9) continue;
        const f = (t - t0) / span;
        const tick = el('span', { class: 'jn-tick tv-num', style: { left: (f * 100) + '%' } }, tickLabel(t));
        if (f < 0.04) tick.classList.add('is-first');
        else if (f > 0.96) tick.classList.add('is-last');
        ax.appendChild(tick);
      }
      return ax;
    }

    function gridlines(t0, t1, count) {
      const span = Math.max(t1 - t0, 1e-9);
      const frag = document.createDocumentFragment();
      for (const t of U.niceTicks(t0, t1, count)) {
        if (t <= t0 || t >= t1) continue;
        frag.appendChild(el('span', { class: 'jn-gridline', style: { left: ((t - t0) / span * 100) + '%' } }));
      }
      return frag;
    }

    function pos(node, start, end, t0, t1, gap) {
      const span = Math.max(t1 - t0, 1e-9);
      const left = (start - t0) / span * 100;
      const width = Math.max(0, end - start) / span * 100;
      node.style.left = left + '%';
      node.style.width = gap ? 'max(1px, calc(' + width + '% - ' + gap + 'px))' : 'max(1px, ' + width + '%)';
      return node;
    }

    function segTip(seg, total) {
      return () => {
        const share = U.pct(seg.duration, total);
        const win = 't' + U.fmtOffset(seg.start) + ' → t' + U.fmtOffset(seg.end);
        if (seg.type === 'work') {
          return [
            seg.span.name,
            ['on path', U.fmtMs(seg.duration)],
            ['of total', share],
            ['service', seg.group],
            ['work', catLabel(seg.span.category)],
            seg.label && seg.label !== seg.span.name ? ['op', seg.label] : null,
            ['window', win],
          ];
        }
        if (seg.type === 'transit') {
          const to = seg.toSpan ? seg.toSpan.group : '';
          return [
            'Queue / transport · ' + U.hopTypeLabel(seg.hopType || 'call'),
            ['duration', U.fmtMs(seg.duration)],
            ['of total', share],
            ['route', seg.group + ' → ' + to],
            seg.label ? [seg.hopType === 'kafka' ? 'topic' : 'call', seg.label] : null,
            ['window', win],
          ];
        }
        return [
          'In-service wait · ' + seg.group,
          ['duration', U.fmtMs(seg.duration)],
          ['of total', share],
          ['held by', seg.span.name],
          seg.toSpan ? ['until', seg.toSpan.name] : null,
          seg.label ? ['topic', seg.label] : null,
          ['window', win],
        ];
      };
    }

    function segClass(seg) {
      if (seg.type === 'work') return 'jn-seg jn-seg--work ' + U.catClass(seg.span.category) + (DARK_INK_CATS[seg.span.category] ? ' jn-ink-dark' : '');
      if (seg.type === 'transit') return 'jn-seg jn-seg--transit tv-hatch';
      return 'jn-seg jn-seg--wait tv-dots';
    }

    function segSelectId(seg) {
      return seg.type === 'work' ? seg.span.id : (seg.toSpan || seg.span).id;
    }

    function segSpans(seg) {
      return seg.toSpan ? [seg.span, seg.toSpan] : [seg.span];
    }

    // ---------------------------------------------------------------- sections

    function renderHeader(journey, state) {
      const opts = targetOptions();
      const select = el('select', {
        class: 'tv-select jn-picker-select',
        attrs: { 'aria-label': 'Journey target span' },
        on: { change() { store.set({ pathTargetId: select.value || null }); } },
      });
      const target = journey.target;
      if (!opts.some((s) => s.id === target.id)) {
        select.appendChild(el('option', { value: target.id, text: optionLabel(target) + ' · current' }));
      }
      for (const s of opts) select.appendChild(el('option', { value: s.id, text: optionLabel(s) }));
      select.value = target.id;

      const reset = state.pathTargetId
        ? el('button', {
          class: 'tv-btn tv-btn--sm tv-btn--ghost',
          attrs: { type: 'button', title: 'Back to the latest-ending span' },
          on: { click() { store.set({ pathTargetId: null }); } },
        }, 'Reset')
        : null;

      return el('div', { class: 'jn-head' },
        el('div', { class: 'jn-titlebox' },
          el('h2', { class: 'jn-title' }, 'Where did the time go?'),
          el('div', { class: 'jn-subtitle tv-secondary' },
            'Critical path to ',
            el('span', { class: 'jn-strong' }, target.name),
            ' in ',
            svcChip(target.group),
            ' — ' + journey.chain.length + ' spans across ' + journey.byGroup.length + ' services')),
        el('div', { class: 'jn-picker' },
          el('label', { class: 'tv-section-title' }, 'Target'),
          el('div', { class: 'jn-picker-row' }, select, reset),
          el('div', { class: 'jn-hint tv-muted' }, 'or use “Path to here” on any span')));
    }

    function renderTiles(journey) {
      const total = journey.total;
      const tile = (label, value, sub, keyCls) => el('div', { class: 'jn-tile tv-card' },
        el('div', { class: 'jn-tile-label' }, keyCls ? el('span', { class: 'tv-key ' + keyCls }) : null, label),
        el('div', { class: 'jn-tile-value tv-num' }, value),
        el('div', { class: 'jn-tile-sub tv-muted tv-num' }, sub));
      return el('div', { class: 'jn-tiles' },
        tile('Total', U.fmtMs(total), 't' + U.fmtOffset(journey.chain[0].start) + ' → t' + U.fmtOffset(journey.target.end), null),
        tile('Work', U.fmtMs(journey.workTotal), U.pct(journey.workTotal, total) + ' of total', 'jn-key-work'),
        tile('Queues / transport', U.fmtMs(journey.transitTotal), U.pct(journey.transitTotal, total) + ' of total', 'tv-hatch'),
        tile('In-service wait', U.fmtMs(journey.waitTotal), U.pct(journey.waitTotal, total) + ' of total', 'tv-dots'));
    }

    function legend(journey) {
      const cats = [];
      for (const seg of journey.segments) {
        if (seg.type === 'work' && !cats.includes(seg.span.category)) cats.push(seg.span.category);
      }
      cats.sort((a, b) => U.CATEGORY_IDS.indexOf(a) - U.CATEGORY_IDS.indexOf(b));
      return el('div', { class: 'jn-legend' },
        el('span', { class: 'jn-legend-item' }, 'Work:'),
        cats.map((c) => el('span', { class: 'jn-legend-item' }, el('span', { class: 'tv-key ' + U.catClass(c) }), catLabel(c))),
        el('span', { class: 'jn-legend-item' }, el('span', { class: 'tv-key tv-hatch' }), 'Queue / transport'),
        el('span', { class: 'jn-legend-item' }, el('span', { class: 'tv-key tv-dots' }), 'In-service wait'));
    }

    function renderStackedBar(journey) {
      const t0 = journey.chain[0].start, t1 = journey.target.end;
      const total = Math.max(journey.total, 1e-9);
      const bar = el('div', { class: 'jn-sbar', attrs: { role: 'list', 'aria-label': 'Journey segments in time order' } });
      for (const seg of journey.segments) {
        const node = el('div', { class: segClass(seg), attrs: { role: 'listitem' }, on: tipHandlers(seg.span.id, segTip(seg, total)) });
        pos(node, seg.start, seg.end, t0, t1, 2);
        if (seg.duration / total >= LABEL_MIN_FRAC) {
          const txt = seg.type === 'work' ? seg.group + ' · ' + U.fmtMs(seg.duration)
            : seg.type === 'transit' ? 'queue ' + U.fmtMs(seg.duration)
              : 'wait · ' + seg.group + ' · ' + U.fmtMs(seg.duration);
          node.appendChild(el('span', { class: 'jn-seg-label tv-num' }, txt));
        }
        node.setAttribute('aria-label', seg.type + ' ' + seg.group + ' ' + U.fmtMs(seg.duration));
        activate(node, () => api.selectSpan(segSelectId(seg)));
        track(spanEls, seg.span.id, node);
        if (seg.toSpan && seg.type !== 'transit') track(spanEls, seg.toSpan.id, node);
        dimItems.push({ node, spans: segSpans(seg) });
        bar.appendChild(node);
      }
      return el('section', { class: 'jn-card tv-card' },
        el('div', { class: 'jn-card-head' },
          el('h3', { class: 'tv-section-title' }, 'Path timeline · ' + U.fmtMs(journey.total)),
          legend(journey)),
        bar,
        axis(t0, t1, 7),
        el('div', { class: 'jn-axis-caption tv-muted' }, 'time since trace start'));
    }

    function renderSteps(journey, state, flags) {
      const T0 = 0;
      const T1 = Math.max(model.duration, journey.target.end);
      const workBySpan = new Map(), transitByParent = new Map(), waitByTo = new Map();
      for (const seg of journey.segments) {
        if (seg.type === 'work') track(workBySpan, seg.span.id, seg);
        else if (seg.type === 'transit') transitByParent.set(seg.span.id, seg);
        else if (seg.toSpan) waitByTo.set(seg.toSpan.id, seg);
      }

      const runs = [];
      for (const s of journey.chain) {
        const last = runs[runs.length - 1];
        if (last && last.group === s.group) last.spans.push(s);
        else runs.push({ group: s.group, spans: [s] });
      }

      const list = el('div', { class: 'jn-steps' });
      list.appendChild(el('div', { class: 'jn-row jn-row--head' },
        el('span'),
        el('span', { class: 'jn-colhead' }, 'Service / span'),
        el('span', { class: 'jn-colhead jn-col-start' }, 'start'),
        el('div', { class: 'jn-col-bar' }, axis(T0, T1, 4, 'jn-axis--mini')),
        el('span', { class: 'jn-colhead jn-col-dur' }, 'on path')));

      const totalRows = runs.reduce((n, r) => n + r.spans.length + 1, 0) + runs.length - 1;
      let rowIdx = 0;
      const rail = (kind) => {
        const r = el('div', { class: 'jn-rail jn-rail--' + kind });
        if (rowIdx === 0) r.classList.add('is-start');
        if (rowIdx === totalRows - 1) r.classList.add('is-end');
        rowIdx++;
        return r;
      };

      runs.forEach((run, ri) => {
        if (ri > 0) list.appendChild(connectorRow(runs[ri - 1].spans[runs[ri - 1].spans.length - 1], run.spans[0], transitByParent, waitByTo, flags, journey, T0, T1, rail('hop')));

        const runWork = run.spans.reduce((n, s) => n + (workBySpan.get(s.id) || []).reduce((m, g) => m + g.duration, 0), 0);
        const head = el('div', { class: 'jn-row jn-row--block' },
          rail('station'),
          el('div', { class: 'jn-block-main' },
            svcChip(run.group),
            el('span', { class: 'tv-muted tv-num jn-block-meta' },
              run.spans.length + (run.spans.length === 1 ? ' span' : ' spans') + ' · ' + U.fmtMs(runWork) + ' work · ' + U.pct(runWork, journey.total))));
        dimItems.push({ node: head, group: run.group });
        list.appendChild(head);

        for (const s of run.spans) list.appendChild(stepRow(s, s === journey.target, workBySpan.get(s.id) || [], transitByParent.get(s.id), T0, T1, rail('step')));
      });

      return el('section', { class: 'jn-card tv-card' },
        el('div', { class: 'jn-card-head' },
          el('h3', { class: 'tv-section-title' }, 'Step by step'),
          el('span', { class: 'tv-muted jn-card-note' }, 'bars on the full-trace time scale · click a step to inspect')),
        list);
    }

    function stepRow(s, isTarget, works, transit, T0, T1, railNode) {
      railNode.appendChild(el('span', { class: 'jn-node ' + U.catClass(s.category) }));
      const work = works.reduce((n, g) => n + g.duration, 0);
      const sub = s.op && s.op.summary && s.op.summary !== s.name ? s.op.summary : catLabel(s.category);

      const barTrack = el('div', { class: 'jn-mini' }, gridlines(T0, T1, 4));
      barTrack.appendChild(pos(el('span', { class: 'jn-mini-extent ' + U.catClass(s.category) }), s.start, s.end, T0, T1));
      for (const g of works) barTrack.appendChild(pos(el('span', { class: 'jn-mini-seg ' + U.catClass(s.category) }), g.start, g.end, T0, T1));
      if (transit) barTrack.appendChild(pos(el('span', { class: 'jn-mini-seg tv-hatch' }), transit.start, transit.end, T0, T1));

      const tip = () => [
        s.name,
        ['on path', U.fmtMs(work)],
        ['span duration', U.fmtMs(s.duration)],
        ['start', 't' + U.fmtOffset(s.start)],
        ['service', s.group],
        [catLabel(s.category), s.op ? s.op.summary : ''],
        s.isError ? ['status', 'error' + (s.statusMessage ? ': ' + s.statusMessage : '')] : null,
      ];
      barTrack.addEventListener('mouseenter', (e) => U.tooltip.show(e.clientX, e.clientY, tipContent(tip())));
      barTrack.addEventListener('mousemove', (e) => U.tooltip.move(e.clientX, e.clientY));
      barTrack.addEventListener('mouseleave', () => U.tooltip.hide());

      const row = el('div', { class: 'jn-row jn-row--step' + (s.isError ? ' is-error' : '') + (isTarget ? ' is-target' : '') },
        railNode,
        el('div', { class: 'jn-step-main' },
          el('div', { class: 'jn-step-name' },
            s.isError ? U.statusIcon('error') : null,
            el('span', { class: 'tv-ellipsis', title: s.name }, s.name),
            isTarget ? el('span', { class: 'tv-badge tv-badge--strong' }, 'target') : null),
          el('div', { class: 'jn-step-sub tv-ellipsis tv-secondary', title: sub }, sub)),
        el('span', { class: 'jn-col-start tv-num tv-muted' }, 't' + U.fmtOffset(s.start)),
        el('div', { class: 'jn-col-bar' }, barTrack),
        el('span', { class: 'jn-col-dur tv-num' + (work > 0 ? '' : ' tv-muted') }, work > 0 ? U.fmtMs(work) : '—'));
      row.addEventListener('mouseenter', () => setHover(s.id));
      row.addEventListener('mouseleave', () => setHover(null));
      activate(row, () => api.selectSpan(s.id));
      track(spanEls, s.id, row);
      dimItems.push({ node: row, spans: [s] });
      return row;
    }

    function connectorRow(p, c, transitByParent, waitByTo, flags, journey, T0, T1, railNode) {
      let transit = transitByParent.get(p.id) || null;
      if (transit && transit.toSpan && transit.toSpan.group !== c.group) transit = null;
      const wait = waitByTo.get(c.id) || null;
      const hop = (transit && transit.hop) || (wait && wait.hop) || c.hopIn || null;
      const type = hop ? hop.type
        : c.category === 'messaging' || p.category === 'messaging' ? 'kafka'
          : c.category === 'rpc' ? 'grpc' : c.category === 'http' ? 'http' : 'call';
      const label = hop ? hop.label : (c.op && c.op.destination) || c.name;
      const queue = transit ? transit.duration : 0;
      const waitMs = wait ? wait.duration : 0;
      const reached = transit && transit.toSpan ? transit.toSpan : c;
      const slowFlag = flags.slow.some((ids) => ids.has(p.id) && (ids.has(c.id) || ids.has(reached.id)));
      const waitFlag = flags.wait.some((ids) => ids.has(c.id) || (wait && ids.has(wait.span.id)));
      const slowQueue = queue >= SLOW_MS || slowFlag;
      const longWait = waitMs >= SLOW_MS || waitFlag;
      const hot = slowQueue || longWait;

      const barTrack = el('div', { class: 'jn-mini jn-mini--hop' }, gridlines(T0, T1, 4));
      if (transit) barTrack.appendChild(pos(el('span', { class: 'jn-mini-seg tv-hatch' }), transit.start, transit.end, T0, T1));
      if (wait) barTrack.appendChild(pos(el('span', { class: 'jn-mini-seg tv-dots' }), wait.start, wait.end, T0, T1));

      const details = [];
      if (transit) details.push(el('span', { class: 'tv-num' + (slowQueue ? ' jn-hot' : '') }, 'queue ' + U.fmtMs(queue)));
      if (wait) details.push(el('span', { class: 'tv-num' + (longWait ? ' jn-hot' : '') }, 'in-service wait ' + U.fmtMs(waitMs) + ' in ' + c.group));
      if (!transit && !wait) details.push(el('span', { class: 'tv-muted tv-num' }, (hop && !hop.async ? 'sync call' : 'no gap') + ' · latency ' + U.fmtMs(Math.max(0, c.start - p.start))));
      const badges = [];
      if (slowQueue) badges.push(el('span', { class: 'tv-badge tv-badge--warning' }, el('span', { class: 'tv-status tv-status--warning' }, '!'), 'slow queue'));
      if (longWait) badges.push(el('span', { class: 'tv-badge tv-badge--warning' }, el('span', { class: 'tv-status tv-status--warning' }, '!'), 'long wait'));

      railNode.classList.toggle('is-hot', hot);
      const tip = () => [
        U.hopTypeLabel(type) + ' hop · ' + p.group + ' → ' + c.group,
        ['queue / transport', U.fmtMs(queue)],
        ['in-service wait', U.fmtMs(waitMs)],
        ['of total', U.pct(queue + waitMs, journey.total)],
        label ? [type === 'kafka' ? 'topic' : 'call', label] : null,
        ['from', p.name],
        ['to', c.name],
        slowFlag ? ['insight', 'slow hop'] : null,
        waitFlag ? ['insight', 'async wait'] : null,
      ];

      const row = el('div', { class: 'jn-row jn-row--hop' + (hot ? ' is-hot' : '') },
        railNode,
        el('div', { class: 'jn-hop-main' },
          el('div', { class: 'jn-hop-line' },
            el('span', { class: 'tv-badge' }, U.hopTypeLabel(type)),
            el('span', { class: 'jn-hop-label tv-mono tv-ellipsis', title: label }, label),
            badges),
          el('div', { class: 'jn-hop-detail tv-secondary' }, details)),
        el('span', { class: 'jn-col-start' }),
        el('div', { class: 'jn-col-bar' }, barTrack),
        el('span', { class: 'jn-col-dur tv-num' + (hot ? ' jn-hot' : ' tv-secondary') }, queue + waitMs > 0 ? U.fmtMs(queue + waitMs) : '—'));
      for (const [evt, fn] of Object.entries(tipHandlers(null, tip))) row.addEventListener(evt, fn);
      activate(row, () => api.selectSpan(c.id));
      dimItems.push({ node: row, spans: [p, c] });
      return row;
    }

    function renderRank(journey, state) {
      const rows = journey.byGroup.map((g) => ({ key: g.group, work: g.work, wait: g.wait, total: g.total }));
      if (journey.transitTotal > 0) rows.push({ key: null, work: 0, wait: 0, transit: journey.transitTotal, total: journey.transitTotal });
      rows.sort((a, b) => b.total - a.total);
      const max = rows.length ? Math.max(rows[0].total, 1e-9) : 1;

      const list = el('div', { class: 'jn-rank' });
      for (const r of rows) {
        const isQueue = r.key == null;
        const trk = el('div', { class: 'jn-rank-track' });
        if (isQueue) {
          trk.appendChild(el('span', { class: 'jn-rank-bar tv-hatch', style: { width: (r.transit / max * 100) + '%' } }));
        } else {
          if (r.work > 0) trk.appendChild(el('span', { class: 'jn-rank-bar jn-rank-work', style: { width: (r.work / max * 100) + '%' } }));
          if (r.wait > 0) trk.appendChild(el('span', { class: 'jn-rank-bar tv-dots', style: { width: (r.wait / max * 100) + '%' } }));
        }
        const tip = () => isQueue
          ? ['Queues / transport', ['total', U.fmtMs(r.total)], ['of path', U.pct(r.total, journey.total)], ['segments', String(journey.segments.filter((s) => s.type === 'transit').length)]]
          : [r.key, ['total', U.fmtMs(r.total)], ['work', U.fmtMs(r.work)], ['in-service wait', U.fmtMs(r.wait)], ['of path', U.pct(r.total, journey.total)]];
        for (const [evt, fn] of Object.entries(tipHandlers(null, tip))) trk.addEventListener(evt, fn);

        const labelCell = isQueue
          ? el('span', { class: 'jn-rank-label jn-rank-queue' }, el('span', { class: 'tv-key tv-hatch' }), 'Queues / transport')
          : el('span', { class: 'jn-rank-label' }, svcChip(r.key));
        const value = el('span', { class: 'jn-rank-value tv-num' },
          el('span', { class: 'jn-strong' }, U.fmtMs(r.total)),
          el('span', { class: 'tv-muted' }, ' ' + U.pct(r.total, journey.total)),
          !isQueue && r.wait > 0 ? el('span', { class: 'tv-muted jn-rank-split' }, ' · ' + U.fmtMs(r.wait) + ' wait') : null);
        const row = el('div', { class: 'jn-rank-row' + (isQueue ? ' is-queue' : '') }, labelCell, trk, value);
        if (!isQueue) {
          activate(row, (e) => api.selectGroup(r.key, { additive: additive(e) }));
          dimItems.push({ node: row, group: r.key });
          trackGroupRow(r.key, row);
        }
        list.appendChild(row);
      }
      return el('section', { class: 'jn-card tv-card' },
        el('div', { class: 'jn-card-head' },
          el('h3', { class: 'tv-section-title' }, 'Time by service on this path'),
          el('div', { class: 'jn-legend' },
            el('span', { class: 'jn-legend-item' }, el('span', { class: 'tv-key jn-key-work' }), 'Work'),
            el('span', { class: 'jn-legend-item' }, el('span', { class: 'tv-key tv-dots' }), 'In-service wait'),
            el('span', { class: 'jn-legend-item' }, el('span', { class: 'tv-key tv-hatch' }), 'Queue / transport'))),
        list);
    }

    const groupRows = new Map();
    function trackGroupRow(key, row) { groupRows.set(key, row); }

    // ---------------------------------------------------------------- state sync

    function applyDim() {
      for (const it of dimItems) {
        let ok;
        if (it.group != null) ok = store.groupMatches(it.group);
        else ok = it.spans.some((s) => store.matches(s));
        it.node.classList.toggle('is-dimmed', !ok);
      }
    }

    function applyMark(map, prev, next, cls) {
      if (prev != null && map.has(prev)) for (const n of map.get(prev)) n.classList.remove(cls);
      if (next != null && map.has(next)) for (const n of map.get(next)) n.classList.add(cls);
    }

    function applyGroups(state) {
      const sel = new Set(state.selectedGroups || []);
      for (const [key, row] of groupRows) row.classList.toggle('is-selected', sel.has(key));
      for (const [key, nodes] of groupEls) for (const n of nodes) n.classList.toggle('is-selected', sel.has(key));
    }

    function renderEmpty(title, sub) {
      root.appendChild(el('div', { class: 'tv-empty' },
        el('div', { class: 'jn-empty-title' }, title),
        sub ? el('div', null, sub) : null));
    }

    function render(state) {
      U.tooltip.hide();
      U.clear(root);
      spanEls = new Map();
      groupEls = new Map();
      groupRows.clear();
      dimItems = [];
      curSel = null;
      curHover = null;
      model = state.model;
      if (!model) { renderEmpty('No trace loaded', 'Load a Tempo trace export to see where the time went.'); return; }
      const journey = state.journey || model.journey;
      if (!journey || !journey.target || !journey.chain.length) { renderEmpty('No critical path', 'This trace has no spans to follow.'); return; }

      const flags = { slow: [], wait: [] };
      for (const ins of model.insights || []) {
        if (ins.kind === 'slow-hop') flags.slow.push(new Set(ins.spanIds));
        else if (ins.kind === 'async-wait') flags.wait.push(new Set(ins.spanIds));
      }

      root.appendChild(renderHeader(journey, state));
      root.appendChild(renderTiles(journey));
      if (journey.warnings && journey.warnings.length) {
        root.appendChild(el('div', { class: 'jn-warn tv-secondary' },
          el('span', { class: 'tv-status tv-status--warning' }, '!'),
          journey.warnings.join(' · ')));
      }
      root.appendChild(renderStackedBar(journey));
      root.appendChild(renderSteps(journey, state, flags));
      root.appendChild(renderRank(journey, state));

      applyDim();
      applyGroups(state);
      applyMark(spanEls, null, state.selectedSpanId, 'is-selected');
      applyMark(spanEls, null, state.hoverSpanId, 'is-hover');
      curSel = state.selectedSpanId;
      curHover = state.hoverSpanId;
    }

    const FULL = ['*', 'model', 'journey', 'pathTargetId', 'groupBy'];
    const DIM = ['search', 'filters', 'selectedGroups'];

    return {
      update(state, changed) {
        if (FULL.some((k) => changed.has(k))) { render(state); return; }
        if (!model) return;
        if (DIM.some((k) => changed.has(k))) applyDim();
        if (changed.has('selectedGroups')) applyGroups(state);
        if (changed.has('selectedSpanId')) { applyMark(spanEls, curSel, state.selectedSpanId, 'is-selected'); curSel = state.selectedSpanId; }
        if (changed.has('hoverSpanId')) { applyMark(spanEls, curHover, state.hoverSpanId, 'is-hover'); curHover = state.hoverSpanId; }
      },
      destroy() {
        ro.disconnect();
        U.tooltip.hide();
        root.remove();
      },
    };
  }

  TV.views.register({
    id: 'journey',
    title: 'Journey',
    order: 3,
    slot: 'main',
    shortcut: '3',
    mount,
  });
})(globalThis.TV = globalThis.TV || {});
