(function (TV) {
  'use strict';

  const U = TV.util;
  const PREFS_KEY = 'tv.map.prefs';
  const FONT_UI = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const F_LABEL = '600 12.5px ' + FONT_UI;
  const F_SUB = '11px ' + FONT_UI;
  const F_PILL = '11px ' + FONT_MONO;
  const PAD_X = 10, PAD_TOP = 7, LINE_H = 15, SUB_H = 13, BAR_GAP = 6, BAR_H = 3, PAD_BOTTOM = 8;
  const MIN_W = 104, MAX_LINE_W = 134, SINGLE_MAX = 134;
  const GAP_Y = 14, DUMMY_H = 2, ARROW = 7;
  const CATS = ['messaging', 'db', 'rpc', 'http', 'internal'];
  const CAT_LABEL = { messaging: 'Kafka / messaging', db: 'Database', rpc: 'gRPC', http: 'HTTP', internal: 'Internal' };
  const KIND_RANK = { group: 0, topic: 1, db: 2 };

  const DEFAULT_PREFS = { journey: true, labels: false, topics: false, dbs: false };

  function loadPrefs() {
    const p = Object.assign({}, DEFAULT_PREFS);
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (raw && typeof raw === 'object') for (const k of Object.keys(DEFAULT_PREFS)) if (typeof raw[k] === 'boolean') p[k] = raw[k];
    } catch (e) { /* storage unavailable */ }
    return p;
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- text measurement

  let mctx = null;
  const wcache = new Map();
  function textW(text, font) {
    const k = font + '|' + text;
    let w = wcache.get(k);
    if (w != null) return w;
    if (!mctx) { try { mctx = document.createElement('canvas').getContext('2d'); } catch (e) { mctx = null; } }
    if (mctx) { mctx.font = font; w = mctx.measureText(text).width; } else w = text.length * 7;
    if (wcache.size > 8000) wcache.clear();
    wcache.set(k, w);
    return w;
  }
  function fitText(text, font, maxW) {
    if (textW(text, font) <= maxW) return text;
    let lo = 4, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (textW(U.truncateMiddle(text, mid), font) <= maxW) lo = mid; else hi = mid - 1;
    }
    return U.truncateMiddle(text, lo);
  }
  function wrapLabel(text) {
    if (textW(text, F_LABEL) <= SINGLE_MAX) return [text];
    const tokens = text.split(/(?<=[-_./:])/);
    if (tokens.length < 2) return [fitText(text, F_LABEL, MAX_LINE_W)];
    const join = (i, j) => tokens.slice(i, j).join('');
    let best = null;
    for (let i = 1; i < tokens.length; i++) {
      const a = join(0, i), b = join(i);
      const cost = Math.max(textW(a, F_LABEL), textW(b, F_LABEL));
      if (!best || cost < best.cost) best = { lines: [a, b], cost };
    }
    if (best.cost > MAX_LINE_W && tokens.length > 2) {
      for (let i = 1; i < tokens.length - 1; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          const lines = [join(0, i), join(i, j), join(j)];
          const cost = Math.max(...lines.map((l) => textW(l, F_LABEL))) + 1;
          if (cost < best.cost) best = { lines, cost };
        }
      }
    }
    return best.lines.map((l) => fitText(l, F_LABEL, MAX_LINE_W));
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ---------------------------------------------------------------- graph

  function buildGraph(model, prefs) {
    const nodes = [], nodeById = new Map(), links = [], linkById = new Map();
    const addNode = (n) => { n.index = nodes.length; n.links = []; nodes.push(n); nodeById.set(n.id, n); return n; };
    const getLink = (from, to, kind) => {
      const id = from + '>' + to;
      let l = linkById.get(id);
      if (!l) {
        l = { id, from, to, kind, edges: [], hops: [], spans: [], spanSet: null, count: 0, latSum: 0, latN: 0,
          latMin: Infinity, latMax: -Infinity, queueMax: 0, timeSum: 0, typeCount: {}, async: false };
        l.index = links.length;
        links.push(l);
        linkById.set(id, l);
      }
      return l;
    };
    const addHopStats = (l, h) => {
      l.latSum += h.latency; l.latN++;
      if (h.latency < l.latMin) l.latMin = h.latency;
      if (h.latency > l.latMax) l.latMax = h.latency;
      if (h.queue > l.queueMax) l.queueMax = h.queue;
    };

    for (const g of model.groups) addNode({ id: 'g:' + g.key, kind: 'group', key: g.key, group: g, first: g.first });

    const topicIds = new Set();
    if (prefs.topics) {
      for (const t of model.topics) {
        if (!t.producers.length && !t.consumers.length && !t.deliveries.length) continue;
        let first = Infinity;
        for (const s of t.producers) if (s.start < first) first = s.start;
        for (const s of t.consumers) if (s.start < first) first = s.start;
        for (const h of t.deliveries) if (h.parent.start < first) first = h.parent.start;
        const n = addNode({ id: 't:' + t.name, kind: 'topic', key: t.name, topic: t, first });
        topicIds.add(n.id);
        const touch = (l, s) => { (l.spanSet || (l.spanSet = new Set())).add(s); l.async = true; l.typeCount.kafka = 1; };
        for (const s of t.producers) { const l = getLink('g:' + s.group, n.id, 'produce'); touch(l, s); }
        for (const s of t.consumers) { const l = getLink(n.id, 'g:' + s.group, 'consume'); touch(l, s); }
        for (const h of t.deliveries) {
          const lp = getLink('g:' + h.from, n.id, 'produce'); touch(lp, h.parent); lp.hops.push(h);
          const lc = getLink(n.id, 'g:' + h.to, 'consume'); touch(lc, h.child); lc.hops.push(h); addHopStats(lc, h);
        }
      }
      for (const l of links) {
        if (!l.spanSet) continue;
        l.spans = Array.from(l.spanSet).sort((a, b) => a.start - b.start);
        l.count = l.spans.length;
        l.spanSet = null;
      }
    }

    for (const e of model.edges) {
      if (e.type === 'kafka' && topicIds.has('t:' + e.label)) continue;
      const l = getLink('g:' + e.from, 'g:' + e.to, 'call');
      l.edges.push(e);
      for (const h of e.hops) { l.hops.push(h); addHopStats(l, h); }
      l.count += e.count;
      l.typeCount[e.type] = (l.typeCount[e.type] || 0) + e.count;
      if (e.async) l.async = true;
    }

    if (prefs.dbs) {
      for (const d of model.databases) {
        let first = Infinity;
        for (const s of d.spans) if (s.start < first) first = s.start;
        const n = addNode({ id: 'd:' + d.key, kind: 'db', key: d.key, db: d, first });
        for (const s of d.spans) {
          const l = getLink('g:' + s.group, n.id, 'db');
          l.spans.push(s); l.count++; l.timeSum += s.duration; l.typeCount.db = 1;
        }
      }
    }

    for (const l of links) {
      l.a = nodeById.get(l.from);
      l.b = nodeById.get(l.to);
      let best = null, bestN = -1;
      for (const t of Object.keys(l.typeCount)) if (l.typeCount[t] > bestN) { best = t; bestN = l.typeCount[t]; }
      l.type = best || 'call';
      l.cat = l.kind === 'db' ? 'db' : (l.kind === 'produce' || l.kind === 'consume') ? 'messaging' : U.hopCategory(l.type);
      if (l.type === 'kafka') l.async = true;
      l.sw = clamp(1.1 * Math.log2(l.count + 1), 1, 6);
      l.hops.sort((x, y) => x.child.start - y.child.start);
      l.a.links.push(l);
      l.b.links.push(l);
    }
    return { nodes, nodeById, links, linkById, topicIds };
  }

  function measureNodes(graph) {
    for (const n of graph.nodes) {
      if (n.kind === 'group') {
        const g = n.group;
        n.lines = wrapLabel(g.key);
        n.sub = `${U.fmtCount(g.spanCount)} span${g.spanCount === 1 ? '' : 's'} · ${U.fmtMs(g.activeTime)}`;
        let lw = 0;
        for (const ln of n.lines) lw = Math.max(lw, textW(ln, F_LABEL));
        n.w = clamp(Math.ceil(Math.max(lw, textW(n.sub, F_SUB) + 4) + 2 * PAD_X), MIN_W, MAX_LINE_W + 2 * PAD_X);
        n.h = PAD_TOP + n.lines.length * LINE_H + SUB_H + BAR_GAP + BAR_H + PAD_BOTTOM;
      } else if (n.kind === 'topic') {
        n.text = fitText(n.key, F_PILL, 150);
        n.w = Math.ceil(textW(n.text, F_PILL)) + 30;
        n.h = 24;
      } else {
        const d = n.db;
        n.text = fitText(d.name || d.system || 'database', F_LABEL, 150);
        n.sub = `${d.system || 'db'} · ×${U.fmtCount(d.count)}`;
        n.w = Math.ceil(Math.max(textW(n.text, F_LABEL), textW(n.sub, F_SUB)) + 2 * PAD_X + 8);
        n.w = Math.max(n.w, 96);
        n.h = 46;
      }
    }
  }

  function layout(graph) {
    const { nodes, links } = graph;
    const sorted = nodes.slice().sort((a, b) => a.first - b.first || KIND_RANK[a.kind] - KIND_RANK[b.kind] || cmpStr(a.key, b.key));
    sorted.forEach((n, i) => { n.seq = i; n.fin = []; n.fout = []; n.rank = 0; });
    for (const l of links) {
      l.back = !(l.a.seq < l.b.seq);
      if (!l.back) { l.a.fout.push(l); l.b.fin.push(l); }
    }
    for (const n of sorted) {
      let r = 0;
      for (const l of n.fin) r = Math.max(r, l.a.rank + 1);
      n.rank = r;
    }
    for (let i = sorted.length - 1; i >= 0; i--) {
      const n = sorted[i];
      if (n.fin.length || !n.fout.length) continue;
      let r = Infinity;
      for (const l of n.fout) r = Math.min(r, l.b.rank - 1);
      n.rank = Math.max(0, r);
    }
    let maxRank = 0;
    for (const n of nodes) if (n.rank > maxRank) maxRank = n.rank;
    const layers = Array.from({ length: maxRank + 1 }, () => []);
    for (const n of sorted) { n.up = []; n.down = []; layers[n.rank].push(n); }

    for (const l of links) {
      l.chain = [l.a];
      if (!l.back) {
        for (let r = l.a.rank + 1; r < l.b.rank; r++) {
          const d = { id: l.id + '#' + r, kind: 'dummy', rank: r, w: 0, h: DUMMY_H, link: l, up: [], down: [] };
          layers[r].push(d);
          l.chain.push(d);
        }
        l.chain.push(l.b);
        const w = 1 + Math.log2(l.count + 1) * 0.5;
        for (let i = 0; i < l.chain.length - 1; i++) {
          l.chain[i].down.push({ n: l.chain[i + 1], w });
          l.chain[i + 1].up.push({ n: l.chain[i], w });
        }
      } else {
        l.chain.push(l.b);
      }
    }

    // crossing reduction: barycenter sweeps
    for (const L of layers) L.forEach((n, i) => { n.pos = i; });
    for (let it = 0; it < 8; it++) {
      const down = it % 2 === 0;
      for (let k = 1; k <= maxRank; k++) {
        const r = down ? k : maxRank - k;
        const L = layers[r];
        for (const n of L) {
          const nb = down ? n.up : n.down;
          if (!nb.length) { n.bc = n.pos; continue; }
          let s = 0, w = 0;
          for (const e of nb) { s += e.n.pos * e.w; w += e.w; }
          n.bc = s / w;
        }
        L.sort((a, b) => a.bc - b.bc || a.pos - b.pos);
        L.forEach((n, i) => { n.pos = i; });
      }
    }

    // vertical placement
    const gapOf = (a, b) => (a.kind === 'dummy' && b.kind === 'dummy' ? 2 : a.kind === 'dummy' || b.kind === 'dummy' ? 6 : GAP_Y);
    function place(L, desired) {
      const y = new Array(L.length);
      let shift = 0;
      for (let i = 0; i < L.length; i++) {
        y[i] = desired[i];
        if (i > 0) y[i] = Math.max(y[i], y[i - 1] + L[i - 1].h / 2 + gapOf(L[i - 1], L[i]) + L[i].h / 2);
        shift += desired[i] - y[i];
      }
      shift /= L.length || 1;
      for (let i = 0; i < L.length; i++) L[i].cy = y[i] + shift;
    }
    for (const L of layers) {
      let total = 0;
      for (let i = 0; i < L.length; i++) total += L[i].h + (i ? gapOf(L[i - 1], L[i]) : 0);
      let y = -total / 2;
      for (let i = 0; i < L.length; i++) {
        if (i) y += gapOf(L[i - 1], L[i]);
        L[i].cy = y + L[i].h / 2;
        y += L[i].h;
      }
    }
    for (let it = 0; it < 8; it++) {
      const down = it % 2 === 0;
      for (let k = 0; k <= maxRank; k++) {
        const r = down ? k : maxRank - k;
        const L = layers[r];
        const desired = L.map((n) => {
          const nb = (down ? n.up : n.down).concat(it > 3 ? (down ? n.down : n.up) : []);
          if (!nb.length) return n.cy;
          let s = 0, w = 0;
          for (const e of nb) { s += e.n.cy * e.w; w += e.w; }
          return s / w;
        });
        place(L, desired);
      }
    }
    let minY = Infinity;
    for (const L of layers) for (const n of L) minY = Math.min(minY, n.cy - n.h / 2);
    for (const L of layers) for (const n of L) { n.cy -= minY; n.y = n.cy - n.h / 2; }

    // column widths; group nodes in a column share a width
    const colW = layers.map((L) => {
      let gw = 0, ow = 0;
      for (const n of L) {
        if (n.kind === 'group') gw = Math.max(gw, n.w);
        else if (n.kind !== 'dummy') ow = Math.max(ow, n.w);
      }
      for (const n of L) if (n.kind === 'group') n.w = gw;
      return Math.max(gw, ow, 24);
    });
    graph.layers = layers;
    graph.colW = colW;
    graph.maxRank = maxRank;
  }

  function placeX(graph, gap) {
    const colX = [];
    let x = 0;
    for (let r = 0; r < graph.colW.length; r++) { colX.push(x); x += graph.colW[r] + gap; }
    graph.colX = colX;
    for (const L of graph.layers) {
      for (const n of L) {
        const cx = colX[n.rank] + graph.colW[n.rank] / 2;
        n.x = cx - n.w / 2;
        n.cx = cx;
      }
    }
  }

  function spreadPorts(list, n, keyFn, prop) {
    list.sort((a, b) => keyFn(a) - keyFn(b));
    const k = list.length;
    const step = k > 1 ? Math.min(5, (n.h * 0.6) / (k - 1)) : 0;
    list.forEach((l, i) => { l[prop] = n.cy + (i - (k - 1) / 2) * step; });
  }

  function route(graph) {
    const { nodes, links, colX, colW } = graph;
    for (const n of nodes) {
      spreadPorts(n.fout.slice(), n, (l) => l.chain[1].cy, 'y0');
      spreadPorts(n.fin.slice(), n, (l) => l.chain[l.chain.length - 2].cy, 'y1');
    }
    const sides = new Map();
    const pushSide = (n, side, l, end) => {
      const k = n.index + side;
      let e = sides.get(k);
      if (!e) sides.set(k, (e = { n, items: [] }));
      e.items.push({ l, end });
    };
    for (const l of links) {
      if (!l.back) continue;
      l.mode = l.a.rank > l.b.rank ? 'left' : l.a.rank === l.b.rank ? 'loop' : 'fwd';
      if (l.mode === 'left') { pushSide(l.a, 'L', l, 'a'); pushSide(l.b, 'R', l, 'b'); }
      else if (l.mode === 'loop') { pushSide(l.a, 'R', l, 'a'); pushSide(l.b, 'R', l, 'b'); }
      else { pushSide(l.a, 'R', l, 'a'); pushSide(l.b, 'L', l, 'b'); }
    }
    for (const { n, items } of sides.values()) {
      const other = (it) => (it.end === 'a' ? it.l.b.cy : it.l.a.cy);
      items.sort((p, q) => other(p) - other(q));
      const k = items.length;
      const step = k > 1 ? Math.min(5, (n.h * 0.3) / (k - 1)) : 0;
      const base = n.cy + n.h * 0.2;
      items.forEach((it, i) => { it.l[it.end === 'a' ? 'by0' : 'by1'] = base + (i - (k - 1) / 2) * step; });
    }

    let extMaxX = -Infinity;
    for (const l of links) {
      const ah = 3 + l.sw * 0.45;
      if (l.back) {
        const y1 = l.by0, y2 = l.by1;
        if (l.mode === 'fwd') {
          const x1 = l.a.x + l.a.w, tip = l.b.x, x2 = tip - ARROW, dx = Math.max(16, (x2 - x1) * 0.5);
          l.d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
          l.arrow = `M${tip},${y2} L${x2},${y2 - ah} L${x2},${y2 + ah} Z`;
          l.lx = (x1 + x2) / 2; l.ly = (y1 + y2) / 2;
        } else {
          const tip = l.b.x + l.b.w, x2 = tip + ARROW;
          let x1, c1;
          if (l.mode === 'left') {
            x1 = l.a.x;
            const dx = Math.max(16, (x1 - x2) * 0.5);
            c1 = x1 - dx;
            l.d = `M${x1},${y1} C${c1},${y1} ${x2 + dx},${y2} ${x2},${y2}`;
            l.lx = (x1 + x2) / 2;
          } else {
            x1 = l.a.x + l.a.w;
            const bulge = 24 + 0.2 * Math.abs(y1 - y2);
            l.d = `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}`;
            l.lx = Math.max(x1, x2) + bulge * 0.75;
            extMaxX = Math.max(extMaxX, l.lx + 4);
          }
          l.ly = (y1 + y2) / 2;
          l.arrow = `M${tip},${y2} L${x2},${y2 - ah} L${x2},${y2 + ah} Z`;
        }
        continue;
      }
      const pts = [[l.a.x + l.a.w, l.y0]];
      for (let i = 1; i < l.chain.length - 1; i++) {
        const d = l.chain[i];
        pts.push([colX[d.rank], d.cy, 'in'], [colX[d.rank] + colW[d.rank], d.cy, 'out']);
      }
      const tipX = l.b.x, y1 = l.y1;
      pts.push([tipX - ARROW, y1]);
      let d = `M${pts[0][0]},${pts[0][1]}`;
      let bestLen = -1;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        if (p[2] === 'in' && q[2] === 'out') { d += ` L${q[0]},${q[1]}`; continue; }
        const dx = Math.max(12, (q[0] - p[0]) * 0.5);
        d += ` C${p[0] + dx},${p[1]} ${q[0] - dx},${q[1]} ${q[0]},${q[1]}`;
        const len = q[0] - p[0];
        if (len > bestLen) { bestLen = len; l.lx = (p[0] + q[0]) / 2; l.ly = (p[1] + q[1]) / 2; }
      }
      l.d = d;
      l.arrow = `M${tipX},${y1} L${tipX - ARROW},${y1 - ah} L${tipX - ARROW},${y1 + ah} Z`;
    }
    graph.extMaxX = extMaxX;
  }

  function scopeBoxes(model, graph) {
    if (model.groupBy === 'scope' || model.groups.length < 3) return [];
    const counts = new Map();
    for (const g of model.groups) counts.set(g.deployScope, (counts.get(g.deployScope) || 0) + 1);
    let major = null, mc = -1;
    for (const [s, c] of counts) if (c > mc) { major = s; mc = c; }
    graph.majorScope = major;
    const out = [];
    for (const [scope, c] of counts) {
      if (scope === major || c < 2 || !scope || scope === 'unknown') continue;
      const members = graph.nodes.filter((n) => n.kind === 'group' && n.group.deployScope === scope);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of members) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
      x0 -= 14; y0 -= 26; x1 += 14; y1 += 12;
      const intrudes = graph.nodes.some((n) => n.kind !== 'dummy' && !(n.kind === 'group' && n.group.deployScope === scope) &&
        n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0);
      if (!intrudes) out.push({ scope, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return out;
  }

  // ---------------------------------------------------------------- view

  function mount(container, api) {
    const store = api.store;
    const prefs = loadPrefs();
    let model = null, graph = null, boxes = [];
    let gap = 56;
    let view = { k: 1, tx: 0, ty: 0 };
    let userMoved = false, pendingFit = true;
    let hoverNode = null, hoverLink = null, pinned = null;
    let localHoverGroup = null;
    let jNodes = new Set(), jLinks = new Set();
    let nodeEls = [], linkEls = [], labelEls = [];
    let destroyed = false;

    const S = U.svg, E = U.el;

    const root = E('div', { class: 'map-root' });
    const svg = S('svg', { class: 'map-svg', attrs: { role: 'img', 'aria-label': 'Flow map of services' } });
    const viewport = S('g', { class: 'map-viewport' });
    const gBoxes = S('g', { class: 'map-boxes' });
    const gLinks = S('g', { class: 'map-links' });
    const gNodes = S('g', { class: 'map-nodes' });
    const gLabels = S('g', { class: 'map-labels' });
    viewport.append(gBoxes, gLinks, gNodes, gLabels);
    svg.appendChild(viewport);

    const chip = (key, text, title) => E('button', {
      class: 'tv-chip map-toggle', type: 'button', title,
      attrs: { 'aria-pressed': String(!!prefs[key]) },
      on: { click: () => togglePref(key) },
      dataset: { pref: key },
    }, text);
    const btnFit = E('button', { class: 'tv-btn tv-btn--sm', type: 'button', title: 'Fit graph to view', on: { click: () => fit() } }, 'Fit');
    const btnOut = E('button', { class: 'tv-btn tv-btn--sm tv-btn--icon map-zbtn', type: 'button', title: 'Zoom out', attrs: { 'aria-label': 'Zoom out' }, on: { click: () => zoomBy(1 / 1.25) } }, '−');
    const btnIn = E('button', { class: 'tv-btn tv-btn--sm tv-btn--icon map-zbtn', type: 'button', title: 'Zoom in', attrs: { 'aria-label': 'Zoom in' }, on: { click: () => zoomBy(1.25) } }, '+');
    const chips = [
      chip('journey', 'Journey', 'Highlight the critical path (journey) chain'),
      chip('labels', 'Labels', 'Show all edge labels'),
      chip('topics', 'Topics as nodes', 'Insert Kafka topics between producers and consumers'),
      chip('dbs', 'Databases', 'Show databases connected to their services'),
    ];
    const stats = E('span', { class: 'map-stats tv-num' });
    const toolbar = E('div', { class: 'map-toolbar' },
      E('div', { class: 'map-zoom' }, btnFit, btnOut, btnIn), E('span', { class: 'map-sep' }), chips, stats);

    const lineKey = (cls) => S('svg', { class: 'map-lkey', width: 22, height: 8, attrs: { 'aria-hidden': 'true' } },
      S('path', { class: cls, d: 'M1,4 L21,4' }));
    const legend = E('div', { class: 'map-legend' },
      E('span', { class: 'map-lg' }, lineKey('map-lk map-lk--sync'), 'sync call'),
      E('span', { class: 'map-lg' }, lineKey('map-lk map-lk--async'), 'async (Kafka)'),
      E('span', { class: 'map-lg' }, lineKey('map-lk map-lk--back'), 'back in time'),
      E('span', { class: 'map-lg' }, lineKey('map-lk map-lk--journey'), 'journey'),
      E('span', { class: 'map-lg-sep' }),
      E('span', { class: 'map-lg tv-muted' }, 'self time / hop type:'),
      CATS.map((c) => E('span', { class: 'map-lg' }, E('span', { class: 'tv-key ' + U.catClass(c) }), CAT_LABEL[c])));
    const pop = E('div', { class: 'map-pop', attrs: { hidden: true, role: 'dialog' } });
    const empty = E('div', { class: 'tv-empty map-empty' },
      E('strong', {}, 'No trace loaded'),
      E('span', {}, 'Load a Tempo trace export to see how services talk to each other.'));
    root.append(svg, toolbar, legend, pop, empty);
    container.appendChild(root);
    root._mapDebug = () => ({ graph, view, gap, layoutMs: graph && graph.layoutMs });

    // ------------------------------------------------------------ prefs

    function togglePref(key) {
      prefs[key] = !prefs[key];
      savePrefs(prefs);
      for (const c of chips) c.setAttribute('aria-pressed', String(!!prefs[c.dataset.pref]));
      if (key === 'topics' || key === 'dbs') { rebuild(); fit(); } else restyle();
    }

    // ------------------------------------------------------------ build / draw

    function rebuild() {
      closePop();
      hoverNode = hoverLink = null;
      model = store.get().model;
      root.classList.toggle('is-empty', !model);
      if (!model) { graph = null; clearDraw(); stats.textContent = ''; return; }
      const t0 = performance.now();
      graph = buildGraph(model, prefs);
      measureNodes(graph);
      layout(graph);
      placeX(graph, gap);
      route(graph);
      boxes = scopeBoxes(model, graph);
      computeJourney();
      draw();
      graph.layoutMs = performance.now() - t0;
      const nG = model.groups.length;
      const nL = graph.links.length;
      stats.textContent = `${nG} ${model.groupBy === 'service' ? 'service' : 'group'}${nG === 1 ? '' : 's'} · ${nL} link${nL === 1 ? '' : 's'}`;
    }

    function clearDraw() {
      U.clear(gBoxes); U.clear(gLinks); U.clear(gNodes); U.clear(gLabels);
      nodeEls = []; linkEls = []; labelEls = [];
    }

    function draw() {
      clearDraw();
      if (!graph) return;
      for (const b of boxes) {
        gBoxes.appendChild(S('g', { class: 'map-box' },
          S('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }),
          S('text', { x: b.x + 10, y: b.y + 15 }, b.scope)));
      }
      for (const l of graph.links) {
        const g = S('g', {
          class: 'map-link' + (l.async ? ' is-async' : '') + (l.back ? ' is-back' : ''),
          style: { '--lc': `var(--cat-${l.cat})` },
          dataset: { li: l.index },
        },
        S('path', { class: 'map-link-line', d: l.d, 'stroke-width': l.sw }),
        S('path', { class: 'map-link-arrow', d: l.arrow }),
        S('path', { class: 'map-link-hit', d: l.d }));
        linkEls[l.index] = g;
        gLinks.appendChild(g);
        const lab = S('text', { class: 'map-elabel', x: l.lx, y: l.ly - 4, 'text-anchor': 'middle' }, linkLabel(l));
        labelEls[l.index] = lab;
        gLabels.appendChild(lab);
      }
      for (const n of graph.nodes) {
        const g = drawNode(n);
        nodeEls[n.index] = g;
        gNodes.appendChild(g);
      }
      orderJourneyLinks();
      restyle();
    }

    function drawNode(n) {
      const g = S('g', { class: 'map-node map-node--' + n.kind, transform: `translate(${n.x},${n.y})`, dataset: { ni: n.index } });
      if (n.kind === 'group') {
        const grp = n.group;
        g.appendChild(S('rect', { class: 'map-node-ring', x: -4, y: -4, width: n.w + 8, height: n.h + 8, rx: 9 }));
        g.appendChild(S('rect', { class: 'map-node-box', width: n.w, height: n.h, rx: 6 }));
        n.lines.forEach((ln, i) => g.appendChild(S('text', { class: 'map-node-label', x: PAD_X, y: PAD_TOP + 11 + i * LINE_H }, ln)));
        const ly = PAD_TOP + n.lines.length * LINE_H;
        g.appendChild(S('text', { class: 'map-node-sub', x: PAD_X, y: ly + 10.5 }, n.sub));
        const by = ly + SUB_H + BAR_GAP, bw = n.w - 2 * PAD_X;
        g.appendChild(S('rect', { class: 'map-node-track', x: PAD_X, y: by, width: bw, height: BAR_H, rx: 1 }));
        let total = 0;
        for (const c of CATS) total += grp.categoryTime[c] || 0;
        const src = total > 0 ? grp.categoryTime : grp.categoryCount;
        if (total <= 0) { total = 0; for (const c of CATS) total += (src && src[c]) || 0; }
        if (total > 0) {
          const parts = CATS.filter((c) => (src[c] || 0) > 0);
          let cum = 0;
          parts.forEach((c, i) => {
            const x0 = PAD_X + (cum / total) * bw;
            cum += src[c];
            const x1 = PAD_X + (cum / total) * bw - (i < parts.length - 1 ? 1 : 0);
            g.appendChild(S('rect', { class: 'map-node-seg ' + U.catClass(c), x: x0, y: by, width: Math.max(1, x1 - x0), height: BAR_H }));
          });
        }
        if (graph.majorScope && grp.deployScope !== graph.majorScope && model.groupBy !== 'scope' && !boxes.some((b) => b.scope === grp.deployScope)) {
          const txt = String(grp.deployScope).toUpperCase();
          const tw = Math.ceil(textW(txt, '600 9.5px ' + FONT_UI)) + 10;
          g.appendChild(S('g', { class: 'map-scope', transform: `translate(${PAD_X - 2},-7)` },
            S('rect', { width: tw, height: 13, rx: 3 }),
            S('text', { x: tw / 2, y: 9.6, 'text-anchor': 'middle' }, txt)));
        }
        if (grp.errorCount > 0) {
          const txt = grp.errorCount > 1 ? '! ' + grp.errorCount : '!';
          const bw2 = grp.errorCount > 1 ? Math.ceil(textW(txt, '700 10px ' + FONT_UI)) + 10 : 15;
          g.appendChild(S('g', { class: 'map-err', transform: `translate(${n.w - bw2 + 5},-6)` },
            S('rect', { width: bw2, height: 15, rx: 7.5 }),
            S('text', { x: bw2 / 2, y: 11, 'text-anchor': 'middle' }, txt)));
        }
      } else if (n.kind === 'topic') {
        g.appendChild(S('rect', { class: 'map-node-ring', x: -4, y: -4, width: n.w + 8, height: n.h + 8, rx: (n.h + 8) / 2 }));
        g.appendChild(S('rect', { class: 'map-node-box', width: n.w, height: n.h, rx: n.h / 2 }));
        g.appendChild(S('circle', { class: 'map-node-dot cat-messaging', cx: 11, cy: n.h / 2, r: 3 }));
        g.appendChild(S('text', { class: 'map-node-pill', x: 19, y: n.h / 2 + 3.8 }, n.text));
      } else {
        const w = n.w, h = n.h, ry = 4;
        g.appendChild(S('path', { class: 'map-node-ring', d: `M-4,${ry} a${w / 2 + 4},${ry + 2} 0 0,1 ${w + 8},0 v${h - 2 * ry} a${w / 2 + 4},${ry + 2} 0 0,1 ${-(w + 8)},0 Z`, transform: 'translate(0,0)' }));
        g.appendChild(S('path', { class: 'map-node-box', d: `M0,${ry} a${w / 2},${ry} 0 0,1 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0,1 ${-w},0 Z` }));
        g.appendChild(S('path', { class: 'map-node-rim', d: `M0,${ry} a${w / 2},${ry} 0 0,0 ${w},0` }));
        g.appendChild(S('circle', { class: 'map-node-dot cat-db', cx: PAD_X + 2, cy: 21, r: 3 }));
        g.appendChild(S('text', { class: 'map-node-label', x: PAD_X + 10, y: 25 }, n.text));
        g.appendChild(S('text', { class: 'map-node-sub', x: PAD_X, y: 39 }, n.sub));
      }
      return g;
    }

    function linkLabel(l) {
      const parts = [];
      if (l.kind === 'call') {
        const labels = Array.from(new Set(l.edges.map((e) => e.label).filter(Boolean)));
        if (labels.length === 1) parts.push(U.truncateMiddle(U.shortTopic(labels[0]), 44));
        else if (labels.length > 1) parts.push(`${labels.length} routes`);
      }
      parts.push('×' + U.fmtCount(l.count));
      if (l.kind === 'db') parts.push(U.fmtMs(l.timeSum));
      else if (l.latN) parts.push(U.fmtMs(l.latSum / l.latN));
      return parts.join(' · ');
    }

    // ------------------------------------------------------------ journey

    function linkIdsForHop(p, c) {
      const hop = c.hopIn && c.hopIn.parent === p ? c.hopIn : null;
      const tid = hop && hop.type === 'kafka' ? 't:' + hop.label : null;
      if (tid && graph.topicIds.has(tid)) return { links: ['g:' + p.group + '>' + tid, tid + '>g:' + c.group], node: tid };
      return { links: ['g:' + p.group + '>g:' + c.group], node: null };
    }

    function computeJourney() {
      jNodes = new Set(); jLinks = new Set();
      const j = store.get().journey;
      if (!graph || !j || !j.chain) return;
      for (let i = 0; i < j.chain.length; i++) {
        const c = j.chain[i];
        jNodes.add('g:' + c.group);
        if (!i) continue;
        const p = j.chain[i - 1];
        if (p.group === c.group) continue;
        const r = linkIdsForHop(p, c);
        for (const id of r.links) if (graph.linkById.has(id)) jLinks.add(id);
        if (r.node) jNodes.add(r.node);
      }
    }

    function orderJourneyLinks() {
      if (!graph) return;
      for (const id of jLinks) {
        const l = graph.linkById.get(id);
        if (l && linkEls[l.index]) gLinks.appendChild(linkEls[l.index]);
      }
    }

    // ------------------------------------------------------------ styling

    function restyle() {
      if (!graph) return;
      const s = store.get();
      const ok = new Map();
      for (const n of graph.nodes) if (n.kind === 'group') ok.set(n.id, store.groupMatches(n.key));
      const nodeOk = (n) => {
        if (n.kind === 'group') return ok.get(n.id);
        return n.links.some((l) => ok.get(l.a.kind === 'group' ? l.a.id : l.b.id));
      };
      const selG = new Set(s.selectedGroups || []);
      const selSpan = s.selectedSpanId ? model.byId.get(s.selectedSpanId) : null;
      const hovSpan = s.hoverSpanId ? model.byId.get(s.hoverSpanId) : null;
      const extHover = new Set();
      if (s.hoverGroup && s.hoverGroup !== localHoverGroup) extHover.add('g:' + s.hoverGroup);
      if (hovSpan) extHover.add('g:' + hovSpan.group);
      const spanLinks = new Set();
      if (selSpan && selSpan.parent && selSpan.hopIn) for (const id of linkIdsForHop(selSpan.parent, selSpan).links) spanLinks.add(id);

      const nearN = new Set(), nearL = new Set();
      if (hoverNode) {
        nearN.add(hoverNode);
        for (const l of hoverNode.links) { nearL.add(l); nearN.add(l.a); nearN.add(l.b); }
      }
      svg.classList.toggle('has-focus', !!hoverNode);
      svg.classList.toggle('show-labels', !!prefs.labels);
      const showJ = !!prefs.journey;

      const okCache = new Map();
      for (const n of graph.nodes) {
        const el = nodeEls[n.index];
        if (!el) continue;
        const good = nodeOk(n);
        okCache.set(n, good);
        const cl = el.classList;
        cl.toggle('is-dimmed', !good);
        cl.toggle('is-selected', n.kind === 'group' && selG.has(n.key));
        cl.toggle('is-span-group', !!selSpan && n.id === 'g:' + selSpan.group && !selG.has(n.key));
        cl.toggle('is-journey', showJ && jNodes.has(n.id));
        cl.toggle('is-hover', n === hoverNode || extHover.has(n.id));
        cl.toggle('is-near', nearN.has(n));
        cl.toggle('has-error', n.kind === 'group' && n.group.errorCount > 0);
      }
      for (const l of graph.links) {
        const el = linkEls[l.index];
        if (!el) continue;
        const inJ = showJ && jLinks.has(l.id);
        const hot = l === hoverLink || (pinned && pinned.link === l) || nearL.has(l) || spanLinks.has(l.id);
        const cl = el.classList;
        cl.toggle('is-dimmed', !(okCache.get(l.a) && okCache.get(l.b)));
        cl.toggle('is-journey', inJ);
        cl.toggle('is-hot', hot);
        cl.toggle('is-near', nearL.has(l));
        el.firstChild.style.strokeWidth = inJ ? Math.max(2, l.sw) + 'px' : '';
        const lab = labelEls[l.index];
        lab.classList.toggle('is-shown', l === hoverLink || (pinned && pinned.link === l));
        lab.classList.toggle('is-near', nearL.has(l));
        lab.classList.toggle('is-dimmed', cl.contains('is-dimmed'));
      }
    }

    // ------------------------------------------------------------ pan / zoom / fit

    function applyTransform() {
      viewport.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.k})`);
    }

    function fit() {
      if (!graph) return;
      const W = svg.clientWidth, H = svg.clientHeight;
      if (W < 40 || H < 40) { pendingFit = true; return; }
      pendingFit = false;
      userMoved = false;
      closePop();
      const top = toolbar.offsetHeight + 18, bottom = legend.offsetHeight + 18, side = 20;
      const availW = W - 2 * side, availH = Math.max(40, H - top - bottom);
      const cols = graph.colW.length;
      let sumW = 0;
      for (const w of graph.colW) sumW += w;
      const g2 = cols > 1 ? clamp((availW - sumW) / (cols - 1), 30, 110) : 60;
      if (Math.abs(g2 - gap) > 0.5) {
        gap = g2;
        placeX(graph, gap);
        route(graph);
        boxes = scopeBoxes(model, graph);
        draw();
      }
      const bb = bbox();
      const k = clamp(Math.min(availW / bb.w, availH / bb.h, 1.15), 0.08, 4);
      view = { k, tx: side + (availW - bb.w * k) / 2 - bb.x * k, ty: top + (availH - bb.h * k) / 2 - bb.y * k };
      applyTransform();
    }

    function bbox() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of graph.nodes) {
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y - 8);
        x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
      }
      for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
      if (isFinite(graph.extMaxX)) x1 = Math.max(x1, graph.extMaxX);
      if (!isFinite(x0)) return { x: 0, y: 0, w: 100, h: 100 };
      return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    }

    function zoomAt(f, px, py) {
      const k = clamp(view.k * f, 0.08, 4);
      const r = k / view.k;
      view = { k, tx: px - (px - view.tx) * r, ty: py - (py - view.ty) * r };
      userMoved = true;
      applyTransform();
    }
    function zoomBy(f) {
      closePop();
      zoomAt(f, svg.clientWidth / 2, svg.clientHeight / 2);
    }

    function onWheel(e) {
      if (!graph) return;
      e.preventDefault();
      closePop();
      const r = svg.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      zoomAt(f, e.clientX - r.left, e.clientY - r.top);
    }

    let drag = null, suppressClick = false;
    function onPointerDown(e) {
      if (e.button !== 0 || !graph) return;
      drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, id: e.pointerId, active: false };
    }
    function onPointerMove(e) {
      if (drag && drag.id === e.pointerId) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.active && Math.hypot(dx, dy) > 4) {
          drag.active = true;
          try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          svg.classList.add('is-panning');
          U.tooltip.hide();
          closePop();
        }
        if (drag.active) {
          view.tx = drag.tx + dx; view.ty = drag.ty + dy;
          userMoved = true;
          applyTransform();
          return;
        }
      }
      if (hoverNode || hoverLink) U.tooltip.move(e.clientX, e.clientY);
    }
    function onPointerUp(e) {
      if (!drag || drag.id !== e.pointerId) return;
      if (drag.active) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      svg.classList.remove('is-panning');
      drag = null;
    }

    // ------------------------------------------------------------ hover / click

    function targetOf(e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-ni],[data-li]') : null;
      if (!t || !graph) return null;
      if (t.dataset.ni != null) return { node: graph.nodes[+t.dataset.ni] };
      return { link: graph.links[+t.dataset.li] };
    }

    function setHover(node, link, e) {
      if (node === hoverNode && link === hoverLink) return;
      hoverNode = node || null;
      hoverLink = link || null;
      restyle();
      if (hoverNode) U.tooltip.show(e.clientX, e.clientY, nodeTip(hoverNode));
      else if (hoverLink) U.tooltip.show(e.clientX, e.clientY, linkTip(hoverLink));
      else U.tooltip.hide();
      const key = hoverNode && hoverNode.kind === 'group' ? hoverNode.key : null;
      if (key !== localHoverGroup) {
        localHoverGroup = key;
        if (store.get().hoverGroup !== key) store.set({ hoverGroup: key });
      }
    }

    function onOver(e) {
      if (drag && drag.active) return;
      const t = targetOf(e);
      setHover(t && t.node, t && t.link, e);
    }
    function onLeave() {
      if (drag && drag.active) return;
      hoverNode = null; hoverLink = null;
      U.tooltip.hide();
      restyle();
      if (localHoverGroup) { localHoverGroup = null; if (store.get().hoverGroup) store.set({ hoverGroup: null }); }
    }

    function onClick(e) {
      if (suppressClick) return;
      const t = targetOf(e);
      if (!t) { closePop(); return; }
      if (t.node) {
        const n = t.node;
        if (n.kind === 'group') {
          closePop();
          api.selectGroup(n.key, { additive: e.shiftKey || e.metaKey || e.ctrlKey });
        } else openPop({ node: n }, e);
      } else openPop({ link: t.link }, e);
    }

    // ------------------------------------------------------------ tooltips

    function tip(title, rows, hint) {
      return E('div', {},
        E('div', { class: 'tv-tt-title' }, title),
        rows.length ? E('div', { class: 'tv-tt-rows' }, rows.filter(Boolean).map((r) => [
          E('span', { class: 'tv-tt-value' }, String(r[1])),
          E('span', { class: 'tv-tt-label' }, r[2] ? E('span', { class: 'tv-tt-key', style: { '--c': `var(--cat-${r[2]})` } }) : null, r[0]),
        ])) : null,
        hint ? E('div', { class: 'map-tt-hint' }, hint) : null);
    }

    function nodeName(n) {
      if (n.kind === 'db') return n.db.name || n.db.system || n.db.key;
      return n.key;
    }

    function nodeTip(n) {
      if (n.kind === 'group') {
        const g = n.group;
        const rows = [
          ['spans', U.fmtCount(g.spanCount)],
          ['active time', U.fmtMs(g.activeTime)],
          ['self time', U.fmtMs(g.selfTime)],
          ['first span', U.fmtOffset(g.first)],
          g.errorCount ? ['errors', U.fmtCount(g.errorCount)] : null,
          ['deploy scope', g.scopes.join(', ') || g.deployScope],
          g.journeyTime > 0 ? ['on journey', U.fmtMs(g.journeyTime)] : null,
          ['in / out links', `${g.inEdges.length} / ${g.outEdges.length}`],
        ];
        for (const c of CATS) if (g.categoryTime[c] > 0) rows.push([CAT_LABEL[c] + ' self time', U.fmtMs(g.categoryTime[c]), c]);
        return tip(g.key, rows, 'Click to focus · Shift-click to add');
      }
      if (n.kind === 'topic') {
        const t = n.topic;
        return tip(t.name, [
          ['producers', t.producerGroups.join(', ') || '—'],
          ['consumer services', U.fmtCount(t.consumerGroups.length)],
          ['deliveries', U.fmtCount(t.deliveries.length)],
          t.latencyAvg != null ? ['avg delivery latency', U.fmtMs(t.latencyAvg)] : null,
          t.latencyMax != null ? ['max delivery latency', U.fmtMs(t.latencyMax)] : null,
        ], 'Click to list deliveries');
      }
      const d = n.db;
      const rows = [
        ['system', d.system || '—'],
        ['host', d.host || '—'],
        ['calls', U.fmtCount(d.count)],
        ['total time', U.fmtMs(d.time)],
        ['used by', d.groups.join(', ')],
      ];
      for (const t of d.tables.slice(0, 3)) rows.push([t.table, `${U.fmtMs(t.time)} · ×${t.count}`]);
      return tip(nodeName(n), rows, 'Click to list queries');
    }

    function linkTitle(l) {
      return `${nodeName(l.a)} → ${nodeName(l.b)}`;
    }

    function linkTip(l) {
      const rows = [];
      if (l.kind === 'db') {
        rows.push(['queries', U.fmtCount(l.count), 'db'], ['total time', U.fmtMs(l.timeSum)]);
      } else {
        const typeLabel = l.kind === 'produce' ? 'Kafka publish' : l.kind === 'consume' ? 'Kafka consume' : U.hopTypeLabel(l.type);
        rows.push([typeLabel + (l.count === 1 ? ' hop' : ' hops'), U.fmtCount(l.count), l.cat]);
        if (l.latN) {
          rows.push(['avg latency', U.fmtMs(l.latSum / l.latN)]);
          if (l.latN > 1) rows.push(['min – max', `${U.fmtMs(l.latMin)} – ${U.fmtMs(l.latMax)}`]);
          if (l.queueMax > 0) rows.push(['max queue', U.fmtMs(l.queueMax)]);
        }
        const labels = Array.from(new Set(l.edges.map((e) => e.label).filter(Boolean)));
        labels.slice(0, 4).forEach((lab, i) => rows.push([i ? '' : (labels.length > 1 ? 'routes' : 'route'), lab]));
        if (labels.length > 4) rows.push(['', `+${labels.length - 4} more`]);
        if (l.back) rows.push(['direction', 'back in time']);
      }
      return tip(linkTitle(l), rows, 'Click to list hops');
    }

    // ------------------------------------------------------------ popover

    function closePop() {
      if (!pinned) return;
      pinned = null;
      pop.hidden = true;
      U.clear(pop);
      restyle();
    }

    function hopRow(h, selId) {
      const c = h.child;
      return tagRow(c.id, E('button', {
        class: 'map-pop-row' + (c.id === selId ? ' is-selected' : ''), type: 'button',
        on: { click: () => api.selectSpan(c.id) },
      },
      E('span', { class: 'map-pop-name' }, c.name),
      E('span', { class: 'map-pop-num tv-num' }, U.fmtMs(h.latency)),
      E('span', { class: 'map-pop-sub' }, [U.fmtOffset(c.start), h.queue > 0 ? 'queue ' + U.fmtMs(h.queue) : 'no queue', c.isError ? 'error' : null, h.parent.name !== c.name ? 'from ' + h.parent.name : null].filter(Boolean).join(' · '))));
    }
    function tagRow(id, btn) { btn._spanId = id; return btn; }
    function spanRow(s, selId) {
      return tagRow(s.id, E('button', {
        class: 'map-pop-row' + (s.id === selId ? ' is-selected' : ''), type: 'button',
        on: { click: () => api.selectSpan(s.id) },
      },
      E('span', { class: 'map-pop-name' }, s.name),
      E('span', { class: 'map-pop-num tv-num' }, U.fmtMs(s.duration)),
      E('span', { class: 'map-pop-sub' }, [s.group, s.op && s.op.summary !== s.name ? s.op.summary : null, U.fmtOffset(s.start)].filter(Boolean).join(' · '))));
    }

    function openPop(target, e) {
      U.tooltip.hide();
      const selId = store.get().selectedSpanId;
      let title, meta, rows, total;
      const LIMIT = 300;
      if (target.link) {
        const l = target.link;
        title = linkTitle(l);
        if (l.hops.length) {
          meta = `${U.fmtCount(l.hops.length)} hop${l.hops.length === 1 ? '' : 's'}${l.latN ? ' · avg ' + U.fmtMs(l.latSum / l.latN) : ''} · latency from parent start`;
          rows = l.hops.slice(0, LIMIT).map((h) => hopRow(h, selId));
          total = l.hops.length;
        } else {
          const spans = l.spans.slice().sort((a, b) => b.duration - a.duration);
          meta = `${U.fmtCount(spans.length)} span${spans.length === 1 ? '' : 's'}${l.kind === 'db' ? ' · ' + U.fmtMs(l.timeSum) + ' total' : ''}`;
          rows = spans.slice(0, LIMIT).map((s) => spanRow(s, selId));
          total = spans.length;
        }
      } else {
        const n = target.node;
        title = nodeName(n);
        if (n.kind === 'topic') {
          const t = n.topic;
          if (t.deliveries.length) {
            const hops = t.deliveries.slice().sort((a, b) => a.child.start - b.child.start);
            meta = `${U.fmtCount(hops.length)} deliveries · ${t.producerGroups.length} producer / ${t.consumerGroups.length} consumer services`;
            rows = hops.slice(0, LIMIT).map((h) => hopRow(h, selId));
            total = hops.length;
          } else {
            const spans = t.producers.concat(t.consumers).sort((a, b) => a.start - b.start);
            meta = `${U.fmtCount(spans.length)} spans`;
            rows = spans.slice(0, LIMIT).map((s) => spanRow(s, selId));
            total = spans.length;
          }
        } else {
          const spans = n.db.spans.slice().sort((a, b) => b.duration - a.duration);
          meta = `${U.fmtCount(spans.length)} queries · ${U.fmtMs(n.db.time)} total`;
          rows = spans.slice(0, LIMIT).map((s) => spanRow(s, selId));
          total = spans.length;
        }
      }
      U.clear(pop);
      pop.append(
        E('div', { class: 'map-pop-head' },
          E('div', { class: 'map-pop-titles' }, E('div', { class: 'map-pop-title' }, title), E('div', { class: 'map-pop-meta' }, meta)),
          E('button', { class: 'tv-btn tv-btn--ghost tv-btn--icon tv-btn--sm', type: 'button', title: 'Close', attrs: { 'aria-label': 'Close' }, on: { click: () => closePop() } }, '×')),
        E('div', { class: 'map-pop-list' }, rows, total > LIMIT ? E('div', { class: 'map-pop-more' }, `+${U.fmtCount(total - LIMIT)} more`) : null));
      pinned = target;
      pop.hidden = false;
      const rr = root.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let x = e.clientX - rr.left + 12, y = e.clientY - rr.top + 12;
      if (x + pw > rr.width - 8) x = Math.max(8, e.clientX - rr.left - pw - 12);
      if (y + ph > rr.height - 8) y = Math.max(8, rr.height - ph - 8);
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
      restyle();
    }

    function onKey(e) {
      if (e.key === 'Escape' && pinned) closePop();
    }

    // ------------------------------------------------------------ wiring

    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);
    svg.addEventListener('pointerover', onOver);
    svg.addEventListener('pointerleave', onLeave);
    svg.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);

    const onResize = U.rafThrottle(() => {
      if (destroyed || !graph) return;
      if (pendingFit || !userMoved) fit();
    });
    const ro = new ResizeObserver(onResize);
    ro.observe(root);

    const RESTYLE_KEYS = ['search', 'filters', 'selectedGroups', 'selectedSpanId', 'hoverSpanId', 'hoverGroup'];

    return {
      update(state, changed) {
        if (destroyed) return;
        if (changed.has('*') || changed.has('model')) {
          rebuild();
          fit();
          return;
        }
        if (!graph) return;
        if (changed.has('journey')) { computeJourney(); orderJourneyLinks(); restyle(); return; }
        if (changed.size === 1 && changed.has('hoverGroup') && state.hoverGroup === localHoverGroup) return;
        if (RESTYLE_KEYS.some((k) => changed.has(k))) {
          if (pinned && changed.has('selectedSpanId')) {
            const sel = state.selectedSpanId;
            for (const b of pop.querySelectorAll('.map-pop-row')) b.classList.remove('is-selected');
            if (sel) for (const b of pop.querySelectorAll('.map-pop-row')) if (b._spanId === sel) b.classList.add('is-selected');
          }
          restyle();
        }
      },
      destroy() {
        destroyed = true;
        ro.disconnect();
        document.removeEventListener('keydown', onKey);
        U.tooltip.hide();
        container.removeChild(root);
      },
      // exposed for tests
      _debug: () => ({ graph, view, gap }),
    };
  }

  TV.views.register({ id: 'map', title: 'Flow map', order: 1, slot: 'main', shortcut: '1', mount });
})(globalThis.TV = globalThis.TV || {});
