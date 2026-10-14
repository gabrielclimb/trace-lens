(function (TV) {
  'use strict';

  const GUTTER_W = 232, GUTTER_MIN = 150, GUTTER_MAX = 480;
  const C_ROW = 11, C_BAR = 8, C_MAX_ROWS = 4, C_PAD = 8, C_MIN_H = 32;
  const E_HEAD = 30, E_ROW = 18, E_BAR = 10, E_PAD = 6, INDENT = 12;
  const MINI_H = 36, JOURNEY_H = 30, J_BAR = 12;
  const ORDERS = [
    { id: 'first', label: 'First start' },
    { id: 'journey', label: 'Journey time' },
    { id: 'self', label: 'Self time' },
  ];
  const CAT_IDS = ['messaging', 'db', 'rpc', 'http', 'internal'];
  const HAS_ROUND_RECT = typeof Path2D !== 'undefined' && typeof Path2D.prototype.roundRect === 'function';

  function sameWin(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  }

  function mount(container, api) {
    const U = TV.util, store = api.store, el = U.el;
    const catLabel = (id) => (U.CATEGORIES.find((c) => c.id === id) || { label: id }).label;

    // ------------------------------------------------------------------ local state
    let state = store.get();
    let model = null;
    let order = 'first';
    let allHops = false;
    let expanded = new Set();
    let gutterW = GUTTER_W;
    let win = null;            // [a, b] ms or null = full trace
    let lastPushed;            // last timeWindow we sent to the store
    let lanes = [];            // {g, y, h, expanded, rows: Span[][], rowTop: number[], barH, items}
    let laneOfGroup = new Map();
    let spanY = null;          // Float64Array index → bar top (content px)
    let spanBarH = null;       // Uint8Array index → bar height
    let spanLane = null;       // Int32Array index → lane index
    let gutterItems = [];      // {y, h, kind, lane, span, depth}
    let totalH = 0;
    let chainIds = new Set();
    let chainHops = [];
    let hiLanes = new Set();   // ancestor lanes of selected span
    let selLane = null;
    let density = null;
    let C = null;              // colors
    let patterns = null;
    let chartW = 0, bodyH = 0;
    let hoverSpan = null, hoverSeg = null;
    let gutterKey = '';
    let axisKey = '';
    let rafId = 0;
    let destroyed = false;
    const cleanups = [];

    // ------------------------------------------------------------------ DOM
    const segBtns = {};
    const orderSeg = el('div', { class: 'tv-seg', attrs: { role: 'group', 'aria-label': 'Lane order' } },
      ORDERS.map((o) => (segBtns[o.id] = el('button', {
        attrs: { type: 'button', 'aria-pressed': o.id === order ? 'true' : 'false' },
        on: { click: () => setOrder(o.id) },
      }, o.label))));
    const hopsInput = el('input', { attrs: { type: 'checkbox' }, on: { change: () => { allHops = hopsInput.checked; scheduleDraw(); } } });
    const expandBtn = el('button', { class: 'tv-btn tv-btn--sm', attrs: { type: 'button' }, on: { click: toggleExpandAll } }, 'Expand all');
    const resetBtn = el('button', { class: 'tv-btn tv-btn--sm', attrs: { type: 'button', title: 'Reset zoom (double-click the chart)' }, on: { click: () => setWin(null, true) } }, 'Reset zoom');

    const legend = el('div', { class: 'tl-legend', attrs: { 'aria-label': 'Legend' } },
      U.CATEGORIES.map((c) => el('span', { class: 'tl-legend-item' }, el('span', { class: 'tv-key ' + U.catClass(c.id) }), c.label.replace(' / messaging', ''))),
      el('span', { class: 'tl-legend-sep' }),
      el('span', { class: 'tl-legend-item' }, el('span', { class: 'tv-key tv-hatch' }), 'Queue / transport'),
      el('span', { class: 'tl-legend-item' }, el('span', { class: 'tv-key tv-dots' }), 'In-service wait'),
      el('span', { class: 'tl-legend-item' }, el('span', { class: 'tl-key-outline' }), 'Journey'),
      el('span', { class: 'tl-legend-item' }, el('span', { class: 'tl-err-dot' }, '!'), 'Error'));

    const toolbar = el('div', { class: 'tl-toolbar' },
      el('span', { class: 'tl-tb-label' }, 'Order'), orderSeg,
      el('label', { class: 'tv-check', title: 'Draw every cross-service hop faintly' }, hopsInput, 'All hops'),
      expandBtn, resetBtn,
      el('span', { class: 'tl-hint tv-muted', title: 'Ctrl/⌘ + scroll or pinch to zoom · drag to pan · double-click to reset · brush the overview' }, 'Ctrl/⌘+scroll zoom · drag pan · dbl-click reset'),
      legend);

    const miniCanvas = el('canvas', { class: 'tl-mini-canvas' });
    const shadeL = el('div', { class: 'tl-shade' });
    const shadeR = el('div', { class: 'tl-shade' });
    const brushHL = el('div', { class: 'tl-brush-h tl-brush-h--l' });
    const brushHR = el('div', { class: 'tl-brush-h tl-brush-h--r' });
    const brush = el('div', { class: 'tl-brush' }, brushHL, brushHR);
    const mini = el('div', { class: 'tl-mini', attrs: { title: 'Drag to select a time window' } }, miniCanvas, shadeL, shadeR, brush);
    const miniGut = el('div', { class: 'tl-gut-cell' }, el('span', { class: 'tv-section-title' }, 'Overview'));

    const axis = el('div', { class: 'tl-axis' });
    const winLabel = el('span', { class: 'tl-win-label tv-num tv-muted' });
    const axisGut = el('div', { class: 'tl-gut-cell' }, winLabel);

    const jCanvas = el('canvas', { class: 'tl-jcanvas' });
    const jTotal = el('span', { class: 'tl-j-total tv-num tv-muted' });
    const jTarget = el('span', { class: 'tl-j-target tv-ellipsis tv-muted' });
    const jGut = el('div', {
      class: 'tl-gut-cell tl-j-gut', attrs: { role: 'button', tabindex: '0', title: 'Open the Journey view' },
      on: { click: () => api.showView('journey'), keydown: (e) => { if (e.key === 'Enter') api.showView('journey'); } },
    }, el('span', { class: 'tl-j-name' }, 'Journey'), jTotal, jTarget);

    const rowMini = el('div', { class: 'tl-hrow tl-hrow--mini' }, miniGut, mini);
    const rowAxis = el('div', { class: 'tl-hrow tl-hrow--axis' }, axisGut, axis);
    const rowJourney = el('div', { class: 'tl-hrow tl-hrow--journey' }, jGut, jCanvas);
    const head = el('div', { class: 'tl-head' }, rowMini, rowAxis, rowJourney);

    const canvas = el('canvas', { class: 'tl-canvas' });
    const gutter = el('div', { class: 'tl-gutter' });
    const content = el('div', { class: 'tl-content' }, canvas, gutter);
    const body = el('div', { class: 'tl-body' }, content);
    const resizer = el('div', { class: 'tl-resizer', attrs: { title: 'Drag to resize the lane labels' } });
    const empty = el('div', { class: 'tv-empty tl-empty' }, el('div', null, 'No trace loaded'), el('div', { class: 'tv-secondary' }, 'Open a Tempo trace export to see the service swimlanes.'));
    const root = el('div', { class: 'tl' }, toolbar, head, body, resizer, empty);
    container.appendChild(root);

    const ctx = canvas.getContext('2d');
    const jctx = jCanvas.getContext('2d');
    const mctx = miniCanvas.getContext('2d');

    // ------------------------------------------------------------------ helpers
    function listen(target, evt, fn, opts) {
      target.addEventListener(evt, fn, opts);
      cleanups.push(() => target.removeEventListener(evt, fn, opts));
    }
    function dur() { return model ? Math.max(model.duration, 1e-6) : 1; }
    function curWin() { return win || [0, dur()]; }
    function X(t) { const w = curWin(); return (t - w[0]) / (w[1] - w[0]) * chartW; }
    function T(x) { const w = curWin(); return w[0] + x / chartW * (w[1] - w[0]); }
    function msPerPx() { const w = curWin(); return (w[1] - w[0]) / Math.max(1, chartW); }

    function readColors() {
      const cs = getComputedStyle(root);
      const v = (n) => cs.getPropertyValue(n).trim();
      C = {
        cat: {}, critical: v('--status-critical') || '#d03b3b',
        text1: v('--text-1'), text2: v('--text-2'), text3: v('--text-3'),
        grid: v('--grid'), axis: v('--axis'), border: v('--border'),
        s1: v('--surface-1'), s2: v('--surface-2'), hover: v('--surface-hover'), active: v('--surface-active'),
        ink: v('--pattern-ink'), dim: parseFloat(v('--dim')) || 0.18,
        font: cs.fontFamily || 'system-ui, sans-serif',
      };
      for (const id of CAT_IDS) C.cat[id] = v('--cat-' + id) || '#999';
      patterns = null;
      scheduleDraw();
    }

    function makePattern(c, kind) {
      const r = window.devicePixelRatio || 1;
      const size = kind === 'hatch' ? 6 : 4;
      const pc = document.createElement('canvas');
      pc.width = Math.round(size * r); pc.height = Math.round(size * r);
      const p = pc.getContext('2d');
      p.scale(r, r);
      p.strokeStyle = C.ink; p.fillStyle = C.ink;
      if (kind === 'hatch') {
        p.lineWidth = 1.2;
        p.beginPath();
        p.moveTo(-1, size + 1); p.lineTo(size + 1, -1);
        p.moveTo(-1, 1); p.lineTo(1, -1);
        p.moveTo(size - 1, size + 1); p.lineTo(size + 1, size - 1);
        p.stroke();
      } else {
        p.beginPath(); p.arc(size / 2, size / 2, 0.9, 0, Math.PI * 2); p.fill();
      }
      const pat = c.createPattern(pc, 'repeat');
      if (pat && pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([1 / r, 0, 0, 1 / r, 0, 0]));
      return pat;
    }
    function ensurePatterns() {
      if (patterns) return;
      patterns = { hatch: makePattern(jctx, 'hatch'), dots: makePattern(jctx, 'dots') };
    }

    function sizeCanvas(cv, c, w, h) {
      const r = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(w * r)), H = Math.max(1, Math.round(h * r));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      return r;
    }

    // ------------------------------------------------------------------ layout
    function orderedGroups() {
      const gs = model.groups.slice();
      if (order === 'self') gs.sort((a, b) => b.selfTime - a.selfTime || a.order - b.order);
      else if (order === 'journey') {
        const jt = new Map();
        if (state.journey) for (const r of state.journey.byGroup) jt.set(r.group, r.total);
        gs.sort((a, b) => (jt.get(b.key) || 0) - (jt.get(a.key) || 0) || a.order - b.order);
      }
      return gs;
    }

    function groupTree(g) {
      const inGroup = new Set(g.spans);
      const kids = new Map();
      const roots = [];
      const sorted = g.spans.slice().sort((a, b) => a.start - b.start || a.index - b.index);
      for (const s of sorted) {
        let p = s.parent, guard = 0;
        while (p && !inGroup.has(p) && guard++ < 10000) p = p.parent;
        if (p && inGroup.has(p)) {
          if (!kids.has(p)) kids.set(p, []);
          kids.get(p).push(s);
        } else roots.push(s);
      }
      const out = [];
      const stack = roots.slice().reverse().map((s) => [s, 0]);
      while (stack.length) {
        const [s, d] = stack.pop();
        out.push({ span: s, depth: d });
        const k = kids.get(s);
        if (k) for (let i = k.length - 1; i >= 0; i--) stack.push([k[i], d + 1]);
      }
      return out;
    }

    function relayout() {
      lanes = []; laneOfGroup = new Map(); gutterItems = [];
      if (!model) { totalH = 0; return; }
      const n = model.spans.length;
      spanY = new Float64Array(n); spanBarH = new Uint8Array(n); spanLane = new Int32Array(n);
      const gap = dur() * 0.002;
      let y = 0;
      for (const g of orderedGroups()) {
        const li = lanes.length;
        const lane = { g, y, h: 0, expanded: expanded.has(g.key), rows: [], rowTop: [], barH: 0, list: null };
        if (lane.expanded) {
          const list = groupTree(g);
          lane.list = list;
          lane.barH = E_BAR;
          gutterItems.push({ y, h: E_HEAD, kind: 'lane', lane });
          list.forEach((it, i) => {
            const top = y + E_HEAD + i * E_ROW;
            lane.rows.push([it.span]);
            lane.rowTop.push(top + (E_ROW - E_BAR) / 2);
            gutterItems.push({ y: top, h: E_ROW, kind: 'span', lane, span: it.span, depth: it.depth });
          });
          lane.h = E_HEAD + list.length * E_ROW + E_PAD;
        } else {
          const ends = [];
          const sorted = g.spans.slice().sort((a, b) => a.start - b.start || a.index - b.index);
          for (const s of sorted) {
            let r = -1;
            for (let i = 0; i < ends.length; i++) if (ends[i] + gap <= s.start) { r = i; break; }
            if (r < 0) {
              if (ends.length < C_MAX_ROWS) { r = ends.length; ends.push(-Infinity); lane.rows.push([]); } else r = C_MAX_ROWS - 1;
            }
            ends[r] = Math.max(ends[r], s.end);
            lane.rows[r].push(s);
          }
          const nRows = Math.max(1, lane.rows.length);
          const contentH = nRows * C_ROW - (C_ROW - C_BAR);
          lane.h = Math.max(C_MIN_H, contentH + 2 * C_PAD);
          const top0 = y + (lane.h - contentH) / 2;
          for (let i = 0; i < nRows; i++) lane.rowTop.push(top0 + i * C_ROW);
          lane.barH = C_BAR;
          gutterItems.push({ y, h: lane.h, kind: 'lane', lane });
        }
        lane.rows.forEach((row, ri) => {
          for (const s of row) { spanY[s.index] = lane.rowTop[ri]; spanBarH[s.index] = lane.barH; spanLane[s.index] = li; }
        });
        lanes.push(lane);
        laneOfGroup.set(g.key, lane);
        y += lane.h;
      }
      totalH = y;
      gutterKey = '';
      updateExpandBtn();
    }

    function computeDensity() {
      density = null;
      if (!model || chartW <= 0) return;
      const bins = Math.max(10, Math.floor(chartW / 2));
      const diff = new Float64Array(bins + 1);
      const d = dur();
      for (const s of model.spans) {
        const a = Math.max(0, Math.min(bins - 1, Math.floor(s.start / d * bins)));
        const b = Math.max(a, Math.min(bins - 1, Math.floor(s.end / d * bins)));
        diff[a] += 1; diff[b + 1] -= 1;
      }
      const counts = new Float64Array(bins);
      let acc = 0, max = 0;
      for (let i = 0; i < bins; i++) { acc += diff[i]; counts[i] = acc; if (acc > max) max = acc; }
      density = { counts, max, bins };
    }

    function computeChain() {
      chainIds = new Set(); chainHops = [];
      const j = state.journey;
      if (!j || !j.chain) return;
      for (const s of j.chain) chainIds.add(s.id);
      for (let i = 0; i < j.chain.length - 1; i++) {
        const p = j.chain[i], c = j.chain[i + 1];
        if (p.group !== c.group) chainHops.push({ parent: p, child: c, async: c.hopIn ? c.hopIn.async : c.start >= p.end });
      }
    }

    function computeSelection() {
      hiLanes = new Set(); selLane = null;
      const s = model && state.selectedSpanId ? model.byId.get(state.selectedSpanId) : null;
      if (!s) return;
      selLane = s.group;
      let p = s.parent, guard = 0;
      while (p && guard++ < 10000) { if (p.group !== s.group) hiLanes.add(p.group); p = p.parent; }
    }

    // ------------------------------------------------------------------ window
    let pushTimer = 0;
    function pushWin(immediate) {
      clearTimeout(pushTimer);
      const send = () => { lastPushed = win ? win.slice() : null; store.set({ timeWindow: lastPushed }); };
      if (immediate) send(); else pushTimer = setTimeout(send, 90);
    }
    function setWin(w, immediate) {
      if (!model) return;
      const d = dur();
      if (w) {
        let a = w[0], b = w[1];
        if (b < a) { const t = a; a = b; b = t; }
        const minW = Math.max(d * 1e-5, 0.001);
        if (b - a < minW) { const m = (a + b) / 2; a = m - minW / 2; b = m + minW / 2; }
        if (b - a >= d) w = null;
        else {
          if (a < 0) { b -= a; a = 0; }
          if (b > d) { a -= b - d; b = d; }
          w = [Math.max(0, a), Math.min(d, b)];
        }
      }
      if (sameWin(w, win)) return;
      win = w;
      scheduleDraw();
      pushWin(immediate);
    }
    function zoomAt(x, factor) {
      const w = curWin();
      const t = T(x);
      const nw = (w[1] - w[0]) * factor;
      const frac = chartW ? x / chartW : 0.5;
      setWin([t - nw * frac, t - nw * frac + nw]);
    }
    function panBy(dxPx) {
      if (!win) return;
      const dt = dxPx * msPerPx();
      setWin([win[0] + dt, win[1] + dt]);
    }

    // ------------------------------------------------------------------ drawing
    function scheduleDraw() {
      if (rafId || destroyed) return;
      rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
    }

    function measure() {
      const bw = body.clientWidth;
      chartW = Math.max(0, bw - gutterW);
      bodyH = body.clientHeight;
      root.style.setProperty('--tl-gutter', gutterW + 'px');
      root.style.setProperty('--tl-chart', chartW + 'px');
    }

    function ticks() {
      const w = curWin();
      const tk = U.niceTicks(w[0], w[1], Math.max(2, Math.round(chartW / 110)));
      const step = tk.length > 1 ? tk[1] - tk[0] : (w[1] - w[0]);
      const useSec = step >= 100 && w[1] >= 1000;
      const fmt = (v) => {
        if (useSec) {
          const d = Math.max(0, Math.min(3, -Math.floor(Math.log10(step / 1000) + 1e-9)));
          return (v / 1000).toFixed(d) + ' s';
        }
        const d = step >= 1 ? 0 : Math.min(4, -Math.floor(Math.log10(step) + 1e-9));
        return v.toFixed(d) + ' ms';
      };
      return { tk, fmt };
    }

    function draw() {
      if (destroyed) return;
      const has = !!model;
      root.classList.toggle('is-empty', !has);
      if (!has) return;
      measure();
      if (chartW <= 0 || bodyH <= 0) return;
      if (!C) readColors();
      ensurePatterns();
      if (!density || density.bins !== Math.max(10, Math.floor(chartW / 2))) computeDensity();
      content.style.height = Math.max(totalH + 8, bodyH) + 'px';
      const { tk, fmt } = ticks();
      drawAxis(tk, fmt);
      drawMini();
      drawJourney(tk);
      drawBody(tk);
      drawGutter();
      resetBtn.disabled = !win;
      const w = curWin();
      winLabel.textContent = win ? 'Window ' + U.fmtMs(w[1] - w[0]) + ' of ' + U.fmtMs(dur()) : 'Full trace · ' + U.fmtMs(dur());
      resizer.style.left = (gutterW - 3) + 'px';
      resizer.style.top = toolbar.offsetHeight + 'px';
    }

    function drawAxis(tk, fmt) {
      const key = chartW + '|' + tk.join(',') + '|' + fmt(tk[0] || 0);
      if (key === axisKey) return;
      axisKey = key;
      U.clear(axis);
      for (const t of tk) {
        const x = X(t);
        if (x < -1 || x > chartW + 1) continue;
        const lab = el('span', { class: 'tl-tick tv-num', style: { left: x + 'px' } }, fmt(t));
        if (x < 24) lab.classList.add('is-start'); else if (x > chartW - 30) lab.classList.add('is-end');
        axis.appendChild(lab);
      }
    }

    function drawMini() {
      const h = MINI_H - 8;
      const r = sizeCanvas(miniCanvas, mctx, chartW, h);
      mctx.setTransform(r, 0, 0, r, 0, 0);
      mctx.clearRect(0, 0, chartW, h);
      if (density && density.max > 0) {
        const bw = chartW / density.bins;
        mctx.fillStyle = C.text3;
        mctx.globalAlpha = 0.5;
        mctx.beginPath();
        for (let i = 0; i < density.bins; i++) {
          const c = density.counts[i];
          if (!c) continue;
          const bh = Math.max(1, Math.sqrt(c / density.max) * (h - 3));
          mctx.rect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
        }
        mctx.fill();
        mctx.globalAlpha = 1;
      }
      mctx.fillStyle = C.axis;
      mctx.fillRect(0, h - 1, chartW, 1);
      const d = dur();
      const w = curWin();
      const x0 = w[0] / d * chartW, x1 = w[1] / d * chartW;
      shadeL.style.left = '0px'; shadeL.style.width = Math.max(0, x0) + 'px';
      shadeR.style.left = x1 + 'px'; shadeR.style.width = Math.max(0, chartW - x1) + 'px';
      brush.style.left = x0 + 'px'; brush.style.width = Math.max(2, x1 - x0) + 'px';
      brush.classList.toggle('is-full', !win);
    }

    function barPath(path, x, y, w, h) {
      if (HAS_ROUND_RECT && w > 4) path.roundRect(x, y, w, h, 2);
      else path.rect(x, y, w, h);
    }

    function barGeom(s) {
      let x0 = X(s.start), x1 = X(s.end);
      let w = x1 - x0;
      if (w < 1) w = 1; else if (w >= 3) w -= 1;
      return [x0, w];
    }

    function drawJourney(tk) {
      const r = sizeCanvas(jCanvas, jctx, chartW, JOURNEY_H);
      jctx.setTransform(r, 0, 0, r, 0, 0);
      jctx.clearRect(0, 0, chartW, JOURNEY_H);
      jctx.fillStyle = C.grid;
      for (const t of tk) { const x = Math.round(X(t)) + 0.5; if (x >= 0 && x <= chartW) jctx.fillRect(x - 0.5, 0, 1, JOURNEY_H); }
      const j = state.journey;
      jTotal.textContent = j && j.total ? U.fmtMs(j.total) : '';
      jTarget.textContent = j && j.target ? '→ ' + j.target.group : '';
      jGut.title = j && j.target ? 'Journey to ' + j.target.group + ': ' + j.target.name + ' — open the Journey view' : 'Open the Journey view';
      if (!j || !j.segments.length) return;
      const y = (JOURNEY_H - J_BAR) / 2;
      const selId = state.selectedSpanId;
      for (const seg of j.segments) {
        const x0 = X(seg.start), x1 = X(seg.end);
        if (x1 < 0 || x0 > chartW) continue;
        const w = Math.max(1, x1 - x0 - (x1 - x0 >= 3 ? 1 : 0));
        const p = new Path2D();
        barPath(p, x0, y, w, J_BAR);
        const dimmed = seg.span && !store.matches(seg.span) && !(seg.toSpan && store.matches(seg.toSpan));
        jctx.globalAlpha = dimmed ? C.dim : 1;
        if (seg.type === 'work') {
          jctx.fillStyle = C.cat[seg.span.category] || C.cat.internal;
          jctx.fill(p);
        } else {
          jctx.fillStyle = seg.type === 'transit' ? patterns.hatch : patterns.dots;
          jctx.fill(p);
          jctx.strokeStyle = C.ink; jctx.lineWidth = 1;
          jctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(0, w - 1), J_BAR - 1);
        }
        jctx.globalAlpha = 1;
        const isSel = selId && ((seg.span && seg.span.id === selId && seg.type === 'work') || (seg.toSpan && seg.toSpan.id === selId && seg.type !== 'work'));
        if (seg === hoverSeg || isSel) {
          jctx.strokeStyle = C.text1; jctx.lineWidth = isSel ? 2 : 1;
          const o = isSel ? 1.5 : 0.5;
          jctx.strokeRect(x0 - o, y - o, w + 2 * o, J_BAR + 2 * o);
        }
      }
    }

    function laneIndexAt(y) {
      let lo = 0, hi = lanes.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lanes[mid].y <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    function drawBody(tk) {
      const scrollTop = body.scrollTop;
      const r = sizeCanvas(canvas, ctx, chartW, bodyH);
      ctx.setTransform(r, 0, 0, r, 0, 0);
      ctx.clearRect(0, 0, chartW, bodyH);
      ctx.translate(0, -scrollTop);
      const top = scrollTop, bottom = scrollTop + bodyH;
      const i0 = Math.max(0, laneIndexAt(top));
      const vis = [];
      for (let i = i0; i < lanes.length && lanes[i].y < bottom; i++) vis.push(lanes[i]);

      // lane backgrounds + separators
      const selGroups = state.selectedGroups || [];
      for (const lane of vis) {
        const k = lane.g.key;
        let bg = null;
        if (k === selLane) bg = C.active;
        else if (hiLanes.has(k) || selGroups.includes(k)) bg = C.hover;
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, lane.y, chartW, lane.h); }
        ctx.fillStyle = C.border;
        ctx.fillRect(0, lane.y + lane.h - 1, chartW, 1);
      }
      // gridlines
      ctx.fillStyle = C.grid;
      for (const t of tk) { const x = Math.round(X(t)); if (x >= 0 && x <= chartW) ctx.fillRect(x, top, 1, bodyH); }

      // bars, batched by category and dim state
      const paths = {};
      for (const id of CAT_IDS) paths[id] = [new Path2D(), new Path2D()];
      const errors = [], labels = [], chain = [];
      let hoverVisible = null, selVisible = null;
      const selId = state.selectedSpanId, hovId = hoverSpan ? hoverSpan.id : state.hoverSpanId;
      const w0 = -2, w1 = chartW + 2;
      for (const lane of vis) {
        for (let ri = 0; ri < lane.rows.length; ri++) {
          const ry = lane.rowTop[ri];
          if (ry > bottom || ry + lane.barH < top) continue;
          const row = lane.rows[ri];
          for (let k = 0; k < row.length; k++) {
            const s = row[k];
            const x0 = X(s.start), x1 = X(s.end);
            if (x1 < w0 || x0 > w1) continue;
            if (lane.expanded) labels.push(s);
            let w = x1 - x0;
            if (w < 1) w = 1; else if (w >= 3) w -= 1;
            const cat = paths[s.category] ? s.category : 'internal';
            barPath(paths[cat][store.matches(s) ? 0 : 1], x0, ry, w, lane.barH);
            if (s.isError) errors.push(s);
            if (chainIds.has(s.id)) chain.push(s);
            if (s.id === selId) selVisible = s;
            if (s.id === hovId) hoverVisible = s;
          }
        }
      }
      for (const id of CAT_IDS) {
        ctx.fillStyle = C.cat[id];
        ctx.globalAlpha = 1; ctx.fill(paths[id][0]);
        ctx.globalAlpha = C.dim; ctx.fill(paths[id][1]);
      }
      ctx.globalAlpha = 1;

      // journey chain outline
      ctx.strokeStyle = C.text1; ctx.lineWidth = 1;
      for (const s of chain) {
        const [x, w] = barGeom(s);
        ctx.strokeRect(x - 0.5, spanY[s.index] - 0.5, w + 1, spanBarH[s.index] + 1);
      }

      // errors: critical outline + '!' marker
      ctx.font = '700 8px ' + C.font;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const s of errors) {
        const [x, w] = barGeom(s);
        const y = spanY[s.index], h = spanBarH[s.index];
        ctx.strokeStyle = C.critical; ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 0.75, y - 0.75, w + 1.5, h + 1.5);
        const cx = Math.min(chartW - 6, x + w + 7), cy = y + h / 2;
        ctx.fillStyle = C.critical;
        ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText('!', cx, cy + 0.5);
      }

      // name labels on expanded lanes
      if (labels.length) {
        ctx.font = '11px ' + C.font;
        ctx.textBaseline = 'middle';
        for (const s of labels) {
          const [x, w] = barGeom(s);
          const y = spanY[s.index] + spanBarH[s.index] / 2;
          const text = s.name + '  ' + U.fmtMs(s.duration);
          ctx.globalAlpha = store.matches(s) ? 1 : Math.max(C.dim, 0.35);
          ctx.fillStyle = C.text2;
          let lx = x + w + (s.isError ? 15 : 5);
          if (lx > chartW - 60) {
            ctx.textAlign = 'right';
            lx = Math.min(x - 5, chartW - 4);
            if (lx > 20) ctx.fillText(text, lx, y);
          } else {
            ctx.textAlign = 'left';
            ctx.fillText(text, Math.max(lx, 4), y);
          }
        }
        ctx.globalAlpha = 1;
      }

      // hop connectors
      if (allHops) {
        ctx.strokeStyle = C.axis; ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
        for (const h of model.hops) drawHop(h.parent, h.child, h.async, top, bottom, false);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = C.text3; ctx.lineWidth = 1;
      for (const h of chainHops) drawHop(h.parent, h.child, h.async, top, bottom, true);
      const focus = [];
      for (const id of [selId, hovId]) {
        const s = id && model.byId.get(id);
        if (!s) continue;
        if (s.hopIn) focus.push(s.hopIn);
        for (const c of s.children) if (c.hopIn) focus.push(c.hopIn);
      }
      ctx.strokeStyle = C.text1; ctx.lineWidth = 1.25;
      for (const h of focus) drawHop(h.parent, h.child, h.async, top, bottom, true);
      ctx.setLineDash([]);

      // hover + selection
      if (hoverVisible && hoverVisible !== selVisible) {
        const s = hoverVisible, [x, w] = barGeom(s), y = spanY[s.index], h = spanBarH[s.index];
        ctx.fillStyle = C.s2; ctx.globalAlpha = 0.3; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
        ctx.strokeStyle = C.text1; ctx.lineWidth = 1;
        ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
      }
      if (selVisible) {
        const s = selVisible, [x, w] = barGeom(s), y = spanY[s.index], h = spanBarH[s.index];
        ctx.strokeStyle = C.s1; ctx.lineWidth = 3;
        ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
        ctx.strokeStyle = C.text1; ctx.lineWidth = 2;
        ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
      }
    }

    function drawHop(p, c, async, top, bottom, arrow) {
      if (!spanBarH[p.index] || !spanBarH[c.index]) return;
      const ph = spanBarH[p.index], ch = spanBarH[c.index];
      const pyc = spanY[p.index] + ph / 2, cyc = spanY[c.index] + ch / 2;
      if (Math.max(pyc, cyc) < top - 20 || Math.min(pyc, cyc) > bottom + 20) return;
      const px = X(Math.max(p.start, Math.min(p.end, c.start)));
      const cx = X(c.start);
      if (Math.max(px, cx) < -20 || Math.min(px, cx) > chartW + 20) return;
      const down = cyc >= pyc ? 1 : -1;
      const py = pyc + down * ph / 2;
      const dx = cx - px;
      const rad = Math.min(5, Math.abs(dx), Math.abs(cyc - py));
      ctx.setLineDash(async ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(px + 0.5, py);
      if (Math.abs(dx) < 1.5) {
        ctx.lineTo(px + 0.5, cyc - down * ch / 2);
      } else {
        const dir = dx > 0 ? 1 : -1;
        ctx.lineTo(px + 0.5, cyc - down * rad);
        ctx.quadraticCurveTo(px + 0.5, cyc, px + 0.5 + dir * rad, cyc);
        ctx.lineTo(cx - dir * 1, cyc);
      }
      ctx.stroke();
      if (arrow) {
        ctx.setLineDash([]);
        const prev = ctx.fillStyle;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        if (Math.abs(dx) < 1.5) {
          const ty = cyc - down * ch / 2;
          ctx.moveTo(px + 0.5, ty); ctx.lineTo(px - 2.5, ty - down * 4); ctx.lineTo(px + 3.5, ty - down * 4);
        } else {
          const dir = dx > 0 ? 1 : -1;
          ctx.moveTo(cx, cyc); ctx.lineTo(cx - dir * 4, cyc - 3); ctx.lineTo(cx - dir * 4, cyc + 3);
        }
        ctx.fill();
        ctx.fillStyle = prev;
      }
    }

    // ------------------------------------------------------------------ gutter (virtualized DOM)
    function drawGutter() {
      const top = body.scrollTop - 120, bottom = body.scrollTop + bodyH + 120;
      let a = 0, lo = 0, hi = gutterItems.length - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (gutterItems[m].y + gutterItems[m].h < top) lo = m + 1; else { a = m; hi = m - 1; } }
      a = Math.min(a, lo);
      let b = a;
      while (b < gutterItems.length && gutterItems[b].y < bottom) b++;
      const s = state;
      const key = [a, b, gutterW, s.selectedSpanId, (s.selectedGroups || []).join('\u0001'), s.search, JSON.stringify(s.filters), lanes.length, totalH, model && model.traceId].join('|');
      if (key === gutterKey) return;
      gutterKey = key;
      U.clear(gutter);
      const frag = document.createDocumentFragment();
      for (let i = a; i < b; i++) {
        const it = gutterItems[i];
        frag.appendChild(it.kind === 'lane' ? laneLabel(it) : spanLabel(it));
      }
      gutter.appendChild(frag);
    }

    function laneLabel(it) {
      const lane = it.lane, g = lane.g;
      const selGroups = state.selectedGroups || [];
      const cls = ['tl-lane'];
      if (lane.expanded) cls.push('is-expanded');
      if (!store.groupMatches(g.key)) cls.push('is-dimmed');
      if (selGroups.includes(g.key)) cls.push('is-focused');
      if (g.key === selLane) cls.push('is-active');
      else if (hiLanes.has(g.key)) cls.push('is-ancestor');
      const caret = el('button', {
        class: 'tl-caret', attrs: { type: 'button', 'aria-expanded': lane.expanded ? 'true' : 'false', 'aria-label': (lane.expanded ? 'Collapse ' : 'Expand ') + g.key },
        on: { click: (e) => { e.stopPropagation(); toggleLane(g.key); } },
      }, U.svg('svg', { viewBox: '0 0 10 10', width: '10', height: '10', 'aria-hidden': 'true' },
        U.svg('path', { d: lane.expanded ? 'M2 3.5 L5 6.5 L8 3.5' : 'M3.5 2 L6.5 5 L3.5 8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
      const meta = el('span', { class: 'tl-lane-meta' },
        g.errorCount ? el('span', { class: 'tl-lane-err', title: g.errorCount + ' error span(s)' }, el('span', { class: 'tl-err-dot' }, '!'), String(g.errorCount)) : null,
        el('span', { class: 'tv-num tv-muted', title: g.spanCount + ' spans' }, U.fmtCount(g.spanCount)));
      return el('div', {
        class: cls.join(' '), style: { top: it.y + 'px', height: it.h + 'px' },
        attrs: { role: 'button', tabindex: '0', title: g.key + ' — ' + g.spanCount + ' spans · active ' + U.fmtMs(g.activeTime) + ' · self ' + U.fmtMs(g.selfTime) + '\nClick to focus · Shift/⌘-click to add' },
        on: {
          click: (e) => api.selectGroup(g.key, { additive: e.shiftKey || e.metaKey || e.ctrlKey }),
          keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.selectGroup(g.key, { additive: e.shiftKey }); } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') toggleLane(g.key); },
        },
      }, el('div', { class: 'tl-lane-head' }, caret, el('span', { class: 'tl-lane-name tv-ellipsis' }, g.label || g.key), meta));
    }

    function spanLabel(it) {
      const s = it.span;
      const cls = ['tl-srow'];
      if (s.id === state.selectedSpanId) cls.push('is-selected');
      if (!store.matches(s)) cls.push('is-dimmed');
      return el('div', {
        class: cls.join(' '), style: { top: it.y + 'px', height: it.h + 'px', paddingLeft: (26 + it.depth * INDENT) + 'px' },
        attrs: { title: s.name + ' · ' + U.fmtMs(s.duration) },
        on: {
          click: () => api.selectSpan(s.id),
          mouseenter: () => setHover(s),
          mouseleave: () => setHover(null),
        },
      },
      el('span', { class: 'tv-dot ' + U.catClass(s.category) }),
      s.isError ? el('span', { class: 'tl-err-dot' }, '!') : null,
      el('span', { class: 'tl-srow-name tv-ellipsis' }, s.name));
    }

    function toggleLane(key) {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      relayout(); scheduleDraw();
    }
    function toggleExpandAll() {
      if (!model) return;
      if (expanded.size >= model.groups.length) expanded.clear();
      else expanded = new Set(model.groups.map((g) => g.key));
      relayout(); scheduleDraw();
    }
    function updateExpandBtn() {
      expandBtn.textContent = model && expanded.size >= model.groups.length ? 'Collapse all' : 'Expand all';
    }
    function setOrder(id) {
      order = id;
      for (const o of ORDERS) segBtns[o.id].setAttribute('aria-pressed', o.id === id ? 'true' : 'false');
      relayout(); scheduleDraw();
    }

    // ------------------------------------------------------------------ hit testing
    function hitSpan(x, y) {
      const li = laneIndexAt(y);
      if (li < 0) return null;
      const lane = lanes[li];
      if (y > lane.y + lane.h) return null;
      let best = null, bestD = Infinity;
      for (let ri = 0; ri < lane.rows.length; ri++) {
        const ry = lane.rowTop[ri];
        const pad = lane.expanded ? (E_ROW - E_BAR) / 2 : 1.5;
        if (y < ry - pad || y > ry + lane.barH + pad) continue;
        for (const s of lane.rows[ri]) {
          const x0 = X(s.start), x1 = Math.max(x0 + 1, X(s.end));
          if (x < x0 - 3 || x > x1 + 3) continue;
          const d = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
          if (d < bestD || (d === bestD && best && s.duration < best.duration)) { best = s; bestD = d; }
        }
      }
      return best;
    }
    function hitSeg(x) {
      const j = state.journey;
      if (!j) return null;
      for (const seg of j.segments) {
        const x0 = X(seg.start), x1 = Math.max(x0 + 2, X(seg.end));
        if (x >= x0 - 1 && x <= x1 + 1) return seg;
      }
      return null;
    }

    function spanTip(s) {
      const rows = [s.name, ['service', s.group], ['duration', U.fmtMs(s.duration)], ['start', U.fmtOffset(s.start)], ['self time', U.fmtMs(s.selfTime)]];
      const summary = s.op && s.op.summary;
      rows.push(summary && summary !== s.name ? [catLabel(s.category), summary] : ['category', catLabel(s.category)]);
      if (s.hopIn) rows.push(['from ' + s.hopIn.from, U.hopTypeLabel(s.hopIn.type) + (s.hopIn.async ? ' (async)' : '') + ' · latency ' + U.fmtMs(s.hopIn.latency) + (s.hopIn.queue > 0 ? ' · queue ' + U.fmtMs(s.hopIn.queue) : '')]);
      if (s.isError) rows.push(['status', 'error' + (s.statusMessage ? ': ' + U.truncateMiddle(s.statusMessage, 120) : '')]);
      if (chainIds.has(s.id)) rows.push(['', 'On the journey path']);
      return rows;
    }
    function segTip(seg) {
      if (seg.type === 'work') {
        return ['Work · ' + seg.group, ['span', seg.span.name], ['duration', U.fmtMs(seg.duration)], ['start', U.fmtOffset(seg.start)],
          seg.label && seg.label !== seg.span.name ? [catLabel(seg.span.category), seg.label] : null];
      }
      const to = seg.toSpan ? seg.toSpan.group : seg.group;
      if (seg.type === 'transit') {
        return ['Queue / transport', ['duration', U.fmtMs(seg.duration)], ['hop', seg.span.group + ' → ' + to],
          seg.label ? [U.hopTypeLabel(seg.hopType) || 'via', seg.label] : null, ['start', U.fmtOffset(seg.start)]];
      }
      return ['In-service wait · ' + seg.group, ['duration', U.fmtMs(seg.duration)], ['until', seg.toSpan ? seg.toSpan.name : ''],
        seg.label ? [U.hopTypeLabel(seg.hopType) || 'via', seg.label] : null, ['start', U.fmtOffset(seg.start)]];
    }

    function setHover(s) {
      if (hoverSpan === s) return;
      hoverSpan = s;
      const id = s ? s.id : null;
      if (store.get().hoverSpanId !== id) store.set({ hoverSpanId: id });
      scheduleDraw();
    }

    // ------------------------------------------------------------------ interactions
    function chartXY(e, elem) {
      const rc = elem.getBoundingClientRect();
      return [e.clientX - rc.left, e.clientY - rc.top];
    }

    let drag = null;
    listen(canvas, 'pointerdown', (e) => {
      if (e.button !== 0 || !model) return;
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, scroll: body.scrollTop };
      canvas.setPointerCapture(e.pointerId);
    });
    listen(canvas, 'pointermove', (e) => {
      if (!model) return;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) {
          drag.moved = true; canvas.classList.add('is-panning'); U.tooltip.hide(); setHover(null);
        }
        if (drag.moved) {
          panBy(-dx);
          body.scrollTop -= dy;
          drag.x = e.clientX; drag.y = e.clientY;
        }
        return;
      }
      const [x, y] = chartXY(e, canvas);
      const s = hitSpan(x, y + body.scrollTop);
      setHover(s);
      if (s) U.tooltip.show(e.clientX, e.clientY, spanTip(s)); else U.tooltip.hide();
      canvas.style.cursor = s ? 'pointer' : '';
    });
    listen(canvas, 'pointerup', (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      canvas.classList.remove('is-panning');
      if (moved) { pushWin(true); return; }
      const [x, y] = chartXY(e, canvas);
      const s = hitSpan(x, y + body.scrollTop);
      if (s) api.selectSpan(s.id);
    });
    listen(canvas, 'pointercancel', () => { drag = null; canvas.classList.remove('is-panning'); });
    listen(canvas, 'pointerleave', () => { if (!drag) { setHover(null); U.tooltip.hide(); } });
    listen(canvas, 'dblclick', () => setWin(null, true));

    listen(jCanvas, 'pointermove', (e) => {
      const [x] = chartXY(e, jCanvas);
      const seg = hitSeg(x);
      if (seg !== hoverSeg) { hoverSeg = seg; scheduleDraw(); }
      jCanvas.style.cursor = seg ? 'pointer' : '';
      if (seg) U.tooltip.show(e.clientX, e.clientY, segTip(seg)); else U.tooltip.hide();
      const target = seg ? (seg.type === 'work' ? seg.span : seg.toSpan) : null;
      setHover(target || null);
    });
    listen(jCanvas, 'pointerleave', () => { hoverSeg = null; U.tooltip.hide(); setHover(null); scheduleDraw(); });
    listen(jCanvas, 'click', (e) => {
      const [x] = chartXY(e, jCanvas);
      const seg = hitSeg(x);
      if (!seg) return;
      const target = seg.type === 'work' ? seg.span : (seg.toSpan || seg.span);
      api.selectSpan(target.id);
      revealSpan(target);
    });
    listen(jCanvas, 'dblclick', () => setWin(null, true));

    listen(root, 'wheel', (e) => {
      if (!model || chartW <= 0) return;
      const rc = canvas.getBoundingClientRect();
      const x = e.clientX - rc.left;
      const overChart = x >= 0 && x <= chartW && !toolbar.contains(e.target);
      if (!overChart) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? bodyH : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const dy = Math.max(-120, Math.min(120, e.deltaY * unit));
        zoomAt(x, Math.exp(dy * 0.005));
      } else if (win && (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) {
        e.preventDefault();
        panBy((e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit);
      }
    }, { passive: false });

    // minimap brush
    let mdrag = null;
    listen(mini, 'pointerdown', (e) => {
      if (e.button !== 0 || !model) return;
      const [x] = chartXY(e, mini);
      const d = dur();
      const t = Math.max(0, Math.min(d, x / chartW * d));
      const w = curWin();
      let mode = 'new';
      if (e.target === brushHL) mode = 'l';
      else if (e.target === brushHR) mode = 'r';
      else if (e.target === brush && win) mode = 'move';
      mdrag = { mode, t0: t, w0: w.slice(), moved: false };
      mini.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    listen(mini, 'pointermove', (e) => {
      if (!mdrag) return;
      const [x] = chartXY(e, mini);
      const d = dur();
      const t = Math.max(0, Math.min(d, x / chartW * d));
      if (Math.abs(t - mdrag.t0) / d * chartW > 2) mdrag.moved = true;
      if (!mdrag.moved) return;
      const w0 = mdrag.w0;
      if (mdrag.mode === 'new') setWin([Math.min(mdrag.t0, t), Math.max(mdrag.t0, t)]);
      else if (mdrag.mode === 'l') setWin([Math.min(t, w0[1]), w0[1]]);
      else if (mdrag.mode === 'r') setWin([w0[0], Math.max(t, w0[0])]);
      else { const dt = t - mdrag.t0; setWin([w0[0] + dt, w0[1] + dt]); }
    });
    listen(mini, 'pointerup', (e) => {
      if (!mdrag) return;
      const m = mdrag; mdrag = null;
      if (m.moved) { pushWin(true); return; }
      if (win && m.mode === 'new') {
        const half = (win[1] - win[0]) / 2;
        setWin([m.t0 - half, m.t0 + half], true);
      }
    });
    listen(mini, 'dblclick', () => setWin(null, true));

    // gutter resize
    let rdrag = null;
    listen(resizer, 'pointerdown', (e) => { rdrag = { x: e.clientX, w: gutterW }; resizer.setPointerCapture(e.pointerId); e.preventDefault(); });
    listen(resizer, 'pointermove', (e) => {
      if (!rdrag) return;
      gutterW = Math.max(GUTTER_MIN, Math.min(GUTTER_MAX, rdrag.w + e.clientX - rdrag.x));
      axisKey = ''; density = null; scheduleDraw();
    });
    listen(resizer, 'pointerup', () => { rdrag = null; });

    listen(body, 'scroll', scheduleDraw, { passive: true });

    const ro = new ResizeObserver(() => { axisKey = ''; scheduleDraw(); });
    ro.observe(body);
    cleanups.push(() => ro.disconnect());

    const mo = new MutationObserver(() => { readColors(); axisKey = ''; });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    cleanups.push(() => mo.disconnect());
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq) {
      const onMq = () => readColors();
      if (mq.addEventListener) mq.addEventListener('change', onMq); else mq.addListener(onMq);
      cleanups.push(() => { if (mq.removeEventListener) mq.removeEventListener('change', onMq); else mq.removeListener(onMq); });
    }

    function revealSpan(s) {
      if (!s || !spanBarH || !spanBarH[s.index]) return;
      const y = spanY[s.index];
      const vh = body.clientHeight;
      if (vh && (y < body.scrollTop + 8 || y + spanBarH[s.index] > body.scrollTop + vh - 8)) body.scrollTop = Math.max(0, y - vh / 3);
      if (win && (s.end < win[0] || s.start > win[1])) {
        const half = (win[1] - win[0]) / 2, mid = (s.start + s.end) / 2;
        setWin([mid - half, mid + half], true);
      }
    }

    // ------------------------------------------------------------------ update
    function update(st, changed) {
      state = st;
      const all = changed.has('*');
      if (all || changed.has('model')) {
        if (model !== st.model) { expanded = new Set(); hoverSpan = null; hoverSeg = null; }
        model = st.model;
        win = st.timeWindow ? st.timeWindow.slice() : null;
        lastPushed = undefined;
        density = null; axisKey = '';
        computeChain(); computeSelection(); relayout();
      } else {
        if (changed.has('journey')) { computeChain(); if (order === 'journey') relayout(); }
        if (changed.has('groupBy') && !changed.has('model')) relayout();
      }
      if (!all && changed.has('timeWindow') && !sameWin(st.timeWindow, lastPushed) && !sameWin(st.timeWindow, win)) {
        win = st.timeWindow ? st.timeWindow.slice() : null;
        axisKey = '';
      }
      if (all || changed.has('selectedSpanId')) {
        computeSelection();
        const s = model && st.selectedSpanId ? model.byId.get(st.selectedSpanId) : null;
        if (s) requestAnimationFrame(() => revealSpan(s));
      }
      if (changed.has('theme')) readColors();
      if (changed.has('hoverSpanId') && hoverSpan && hoverSpan.id !== st.hoverSpanId) hoverSpan = null;
      if (all || changed.has('view')) axisKey = '';
      scheduleDraw();
    }

    readColors();
    return {
      update,
      destroy() {
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        clearTimeout(pushTimer);
        for (const fn of cleanups) fn();
        U.tooltip.hide();
        root.remove();
      },
    };
  }

  TV.views.register({ id: 'timeline', title: 'Timeline', order: 2, slot: 'main', shortcut: '2', mount });
})(globalThis.TV = globalThis.TV || {});
