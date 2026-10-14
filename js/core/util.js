(function (TV) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------- formatting

  function fmtMs(ms) {
    if (ms == null || typeof ms !== 'number' || !isFinite(ms)) return '–';
    if (ms === 0) return '0 ms';
    const sign = ms < 0 ? '−' : '';
    let a = Math.abs(ms);
    if (a < 1) {
      const us = Math.round(a * 1000);
      if (us < 1000) return sign + us + ' µs';
      a = 1;
    }
    if (a < 100) {
      const v = Math.round(a * 10) / 10;
      if (v < 100) return sign + v.toFixed(1) + ' ms';
      a = 100;
    }
    if (a < 1000) {
      const v = Math.round(a);
      if (v < 1000) return sign + v + ' ms';
      a = 1000;
    }
    const s = a / 1000;
    if (s < 10) return sign + (Math.round(s * 100) / 100).toFixed(2) + ' s';
    if (s < 100) return sign + (Math.round(s * 10) / 10).toFixed(1) + ' s';
    if (s < 600) return sign + Math.round(s) + ' s';
    const m = Math.floor(s / 60);
    return sign + m + 'm ' + String(Math.round(s - m * 60)).padStart(2, '0') + 's';
  }

  function fmtOffset(ms) {
    if (ms == null || typeof ms !== 'number' || !isFinite(ms)) return '–';
    return (ms < 0 ? '−' : '+') + fmtMs(Math.abs(ms));
  }

  function fmtEpoch(epochMs) {
    if (epochMs == null || !isFinite(epochMs)) return '–';
    const d = new Date(epochMs);
    const p2 = (n) => String(n).padStart(2, '0');
    return MONTHS[d.getMonth()] + ' ' + p2(d.getDate()) + ' ' + d.getFullYear() + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' +
      String(d.getMilliseconds()).padStart(3, '0');
  }

  function fmtCount(n) {
    if (n == null || !isFinite(n)) return '–';
    const r = Math.round(n);
    const s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (r < 0 ? '-' : '') + s;
  }

  function pct(part, whole) {
    if (!whole || !isFinite(whole) || !isFinite(part)) return '0%';
    const v = (part / whole) * 100;
    if (v > 0 && v < 1) return '<1%';
    return Math.round(v) + '%';
  }

  // ---------------------------------------------------------------- DOM

  function appendChildren(node, children) {
    for (const c of children) {
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) appendChildren(node, c);
      else if (typeof c === 'object' && typeof c.nodeType === 'number') node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    }
  }

  function isChildLike(v) {
    return v != null && (typeof v !== 'object' || Array.isArray(v) || typeof v.nodeType === 'number');
  }

  function applyProps(node, props, isSvg) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || v === false) continue;
      switch (key) {
        case 'class':
        case 'className': {
          const cls = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
          if (isSvg) node.setAttribute('class', cls); else node.className = cls;
          break;
        }
        case 'style':
          if (typeof v === 'string') node.style.cssText = v;
          else {
            for (const k of Object.keys(v)) {
              if (v[k] == null) continue;
              if (k.startsWith('--') || k.includes('-')) node.style.setProperty(k, String(v[k]));
              else node.style[k] = v[k];
            }
          }
          break;
        case 'dataset':
          for (const k of Object.keys(v)) if (v[k] != null) node.dataset[k] = String(v[k]);
          break;
        case 'attrs':
          for (const k of Object.keys(v)) {
            const a = v[k];
            if (a == null || a === false) continue;
            node.setAttribute(k, a === true ? '' : String(a));
          }
          break;
        case 'on':
          for (const evt of Object.keys(v)) if (typeof v[evt] === 'function') node.addEventListener(evt, v[evt]);
          break;
        case 'text':
          node.textContent = String(v);
          break;
        case 'title':
          if (isSvg) {
            const t = document.createElementNS(SVG_NS, 'title');
            t.textContent = String(v);
            node.appendChild(t);
          } else node.title = String(v);
          break;
        case 'innerHTML':
        case 'outerHTML':
        case 'insertAdjacentHTML':
          break; // never inject markup
        default:
          if (isSvg) node.setAttribute(key, String(v));
          else if (key in node) node[key] = v;
          else node.setAttribute(key, v === true ? '' : String(v));
      }
    }
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (isChildLike(props)) children.unshift(props);
    else if (props) applyProps(node, props, false);
    appendChildren(node, children);
    return node;
  }

  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (isChildLike(attrs)) children.unshift(attrs);
    else if (attrs) applyProps(node, attrs, true);
    appendChildren(node, children);
    return node;
  }

  function clear(node) {
    if (node) node.textContent = '';
    return node;
  }

  // ---------------------------------------------------------------- categories

  const CATEGORIES = [
    { id: 'messaging', label: 'Kafka / messaging' },
    { id: 'db', label: 'Database' },
    { id: 'rpc', label: 'gRPC' },
    { id: 'http', label: 'HTTP' },
    { id: 'internal', label: 'Internal' },
  ];
  const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

  function catClass(cat) {
    return 'cat-' + (CATEGORY_IDS.includes(cat) ? cat : 'internal');
  }

  const HOP_TYPES = [
    { id: 'kafka', label: 'Kafka', category: 'messaging' },
    { id: 'grpc', label: 'gRPC', category: 'rpc' },
    { id: 'http', label: 'HTTP', category: 'http' },
    { id: 'call', label: 'Call', category: 'internal' },
  ];

  function hopCategory(type) {
    const t = HOP_TYPES.find((h) => h.id === type);
    return t ? t.category : 'internal';
  }

  function hopTypeLabel(type) {
    const t = HOP_TYPES.find((h) => h.id === type);
    return t ? t.label : String(type || '');
  }

  // ---------------------------------------------------------------- intervals & numbers

  function mergeIntervals(list) {
    const items = [];
    for (const iv of list || []) {
      if (!iv) continue;
      const s = +iv[0], e = +iv[1];
      if (!isFinite(s) || !isFinite(e) || e < s) continue;
      items.push([s, e]);
    }
    items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [];
    for (const iv of items) {
      const last = out[out.length - 1];
      if (last && iv[0] <= last[1]) {
        if (iv[1] > last[1]) last[1] = iv[1];
      } else out.push(iv);
    }
    return out;
  }

  function unionLength(list) {
    let total = 0;
    for (const iv of mergeIntervals(list)) total += iv[1] - iv[0];
    return total;
  }

  function niceTicks(min, max, approxCount) {
    if (!isFinite(min) || !isFinite(max)) return [];
    if (max < min) { const t = min; min = max; max = t; }
    if (max === min) return [min];
    const count = Math.max(1, approxCount || 5);
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    const first = Math.ceil(min / step - 1e-9) * step;
    const ticks = [];
    for (let i = 0, v = first; v <= max + step * 1e-9 && i < 1000; i++, v = first + i * step) {
      ticks.push(Number(v.toFixed(decimals)));
    }
    return ticks;
  }

  function quantile(arr, q) {
    const v = (arr || []).filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return 0;
    const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }

  function median(arr) {
    return quantile(arr, 0.5);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function uniqSorted(list) {
    return Array.from(new Set(list)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ---------------------------------------------------------------- timing helpers

  function debounce(fn, ms) {
    let t = null;
    const d = function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
    d.cancel = () => { if (t) clearTimeout(t); t = null; };
    return d;
  }

  function rafThrottle(fn) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    let handle = null, lastArgs = null, ctx = null;
    const t = function (...args) {
      lastArgs = args;
      ctx = this;
      if (handle != null) return;
      handle = raf(() => { handle = null; fn.apply(ctx, lastArgs); });
    };
    t.cancel = () => { if (handle != null) caf(handle); handle = null; };
    return t;
  }

  // ---------------------------------------------------------------- clipboard

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } finally { ta.remove(); }
    if (!ok) throw new Error('Copy to clipboard failed');
  }

  function copyText(text) {
    const s = String(text == null ? '' : text);
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).catch(() => fallbackCopy(s));
    }
    return new Promise((resolve, reject) => {
      try { fallbackCopy(s); resolve(); } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------- strings

  function truncateMiddle(str, max) {
    const s = String(str == null ? '' : str);
    if (!max || s.length <= max) return s;
    if (max < 5) return s.slice(0, max);
    const keep = max - 1;
    const head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }

  const TOPIC_PREFIXES = [
    /^persistent:\/\/[^/]+\/[^/]+\//i, // pulsar tenant/namespace
    /^(?:[a-z0-9_]+\.){2,}(?=[^.]+$)/i, // dotted package-style prefixes
    /^(?:prod|production|staging|stage|dev|develop|test|qa|sandbox)[._-]/i,
  ];

  function shortTopic(name) {
    let s = String(name == null ? '' : name);
    if (s.length <= 40) return s;
    for (const re of TOPIC_PREFIXES) {
      const next = s.replace(re, '');
      if (next && next !== s) s = next;
    }
    return truncateMiddle(s, 40);
  }

  function shortRpc(service) {
    const s = String(service == null ? '' : service);
    const parts = s.split('.');
    return parts[parts.length - 1] || s;
  }

  // ---------------------------------------------------------------- tooltip

  let tipNode = null;
  let tipPos = { x: 0, y: 0 };

  function ensureTip() {
    if (tipNode && tipNode.isConnected) return tipNode;
    tipNode = document.createElement('div');
    tipNode.className = 'tv-tooltip';
    tipNode.setAttribute('role', 'tooltip');
    tipNode.style.position = 'fixed';
    tipNode.style.pointerEvents = 'none';
    tipNode.style.zIndex = '10000';
    tipNode.style.left = '0px';
    tipNode.style.top = '0px';
    tipNode.style.display = 'none';
    document.body.appendChild(tipNode);
    return tipNode;
  }

  function renderTipContent(node, content) {
    clear(node);
    if (content == null) return;
    if (typeof content === 'object' && typeof content.nodeType === 'number') { node.appendChild(content); return; }
    if (!Array.isArray(content)) { node.appendChild(el('div', { class: 'tv-tt-title' }, String(content))); return; }
    for (const row of content) {
      if (row == null || row === false) continue;
      if (Array.isArray(row)) {
        const label = row[0], value = row[1];
        node.appendChild(el('div', { class: 'tv-tt-row' },
          el('span', { class: 'tv-tt-value' }, value == null ? '–' : value),
          label == null || label === '' ? null : el('span', { class: 'tv-tt-label' }, label)));
      } else if (typeof row === 'object' && typeof row.nodeType === 'number') {
        node.appendChild(row);
      } else {
        node.appendChild(el('div', { class: 'tv-tt-title' }, String(row)));
      }
    }
  }

  function placeTip(x, y) {
    if (!tipNode) return;
    tipPos = { x, y };
    const pad = 12;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
    const w = tipNode.offsetWidth, h = tipNode.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > vw - 4) left = Math.max(4, x - pad - w);
    if (top + h > vh - 4) top = Math.max(4, y - pad - h);
    tipNode.style.left = Math.round(left) + 'px';
    tipNode.style.top = Math.round(top) + 'px';
  }

  const tooltip = {
    show(clientX, clientY, content) {
      const n = ensureTip();
      renderTipContent(n, content);
      n.style.display = 'block';
      placeTip(clientX, clientY);
    },
    move(clientX, clientY) {
      if (!tipNode || tipNode.style.display === 'none') return;
      placeTip(clientX, clientY);
    },
    hide() {
      if (tipNode) tipNode.style.display = 'none';
    },
    get visible() {
      return !!(tipNode && tipNode.style.display !== 'none');
    },
    get position() {
      return tipPos;
    },
  };

  function statusIcon(status) {
    const isError = status === 'error' || (status && typeof status === 'object' && (status.isError || status.status === 'error' || status.code === 'error'));
    if (!isError) return document.createDocumentFragment();
    return el('span', {
      class: 'tv-status-icon tv-status-critical',
      title: 'Error',
      attrs: { 'aria-label': 'Error', role: 'img' },
      style: 'display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;' +
        'border-radius:50%;background:var(--status-critical,#d03b3b);color:#fff;font-size:10px;' +
        'font-weight:700;line-height:1;flex:none;vertical-align:middle',
    }, '!');
  }

  TV.util = {
    fmtMs, fmtOffset, fmtEpoch, fmtCount, pct,
    el, svg, clear, SVG_NS,
    CATEGORIES, CATEGORY_IDS, catClass, HOP_TYPES, hopCategory, hopTypeLabel,
    mergeIntervals, unionLength, niceTicks, median, quantile, clamp, uniqSorted,
    debounce, rafThrottle, copyText,
    truncateMiddle, shortTopic, shortRpc,
    tooltip, statusIcon,
  };
})(globalThis.TV = globalThis.TV || {});
