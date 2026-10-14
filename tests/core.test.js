#!/usr/bin/env node
// Core tests (parse + model + journey + insights + store). Plain node, no dependencies.
//   node tests/core.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
for (const f of ['util', 'parse', 'model', 'store']) require(path.join(ROOT, 'js', 'core', f + '.js'));
const TV = globalThis.TV;

const FIX = path.join(__dirname, 'fixtures');
const read = (p) => fs.readFileSync(p, 'utf8');
const SAMPLE = read(path.join(ROOT, 'data', 'sample-trace.json'));
const FIXTURES = {
  'sample-trace': SAMPLE,
  'otlp-resourcespans': read(path.join(FIX, 'otlp-resourcespans.json')),
  jaeger: read(path.join(FIX, 'jaeger.json')),
  'multi-trace': read(path.join(FIX, 'multi-trace.json')),
  errors: read(path.join(FIX, 'errors.json')),
  'synthetic-5k': read(path.join(FIX, 'synthetic-5k.json')),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       '));
  }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);
const countBy = (list, key) => list.reduce((m, x) => ((m[x[key]] = (m[x[key]] || 0) + 1), m), {});

const parsed = {};
for (const [k, text] of Object.entries(FIXTURES)) parsed[k] = TV.parse(text);
const sample = TV.buildModel(parsed['sample-trace'].traces[0], { groupBy: 'service' });

console.log('reference numbers (sample trace)');
test('trace, spans, groups, scopes, duration', () => {
  assert.strictEqual(parsed['sample-trace'].format, 'otlp');
  assert.strictEqual(parsed['sample-trace'].traces.length, 1);
  assert.strictEqual(sample.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.strictEqual(sample.stats.spanCount, 68);
  assert.strictEqual(sample.groups.length, 15);
  assert.strictEqual(new Set(sample.spans.map((s) => s.namespace)).size, 13);
  assert.deepStrictEqual([...new Set(sample.spans.map((s) => s.deployScope))].sort(), ['forest', 'platform']);
  near(sample.duration, 668.3, 0.002);
  assert.strictEqual(sample.stats.errorCount, 1);
  assert.strictEqual(sample.stats.maxDepth, 12);
});
test('root and orphan', () => {
  assert.strictEqual(sample.roots.length, 1);
  assert.strictEqual(sample.roots[0].id, 'eb5ff7e96a855834');
  assert.strictEqual(sample.roots[0].group, 'storefront-gateway');
  assert.strictEqual(sample.roots[0].name, 'orders-raw publish');
  assert.strictEqual(sample.orphans.length, 1);
  const o = sample.orphans[0];
  assert.strictEqual(o.id, '091d0285685a89b4');
  assert.strictEqual(o.parentId, '9e3f1c0a7b2d4e65');
  assert.strictEqual(o.group, 'api-gateway');
  assert.strictEqual(o.depth, 0);
});
test('hops, edges, causal re-links', () => {
  assert.strictEqual(sample.hops.length, 23);
  assert.strictEqual(sample.edges.length, 17);
  assert.strictEqual(sample.inferredLinks.length, 1);
  const d = sample.byId.get('c501fb630de73dec');
  assert.strictEqual(d.parent.group, 'order-orchestrator', 'structural parent untouched');
  assert.strictEqual(d.causalParent.group, 'warehouse-gateway');
  assert.strictEqual(d.hopIn.label, 'shipments-created');
  assert.ok(sample.edges.some((e) => e.label === 'POST /v1/routes/{uuid}/estimate'), 'http ids templated');
});
test('default journey', () => {
  const j = sample.journey;
  assert.strictEqual(j.target.group, 'invoice-service');
  near(j.total, 668.3, 0.002);
  near(j.transitTotal, 129.8, 0.05);
  near(j.waitTotal, 401.8, 0.05);
  assert.strictEqual(j.byGroup[0].group, 'fulfillment-job');
  const flink = j.byGroup.find((r) => r.group === 'fulfillment-job');
  near(flink.wait, 401.6, 0.05, 'Flink in-service wait');
  near(sample.groupByKey.get('fulfillment-job').journeyTime, flink.total, 1e-9);
});
test('insight counts and shape', () => {
  const c = countBy(sample.insights, 'kind');
  assert.deepStrictEqual(c, { error: 1, 'async-wait': 1, 'slow-hop': 2, orphan: 1, 'repeated-query': 1, hotspot: 3, 'fan-out': 1,
    'repeated-consume': 1, skew: 1, 'scope-crossing': 1 });
  const rank = { critical: 0, warning: 1, info: 2 };
  const ids = new Set();
  sample.insights.forEach((ins, i) => {
    assert.ok(ins.id && !ids.has(ins.id), 'unique id');
    ids.add(ins.id);
    assert.ok(ins.title && ins.title.length <= 140, 'concise title: ' + ins.title);
    assert.ok(ins.detail && ins.detail.length <= 420, 'concise detail: ' + ins.detail);
    assert.ok(!/undefined|NaN|\[object/.test(ins.title + ins.detail), 'no junk in text: ' + ins.title);
    assert.ok(typeof ins.metric === 'number' && isFinite(ins.metric));
    for (const id of ins.spanIds) assert.ok(sample.byId.has(id), 'spanId exists');
    for (const g of ins.groupKeys) assert.ok(sample.groupByKey.has(g), 'group exists');
    if (i) assert.ok(rank[sample.insights[i - 1].severity] <= rank[ins.severity], 'sorted by severity');
  });
  const orphan = sample.insights.find((i) => i.kind === 'orphan');
  assert.ok(orphan.groupKeys.includes('fulfillment-job'), 'likely caller found via k8s.pod.ip');
  const sc = sample.insights.find((i) => i.kind === 'scope-crossing');
  assert.strictEqual(sc.title, 'forest → platform: order-intake → order-orchestrator');
});

console.log('model invariants (every fixture × service/namespace)');
for (const [name, p] of Object.entries(parsed)) {
  for (const groupBy of ['service', 'namespace']) {
    const m = TV.buildModel(p.traces[0], { groupBy });
    test(`${name}.${groupBy}: spans, selfTime, groups`, () => {
      assert.strictEqual(m.groupBy, groupBy);
      m.spans.forEach((s, i) => {
        assert.strictEqual(s.index, i);
        if (i) assert.ok(m.spans[i - 1].start <= s.start, 'sorted by start');
        assert.ok(s.selfTime >= 0 && s.selfTime <= s.duration + 1e-9, `selfTime in [0, duration] for ${s.id}`);
        assert.strictEqual(s.group, groupBy === 'service' ? s.service : s.namespace);
        assert.ok(['messaging', 'db', 'rpc', 'http', 'internal'].includes(s.category));
        assert.strictEqual(typeof s.op.summary, 'string');
        if (s.parent) assert.ok(s.parent.children.includes(s) && s.depth === s.parent.depth + 1);
      });
      let spanTotal = 0;
      for (const g of m.groups) {
        spanTotal += g.spanCount;
        near(g.selfTime, g.spans.reduce((a, s) => a + s.selfTime, 0), 1e-6);
        assert.ok(g.activeTime <= g.last - g.first + 1e-9);
      }
      assert.strictEqual(spanTotal, m.spans.length);
    });
    test(`${name}.${groupBy}: hops cross groups, edges aggregate hops`, () => {
      for (const h of m.hops) {
        assert.notStrictEqual(h.from, h.to);
        assert.strictEqual(h.from, h.parent.group);
        assert.strictEqual(h.to, h.child.group);
        assert.strictEqual(h.child.hopIn, h);
        assert.strictEqual(h.child.causalParent, h.parent);
        assert.ok(h.queue >= 0);
      }
      assert.strictEqual(m.edges.reduce((a, e) => a + e.count, 0), m.hops.length);
      for (const s of m.spans) if (s.causalParent && s.causalParent.group === s.group) assert.strictEqual(s.hopIn, null);
    });
    test(`${name}.${groupBy}: journey invariants`, () => {
      const targets = [null];
      for (let i = 0; i < m.spans.length; i += Math.max(1, Math.floor(m.spans.length / 40))) targets.push(m.spans[i].id);
      for (const t of targets) {
        const j = t ? TV.computeJourney(m, t) : m.journey;
        let prevEnd = -Infinity, sum = 0;
        for (const seg of j.segments) {
          assert.ok(seg.end > seg.start, 'positive length');
          assert.ok(seg.start >= prevEnd - 1e-9, `segments sorted & non-overlapping (target ${t})`);
          prevEnd = seg.end;
          sum += seg.duration;
          assert.ok(['work', 'transit', 'wait'].includes(seg.type));
        }
        near(sum, j.total, 0.01, `segments sum to total (target ${t})`);
        near(j.workTotal + j.waitTotal + j.transitTotal, sum, 1e-6);
        assert.strictEqual(j.chain[j.chain.length - 1], j.target);
        assert.ok(!j.chain[0].causalParent, 'chain starts at a root');
      }
    });
  }
}

console.log('parse');
test('OTLP resourceSpans: base64 ids, string timestamps, int kinds equal the sample', () => {
  const a = parsed['sample-trace'].traces[0], b = parsed['otlp-resourcespans'].traces[0];
  assert.strictEqual(b.traceId, a.traceId);
  assert.strictEqual(b.spans.length, a.spans.length);
  const byId = new Map(a.spans.map((s) => [s.spanId, s]));
  for (const s of b.spans) {
    assert.ok(/^[0-9a-f]{16}$/.test(s.spanId), 'hex span id');
    const o = byId.get(s.spanId);
    assert.ok(o, 'same ids as the sample');
    assert.strictEqual(s.parentSpanId, o.parentSpanId);
    assert.strictEqual(s.kind, o.kind);
    near(s.start, o.start, 0.001);
    near(s.end, o.end, 0.001);
  }
});
test('Jaeger JSON', () => {
  const p = parsed.jaeger;
  assert.strictEqual(p.format, 'jaeger');
  assert.strictEqual(p.traces[0].spans.length, 68);
  const m = TV.buildModel(p.traces[0], { groupBy: 'service' });
  assert.strictEqual(m.groups.length, 15);
  assert.strictEqual(m.roots[0].id, 'eb5ff7e96a855834');
  near(m.duration, 668.3, 0.002);
});
test('multi-trace: split by traceId, sorted by span count', () => {
  const p = parsed['multi-trace'];
  assert.strictEqual(p.traces.length, 2);
  assert.strictEqual(p.traces[0].spans.length, 68);
  assert.strictEqual(p.traces[1].spans.length, 6);
  const m2 = TV.buildModel(p.traces[1], {});
  assert.strictEqual(m2.stats.errorCount, 1);
});
test('errors fixture: error insight + orphan', () => {
  const m = TV.buildModel(parsed.errors.traces[0], {});
  const c = countBy(m.insights, 'kind');
  assert.strictEqual(c.error, 2);
  assert.strictEqual(c.orphan, 1);
  assert.ok(c.skew >= 1 && c['repeated-query'] === 1 && c['fan-out'] === 1);
});
test('garbage input throws a readable Error', () => {
  for (const bad of ['', '   ', 'not json', '{"foo":1}', '[]', 'null', '42', '{"batches":[]}', '{"data":[]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"x"}]}]}]}']) {
    assert.throws(() => TV.parse(bad), (e) => e instanceof Error && e.message.length > 10 && !/undefined/.test(e.message),
      'input ' + JSON.stringify(bad));
  }
});
test('buildModel rejects non-traces', () => {
  assert.throws(() => TV.buildModel(null), /expected a parsed trace/);
});

console.log('robustness');
function rawSpan(id, parent, start, end, extra) {
  return Object.assign({ traceId: 't', spanId: id, parentSpanId: parent, name: id, kind: 'internal', start, end,
    startEpochMs: start, status: { code: 'unset', message: '' }, attrs: {}, resource: { 'service.name': 'svc-' + id },
    scope: { name: '', version: '' }, events: [], links: [] }, extra);
}
test('parent cycle A→B→A does not hang and yields a root', () => {
  const trace = { traceId: 't', t0Epoch: 0, spans: [rawSpan('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 0, 10),
    rawSpan('bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa', 1, 5), rawSpan('cccccccccccccccc', 'aaaaaaaaaaaaaaaa', 2, 3),
    rawSpan('dddddddddddddddd', 'dddddddddddddddd', 4, 6)] };
  const m = TV.buildModel(trace, {});
  assert.strictEqual(m.spans.length, 4);
  assert.ok(m.warnings.some((w) => /cycle/i.test(w)));
  assert.ok(m.warnings.some((w) => /themselves/i.test(w)));
  for (const s of m.spans) assert.ok(s.depth >= 0);
  for (const s of m.spans) TV.computeJourney(m, s.id);
  assert.strictEqual(m.byId.get('aaaaaaaaaaaaaaaa').depth, 0, 'earliest span of the cycle becomes the root');
});
test('cycle through a parsed OTLP document', () => {
  const doc = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] },
    scopeSpans: [{ spans: [
      { traceId: '0123456789abcdef0123456789abcdef', spanId: '1111111111111111', parentSpanId: '2222222222222222', name: 'a', startTimeUnixNano: '1000000', endTimeUnixNano: '5000000' },
      { traceId: '0123456789abcdef0123456789abcdef', spanId: '2222222222222222', parentSpanId: '1111111111111111', name: 'b', startTimeUnixNano: '2000000', endTimeUnixNano: '3000000' },
    ] }] }] };
  const m = TV.buildModel(TV.parse(JSON.stringify(doc)).traces[0], {});
  assert.strictEqual(m.spans.length, 2);
  assert.strictEqual(m.roots.length + m.orphans.length, 1);
});

console.log('store');
test('load, groupBy switch, selection reset', () => {
  const store = TV.createStore();
  store.load(SAMPLE, 'sample-trace.json');
  let st = store.get();
  assert.strictEqual(st.model.groupBy, 'service');
  assert.strictEqual(st.model.groups.length, 15);
  store.set({ selectedGroups: ['storefront-gateway'], selectedSpanId: 'eb5ff7e96a855834' });
  const seen = [];
  const off = store.subscribe((s, changed) => seen.push(changed));
  store.set({ groupBy: 'namespace' });
  off();
  st = store.get();
  assert.strictEqual(st.model.groupBy, 'namespace');
  assert.strictEqual(st.model.groups.length, 13);
  assert.ok(seen.length && seen[seen.length - 1].has('model'));
  assert.deepStrictEqual(st.selectedGroups, []);
  assert.strictEqual(st.selectedSpanId, 'eb5ff7e96a855834', 'span still exists → kept');
  assert.ok(st.journey && st.journey.target);
});
test('matches / groupMatches semantics', () => {
  const store = TV.createStore();
  store.load(SAMPLE, 'sample');
  const m = store.get().model;
  assert.ok(m.spans.every(store.matches), 'no filter → everything matches');
  assert.ok(!store.isFiltering());
  store.set({ search: 'STOCKSERVICE' });
  const hits = m.spans.filter(store.matches);
  assert.ok(hits.length > 0 && hits.length < m.spans.length, 'case-insensitive search');
  store.set({ search: '', filters: { categories: ['db'], errorsOnly: false, minDuration: 0 } });
  assert.ok(m.spans.filter(store.matches).every((s) => s.category === 'db'));
  assert.ok(store.isFiltering());
  store.set({ filters: { categories: [], errorsOnly: false, minDuration: 100 } });
  assert.ok(m.spans.filter(store.matches).every((s) => s.duration >= 100));
  store.set({ filters: { categories: [], errorsOnly: true, minDuration: 0 } });
  assert.strictEqual(m.spans.filter(store.matches).length, 1, 'sample has one error');
  store.set({ filters: { categories: [], errorsOnly: false, minDuration: 0 }, selectedGroups: ['storefront-gateway'] });
  assert.ok(m.spans.filter(store.matches).every((s) => s.group === 'storefront-gateway'));
  assert.ok(store.groupMatches('storefront-gateway'));
  assert.ok(!store.groupMatches('order-intake'));
  store.set({ selectedGroups: [], filters: { categories: ['db'], errorsOnly: false, minDuration: 0 } });
  assert.ok(!store.groupMatches('storefront-gateway'), 'group without db spans does not match');
  assert.ok(store.groupMatches('inventory-api'));
});

console.log('performance');
test('5k-span buildModel < 250 ms', () => {
  const t = parsed['synthetic-5k'].traces[0];
  assert.ok(t.spans.length >= 5000);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    TV.buildModel(t, { groupBy: 'service' });
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`       best of 3: ${best.toFixed(1)} ms`);
  assert.ok(best < 250, `buildModel took ${best.toFixed(1)} ms`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
