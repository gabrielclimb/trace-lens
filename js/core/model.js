(function (TV) {
  'use strict';

  const GROUPINGS = [
    { id: 'service', label: 'Service' },
    { id: 'namespace', label: 'Namespace' },
    { id: 'scope', label: 'Deploy scope' },
  ];
  const CATS = ['messaging', 'db', 'rpc', 'http', 'internal'];
  const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
  const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);
  const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f]*:[0-9a-f:]+$/i;

  const util = () => TV.util;
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));
  const first = (...vals) => {
    for (const v of vals) if (v != null && v !== '') return v;
    return undefined;
  };
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sortedUniq = (list) => Array.from(new Set(list.filter((x) => x != null && x !== ''))).sort(cmpStr);

  function fmt(ms) {
    return util() && util().fmtMs ? util().fmtMs(ms) : (Math.round(ms * 10) / 10) + ' ms';
  }
  function fmt1(ms) {
    if (ms >= 1000) return fmt(ms);
    return (Math.round(ms * 10) / 10).toFixed(1) + ' ms';
  }

  // ---------------------------------------------------------------- grouping

  function groupKeyOf(span, groupBy) {
    if (groupBy === 'namespace') return span.namespace;
    if (groupBy === 'scope') return span.deployScope;
    return span.service;
  }

  // ---------------------------------------------------------------- category & op

  function categoryOf(attrs, kind) {
    const keys = Object.keys(attrs);
    if (keys.some((k) => k.startsWith('db.')) || 'db' in attrs) return 'db';
    if ('rpc.system' in attrs || 'rpc.service' in attrs) return 'rpc';
    if ('http.request.method' in attrs || 'http.method' in attrs || 'url.full' in attrs || 'http.url' in attrs ||
      'http.route' in attrs || 'http.target' in attrs) return 'http';
    if (keys.some((k) => k.startsWith('messaging.')) || kind === 'producer' || kind === 'consumer' || 'topic' in attrs) return 'messaging';
    return 'internal';
  }

  function urlPath(u) {
    const s = str(u);
    if (!s) return '';
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(s);
    const p = m ? m[1] : s.split(/[?#]/)[0];
    return p || (m ? '/' : '');
  }

  function urlHost(u) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(str(u));
    return m ? m[1] : '';
  }

  const NAME_TOPIC_RE = /^(.+?) (send|publish|process|receive)$/;
  const PRODUCER_OPS = new Set(['publish', 'send', 'create', 'produce']);

  function messagingOp(span) {
    const a = span.attrs;
    const nameMatch = NAME_TOPIC_RE.exec(span.name);
    const destination = str(first(a['messaging.destination.name'], a['messaging.destination'], a['messaging.source.name'],
      a.topic, nameMatch && nameMatch[1]));
    const operation = str(first(a['messaging.operation'], a['messaging.operation.name'], a['messaging.operation.type'],
      nameMatch && nameMatch[2]));
    let role;
    if (span.kind === 'producer') role = 'producer';
    else if (span.kind === 'consumer') role = 'consumer';
    else role = PRODUCER_OPS.has(operation.toLowerCase()) ? 'producer' : 'consumer';
    const op = {
      system: str(a['messaging.system']),
      destination,
      operation: operation || (role === 'producer' ? 'publish' : 'process'),
      role,
      partition: first(a['messaging.kafka.partition'], a['messaging.kafka.destination.partition'],
        a['messaging.destination.partition.id'], a['messaging.partition'], a['kafka.message.partition'], a.partition,
        a['messaging.kafka.source.partition']),
      offset: first(a['messaging.kafka.message.offset'], a['messaging.kafka.offset'], a['messaging.offset'],
        a['kafka.message.offset'], a.offset),
      consumerGroup: str(first(a['messaging.kafka.consumer.group'], a['messaging.consumer.group.name'],
        a['messaging.kafka.consumer_group'])),
      key: first(a['messaging.kafka.message.key'], a['messaging.kafka.message_key'], a.key),
      summary: '',
    };
    if (op.partition === undefined) op.partition = null;
    if (op.offset === undefined) op.offset = null;
    if (op.key === undefined) op.key = null;
    op.summary = messagingSummary(op, span);
    return op;
  }

  function messagingSummary(op, span) {
    if (!op.destination) return op.operation + ' · ' + span.name;
    return op.operation + (op.role === 'producer' ? ' → ' : ' ← ') + op.destination;
  }

  function dbOp(span) {
    const a = span.attrs;
    const statement = str(first(a['db.statement'], a['db.query.text']));
    const name = str(first(a['db.name'], a['db.namespace'], typeof a.db === 'string' ? a.db : undefined));
    let operation = str(first(a['db.operation'], a['db.operation.name']));
    if (!operation && statement) {
      const m = /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*([a-z]+)/i.exec(statement);
      if (m) operation = m[1].toUpperCase();
    }
    const host = str(first(a['server.address'], a['net.peer.name'], urlHost(a['db.connection_string']),
      a['network.peer.address'], a['net.peer.ip']));
    const op = {
      system: str(first(a['db.system'], a['db.system.name'])),
      name,
      table: str(first(a['db.sql.table'], a['db.collection.name'], a['db.mongodb.collection'], a['db.cassandra.table'])),
      operation,
      statement,
      host,
      summary: '',
    };
    const tableDisplay = op.table && !op.table.includes('.') && op.name ? op.name + '.' + op.table : op.table;
    if (op.operation || tableDisplay) op.summary = [op.system || 'db', op.operation, tableDisplay || op.name].filter(Boolean).join(' ');
    else op.summary = [op.system || 'db', op.name].filter(Boolean).join(' ') + ' · ' + span.name;
    return op;
  }

  function rpcOp(span) {
    const a = span.attrs;
    const op = {
      system: str(a['rpc.system']),
      service: str(a['rpc.service']),
      method: str(a['rpc.method']),
      grpcStatus: first(a['rpc.grpc.status_code'], a['rpc.response.status_code']),
      summary: '',
    };
    if (op.grpcStatus === undefined) op.grpcStatus = null;
    const svc = util().shortRpc(op.service);
    op.summary = [op.system, svc + (op.method ? '/' + op.method : '')].filter(Boolean).join(' ') || span.name;
    return op;
  }

  function methodFromName(name) {
    const m = /^(?:http\s+)?([a-z]+)\b/i.exec(str(name));
    const v = m ? m[1].toUpperCase() : '';
    return HTTP_METHODS.has(v) ? v : '';
  }

  function httpOp(span) {
    const a = span.attrs;
    const url = str(first(a['url.full'], a['http.url']));
    const methodAttr = str(a.method).toUpperCase();
    const op = {
      method: str(first(a['http.request.method'], a['http.method'], HTTP_METHODS.has(methodAttr) ? methodAttr : undefined,
        methodFromName(span.name))).toUpperCase(),
      route: str(a['http.route']),
      url,
      statusCode: first(a['http.response.status_code'], a['http.status_code']),
      host: str(first(a['server.address'], a['http.host'], a['net.peer.name'], urlHost(url))),
      summary: '',
    };
    if (op.statusCode === undefined) op.statusCode = null;
    const path = op.route || httpPathOf(span) || url;
    op.summary = [op.method, path].filter(Boolean).join(' ') + (op.statusCode != null ? ' → ' + op.statusCode : '');
    if (!op.summary.trim()) op.summary = span.name;
    return op;
  }

  function httpRoute(s) { return str(s.attrs['http.route']); }
  function httpPathOf(s) {
    const a = s.attrs;
    return str(first(a['url.path'], a['http.target'] != null ? str(a['http.target']).split(/[?#]/)[0] : undefined));
  }
  function httpUrlPath(s) { return urlPath(first(s.attrs['url.full'], s.attrs['http.url'])); }

  function computeOp(span) {
    switch (span.category) {
      case 'messaging': return messagingOp(span);
      case 'db': return dbOp(span);
      case 'rpc': return rpcOp(span);
      case 'http': return httpOp(span);
      default: return { summary: span.name };
    }
  }

  // ---------------------------------------------------------------- relations

  function isKafkaish(s) {
    if (s.category !== 'messaging') return false;
    const sys = str(s.op.system).toLowerCase();
    return !sys || sys === 'kafka';
  }

  function relationType(p, c) {
    if (p.kind === 'producer' || c.kind === 'consumer' || isKafkaish(p) || isKafkaish(c)) return 'kafka';
    if (p.category === 'rpc' || c.category === 'rpc') return 'grpc';
    if (p.category === 'http' || c.category === 'http') return 'http';
    return 'call';
  }

  function msgDest(s) {
    return s.category === 'messaging' ? str(s.op.destination) : '';
  }

  // Concrete paths (no http.route on either side) get ids templated so edges aggregate:
  // /api/v1/companies/29002a6e-4996-… → /api/v1/companies/{uuid}
  function templatePath(path) {
    return path.split('/').map((seg) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
      if (/^\d+$/.test(seg)) return '{id}';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return '{hex}';
      return seg;
    }).join('/');
  }

  function relationLabel(type, p, c, smart) {
    if (type === 'kafka') return msgDest(p) || msgDest(c);
    if (type === 'grpc') {
      const r = p.category === 'rpc' && (p.op.service || p.op.method) ? p : c;
      const svc = util().shortRpc(str(r.attrs['rpc.service']));
      const method = str(r.attrs['rpc.method']);
      return method ? svc + '/' + method : svc;
    }
    if (type === 'http') {
      const method = (c.category === 'http' && c.op.method) || (p.category === 'http' && p.op.method) || '';
      const route = httpRoute(c) || httpRoute(p);
      let path = route || httpPathOf(c) || httpPathOf(p) || httpUrlPath(c) || httpUrlPath(p);
      if (smart && !route && path) path = templatePath(path);
      return [method, path].filter(Boolean).join(' ');
    }
    return c.name;
  }

  function isAsync(type, p, c) {
    return type === 'kafka' || c.start >= p.end;
  }

  // ---------------------------------------------------------------- self time

  function selfTimeOf(s) {
    if (!s.children.length) return s.duration;
    let covered = 0, cs = 0, ce = -Infinity;
    for (const c of s.children) {
      const a = c.start > s.start ? c.start : s.start;
      const b = c.end < s.end ? c.end : s.end;
      if (b <= a) continue;
      if (a > ce) {
        if (ce > -Infinity) covered += ce - cs;
        cs = a; ce = b;
      } else if (b > ce) ce = b;
    }
    if (ce > -Infinity) covered += ce - cs;
    const v = s.duration - covered;
    return v > 0 ? v : 0;
  }

  // ---------------------------------------------------------------- journey

  function defaultJourneyTarget(model) {
    let best = null;
    for (const s of model.spans) {
      if (!best || s.end > best.end || (s.end === best.end && s.start >= best.start)) best = s;
    }
    return best;
  }

  function computeJourney(model, targetSpanId) {
    const warnings = [];
    let target = targetSpanId ? model.byId.get(targetSpanId) : null;
    if (targetSpanId && !target) warnings.push(`Journey target ${targetSpanId} not found; using the latest-ending span`);
    if (!target) target = defaultJourneyTarget(model);
    const empty = { target: target || null, chain: [], segments: [], byGroup: [], transitTotal: 0, workTotal: 0, waitTotal: 0, total: 0, warnings };
    if (!target) return empty;

    const chain = [];
    const seen = new Set();
    for (let s = target; s && !seen.has(s.id); s = s.causalParent) {
      seen.add(s.id);
      chain.push(s);
    }
    chain.reverse();

    const segments = [];
    let cursor = chain[0].start;
    let skew = 0;
    const emit = (type, group, span, toSpan, start, end, label, hop) => {
      if (end < start) { skew += start - end; return; }
      const s = start < cursor ? cursor : start;
      if (end <= s) return;
      segments.push({
        type, group, span, toSpan: toSpan || null, start: s, end, duration: end - s, label: label || '',
        hopType: hop ? hop.type : null, hop: hop || null,
      });
      cursor = end;
    };

    for (let i = 0; i < chain.length - 1; i++) {
      const p = chain[i], c = chain[i + 1];
      if (c.group === p.group) {
        emit('work', p.group, p, null, p.start, c.start, p.op.summary);
        continue;
      }
      let firstChild = c;
      for (const k of p.causalChildren) {
        if (k.group === c.group && k.start < firstChild.start) firstChild = k;
      }
      const hop = firstChild.hopIn;
      const cHop = c.hopIn;
      emit('work', p.group, p, null, p.start, Math.min(p.end, firstChild.start), p.op.summary);
      if (firstChild.start > p.end) {
        emit('transit', p.group, p, firstChild, p.end, firstChild.start, hop ? hop.label : '', hop);
      }
      if (c !== firstChild && c.start > firstChild.start) {
        emit('wait', c.group, firstChild, c, firstChild.start, c.start, cHop ? cHop.label : '', cHop);
      }
    }
    emit('work', target.group, target, null, target.start, target.end, target.op.summary);
    if (skew > 0) warnings.push(`Clock skew on the path: ${fmt(skew)} of negative intervals clamped to 0`);

    const byGroupMap = new Map();
    let transitTotal = 0, workTotal = 0, waitTotal = 0;
    for (const seg of segments) {
      if (seg.type === 'transit') { transitTotal += seg.duration; continue; }
      let g = byGroupMap.get(seg.group);
      if (!g) byGroupMap.set(seg.group, (g = { group: seg.group, work: 0, wait: 0, total: 0 }));
      if (seg.type === 'work') { g.work += seg.duration; workTotal += seg.duration; } else { g.wait += seg.duration; waitTotal += seg.duration; }
      g.total += seg.duration;
    }
    const byGroup = Array.from(byGroupMap.values()).sort((a, b) => b.total - a.total || cmpStr(a.group, b.group));
    const total = target.end - chain[0].start;
    const covered = transitTotal + workTotal + waitTotal;
    if (Math.abs(covered - total) > 0.01) warnings.push(`Journey segments cover ${fmt(covered)} of ${fmt(total)} (clock skew)`);
    return { target, chain, segments, byGroup, transitTotal, workTotal, waitTotal, total, warnings };
  }

  // ---------------------------------------------------------------- insights

  function hopTypeLabel(t) {
    return util().hopTypeLabel ? util().hopTypeLabel(t) : t;
  }

  function computeInsights(model) {
    const literal = model.literal;
    const out = [];
    const add = (kind, severity, title, detail, metric, spanIds, groupKeys) => {
      out.push({ id: '', kind, severity, title, detail, metric, spanIds: sortedUniq(spanIds), groupKeys: sortedUniq(groupKeys) });
    };
    const median = util().median;
    const trunc = (s, n) => util().truncateMiddle(str(s).replace(/\s+/g, ' ').trim(), n);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    // 1. errors
    for (const s of model.spans) {
      if (!s.isError) continue;
      const exc = s.events.find((e) => /exception/i.test(e.name));
      const excMsg = exc ? str(first(exc.attrs['exception.message'], exc.attrs['exception.type'])) : '';
      const detail = trunc(s.statusMessage || excMsg, 240) || 'Status is ERROR but no message was recorded.';
      add('error', 'critical', `${s.group}: ${s.name} failed`, detail, s.duration, [s.id], [s.group]);
    }

    // 2. slow hops
    const asyncHops = model.hops.filter((h) => h.async);
    if (asyncHops.length) {
      const threshold = Math.max(25, 4 * median(asyncHops.map((h) => h.queue)));
      // Smart mode: only the first delivery from a parent into a service is transport; later siblings
      // in the same service are in-service processing (e.g. Flink operators), reported as journey waits.
      const isFirstDelivery = (h) => {
        const c = h.child;
        for (const list of [h.parent.causalChildren, c.parent ? c.parent.children : []]) {
          for (const k of list) if (k !== c && k.group === c.group && (k.start < c.start || (k.start === c.start && k.index < c.index))) return false;
        }
        return true;
      };
      for (const h of asyncHops) {
        if (h.queue < threshold) continue;
        if (!literal && !isFirstDelivery(h)) continue;
        const detail = h.type === 'kafka'
          ? `The message on ${h.label || 'the topic'} waited ${fmt(h.queue)} after ${h.from} sent it before ${h.to} picked it up ` +
            `(${fmt(h.latency)} from send start). Usual causes: consumer lag, rebalancing or polling/batching delay.`
          : `${h.to} started ${fmt(h.queue)} after ${h.from} finished the ${hopTypeLabel(h.type)} call` +
            `${h.label ? ` (${h.label})` : ''}: queued, retried or fire-and-forget.`;
        add('slow-hop', 'warning', `${fmt1(h.queue)} queue: ${h.from} → ${h.to}`, detail,
          h.queue, [h.parent.id, h.child.id], [h.from, h.to]);
      }
    }

    // 3. orphans
    if (model.orphans.length) {
      const ipIndex = buildIpIndex(model);
      for (const o of model.orphans) {
        const a = o.attrs;
        const ua = str(first(a['user_agent.original'], a['http.user_agent']));
        const ips = sortedUniq([a['client.address'], a['net.peer.ip'], a['network.peer.address']].map(str).filter((v) => IP_RE.test(v)));
        const callers = new Map();
        for (const ip of ips) {
          for (const hit of ipIndex.get(ip) || []) {
            if (hit.span === o) continue;
            if (hit.span.group !== o.group) {
              addCaller(callers, hit.span.group, `${ip} is its ${hit.key}`);
            }
            if (!literal && hit.peerKey && hit.span.parent && hit.span.parent.group !== o.group) {
              addCaller(callers, hit.span.parent.group, `its calls to ${hit.span.group} also come from ${ip}`);
            }
          }
        }
        const callerKeys = Array.from(callers.keys());
        let detail = `Parent ${o.parentId} is not in this trace: the caller is not instrumented or its span was dropped.`;
        if (callerKeys.length) detail += ` Likely caller: ${callerKeys.map((k) => `${k} (${callers.get(k)[0]})`).join(' or ')}.`;
        const from = [ips.join(', '), ua && `"${trunc(ua, 60)}"`].filter(Boolean).join(', ');
        if (from) detail += ` Request came from ${from}.`;
        add('orphan', 'warning', `Missing parent span ${o.parentId.slice(0, 8)} for ${o.group}: ${o.name}`, detail,
          o.duration, [o.id], [o.group, ...callerKeys]);
      }
    }

    // 4. async waits on the default journey
    const j = model.journey;
    if (j) {
      for (const seg of j.segments) {
        if (seg.type !== 'wait' || seg.duration < 50) continue;
        add('async-wait', seg.duration >= 250 ? 'warning' : 'info', `${fmt(seg.duration)} waiting inside ${seg.group}`,
          `The message reached ${seg.group} at ${fmtOff(seg.start)} (${trunc(seg.span.name, 60)}) but the path only continues at ` +
          `${fmtOff(seg.end)} (${trunc(seg.toSpan.name, 60)}): buffering, windowing, timers or retries inside the service.`,
          seg.duration, [seg.span.id, seg.toSpan.id], [seg.group]);
      }
    }

    // 5. repeated queries
    const queries = new Map();
    for (const s of model.spans) {
      if (s.category !== 'db') continue;
      const stmt = s.op.statement || s.name;
      const key = s.group + '\u0000' + stmt;
      let q = queries.get(key);
      if (!q) queries.set(key, (q = { group: s.group, stmt, spans: [], time: 0 }));
      q.spans.push(s);
      q.time += s.duration;
    }
    for (const q of queries.values()) {
      const n = q.spans.length;
      if (n < 5) continue;
      add('repeated-query', n >= 10 ? 'warning' : 'info', `${n}× the same query in ${q.group}`,
        `${trunc(q.stmt, 90)} — ${fmt(q.time)} in total, ${fmt(q.time / n)} on average. Batch or cache it.`,
        n, q.spans.map((s) => s.id), [q.group]);
    }

    // 6. repeated consumption of one produced message, aggregated per producer service + topic + consumer
    const repeats = new Map();
    for (const p of model.spans) {
      if (p.category !== 'messaging' || p.op.role !== 'producer' || !p.causalChildren.length) continue;
      const byConsumer = new Map();
      for (const c of p.causalChildren) {
        if (c.category !== 'messaging' || c.op.role !== 'consumer') continue;
        // smart mode: same service *and* same Kafka consumer group (two consumer groups in one service is not a repeat)
        const key = c.group + '\u0000' + (literal ? '' : c.op.consumerGroup || '');
        if (!byConsumer.has(key)) byConsumer.set(key, []);
        byConsumer.get(key).push(c);
      }
      for (let list of byConsumer.values()) {
        // smart mode: when the bucket holds real receive spans (own topic), ignore operator spans
        // that merely inherit the context (e.g. Flink operators of kind CONSUMER)
        if (!literal && list.some((c) => c.op.ownDestination)) list = list.filter((c) => c.op.ownDestination);
        if (list.length < 2) continue;
        const g = list[0].group, cg = literal ? '' : list[0].op.consumerGroup;
        const topic = p.op.destination || list[0].op.destination;
        const key = [p.group, topic, g, cg].join('\u0000');
        let r = repeats.get(key);
        if (!r) repeats.set(key, (r = { from: p.group, topic, group: g, cg, messages: 0, min: Infinity, max: 0, ids: [] }));
        r.messages++;
        r.min = Math.min(r.min, list.length);
        r.max = Math.max(r.max, list.length);
        r.ids.push(p.id, ...list.map((c) => c.id));
      }
    }
    for (const r of repeats.values()) {
      const times = r.min === r.max ? `${r.max}×` : `up to ${r.max}×`;
      const title = r.messages === 1 ? `${r.group} received one message ${times}` : `${r.group} received each of ${r.messages} messages ${times}`;
      add('repeated-consume', 'info', title,
        `${r.topic ? `Topic ${r.topic}` : 'Messages'} from ${r.from}${r.cg ? `, consumer group ${r.cg}` : ''}. ` +
        'Usually redelivery (offset not committed) or several listeners on the same topic.',
        r.max, r.ids, [r.from, r.group]);
    }

    // 7. fan-out topics
    for (const t of model.topics) {
      if (t.consumerGroups.length < 4) continue;
      add('fan-out', 'info', `${t.name} fans out to ${t.consumerGroups.length} services`,
        `Produced by ${t.producerGroups.join(', ') || 'an uninstrumented producer'}; consumed by ${t.consumerGroups.join(', ')}.`,
        t.consumerGroups.length, t.producers.map((s) => s.id), [...t.producerGroups, ...t.consumerGroups]);
    }

    // 8. deploy-scope crossings: hops whose two spans run in different deploy scopes, one card per service pair
    const crossings = new Map();
    for (const h of model.hops) {
      const sa = h.parent.deployScope, sb = h.child.deployScope;
      if (sa === sb) continue;
      const key = [h.from, h.to, sa, sb].join('\u0000');
      let x = crossings.get(key);
      if (!x) crossings.set(key, (x = { from: h.from, to: h.to, sa, sb, hops: [] }));
      x.hops.push(h);
    }
    for (const x of crossings.values()) {
      const labels = sortedUniq(x.hops.map((h) => h.label));
      const types = sortedUniq(x.hops.map((h) => hopTypeLabel(h.type)));
      add('scope-crossing', 'info', `${x.sa} → ${x.sb}: ${x.from} → ${x.to}`,
        `${plural(x.hops.length, types.join('/') + ' hop')} ${x.hops.length === 1 ? 'crosses' : 'cross'} from deploy scope ${x.sa} to ${x.sb}` +
        `${labels.length ? ` via ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` and ${labels.length - 3} more` : ''}` : ''}.`,
        x.hops.length, x.hops.flatMap((h) => [h.parent.id, h.child.id]), [x.from, x.to]);
    }

    // 9. hotspots on the default journey
    if (j && j.total > 0) {
      const ranked = model.groups.filter((g) => g.journeyTime > 0).sort((a, b) => b.journeyTime - a.journeyTime || cmpStr(a.key, b.key)).slice(0, 3);
      for (const g of ranked) {
        const ids = j.chain.filter((s) => s.group === g.key).map((s) => s.id);
        for (const s of j.segments) {
          if (s.group !== g.key || s.type === 'transit') continue;
          ids.push(s.span.id);
          if (s.toSpan) ids.push(s.toSpan.id);
        }
        const row = j.byGroup.find((r) => r.group === g.key) || { work: 0, wait: 0 };
        const parts = [row.work > 0 && `${fmt(row.work)} working`, row.wait > 0 && `${fmt(row.wait)} waiting`].filter(Boolean);
        add('hotspot', 'info', `${g.key}: ${util().pct(g.journeyTime, j.total)} of the journey (${fmt(g.journeyTime)})`,
          `${parts.join(' + ')} on the ${fmt(j.total)} path to ${trunc(j.target.name, 60)} (${j.target.group}).`,
          g.journeyTime, ids, [g.key]);
      }
    }

    // 10. clock skew
    for (const c of model.spans) {
      const p = c.parent;
      if (!p) continue;
      const type = relationType(p, c);
      if (isAsync(type, p, c)) continue;
      if (c.start < p.start) {
        add('skew', 'info', `Clock skew: ${c.group}: ${c.name} starts ${fmt(p.start - c.start)} before its parent`,
          `It is a synchronous child of ${p.name} (${p.group}), so the two hosts' clocks disagree; offsets across this call are unreliable.`,
          p.start - c.start, [p.id, c.id], [p.group, c.group]);
      } else if (p.kind === 'client' && c.kind === 'server' && c.end > p.end + 1) {
        add('skew', 'info', `Clock skew: ${c.group}: ${c.name} ends ${fmt(c.end - p.end)} after its caller`,
          `The server span outlives the client span ${p.name} (${p.group}) that waited for it, so the two hosts' clocks disagree.`,
          c.end - p.end, [p.id, c.id], [p.group, c.group]);
      }
    }

    out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.metric - a.metric ||
      cmpStr(a.kind, b.kind) || cmpStr(a.title, b.title));
    const perKind = new Map();
    for (const ins of out) {
      const n = (perKind.get(ins.kind) || 0) + 1;
      perKind.set(ins.kind, n);
      ins.id = ins.kind + '-' + n;
    }
    return out;
  }

  function fmtOff(ms) {
    return util().fmtOffset ? 't' + util().fmtOffset(ms) : 't+' + ms;
  }

  function addCaller(map, group, reason) {
    if (!map.has(group)) map.set(group, []);
    const list = map.get(group);
    if (!list.includes(reason)) list.push(reason);
  }

  const PEER_KEYS = new Set(['client.address', 'net.peer.ip', 'network.peer.address']);

  function buildIpIndex(model) {
    const idx = new Map();
    const put = (ip, entry) => {
      if (!idx.has(ip)) idx.set(ip, []);
      idx.get(ip).push(entry);
    };
    const seenRes = new Map();
    for (const s of model.spans) {
      for (const k of Object.keys(s.attrs)) {
        const v = s.attrs[k];
        if (typeof v !== 'string' || !IP_RE.test(v)) continue;
        const peerKey = PEER_KEYS.has(k) && (s.kind === 'server' || s.kind === 'consumer');
        put(v, { span: s, key: k, peerKey });
      }
      // resource attributes describe where the span runs (e.g. k8s.pod.ip); index once per group
      let groups = seenRes.get(s.resource);
      if (!groups) seenRes.set(s.resource, (groups = new Set()));
      if (groups.has(s.group)) continue;
      groups.add(s.group);
      for (const k of Object.keys(s.resource)) {
        const v = s.resource[k];
        if (typeof v === 'string' && IP_RE.test(v)) put(v, { span: s, key: k, peerKey: false });
      }
    }
    return idx;
  }

  // ---------------------------------------------------------------- causal links

  // Context propagation is often broken by stream processors (e.g. Flink forwards the *input* record's
  // context to every operator and sink), so a consumer of topic T can be parented to a producer of a
  // different topic. Re-link such a consumer to the latest producer of T that started before it and
  // lives in the same subtree of its structural parent. The structural tree (parent/children/depth)
  // is untouched; hops, edges, topics deliveries and the journey use the causal links.
  function inferCausalLinks(spans, ownDest) {
    const n = spans.length;
    const tin = new Int32Array(n), tout = new Int32Array(n);
    let clock = 0;
    for (const r of spans) {
      if (r.parent) continue;
      tin[r.index] = clock++;
      const stack = [[r, 0]];
      while (stack.length) {
        const top = stack[stack.length - 1];
        const node = top[0];
        if (top[1] < node.children.length) {
          const c = node.children[top[1]++];
          tin[c.index] = clock++;
          stack.push([c, 0]);
        } else {
          tout[node.index] = clock++;
          stack.pop();
        }
      }
    }
    const inSubtree = (q, p) => tin[p.index] < tin[q.index] && tout[q.index] < tout[p.index];

    const producers = new Map();
    for (const s of spans) {
      if (s.category !== 'messaging' || s.op.role !== 'producer' || !s.op.destination) continue;
      if (!producers.has(s.op.destination)) producers.set(s.op.destination, []);
      producers.get(s.op.destination).push(s); // spans are already in start order
    }
    const links = [];
    for (const c of spans) {
      const p = c.parent;
      if (!p || c.category !== 'messaging' || c.op.role !== 'consumer' || !ownDest.has(c)) continue;
      const topic = c.op.destination;
      if (p.category === 'messaging' && p.op.role === 'producer' && p.op.destination === topic) continue;
      const list = producers.get(topic);
      if (!list) continue;
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].start <= c.start) lo = mid + 1; else hi = mid; }
      for (let i = lo - 1; i >= 0; i--) {
        const q = list[i];
        if (q === c || !inSubtree(q, p) || inSubtree(q, c)) continue;
        c.causalParent = q;
        c.causalInferred = true;
        links.push({ producer: q, consumer: c, topic, structuralParent: p });
        break;
      }
    }
    return links;
  }

  // ---------------------------------------------------------------- build

  function buildModel(trace, opts) {
    opts = opts || {};
    if (!trace || !Array.isArray(trace.spans)) throw new Error('buildModel: expected a parsed trace ({traceId, spans})');
    const groupBy = GROUPINGS.some((g) => g.id === opts.groupBy) ? opts.groupBy : 'service';
    const literal = !!opts.literal;
    const warnings = Array.isArray(trace.warnings) ? trace.warnings.slice() : [];

    // spans
    const byId = new Map();
    let spans = [];
    let dup = 0;
    for (const r of trace.spans) {
      if (!r || !r.spanId) continue;
      if (byId.has(r.spanId)) { dup++; continue; }
      const resource = r.resource || {};
      const attrs = r.attrs || {};
      const statusCode = typeof r.status === 'string' ? r.status : (r.status && r.status.code) || 'unset';
      const service = str(resource['service.name']) || 'unknown-service';
      const start = +r.start || 0;
      const end = Math.max(start, +r.end || start);
      const span = {
        id: r.spanId,
        parentId: r.parentSpanId || '',
        traceId: r.traceId || trace.traceId || '',
        name: str(r.name),
        kind: r.kind || 'unspecified',
        start, end, duration: end - start,
        startEpochMs: r.startEpochMs != null ? r.startEpochMs : (trace.t0Epoch || 0) + start,
        status: statusCode,
        statusMessage: (r.status && typeof r.status === 'object' && r.status.message) || '',
        isError: statusCode === 'error',
        attrs, resource,
        scope: r.scope || { name: '', version: '' },
        events: Array.isArray(r.events) ? r.events : [],
        links: [],
        service,
        namespace: str(resource['k8s.namespace.name']) || str(resource['service.namespace']) || service,
        deployScope: str(resource['deployment.scope.name']) || 'unknown',
        pod: str(resource['k8s.pod.name']) || null,
        group: '',
        parent: null, children: [], depth: -1,
        category: 'internal', op: null, selfTime: 0, isOrphan: false, index: -1, hopIn: null,
        causalParent: null, causalChildren: [], causalInferred: false,
        _rawLinks: Array.isArray(r.links) ? r.links : [],
      };
      span.group = groupKeyOf(span, groupBy);
      span.category = categoryOf(attrs, span.kind);
      spans.push(span);
      byId.set(span.id, span);
    }
    if (dup) warnings.push(`${dup} duplicate span id(s) ignored`);

    // parents
    let selfParent = 0;
    for (const s of spans) {
      if (!s.parentId) continue;
      const p = byId.get(s.parentId);
      if (p && p !== s) { s.parent = p; p.children.push(s); } else {
        s.isOrphan = true;
        if (p === s) selfParent++;
      }
    }
    if (selfParent) warnings.push(`${selfParent} span(s) referenced themselves as parent; treated as roots`);

    // depth (iterative BFS), breaking parent cycles if any
    const bfs = (startSpan) => {
      startSpan.depth = 0;
      const queue = [startSpan];
      for (let qi = 0; qi < queue.length; qi++) {
        const n = queue[qi];
        for (const c of n.children) {
          if (c.depth !== -1) continue;
          c.depth = n.depth + 1;
          queue.push(c);
        }
      }
    };
    for (const s of spans) if (!s.parent) bfs(s);
    for (const s of spans) {
      if (s.depth !== -1) continue;
      const walked = new Set();
      let x = s;
      while (x.parent && !walked.has(x)) { walked.add(x); x = x.parent; }
      let cut = x;
      for (let y = x.parent; y && y !== x; y = y.parent) if (y.start < cut.start) cut = y;
      const p = cut.parent;
      if (p) p.children.splice(p.children.indexOf(cut), 1);
      cut.parent = null;
      cut.isOrphan = true;
      warnings.push(`Parent cycle detected: span ${cut.id} (${cut.name}) treated as a root`);
      bfs(cut);
    }

    // order
    const ord = new Map();
    spans.forEach((s, i) => ord.set(s, i));
    spans.sort((a, b) => a.start - b.start || a.depth - b.depth || ord.get(a) - ord.get(b));
    let maxDepth = 0;
    spans.forEach((s, i) => {
      s.index = i;
      if (s.depth > maxDepth) maxDepth = s.depth;
    });
    for (const s of spans) if (s.children.length > 1) s.children.sort((a, b) => a.start - b.start || a.index - b.index);

    // ops (producers never inherit, so one fix-up pass for consumers suffices)
    for (const s of spans) s.op = computeOp(s);
    const ownDest = new Set();
    for (const s of spans) {
      if (s.category === 'messaging') s.op.ownDestination = !!s.op.destination;
      if (s.category === 'messaging' && s.op.destination) ownDest.add(s);
      if (s.category !== 'messaging' || s.op.role !== 'consumer' || s.op.destination) continue;
      const p = s.parent;
      if (p && p.category === 'messaging' && p.op.role === 'producer' && p.op.destination) {
        s.op.destination = p.op.destination;
        s.op.summary = messagingSummary(s.op, s);
      }
    }

    // self time, links
    for (const s of spans) {
      s.selfTime = selfTimeOf(s);
      s.links = s._rawLinks.map((l) => ({ traceId: l.traceId, spanId: l.spanId, attrs: l.attrs || {}, target: byId.get(l.spanId) || null }));
      delete s._rawLinks;
    }

    const roots = spans.filter((s) => !s.parent && !s.isOrphan);
    const orphans = spans.filter((s) => s.isOrphan);

    // causal links (= structural unless re-linked by topic)
    for (const s of spans) s.causalParent = s.parent;
    const inferredLinks = literal ? [] : inferCausalLinks(spans, ownDest);
    for (const s of spans) if (s.causalParent) s.causalParent.causalChildren.push(s);
    for (const s of spans) if (s.causalChildren.length > 1) s.causalChildren.sort((a, b) => a.start - b.start || a.index - b.index);

    // hops & edges
    const hops = [];
    const edgeMap = new Map();
    for (const c of spans) {
      const p = c.causalParent;
      if (!p || p.group === c.group) continue;
      const type = relationType(p, c);
      const hop = {
        parent: p, child: c, from: p.group, to: c.group, type,
        label: relationLabel(type, p, c, !literal),
        async: isAsync(type, p, c),
        latency: c.start - p.start,
        queue: Math.max(0, c.start - p.end),
        inferred: c.causalInferred,
      };
      c.hopIn = hop;
      hops.push(hop);
      const id = hop.from + '→' + hop.to + '|' + hop.type + '|' + hop.label;
      let e = edgeMap.get(id);
      if (!e) {
        edgeMap.set(id, (e = { id, from: hop.from, to: hop.to, type: hop.type, label: hop.label, async: false, hops: [],
          count: 0, latencyMin: Infinity, latencyAvg: 0, latencyMax: -Infinity, queueMax: 0 }));
      }
      e.hops.push(hop);
      e.count++;
      e.async = e.async || hop.async;
      if (hop.latency < e.latencyMin) e.latencyMin = hop.latency;
      if (hop.latency > e.latencyMax) e.latencyMax = hop.latency;
      if (hop.queue > e.queueMax) e.queueMax = hop.queue;
      e.latencyAvg += hop.latency;
    }
    const edges = Array.from(edgeMap.values());
    for (const e of edges) e.latencyAvg /= e.count;
    edges.sort((a, b) => a.hops[0].child.start - b.hops[0].child.start || cmpStr(a.id, b.id));

    // groups
    const groupByKey = new Map();
    for (const s of spans) {
      let g = groupByKey.get(s.group);
      if (!g) {
        g = {
          key: s.group, label: s.group, order: 0, spans: [],
          services: [], namespaces: [], scopes: [], deployScope: '',
          first: Infinity, last: -Infinity, activeTime: 0, intervals: [],
          selfTime: 0, spanCount: 0, errorCount: 0,
          categoryTime: { messaging: 0, db: 0, rpc: 0, http: 0, internal: 0 },
          categoryCount: { messaging: 0, db: 0, rpc: 0, http: 0, internal: 0 },
          dbCalls: 0, dbTime: 0, topicsProduced: [], topicsConsumed: [],
          inEdges: [], outEdges: [], journeyTime: 0,
        };
        groupByKey.set(s.group, g);
      }
      g.spans.push(s);
      g.spanCount++;
      if (s.isError) g.errorCount++;
      if (s.start < g.first) g.first = s.start;
      if (s.end > g.last) g.last = s.end;
      g.selfTime += s.selfTime;
      g.categoryTime[s.category] += s.selfTime;
      g.categoryCount[s.category]++;
      if (s.category === 'db') { g.dbCalls++; g.dbTime += s.duration; }
    }
    const groups = Array.from(groupByKey.values());
    for (const g of groups) {
      g.services = sortedUniq(g.spans.map((s) => s.service));
      g.namespaces = sortedUniq(g.spans.map((s) => s.namespace));
      g.scopes = sortedUniq(g.spans.map((s) => s.deployScope));
      const scopeCounts = new Map();
      for (const s of g.spans) scopeCounts.set(s.deployScope, (scopeCounts.get(s.deployScope) || 0) + 1);
      g.deployScope = Array.from(scopeCounts).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))[0][0];
      g.intervals = util().mergeIntervals(g.spans.map((s) => [s.start, s.end]));
      g.activeTime = g.intervals.reduce((acc, iv) => acc + iv[1] - iv[0], 0);
      const msg = g.spans.filter((s) => s.category === 'messaging' && s.op.destination);
      g.topicsProduced = sortedUniq(msg.filter((s) => s.op.role === 'producer').map((s) => s.op.destination));
      g.topicsConsumed = sortedUniq(msg.filter((s) => s.op.role === 'consumer').map((s) => s.op.destination));
    }
    groups.sort((a, b) => a.first - b.first || cmpStr(a.key, b.key));
    groups.forEach((g, i) => { g.order = i; });
    for (const e of edges) {
      const a = groupByKey.get(e.from), b = groupByKey.get(e.to);
      if (a) a.outEdges.push(e);
      if (b) b.inEdges.push(e);
    }

    // topics
    const topicMap = new Map();
    const topicOf = (name) => {
      let t = topicMap.get(name);
      if (!t) {
        topicMap.set(name, (t = { name, system: '', producers: [], consumers: [], producerGroups: [], consumerGroups: [],
          deliveries: [], latencyMin: null, latencyAvg: null, latencyMax: null }));
      }
      return t;
    };
    for (const s of spans) {
      if (s.category !== 'messaging' || !s.op.destination) continue;
      const t = topicOf(s.op.destination);
      (s.op.role === 'producer' ? t.producers : t.consumers).push(s);
      if (!t.system && s.op.system) t.system = s.op.system;
    }
    for (const h of hops) if (h.type === 'kafka' && h.label) topicOf(h.label).deliveries.push(h);
    const topics = Array.from(topicMap.values()).sort((a, b) => cmpStr(a.name, b.name));
    for (const t of topics) {
      t.producerGroups = sortedUniq(t.producers.map((s) => s.group));
      t.consumerGroups = sortedUniq(t.consumers.map((s) => s.group));
      if (t.deliveries.length) {
        const lat = t.deliveries.map((h) => h.latency);
        t.latencyMin = Math.min(...lat);
        t.latencyMax = Math.max(...lat);
        t.latencyAvg = lat.reduce((a, b) => a + b, 0) / lat.length;
      }
    }

    // databases
    const dbMap = new Map();
    for (const s of spans) {
      if (s.category !== 'db') continue;
      const key = `${s.op.system}/${s.op.name}@${s.op.host}`;
      let d = dbMap.get(key);
      if (!d) {
        dbMap.set(key, (d = { key, system: s.op.system, name: s.op.name, host: s.op.host, spans: [], groups: [], count: 0, time: 0, tables: [], _tables: new Map() }));
      }
      d.spans.push(s);
      d.count++;
      d.time += s.duration;
      if (s.op.table) {
        let t = d._tables.get(s.op.table);
        if (!t) d._tables.set(s.op.table, (t = { table: s.op.table, count: 0, time: 0 }));
        t.count++;
        t.time += s.duration;
      }
    }
    const databases = Array.from(dbMap.values());
    for (const d of databases) {
      d.groups = sortedUniq(d.spans.map((s) => s.group));
      d.tables = Array.from(d._tables.values()).sort((a, b) => b.time - a.time || cmpStr(a.table, b.table));
      delete d._tables;
    }
    databases.sort((a, b) => b.time - a.time || cmpStr(a.key, b.key));

    // stats
    const byKind = {};
    const byCategory = { messaging: 0, db: 0, rpc: 0, http: 0, internal: 0 };
    let errorCount = 0, duration = 0;
    for (const s of spans) {
      byKind[s.kind] = (byKind[s.kind] || 0) + 1;
      byCategory[s.category]++;
      if (s.isError) errorCount++;
      if (s.end > duration) duration = s.end;
    }

    const model = {
      traceId: trace.traceId || (spans[0] && spans[0].traceId) || '',
      t0Epoch: trace.t0Epoch || 0,
      duration, groupBy, literal, spans, byId, roots, orphans, groups, groupByKey, edges, hops, topics, databases,
      inferredLinks,
      journey: null, insights: [],
      stats: { spanCount: spans.length, groupCount: groups.length, errorCount, orphanCount: orphans.length, maxDepth, byKind, byCategory },
      warnings,
    };

    model.journey = computeJourney(model, null);
    for (const row of model.journey.byGroup) {
      const g = groupByKey.get(row.group);
      if (g) g.journeyTime = row.total;
    }
    model.insights = computeInsights(model);
    return model;
  }

  TV.GROUPINGS = GROUPINGS;
  TV.CATEGORY_KEYS = CATS;
  TV.buildModel = buildModel;
  TV.computeJourney = computeJourney;
  TV.defaultJourneyTarget = defaultJourneyTarget;
  TV.modelHelpers = { groupKeyOf, categoryOf, relationType, relationLabel, selfTimeOf, urlPath, templatePath };
})(globalThis.TV = globalThis.TV || {});
