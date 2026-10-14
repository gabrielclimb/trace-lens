#!/usr/bin/env node
// Prints the core model of a trace in the cross-check DUMP FORMAT.
// usage: node tests/dump.js <trace.json> [--groupBy service|namespace|scope] [--target spanId] [--literal]
//   --literal: spec-literal semantics (structural parents only, no topic re-linking, literal insight rules)
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
for (const f of ['util', 'parse', 'model', 'store']) require(path.join(root, 'js', 'core', f + '.js'));
const TV = globalThis.TV;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const r3 = (x) => {
  if (x == null || typeof x !== 'number' || !isFinite(x)) return x == null ? null : x;
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (list) => list.slice().sort(cmp);

function dump(model, journey) {
  const spans = {};
  for (const s of model.spans) {
    spans[s.id] = {
      group: s.group,
      category: s.category,
      kind: s.kind,
      depth: s.depth,
      start: r3(s.start),
      end: r3(s.end),
      duration: r3(s.duration),
      selfTime: r3(s.selfTime),
      status: s.status,
      opDestination: s.category === 'messaging' && s.op.destination ? s.op.destination : null,
      hopIn: s.hopIn ? { from: s.hopIn.from, type: s.hopIn.type, label: s.hopIn.label } : null,
    };
  }
  const groups = model.groups.slice().sort((a, b) => cmp(a.key, b.key)).map((g) => ({
    key: g.key,
    spanCount: g.spanCount,
    first: r3(g.first),
    last: r3(g.last),
    activeTime: r3(g.activeTime),
    selfTime: r3(g.selfTime),
    errorCount: g.errorCount,
    dbCalls: g.dbCalls,
    dbTime: r3(g.dbTime),
    topicsProduced: sorted(g.topicsProduced),
    topicsConsumed: sorted(g.topicsConsumed),
    categoryTime: {
      messaging: r3(g.categoryTime.messaging), db: r3(g.categoryTime.db), rpc: r3(g.categoryTime.rpc),
      http: r3(g.categoryTime.http), internal: r3(g.categoryTime.internal),
    },
    journeyTime: r3(g.journeyTime),
  }));
  const hops = model.hops.slice()
    .sort((a, b) => cmp(a.parent.id, b.parent.id) || cmp(a.child.id, b.child.id))
    .map((h) => ({
      parent: h.parent.id, child: h.child.id, from: h.from, to: h.to, type: h.type, label: h.label,
      async: h.async, latency: r3(h.latency), queue: r3(h.queue),
    }));
  const edges = model.edges.slice().sort((a, b) => cmp(a.id, b.id)).map((e) => ({
    id: e.id, count: e.count, latencyMin: r3(e.latencyMin), latencyAvg: r3(e.latencyAvg), latencyMax: r3(e.latencyMax),
    queueMax: r3(e.queueMax), async: e.async,
  }));
  const topics = model.topics.slice().sort((a, b) => cmp(a.name, b.name)).map((t) => ({
    name: t.name, producerGroups: sorted(t.producerGroups), consumerGroups: sorted(t.consumerGroups), deliveries: t.deliveries.length,
  }));
  const databases = model.databases.slice().sort((a, b) => cmp(a.key, b.key)).map((d) => ({
    key: d.key, count: d.count, time: r3(d.time), groups: sorted(d.groups),
  }));
  const j = journey;
  const journeyOut = j && j.target ? {
    target: j.target.id,
    chain: j.chain.map((s) => s.id),
    segments: j.segments.map((s) => ({ type: s.type, group: s.group, start: r3(s.start), end: r3(s.end) })),
    byGroup: j.byGroup.slice().sort((a, b) => cmp(a.group, b.group)).map((g) => ({
      group: g.group, work: r3(g.work), wait: r3(g.wait), total: r3(g.total),
    })),
    transitTotal: r3(j.transitTotal), workTotal: r3(j.workTotal), waitTotal: r3(j.waitTotal), total: r3(j.total),
  } : null;
  const insights = model.insights.map((i) => ({
    kind: i.kind, severity: i.severity, metric: r3(i.metric), spanIds: sorted(i.spanIds), groupKeys: sorted(i.groupKeys),
  })).sort((a, b) => cmp(a.kind, b.kind) || cmp(a.spanIds.join(','), b.spanIds.join(',')) || cmp(a.groupKeys.join(','), b.groupKeys.join(',')));

  return {
    traceId: model.traceId,
    groupBy: model.groupBy,
    spanCount: model.stats.spanCount,
    duration: r3(model.duration),
    maxDepth: model.stats.maxDepth,
    roots: sorted(model.roots.map((s) => s.id)),
    orphans: sorted(model.orphans.map((s) => s.id)),
    spans, groups, hops, edges, topics, databases,
    journey: journeyOut,
    insights,
  };
}

function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    process.stderr.write('usage: node tests/dump.js <trace.json> [--groupBy service|namespace|scope] [--target spanId] [--literal]\n');
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const parsed = TV.parse(text);
  const model = TV.buildModel(parsed.traces[0], { groupBy: arg('groupBy', 'service'), literal: process.argv.includes('--literal') });
  const target = arg('target', null);
  const journey = target ? TV.computeJourney(model, target) : model.journey;
  process.stdout.write(JSON.stringify(dump(model, journey), null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { dump };
