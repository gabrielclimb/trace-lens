(function (TV) {
  'use strict';

  const CAT_SHORT = { messaging: 'Kafka', db: 'Database', rpc: 'gRPC', http: 'HTTP', internal: 'Internal' };
  const SEV_ICON = { critical: '!', warning: '!', info: 'i' };
  const CHILD_CAP = 100;
  const EVENT_CAP = 300;

  function fmtVal(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  // insert soft breaks after separators so dotted keys wrap at word boundaries
  function breakable(text) {
    const parts = String(text).split(/(?<=[._\-/])/);
    const out = [];
    parts.forEach((p, i) => {
      if (i) out.push(document.createElement('wbr'));
      out.push(p);
    });
    return out;
  }

  function has(v) {
    return v != null && v !== '';
  }

  function mount(container, api) {
    const u = api.util;
    const el = u.el;
    const store = api.store;

    const root = el('div', { class: 'dt', attrs: { role: 'region', 'aria-label': 'Details' } });
    container.appendChild(root);

    const ui = { open: {}, attrFilter: '', expandedEvents: new Set() };
    let modeKey = null;
    let insightIndex = null;
    let insightIndexFor = null;
    let hoverId = null;

    // ------------------------------------------------------------ small helpers

    function btn(label, onClick, opts) {
      opts = opts || {};
      return el('button', {
        class: ['tv-btn', 'tv-btn--sm', opts.ghost ? 'tv-btn--ghost' : null, opts.cls],
        attrs: { type: 'button', title: opts.title || null },
        on: { click: onClick },
      }, label);
    }

    function flash(node, text) {
      node.classList.add('is-copied');
      const prev = node.getAttribute('data-flash');
      node.setAttribute('data-flash', text || 'Copied');
      clearTimeout(node._flashT);
      node._flashT = setTimeout(() => {
        node.classList.remove('is-copied');
        if (prev == null) node.removeAttribute('data-flash');
      }, 900);
    }

    function copyBtn(text, label) {
      const b = el('button', {
        class: 'tv-btn tv-btn--sm tv-btn--ghost dt-copy',
        attrs: { type: 'button', title: 'Copy ' + (label || 'value'), 'aria-label': 'Copy ' + (label || 'value') },
      }, 'Copy');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        u.copyText(text).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 900); }, () => {});
      });
      return b;
    }

    function svcChip(key) {
      return el('button', {
        class: 'tv-svc dt-svc',
        attrs: { type: 'button', title: key + ' — click to focus (Shift/Cmd to add)' },
        on: { click: (e) => api.selectGroup(key, { additive: e.shiftKey || e.metaKey || e.ctrlKey }) },
      }, el('span', { class: 'tv-ellipsis' }, key));
    }

    function hoverable(node, span) {
      node.addEventListener('mouseenter', () => setHover(span.id));
      node.addEventListener('mouseleave', () => setHover(null));
      return node;
    }

    function setHover(id) {
      if (hoverId === id) return;
      hoverId = id;
      if (store.get().hoverSpanId !== id) store.set({ hoverSpanId: id });
    }

    function spanLink(span, opts) {
      opts = opts || {};
      const row = el('button', {
        class: 'dt-row dt-row--btn',
        attrs: { type: 'button', title: span.group + ' · ' + span.name },
        on: { click: () => api.selectSpan(span.id) },
      },
      span.isError ? u.statusIcon('error') : null,
      el('span', { class: ['tv-dot', u.catClass(span.category)] }),
      el('span', { class: 'dt-row-main' },
        opts.showGroup !== false ? el('span', { class: 'dt-row-group tv-ellipsis' }, span.group) : null,
        el('span', { class: 'dt-row-name tv-ellipsis' }, span.name)),
      el('span', { class: 'dt-row-val tv-num' }, opts.value != null ? opts.value : u.fmtMs(span.duration)));
      return hoverable(row, span);
    }

    function section(id, title, count, build, defaultOpen) {
      const open = ui.open[id] != null ? ui.open[id] : defaultOpen !== false;
      const det = el('details', { class: 'dt-sec' });
      if (open) det.open = true;
      det.appendChild(el('summary', { class: 'dt-sec-sum' },
        el('span', { class: 'tv-section-title' }, title),
        count != null ? el('span', { class: 'dt-count tv-num' }, u.fmtCount(count)) : null));
      const body = el('div', { class: 'dt-sec-body' });
      det.appendChild(body);
      let built = false;
      const ensure = () => {
        if (!built && det.open) { built = true; build(body); }
      };
      det.addEventListener('toggle', () => { ui.open[id] = det.open; ensure(); });
      ensure();
      return det;
    }

    function block(title, ...children) {
      return el('div', { class: 'dt-block' }, title ? el('h3', { class: 'tv-section-title dt-block-title' }, title) : null, ...children);
    }

    function kv(rows) {
      const dl = el('dl', { class: 'tv-kv dt-kv' });
      for (const r of rows) {
        if (!r) continue;
        dl.appendChild(el('dt', null, r[0]));
        dl.appendChild(el('dd', null, r[1]));
      }
      return dl;
    }

    function idValue(id, label) {
      return el('span', { class: 'dt-id' }, el('span', { class: 'tv-mono dt-id-text' }, id), copyBtn(id, label));
    }

    function statTiles(items) {
      return el('div', { class: 'dt-stats' }, items.filter(Boolean).map((it) =>
        el('div', { class: ['dt-stat', it.cls] },
          el('div', { class: 'dt-stat-val tv-num' }, it.value),
          el('div', { class: 'dt-stat-label' }, it.label))));
    }

    function getInsightIndex(model) {
      if (insightIndexFor === model) return insightIndex;
      insightIndexFor = model;
      insightIndex = new Map();
      for (const ins of model.insights || []) {
        for (const id of ins.spanIds || []) {
          let l = insightIndex.get(id);
          if (!l) insightIndex.set(id, (l = []));
          l.push(ins);
        }
      }
      return insightIndex;
    }

    function sevIcon(sev) {
      return el('span', { class: ['tv-status', 'tv-status--' + sev], attrs: { 'aria-hidden': 'true' } }, SEV_ICON[sev] || 'i');
    }

    // ------------------------------------------------------------ attribute table

    function attrTable(obj, withFilter, filterKey) {
      const wrap = el('div', { class: 'dt-attrs-wrap' });
      const keys = Object.keys(obj || {}).sort();
      if (!keys.length) {
        wrap.appendChild(el('div', { class: 'dt-none' }, 'None'));
        return wrap;
      }
      const list = el('div', { class: 'dt-attrs', attrs: { role: 'list' } });
      const rows = keys.map((k) => {
        const val = fmtVal(obj[k]);
        const row = el('div', {
          class: 'dt-attr',
          attrs: { role: 'listitem', tabindex: '0', title: 'Click to copy value' },
        },
        el('span', { class: 'dt-attr-k' }, breakable(k)),
        el('span', { class: 'dt-attr-v' }, val === '' ? '""' : val));
        const doCopy = () => u.copyText(val).then(() => flash(row), () => {});
        row.addEventListener('click', doCopy);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCopy(); } });
        row._text = (k + '\u0000' + val).toLowerCase();
        list.appendChild(row);
        return row;
      });
      if (withFilter) {
        const hidden = el('div', { class: 'dt-none' });
        const input = el('input', {
          class: 'tv-input dt-filter',
          attrs: { type: 'search', placeholder: 'Filter ' + keys.length + ' attributes', 'aria-label': 'Filter attributes', spellcheck: 'false' },
        });
        const apply = () => {
          const q = input.value.trim().toLowerCase();
          ui[filterKey] = input.value;
          let n = 0;
          for (const r of rows) {
            const hit = !q || r._text.includes(q);
            r.classList.toggle('is-hidden', !hit);
            if (!hit) n++;
          }
          hidden.textContent = n ? n + ' hidden by filter' : '';
          hidden.classList.toggle('is-hidden', !n);
        };
        input.value = ui[filterKey] || '';
        input.addEventListener('input', apply);
        wrap.appendChild(input);
        wrap.appendChild(list);
        wrap.appendChild(hidden);
        apply();
      } else {
        wrap.appendChild(list);
      }
      return wrap;
    }

    // ------------------------------------------------------------ span mode

    function opCard(span) {
      const op = span.op || {};
      const rows = [];
      let stmt = null;
      const add = (k, v, mono) => {
        if (!has(v)) return;
        rows.push([k, el('span', { class: mono ? 'tv-mono' : null }, fmtVal(v))]);
      };
      let title = CAT_SHORT[span.category] || 'Operation';
      if (span.category === 'db') {
        title = 'Database';
        add('System', op.system);
        add('Database', op.name);
        add('Table', op.table);
        add('Operation', op.operation);
        add('Host', op.host, true);
        if (has(op.statement)) {
          stmt = el('div', { class: 'dt-code-wrap' },
            el('pre', { class: 'dt-code' }, String(op.statement)),
            copyBtn(String(op.statement), 'statement'));
        }
      } else if (span.category === 'messaging') {
        title = 'Messaging';
        add('Topic', op.destination, true);
        add('Operation', [op.operation, op.role].filter(Boolean).join(' · '));
        add('System', op.system);
        add('Partition', op.partition, true);
        add('Offset', op.offset, true);
        add('Key', op.key, true);
        add('Consumer group', op.consumerGroup, true);
      } else if (span.category === 'rpc') {
        title = 'gRPC';
        add('Service', op.service, true);
        add('Method', op.method, true);
        add('System', op.system);
        if (has(op.grpcStatus)) {
          const code = Number(op.grpcStatus);
          rows.push(['Status', el('span', { class: 'dt-inline' },
            code !== 0 && !isNaN(code) ? u.statusIcon('error') : null,
            el('span', { class: 'tv-mono' }, String(op.grpcStatus) + (code === 0 ? ' OK' : '')))]);
        }
      } else if (span.category === 'http') {
        title = 'HTTP';
        add('Method', op.method);
        add('Route', op.route, true);
        add('URL', op.url, true);
        add('Host', op.host, true);
        if (has(op.statusCode)) {
          const code = Number(op.statusCode);
          rows.push(['Status', el('span', { class: 'dt-inline' },
            code >= 500 ? u.statusIcon('error') : null,
            el('span', { class: 'tv-mono' }, String(op.statusCode)))]);
        }
      } else {
        return null;
      }
      if (!rows.length && !stmt) return null;
      return el('div', { class: 'dt-op tv-card' },
        el('div', { class: 'dt-op-head' },
          el('span', { class: ['tv-key', u.catClass(span.category)] }),
          el('span', { class: 'tv-section-title' }, title),
          op.summary ? el('span', { class: 'dt-op-sum tv-ellipsis', attrs: { title: op.summary } }, op.summary) : null),
        stmt,
        rows.length ? kv(rows) : null);
    }

    function hopCard(span) {
      const h = span.hopIn;
      if (!h) return null;
      const parts = [];
      parts.push(el('div', { class: 'dt-hop-line' },
        el('span', { class: 'dt-hop-arrow', attrs: { 'aria-hidden': 'true' } }, '←'),
        el('span', { class: 'tv-muted' }, 'Arrived from'),
        svcChip(h.from)));
      parts.push(el('div', { class: 'dt-hop-line' },
        el('span', { class: 'tv-badge' }, el('span', { class: ['tv-dot', u.catClass(u.hopCategory(h.type))] }), u.hopTypeLabel(h.type)),
        h.label ? el('span', { class: 'tv-mono dt-hop-label', attrs: { title: h.label } }, h.label) : null,
        h.inferred ? el('span', { class: 'tv-badge', attrs: { title: 'Causal link inferred from the topic (context propagation was broken)' } }, 'inferred') : null));
      parts.push(el('div', { class: 'dt-hop-line dt-hop-metrics tv-num' },
        el('span', null, el('span', { class: 'tv-muted' }, 'latency '), u.fmtMs(h.latency)),
        el('span', { class: 'tv-muted' }, '·'),
        el('span', { class: h.queue >= 25 ? 'dt-warn' : null },
          h.queue >= 25 ? el('span', { class: 'tv-status tv-status--warning dt-mini-status', attrs: { 'aria-hidden': 'true' } }, '!') : null,
          el('span', { class: 'tv-muted' }, 'queue '), u.fmtMs(h.queue)),
        el('span', { class: 'tv-muted' }, '·'),
        el('span', { class: 'tv-muted' }, h.async ? 'async' : 'sync')));
      const parentBtn = el('button', {
        class: 'dt-link',
        attrs: { type: 'button', title: 'Select the sending span' },
        on: { click: () => api.selectSpan(h.parent.id) },
      }, 'from ' + h.parent.name);
      parts.push(el('div', { class: 'dt-hop-line' }, hoverable(parentBtn, h.parent)));
      return el('div', { class: 'dt-hop tv-card' }, parts);
    }

    function eventsList(span, body) {
      const evs = span.events || [];
      const groups = [];
      for (const e of evs) {
        const last = groups[groups.length - 1];
        if (last && last.name === e.name) last.items.push(e);
        else groups.push({ name: e.name, items: [e] });
      }
      const list = el('div', { class: 'dt-events' });
      let rendered = 0;
      const evRow = (e) => {
        const attrs = e.attrs || {};
        const keys = Object.keys(attrs);
        const row = el('div', { class: 'dt-event' },
          el('span', { class: 'dt-event-t tv-num' }, u.fmtOffset(e.time - span.start)),
          el('span', { class: 'dt-event-main' },
            el('span', { class: 'dt-event-name' }, /exception/i.test(e.name || '') ? u.statusIcon('error') : null, e.name || '(unnamed)'),
            keys.length ? el('span', { class: 'dt-event-attrs' }, keys.slice(0, 8).map((k) =>
              el('span', { class: 'dt-event-attr' }, el('span', { class: 'tv-muted' }, k + '='), fmtVal(attrs[k])))) : null,
            keys.length > 8 ? el('span', { class: 'tv-muted' }, '+' + (keys.length - 8) + ' more') : null));
        return row;
      };
      groups.forEach((g, gi) => {
        if (rendered >= EVENT_CAP) return;
        if (g.items.length === 1) {
          list.appendChild(evRow(g.items[0]));
          rendered++;
          return;
        }
        const key = gi + ':' + g.name;
        const open = ui.expandedEvents.has(key);
        const head = el('button', {
          class: 'dt-event dt-event--group',
          attrs: { type: 'button', 'aria-expanded': String(open) },
        },
        el('span', { class: 'dt-event-t tv-num' }, u.fmtOffset(g.items[0].time - span.start)),
        el('span', { class: 'dt-event-main' },
          el('span', { class: 'dt-event-name' },
            el('span', { class: 'dt-caret', attrs: { 'aria-hidden': 'true' } }, open ? '▾' : '▸'),
            el('span', { class: 'tv-num' }, u.fmtCount(g.items.length) + ' × '), g.name || '(unnamed)'),
          el('span', { class: 'tv-muted tv-num' }, 'until ' + u.fmtOffset(g.items[g.items.length - 1].time - span.start))));
        const sub = el('div', { class: ['dt-event-sub', open ? null : 'is-hidden'] });
        let filled = false;
        const fill = () => {
          if (filled) return;
          filled = true;
          g.items.slice(0, EVENT_CAP).forEach((e) => sub.appendChild(evRow(e)));
          if (g.items.length > EVENT_CAP) sub.appendChild(el('div', { class: 'dt-none' }, (g.items.length - EVENT_CAP) + ' more not shown'));
        };
        if (open) fill();
        head.addEventListener('click', () => {
          const now = !ui.expandedEvents.has(key);
          if (now) ui.expandedEvents.add(key); else ui.expandedEvents.delete(key);
          head.setAttribute('aria-expanded', String(now));
          head.querySelector('.dt-caret').textContent = now ? '▾' : '▸';
          if (now) fill();
          sub.classList.toggle('is-hidden', !now);
        });
        list.appendChild(head);
        list.appendChild(sub);
        rendered++;
      });
      if (!evs.length) list.appendChild(el('div', { class: 'dt-none' }, 'No events'));
      body.appendChild(list);
    }

    function spanJson(span) {
      return {
        traceId: span.traceId,
        spanId: span.id,
        parentSpanId: span.parentId || '',
        name: span.name,
        kind: span.kind,
        service: span.service,
        group: span.group,
        category: span.category,
        startTimeUnixMs: span.startEpochMs,
        startOffsetMs: span.start,
        endOffsetMs: span.end,
        durationMs: span.duration,
        selfTimeMs: span.selfTime,
        status: { code: span.status, message: span.statusMessage || '' },
        attributes: span.attrs,
        resource: span.resource,
        scope: span.scope,
        events: span.events,
        links: (span.links || []).map((l) => ({ traceId: l.traceId, spanId: l.spanId, attributes: l.attrs })),
      };
    }

    function renderSpan(state, span) {
      const model = state.model;
      const frag = [];
      const onPath = state.journey && state.journey.chain && state.journey.chain.includes(span);

      // header
      frag.push(el('header', { class: 'dt-head' },
        el('div', { class: 'dt-eyebrow' }, el('span', { class: 'tv-section-title' }, 'Span'),
          onPath ? el('span', { class: 'tv-badge tv-badge--strong', attrs: { title: 'This span is on the current journey path' } }, 'on path') : null),
        el('h2', { class: 'dt-title' }, span.isError ? u.statusIcon('error') : null, el('span', null, span.name || '(unnamed span)')),
        el('div', { class: 'dt-tags' },
          svcChip(span.group),
          el('span', { class: 'tv-badge', attrs: { title: 'Span kind' } }, span.kind),
          el('span', { class: 'tv-badge', attrs: { title: 'Category' } }, el('span', { class: ['tv-dot', u.catClass(span.category)] }), CAT_SHORT[span.category] || span.category),
          span.isError ? el('span', { class: 'tv-badge tv-badge--critical' }, 'Error') : null,
          span.isOrphan ? el('span', { class: 'tv-badge tv-badge--warning' }, 'missing parent') : null),
        span.isError && span.statusMessage ? el('div', { class: 'dt-errmsg' }, span.statusMessage) : null,
        el('div', { class: 'dt-actions' },
          btn('Path to here', () => api.setPathTarget(span.id), { title: 'Explain where the time went up to this span' }),
          btn('Focus service', () => api.selectGroup(span.group), { title: 'Filter every view to ' + span.group }),
          (() => {
            const b = btn('Copy span JSON', () => {
              u.copyText(JSON.stringify(spanJson(span), null, 2)).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy span JSON'; }, 900); }, () => {});
            });
            return b;
          })())));

      // flagged by insights
      const flagged = getInsightIndex(model).get(span.id);
      if (flagged && flagged.length) {
        frag.push(el('div', { class: 'dt-flags' }, flagged.slice(0, 4).map((ins) =>
          el('div', { class: ['dt-flag', 'dt-flag--' + ins.severity] }, sevIcon(ins.severity),
            el('span', { class: 'dt-flag-sev' }, ins.severity),
            el('span', { class: 'dt-flag-title' }, ins.title)))));
      }

      // facts
      const pct = span.duration > 0 ? ' (' + u.pct(span.selfTime, span.duration) + ')' : '';
      let parentVal;
      if (span.parent) {
        parentVal = hoverable(el('button', { class: 'dt-link', attrs: { type: 'button' }, on: { click: () => api.selectSpan(span.parent.id) } },
          span.parent.name + (span.parent.group !== span.group ? ' · ' + span.parent.group : '')), span.parent);
      } else if (span.parentId) {
        parentVal = el('span', { class: 'dt-missing' }, el('span', { class: 'tv-muted' }, 'missing '), el('span', { class: 'tv-mono' }, span.parentId));
      } else {
        parentVal = el('span', { class: 'tv-muted' }, 'none (root)');
      }
      frag.push(block(null, kv([
        ['Start', el('span', null, el('span', { class: 'tv-num' }, u.fmtOffset(span.start)), el('br'), el('span', { class: 'tv-muted tv-num' }, u.fmtEpoch(span.startEpochMs)))],
        ['Duration', el('span', { class: 'tv-num dt-strong' }, u.fmtMs(span.duration))],
        ['Self time', el('span', { class: 'tv-num' }, u.fmtMs(span.selfTime) + pct)],
        ['Depth', el('span', { class: 'tv-num' }, String(span.depth))],
        ['Span ID', idValue(span.id, 'span id')],
        ['Trace ID', idValue(span.traceId || model.traceId, 'trace id')],
        ['Parent', parentVal],
        ['Children', el('span', { class: 'tv-num' }, u.fmtCount(span.children.length))],
        span.pod ? ['Pod', el('span', { class: 'tv-mono' }, span.pod)] : null,
        span.deployScope && span.deployScope !== 'unknown' ? ['Scope', span.deployScope] : null,
      ])));

      const hop = hopCard(span);
      if (hop) frag.push(hop);
      const op = opCard(span);
      if (op) frag.push(op);

      frag.push(section('attrs', 'Attributes', Object.keys(span.attrs || {}).length, (b) => b.appendChild(attrTable(span.attrs, true, 'attrFilter')), true));
      frag.push(section('resource', 'Resource', Object.keys(span.resource || {}).length, (b) => b.appendChild(attrTable(span.resource, false)), false));
      if ((span.events || []).length) frag.push(section('events', 'Events', span.events.length, (b) => eventsList(span, b), true));
      if ((span.links || []).length) {
        frag.push(section('links', 'Links', span.links.length, (b) => {
          for (const l of span.links) {
            if (l.target) b.appendChild(spanLink(l.target));
            else {
              b.appendChild(el('div', { class: 'dt-row dt-row--static', attrs: { title: 'Linked span is not in this trace' } },
                el('span', { class: 'dt-row-main' },
                  el('span', { class: 'dt-row-group tv-mono tv-ellipsis' }, 'trace ' + (l.traceId || '?')),
                  el('span', { class: 'dt-row-name tv-mono tv-ellipsis' }, 'span ' + (l.spanId || '?'))),
                el('span', { class: 'dt-row-val tv-muted' }, 'not in trace')));
            }
          }
        }, true));
      }
      if (span.children.length) {
        frag.push(section('children', 'Children', span.children.length, (b) => {
          const renderKids = (n) => {
            u.clear(b);
            span.children.slice(0, n).forEach((c) => b.appendChild(spanLink(c, { showGroup: true })));
            if (span.children.length > n) {
              b.appendChild(btn('Show all ' + u.fmtCount(span.children.length), () => renderKids(Infinity), { ghost: true, cls: 'dt-more' }));
            }
          };
          renderKids(CHILD_CAP);
        }, true));
      }
      return frag;
    }

    // ------------------------------------------------------------ group mode

    function catBar(counts, total, unitFmt) {
      const bar = el('div', { class: 'dt-catbar', attrs: { role: 'img', 'aria-label': 'Self time by category' } });
      const legend = el('div', { class: 'dt-catlegend' });
      for (const c of u.CATEGORIES) {
        const v = counts[c.id] || 0;
        if (v <= 0) continue;
        const seg = el('span', { class: ['dt-catseg', u.catClass(c.id)], style: { flexGrow: String(v) } });
        seg.addEventListener('mouseenter', (e) => u.tooltip.show(e.clientX, e.clientY, [c.label, [c.label, unitFmt(v)], ['of self time', u.pct(v, total)]]));
        seg.addEventListener('mousemove', (e) => u.tooltip.move(e.clientX, e.clientY));
        seg.addEventListener('mouseleave', () => u.tooltip.hide());
        bar.appendChild(seg);
        legend.appendChild(el('div', { class: 'dt-catrow' },
          el('span', { class: ['tv-key', u.catClass(c.id)] }),
          el('span', { class: 'dt-catrow-label' }, c.label),
          el('span', { class: 'dt-catrow-val tv-num' }, unitFmt(v)),
          el('span', { class: 'dt-catrow-pct tv-num tv-muted' }, u.pct(v, total))));
      }
      if (!bar.childNodes.length) return el('div', { class: 'dt-none' }, 'No self time recorded');
      return el('div', null, bar, legend);
    }

    function edgeRow(e, dir) {
      const other = dir === 'in' ? e.from : e.to;
      const first = e.hops && e.hops[0];
      const row = el('div', { class: 'dt-edge' },
        el('div', { class: 'dt-edge-top' },
          el('span', { class: 'dt-hop-arrow', attrs: { 'aria-hidden': 'true' } }, dir === 'in' ? '←' : '→'),
          svcChip(other),
          el('span', { class: 'dt-edge-count tv-num' }, '×' + u.fmtCount(e.count))),
        el('button', {
          class: 'dt-edge-sub',
          attrs: { type: 'button', title: 'Select the first ' + (dir === 'in' ? 'arriving' : 'outgoing') + ' span of this edge' },
          on: { click: () => first && api.selectSpan(first.child.id) },
        },
        el('span', { class: ['tv-dot', u.catClass(u.hopCategory(e.type))] }),
        el('span', { class: 'dt-edge-type' }, u.hopTypeLabel(e.type) + (e.async ? ' · async' : '')),
        e.label ? el('span', { class: 'dt-edge-label tv-mono tv-ellipsis' }, e.label) : null,
        el('span', { class: 'dt-edge-lat tv-num' }, u.fmtMs(e.latencyAvg))));
      row.addEventListener('mouseenter', (ev) => u.tooltip.show(ev.clientX, ev.clientY, [
        e.from + ' → ' + e.to,
        [u.hopTypeLabel(e.type), 'type'],
        e.label ? [e.label, 'via'] : null,
        [u.fmtCount(e.count), 'hops'],
        [u.fmtMs(e.latencyMin) + ' / ' + u.fmtMs(e.latencyAvg) + ' / ' + u.fmtMs(e.latencyMax), 'latency min / avg / max'],
        e.queueMax > 0 ? [u.fmtMs(e.queueMax), 'max queue'] : null,
      ]));
      row.addEventListener('mousemove', (ev) => u.tooltip.move(ev.clientX, ev.clientY));
      row.addEventListener('mouseleave', () => u.tooltip.hide());
      return row;
    }

    function renderGroup(state, g) {
      const model = state.model;
      const frag = [];
      const meta = [];
      if (model.groupBy !== 'namespace' && g.namespaces && g.namespaces.length) meta.push(...g.namespaces.map((n) => el('span', { class: 'tv-badge', attrs: { title: 'Namespace' } }, 'ns ' + n)));
      if (g.scopes && g.scopes.length) meta.push(...g.scopes.filter((s) => s !== 'unknown').map((s) => el('span', { class: 'tv-badge', attrs: { title: 'Deploy scope' } }, s)));
      if (model.groupBy !== 'service' && g.services && g.services.length) meta.push(el('span', { class: 'tv-badge', attrs: { title: g.services.join(', ') } }, u.fmtCount(g.services.length) + ' services'));

      frag.push(el('header', { class: 'dt-head' },
        el('div', { class: 'dt-eyebrow' }, el('span', { class: 'tv-section-title' }, model.groupBy === 'service' ? 'Service' : model.groupBy === 'namespace' ? 'Namespace' : 'Deploy scope')),
        el('h2', { class: 'dt-title' }, g.errorCount ? u.statusIcon('error') : null, el('span', null, g.key)),
        meta.length ? el('div', { class: 'dt-tags' }, meta) : null,
        el('div', { class: 'dt-actions' },
          btn('Clear focus', () => api.selectGroup(null)),
          btn('Copy name', (e) => { u.copyText(g.key).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy name'; }, 900); }, () => {}); }))));

      frag.push(statTiles([
        { label: 'spans', value: u.fmtCount(g.spanCount) },
        { label: 'errors', value: u.fmtCount(g.errorCount), cls: g.errorCount ? 'dt-stat--critical' : null },
        { label: 'active', value: u.fmtMs(g.activeTime) },
        { label: 'self time', value: u.fmtMs(g.selfTime) },
        { label: 'first', value: u.fmtOffset(g.first) },
        { label: 'last', value: u.fmtOffset(g.last) },
        { label: 'on journey', value: g.journeyTime ? u.fmtMs(g.journeyTime) : '–' },
        g.dbCalls ? { label: 'DB calls · time', value: u.fmtCount(g.dbCalls) + ' · ' + u.fmtMs(g.dbTime) } : null,
      ]));

      frag.push(block('Self time by category', catBar(g.categoryTime || {}, g.selfTime, u.fmtMs)));

      const inE = (g.inEdges || []).slice().sort((a, b) => b.count - a.count);
      const outE = (g.outEdges || []).slice().sort((a, b) => b.count - a.count);
      frag.push(section('g-in', 'Inbound', inE.length, (b) => {
        if (!inE.length) b.appendChild(el('div', { class: 'dt-none' }, 'No inbound hops (entry point)'));
        inE.forEach((e) => b.appendChild(edgeRow(e, 'in')));
      }, true));
      frag.push(section('g-out', 'Outbound', outE.length, (b) => {
        if (!outE.length) b.appendChild(el('div', { class: 'dt-none' }, 'No outbound hops'));
        outE.forEach((e) => b.appendChild(edgeRow(e, 'out')));
      }, true));

      const tp = g.topicsProduced || [], tc = g.topicsConsumed || [];
      if (tp.length || tc.length) {
        frag.push(section('g-topics', 'Topics', tp.length + tc.length, (b) => {
          const topicRow = (name, role) => {
            const span = g.spans.find((s) => s.category === 'messaging' && s.op && s.op.destination === name && s.op.role === role);
            const row = el('button', {
              class: 'dt-row dt-row--btn',
              attrs: { type: 'button', title: (role === 'producer' ? 'Produces to ' : 'Consumes from ') + name },
              on: { click: () => span && api.selectSpan(span.id) },
            },
            el('span', { class: 'dt-hop-arrow', attrs: { 'aria-hidden': 'true' } }, role === 'producer' ? '→' : '←'),
            el('span', { class: 'dt-row-main' }, el('span', { class: 'dt-row-name tv-mono tv-ellipsis' }, name)),
            el('span', { class: 'dt-row-val tv-muted' }, role === 'producer' ? 'produces' : 'consumes'));
            return span ? hoverable(row, span) : row;
          };
          tp.forEach((t) => b.appendChild(topicRow(t, 'producer')));
          tc.forEach((t) => b.appendChild(topicRow(t, 'consumer')));
        }, true));
      }

      const dbs = (model.databases || []).filter((d) => d.groups.includes(g.key));
      if (dbs.length) {
        frag.push(section('g-dbs', 'Databases', dbs.length, (b) => {
          for (const d of dbs) {
            const mine = d.spans.filter((s) => s.group === g.key);
            const t = mine.reduce((a, s) => a + s.duration, 0);
            const row = el('button', {
              class: 'dt-row dt-row--btn',
              attrs: { type: 'button', title: d.key },
              on: { click: () => mine[0] && api.selectSpan(mine[0].id) },
            },
            el('span', { class: 'tv-dot cat-db' }),
            el('span', { class: 'dt-row-main' },
              el('span', { class: 'dt-row-group tv-ellipsis' }, d.system || 'db'),
              el('span', { class: 'dt-row-name tv-ellipsis' }, d.name || d.host || d.key)),
            el('span', { class: 'dt-row-val tv-num' }, '×' + u.fmtCount(mine.length) + ' · ' + u.fmtMs(t)));
            b.appendChild(row);
          }
        }, true));
      }

      // top operations
      const ops = new Map();
      for (const s of g.spans) {
        const label = (s.op && s.op.summary) || s.name;
        let o = ops.get(label);
        if (!o) ops.set(label, (o = { label, count: 0, total: 0, span: s, errors: 0 }));
        o.count++;
        o.total += s.duration;
        if (s.isError) o.errors++;
      }
      const top = Array.from(ops.values()).sort((a, b) => b.total - a.total).slice(0, 8);
      const maxT = top.length ? top[0].total || 1 : 1;
      frag.push(section('g-ops', 'Top operations', ops.size, (b) => {
        for (const o of top) {
          const row = el('button', {
            class: 'dt-row dt-row--btn dt-oprow',
            attrs: { type: 'button', title: o.label + ' — select the first span' },
            on: { click: () => api.selectSpan(o.span.id) },
          },
          o.errors ? u.statusIcon('error') : el('span', { class: ['tv-dot', u.catClass(o.span.category)] }),
          el('span', { class: 'dt-row-main' },
            el('span', { class: 'dt-row-name tv-ellipsis' }, o.label),
            el('span', { class: 'dt-opbar' }, el('span', { class: ['dt-opbar-fill', u.catClass(o.span.category)], style: { width: Math.max(1, (o.total / maxT) * 100) + '%' } }))),
          el('span', { class: 'dt-row-val tv-num' }, (o.count > 1 ? '×' + u.fmtCount(o.count) + ' · ' : '') + u.fmtMs(o.total)));
          b.appendChild(hoverable(row, o.span));
        }
      }, true));
      return frag;
    }

    // ------------------------------------------------------------ trace mode

    function journeyBar(j) {
      const bar = el('div', { class: 'dt-jbar', attrs: { role: 'img', 'aria-label': 'Journey segments in time order' } });
      for (const seg of j.segments || []) {
        if (!(seg.duration > 0)) continue;
        const cls = seg.type === 'transit' ? 'tv-hatch' : seg.type === 'wait' ? 'tv-dots' : u.catClass(seg.span && seg.span.category);
        const node = el('span', { class: ['dt-jseg', cls], style: { flexGrow: String(seg.duration) } });
        node.addEventListener('mouseenter', (e) => u.tooltip.show(e.clientX, e.clientY, [
          seg.type === 'work' ? seg.group : seg.type === 'transit' ? 'Queue / transport' : 'In-service wait · ' + seg.group,
          [u.fmtMs(seg.duration), seg.type],
          seg.label ? [seg.label, seg.type === 'work' ? 'operation' : 'via'] : null,
          [u.fmtOffset(seg.start), 'starts at'],
        ]));
        node.addEventListener('mousemove', (e) => u.tooltip.move(e.clientX, e.clientY));
        node.addEventListener('mouseleave', () => u.tooltip.hide());
        node.addEventListener('click', () => { if (seg.toSpan || seg.span) api.selectSpan((seg.toSpan || seg.span).id); });
        bar.appendChild(node);
      }
      return bar;
    }

    function renderTrace(state) {
      const model = state.model;
      const st = model.stats || {};
      const frag = [];
      frag.push(el('header', { class: 'dt-head' },
        el('div', { class: 'dt-eyebrow' }, el('span', { class: 'tv-section-title' }, 'Trace')),
        el('h2', { class: 'dt-title dt-title--mono' }, el('span', { class: 'tv-mono' }, model.traceId || '(no trace id)')),
        el('div', { class: 'dt-tags' },
          el('span', { class: 'tv-muted tv-num' }, u.fmtEpoch(model.t0Epoch)),
          model.traceId ? copyBtn(model.traceId, 'trace id') : null)));

      if (state.selectedGroups && state.selectedGroups.length > 1) {
        frag.push(block('Focused (' + state.selectedGroups.length + ')',
          el('div', { class: 'dt-chiplist' }, state.selectedGroups.map((k) => svcChip(k))),
          el('div', { class: 'dt-actions' }, btn('Clear focus', () => api.selectGroup(null)))));
      }

      frag.push(statTiles([
        { label: 'duration', value: u.fmtMs(model.duration) },
        { label: 'spans', value: u.fmtCount(st.spanCount) },
        { label: model.groupBy === 'service' ? 'services' : 'groups', value: u.fmtCount(st.groupCount) },
        { label: 'errors', value: u.fmtCount(st.errorCount), cls: st.errorCount ? 'dt-stat--critical' : null },
        { label: 'orphans', value: u.fmtCount(st.orphanCount), cls: st.orphanCount ? 'dt-stat--warning' : null },
        { label: 'max depth', value: u.fmtCount(st.maxDepth) },
      ]));

      const j = state.journey;
      if (j && j.target) {
        const first = j.chain && j.chain[0];
        frag.push(block('Journey',
          el('p', { class: 'dt-lead' },
            el('strong', { class: 'tv-num' }, u.fmtMs(j.total)),
            ' from ', first ? el('strong', null, first.group) : '…',
            ' to ', el('strong', null, j.target.group),
            el('span', { class: 'tv-muted' }, ' · ' + (j.chain ? j.chain.length : 0) + ' steps')),
          journeyBar(j),
          el('div', { class: 'dt-jlegend tv-num' },
            el('span', null, el('span', { class: 'tv-key cat-internal' }), 'work ', el('strong', null, u.fmtMs(j.workTotal))),
            el('span', null, el('span', { class: 'tv-key tv-hatch' }), 'queue ', el('strong', null, u.fmtMs(j.transitTotal))),
            el('span', null, el('span', { class: 'tv-key tv-dots' }), 'wait ', el('strong', null, u.fmtMs(j.waitTotal)))),
          (j.byGroup || []).length ? el('div', { class: 'dt-jtop' }, (j.byGroup || []).slice(0, 3).map((r) =>
            el('div', { class: 'dt-jtop-row' }, svcChip(r.group),
              el('span', { class: 'tv-num dt-row-val' }, u.fmtMs(r.total) + ' · ' + u.pct(r.total, j.total))))) : null,
          el('div', { class: 'dt-actions' },
            btn('Open journey', () => api.showView('journey')),
            btn('Select target', () => api.selectSpan(j.target.id)))));
      }

      const ins = model.insights || [];
      if (ins.length) {
        frag.push(block('Top insights',
          el('div', { class: 'dt-flags' }, ins.slice(0, 4).map((x) => {
            const row = el('button', {
              class: ['dt-flag', 'dt-flag--' + x.severity, 'dt-flag--btn'],
              attrs: { type: 'button', title: x.detail || x.title },
              on: { click: () => { if (x.spanIds && x.spanIds[0]) api.selectSpan(x.spanIds[0]); else api.showView('insights'); } },
            }, sevIcon(x.severity), el('span', { class: 'dt-flag-sev' }, x.severity), el('span', { class: 'dt-flag-title' }, x.title));
            return row;
          })),
          el('div', { class: 'dt-actions' }, btn('All ' + ins.length + ' insights', () => api.showView('insights')))));
      }

      frag.push(section('t-roots', 'Roots', model.roots.length, (b) => {
        model.roots.slice(0, 50).forEach((s) => b.appendChild(spanLink(s)));
        if (!model.roots.length) b.appendChild(el('div', { class: 'dt-none' }, 'No true root span (every span has a parent id)'));
      }, true));
      if (model.orphans.length) {
        frag.push(section('t-orphans', 'Orphans', model.orphans.length, (b) => {
          model.orphans.slice(0, 50).forEach((s) => b.appendChild(spanLink(s, { value: 'parent ' + s.parentId.slice(0, 8) })));
        }, true));
      }
      if (model.warnings && model.warnings.length) {
        frag.push(section('t-warn', 'Parser warnings', model.warnings.length, (b) => {
          model.warnings.forEach((w) => b.appendChild(el('div', { class: 'dt-warnline' }, w)));
        }, false));
      }
      frag.push(el('p', { class: 'dt-hint' }, 'Click any span or service to see its details here.'));
      return frag;
    }

    // ------------------------------------------------------------ render

    function render(state) {
      u.tooltip.hide();
      const model = state.model;
      let key, nodes;
      if (!model) {
        key = 'none';
        nodes = [el('div', { class: 'tv-empty' }, el('strong', null, 'No trace loaded'), el('span', null, 'Load a Tempo JSON export to see details here.'))];
      } else {
        const span = state.selectedSpanId ? model.byId.get(state.selectedSpanId) : null;
        const g = !span && state.selectedGroups && state.selectedGroups.length === 1 ? model.groupByKey.get(state.selectedGroups[0]) : null;
        if (span) { key = 's:' + span.id; nodes = renderSpan(state, span); }
        else if (g) { key = 'g:' + g.key; nodes = renderGroup(state, g); }
        else { key = 't:' + model.traceId; nodes = renderTrace(state); }
      }
      if (key !== modeKey) ui.expandedEvents.clear();
      const keepScroll = key === modeKey ? root.scrollTop : 0;
      u.clear(root);
      root.appendChild(el('div', { class: 'dt-inner' }, nodes));
      root.scrollTop = keepScroll;
      modeKey = key;
    }

    const RELEVANT = ['model', 'selectedSpanId', 'selectedGroups', 'journey', 'groupBy'];
    return {
      update(state, changed) {
        if (!changed || changed.has('*') || RELEVANT.some((k) => changed.has(k))) render(state);
      },
      destroy() {
        u.tooltip.hide();
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };
  }

  TV.views.register({ id: 'detail', title: 'Details', order: 100, slot: 'side', mount });
})(globalThis.TV = globalThis.TV || {});
