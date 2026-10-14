(function (TV) {
  'use strict';

  const KIND_BY_NUM = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
  const KINDS = new Set(KIND_BY_NUM);
  const MAX_DEPTH = 8;

  // Quote integer nanosecond timestamps before JSON.parse so BigInt keeps full precision.
  const TS_RE = /"((?:start|end)TimeUnixNano|timeUnixNano|(?:start|end)_time_unix_nano|time_unix_nano)"(\s*:\s*)(-?\d+)(?=\s*[,}\]])/g;

  // ---------------------------------------------------------------- values

  function intVal(x) {
    if (typeof x === 'number') return x;
    if (typeof x === 'bigint') return Number(x) <= Number.MAX_SAFE_INTEGER && Number(x) >= -Number.MAX_SAFE_INTEGER ? Number(x) : String(x);
    if (typeof x === 'string') {
      const n = Number(x);
      if (!isFinite(n)) return x;
      return Math.abs(n) > Number.MAX_SAFE_INTEGER ? x : n;
    }
    return x == null ? null : x;
  }

  function anyValue(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object') return v;
    if ('stringValue' in v) return v.stringValue == null ? null : String(v.stringValue);
    if ('intValue' in v) return intVal(v.intValue);
    if ('doubleValue' in v) return v.doubleValue == null ? null : Number(v.doubleValue);
    if ('boolValue' in v) return v.boolValue === true || v.boolValue === 'true';
    if ('bytesValue' in v) return v.bytesValue == null ? null : String(v.bytesValue);
    if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(anyValue);
    if ('kvlistValue' in v) return attrsToObj((v.kvlistValue && v.kvlistValue.values) || []);
    return null;
  }

  // Untrusted keys: never let "__proto__" & co. touch the prototype chain.
  function setOwn(obj, key, value) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
    } else obj[key] = value;
  }

  function attrsToObj(list) {
    const out = {};
    if (Array.isArray(list)) {
      for (const kv of list) {
        if (!kv || kv.key == null) continue;
        setOwn(out, String(kv.key), anyValue(kv.value));
      }
    } else if (list && typeof list === 'object') {
      for (const k of Object.keys(list)) setOwn(out, k, list[k]);
    }
    return out;
  }

  function jaegerTagValue(t) {
    const type = String(t.type || '').toLowerCase();
    const v = t.value;
    if (type === 'bool') return v === true || v === 'true';
    if (type === 'int64') return intVal(v);
    if (type === 'float64') return Number(v);
    if (type === 'string' || type === 'binary') return v == null ? null : String(v);
    return v === undefined ? null : v;
  }

  function tagsToObj(tags) {
    const out = {};
    if (!Array.isArray(tags)) return out;
    for (const t of tags) if (t && t.key != null) setOwn(out, String(t.key), jaegerTagValue(t));
    return out;
  }

  // ---------------------------------------------------------------- ids

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function b64ToHex(s) {
    const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    let bits = 0, acc = 0, hex = '';
    for (const ch of clean) {
      const v = B64.indexOf(ch);
      if (v < 0) return null;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        hex += ((acc >> bits) & 0xff).toString(16).padStart(2, '0');
      }
    }
    return hex;
  }

  function normId(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    let id;
    if (/^[0-9a-f]+$/i.test(s) && (s.length === 16 || s.length === 32)) id = s.toLowerCase();
    else {
      const hex = /^[A-Za-z0-9+/_-]+={0,2}$/.test(s) ? b64ToHex(s) : null;
      if (hex && (hex.length === 16 || hex.length === 32)) id = hex;
      else if (/^[0-9a-f]+$/i.test(s)) id = s.toLowerCase().padStart(s.length <= 16 ? 16 : 32, '0');
      else id = s;
    }
    return /^0+$/.test(id) ? '' : id;
  }

  // ---------------------------------------------------------------- time

  function toNs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return isFinite(v) ? BigInt(Math.round(v)) : null;
    if (typeof v === 'string') {
      const t = v.trim();
      if (/^-?\d+$/.test(t)) return BigInt(t);
      const n = Number(t);
      return t && isFinite(n) ? BigInt(Math.round(n)) : null;
    }
    return null;
  }

  function usToNs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim()) * 1000n;
    const n = Number(v);
    if (!isFinite(n)) return null;
    const whole = Math.trunc(n);
    return BigInt(whole) * 1000n + BigInt(Math.round((n - whole) * 1000));
  }

  // ---------------------------------------------------------------- enums

  function normKind(k) {
    if (typeof k === 'number') return KIND_BY_NUM[k] || 'unspecified';
    if (typeof k === 'string') {
      const s = k.trim().toLowerCase().replace(/^span_kind_/, '');
      if (/^\d+$/.test(s)) return KIND_BY_NUM[+s] || 'unspecified';
      return KINDS.has(s) ? s : 'unspecified';
    }
    return 'unspecified';
  }

  function normStatusCode(c) {
    if (c == null || c === '') return 'unset';
    if (typeof c === 'number') return c === 2 ? 'error' : c === 1 ? 'ok' : 'unset';
    const s = String(c).trim().toUpperCase().replace(/^STATUS_CODE_/, '');
    if (s === '2' || s === 'ERROR') return 'error';
    if (s === '1' || s === 'OK') return 'ok';
    return 'unset';
  }

  function finishStatus(code, message, attrs) {
    if (attrs.error === true || attrs['otel.status_code'] === 'ERROR') code = 'error';
    if (!message && code === 'error') {
      const d = attrs['otel.status_description'];
      if (typeof d === 'string') message = d;
    }
    return { code, message: message == null ? '' : String(message) };
  }

  // ---------------------------------------------------------------- readers

  function pick(o, ...keys) {
    for (const k of keys) if (o[k] !== undefined) return o[k];
    return undefined;
  }

  function readOtlpSpan(s, resource, scope, ctx) {
    if (!s || typeof s !== 'object') return;
    const spanId = normId(pick(s, 'spanId', 'span_id'));
    if (!spanId) { ctx.count('Skipped span(s) without a valid spanId'); return; }
    const attrs = attrsToObj(s.attributes);
    const st = s.status || {};
    const events = (Array.isArray(s.events) ? s.events : []).map((e) => ({
      timeNs: toNs(pick(e || {}, 'timeUnixNano', 'time_unix_nano')),
      name: String((e && e.name) == null ? '' : e.name),
      attrs: attrsToObj(e && e.attributes),
    }));
    const links = (Array.isArray(s.links) ? s.links : []).map((l) => ({
      traceId: normId(pick(l || {}, 'traceId', 'trace_id')),
      spanId: normId(pick(l || {}, 'spanId', 'span_id')),
      attrs: attrsToObj(l && l.attributes),
    }));
    ctx.spans.push({
      traceId: normId(pick(s, 'traceId', 'trace_id')),
      spanId,
      parentSpanId: normId(pick(s, 'parentSpanId', 'parent_span_id')),
      name: s.name == null ? '' : String(s.name),
      kind: normKind(s.kind),
      startNs: toNs(pick(s, 'startTimeUnixNano', 'start_time_unix_nano')),
      endNs: toNs(pick(s, 'endTimeUnixNano', 'end_time_unix_nano')),
      status: finishStatus(normStatusCode(st.code), st.message, attrs),
      attrs, resource, scope, events, links,
    });
  }

  function readResourceSpans(rs, ctx) {
    if (!rs || typeof rs !== 'object') return;
    const resource = attrsToObj(rs.resource && rs.resource.attributes);
    const groups = pick(rs, 'scopeSpans', 'instrumentationLibrarySpans', 'scope_spans', 'instrumentation_library_spans');
    if (!Array.isArray(groups)) return;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const lib = pick(g, 'scope', 'instrumentationLibrary', 'instrumentation_library') || {};
      const scope = { name: lib.name == null ? '' : String(lib.name), version: lib.version == null ? '' : String(lib.version) };
      for (const s of Array.isArray(g.spans) ? g.spans : []) readOtlpSpan(s, resource, scope, ctx);
    }
  }

  function readJaegerTrace(t, ctx) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.spans)) return;
    const procs = t.processes && typeof t.processes === 'object' ? t.processes : {};
    const resCache = new Map();
    const resourceFor = (pid, inline) => {
      if (!inline && resCache.has(pid)) return resCache.get(pid);
      const p = inline || procs[pid] || {};
      const r = tagsToObj(p.tags);
      if (p.serviceName != null) r['service.name'] = String(p.serviceName);
      if (!inline) resCache.set(pid, r);
      return r;
    };
    for (const s of t.spans) {
      if (!s || typeof s !== 'object') continue;
      const spanId = normId(s.spanID);
      if (!spanId) { ctx.count('Skipped span(s) without a valid spanID'); continue; }
      const attrs = tagsToObj(s.tags);
      const refs = Array.isArray(s.references) ? s.references : [];
      let parentRef = refs.find((r) => r && String(r.refType).toUpperCase() === 'CHILD_OF');
      if (!parentRef) parentRef = refs.find((r) => r && String(r.refType).toUpperCase() === 'FOLLOWS_FROM');
      let parentSpanId = parentRef ? normId(parentRef.spanID) : '';
      if (!parentRef && s.parentSpanID) parentSpanId = normId(s.parentSpanID);
      const links = refs.filter((r) => r && r !== parentRef).map((r) => ({
        traceId: normId(r.traceID), spanId: normId(r.spanID), attrs: { refType: String(r.refType || '') },
      }));
      const startNs = usToNs(s.startTime);
      const durNs = usToNs(s.duration);
      const events = (Array.isArray(s.logs) ? s.logs : []).map((lg) => {
        const fields = tagsToObj(lg && lg.fields);
        const nm = fields.event != null ? fields.event : fields.message != null ? fields.message : 'log';
        return { timeNs: usToNs(lg && lg.timestamp), name: String(nm), attrs: fields };
      });
      let code = 'unset';
      const otelCode = attrs['otel.status_code'];
      if (attrs.error === true || attrs.error === 'true' || otelCode === 'ERROR') code = 'error';
      else if (otelCode === 'OK') code = 'ok';
      if (Array.isArray(s.warnings)) for (const w of s.warnings) ctx.count('Jaeger: ' + String(w));
      ctx.spans.push({
        traceId: normId(s.traceID || t.traceID),
        spanId,
        parentSpanId,
        name: s.operationName == null ? '' : String(s.operationName),
        kind: normKind(attrs['span.kind']),
        startNs,
        endNs: startNs != null && durNs != null ? startNs + durNs : null,
        status: finishStatus(code, attrs['otel.status_description'], attrs),
        attrs,
        resource: resourceFor(s.processID, s.process && !procs[s.processID] ? s.process : null),
        scope: {
          name: String(attrs['otel.scope.name'] || attrs['otel.library.name'] || ''),
          version: String(attrs['otel.scope.version'] || attrs['otel.library.version'] || ''),
        },
        events,
        links,
      });
    }
  }

  function collect(node, ctx, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, ctx, depth + 1);
      return;
    }
    let hit = false;
    const rsList = pick(node, 'batches', 'resourceSpans', 'resource_spans');
    if (Array.isArray(rsList)) {
      hit = true;
      ctx.formats.add('otlp');
      for (const rs of rsList) readResourceSpans(rs, ctx);
    }
    if (!hit && (Array.isArray(node.scopeSpans) || Array.isArray(node.instrumentationLibrarySpans) ||
      Array.isArray(node.scope_spans) || Array.isArray(node.instrumentation_library_spans))) {
      hit = true;
      ctx.formats.add('otlp');
      readResourceSpans(node, ctx);
    }
    if (Array.isArray(node.data) && node.data.some((d) => d && Array.isArray(d.spans))) {
      hit = true;
      ctx.formats.add('jaeger');
      for (const d of node.data) readJaegerTrace(d, ctx);
    }
    if (!hit && Array.isArray(node.spans) && (node.traceID || node.processes)) {
      hit = true;
      ctx.formats.add('jaeger');
      readJaegerTrace(node, ctx);
    }
    if (!hit && node.trace && typeof node.trace === 'object') collect(node.trace, ctx, depth + 1);
  }

  function describe(json) {
    if (Array.isArray(json)) return `Found a top-level array with ${json.length} item(s).`;
    const keys = Object.keys(json).slice(0, 8);
    return keys.length ? `Found top-level keys: ${keys.join(', ')}.` : 'Found an empty object.';
  }

  // ---------------------------------------------------------------- main

  function parse(input, opts) {
    void opts;
    let json = input;
    if (typeof input === 'string') {
      const text = input.replace(/^﻿/, '').trim();
      if (!text) throw new Error('The input is empty — expected a trace JSON export.');
      try {
        json = JSON.parse(text.replace(TS_RE, '"$1"$2"$3"'));
      } catch (e) {
        throw new Error('Could not read the input as JSON: ' + (e && e.message ? e.message : String(e)));
      }
    }
    if (json == null || typeof json !== 'object') {
      throw new Error('Unrecognized trace format: expected a JSON object or array, got ' + (json === null ? 'null' : typeof json) + '.');
    }

    const counts = new Map();
    const ctx = {
      spans: [],
      formats: new Set(),
      count(msg) { counts.set(msg, (counts.get(msg) || 0) + 1); },
    };
    collect(json, ctx, 0);

    if (!ctx.formats.size) {
      throw new Error('Unrecognized trace format. Expected OTLP JSON as exported by Grafana Tempo ' +
        '({"batches": [...]} or {"resourceSpans": [...]}) or Jaeger JSON ({"data": [{"spans": [...]}]}). ' + describe(json));
    }
    if (!ctx.spans.length) throw new Error('The trace file contains no spans.');

    const byTrace = new Map();
    for (const s of ctx.spans) {
      const key = s.traceId || '';
      if (!byTrace.has(key)) byTrace.set(key, []);
      byTrace.get(key).push(s);
    }

    const warnings = [];
    const traces = [];
    for (const [traceId, list] of byTrace) {
      const tw = [];
      const seen = new Set();
      const kept = [];
      let dup = 0, noTime = 0, negDur = 0;
      for (const s of list) {
        if (seen.has(s.spanId)) { dup++; continue; }
        if (s.startNs == null) s.startNs = s.endNs;
        if (s.startNs == null) { noTime++; continue; }
        if (s.endNs == null) s.endNs = s.startNs;
        if (s.endNs < s.startNs) { negDur++; s.endNs = s.startNs; }
        seen.add(s.spanId);
        kept.push(s);
      }
      if (dup) tw.push(`${dup} duplicate span id(s) in trace ${traceId || '(no id)'} — kept the first occurrence`);
      if (noTime) tw.push(`${noTime} span(s) without timestamps dropped from trace ${traceId || '(no id)'}`);
      if (negDur) tw.push(`${negDur} span(s) ended before they started (end set to start) in trace ${traceId || '(no id)'}`);
      if (!traceId) tw.push('Some spans had no traceId; they were grouped into one trace');
      if (!kept.length) { warnings.push(...tw); continue; }

      let t0 = kept[0].startNs;
      for (const s of kept) if (s.startNs < t0) t0 = s.startNs;
      const rel = (ns) => Number(ns - t0) / 1e6;

      const spans = kept.map((s) => ({
        traceId: s.traceId || traceId,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        name: s.name,
        kind: s.kind,
        start: rel(s.startNs),
        end: rel(s.endNs),
        startEpochMs: Number(s.startNs) / 1e6,
        status: s.status,
        attrs: s.attrs,
        resource: s.resource,
        scope: s.scope,
        events: s.events.map((e) => ({ time: e.timeNs == null ? rel(s.startNs) : rel(e.timeNs), name: e.name, attrs: e.attrs })),
        links: s.links,
      }));
      warnings.push(...tw);
      traces.push({ traceId, t0Epoch: Number(t0) / 1e6, spans, warnings: tw });
    }
    if (!traces.length) throw new Error('The trace file contains no usable spans (missing ids or timestamps).');

    for (const [msg, n] of counts) warnings.push(n > 1 ? `${msg} (×${n})` : msg);
    traces.sort((a, b) => b.spans.length - a.spans.length);
    const format = ctx.formats.has('otlp') ? 'otlp' : 'jaeger';
    return { format, traces, warnings };
  }

  TV.parse = parse;
  TV.parse.normId = normId;
  TV.parse.anyValue = anyValue;
})(globalThis.TV = globalThis.TV || {});
