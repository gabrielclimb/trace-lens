#!/usr/bin/env node
// Diffs the JS core (tests/dump.js format) against the Python oracle (tests/oracle-out) for every
// fixture × groupBy. Numbers are compared with a 0.002 ms tolerance.
//
//   node tests/compare.js [--verbose] [--only <fixture>]   (--literal dumps the spec-literal mode; it is NOT expected to match)
//
// Exit code 0 when everything matches, 1 otherwise. Regenerate the oracle with
// `python3 -I tests/run_oracle.py` after changing tests/oracle.py.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
for (const f of ['util', 'parse', 'model', 'store']) require(path.join(ROOT, 'js', 'core', f + '.js'));
const TV = globalThis.TV;
const { dump } = require('./dump.js');

const TOL = 0.002;
const FIXTURES = [
  ['sample-trace', path.join(ROOT, 'data', 'sample-trace.json')],
  ['otlp-resourcespans', path.join(__dirname, 'fixtures', 'otlp-resourcespans.json')],
  ['jaeger', path.join(__dirname, 'fixtures', 'jaeger.json')],
  ['multi-trace', path.join(__dirname, 'fixtures', 'multi-trace.json')],
  ['errors', path.join(__dirname, 'fixtures', 'errors.json')],
  ['synthetic-5k', path.join(__dirname, 'fixtures', 'synthetic-5k.json')],
];
const GROUPINGS = ['service', 'namespace'];

const argv = process.argv.slice(2);
const literal = argv.includes('--literal');
const verbose = argv.includes('--verbose');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

// Arrays of objects with a natural id are compared as maps so one missing element does not cascade.
const KEYED = { groups: 'key', edges: 'id', topics: 'name', databases: 'key', byGroup: 'group' };
const hopKey = (h) => h.parent + '>' + h.child;
const insightKey = (i) => i.kind + ':' + i.spanIds.join(',') + ':' + i.groupKeys.join(',');

function diff(a, b, p, out) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > TOL) out.push([p, a, b]);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push([p, a, b]);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push([p, a, b]); return; }
  const last = p.split('.').pop();
  let keyFn = null;
  if (Array.isArray(a)) {
    if (KEYED[last]) keyFn = (x) => x[KEYED[last]];
    else if (last === 'hops') keyFn = hopKey;
    else if (last === 'insights') keyFn = insightKey;
  }
  if (keyFn) {
    const ma = new Map(a.map((x) => [keyFn(x), x])), mb = new Map(b.map((x) => [keyFn(x), x]));
    for (const [k, x] of ma) if (!mb.has(k)) out.push([`${p}[${k}]`, 'present', 'MISSING']);
    for (const [k, x] of mb) if (!ma.has(k)) out.push([`${p}[${k}]`, 'MISSING', 'present']);
    for (const [k, x] of ma) if (mb.has(k)) diff(x, mb.get(k), `${p}[${k}]`, out);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push([p + '.length', a.length, b.length]);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${p}[${i}]`, out);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { out.push([`${p}.${k}`, 'MISSING', b[k]]); continue; }
    if (!(k in b)) { out.push([`${p}.${k}`, a[k], 'MISSING']); continue; }
    diff(a[k], b[k], p ? `${p}.${k}` : k, out);
  }
}

const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 80 ? s.slice(0, 77) + '...' : s;
};

let failures = 0;
for (const [name, file] of FIXTURES) {
  if (only && name !== only) continue;
  const parsed = TV.parse(fs.readFileSync(file, 'utf8'));
  for (const gb of GROUPINGS) {
    const jsNum = path.join(__dirname, 'oracle-out', 'js-numbers', `${name}.${gb}.json`);
    const ref = path.join(__dirname, 'oracle-out', `${name}.${gb}.json`);
    const oracleFile = fs.existsSync(jsNum) ? jsNum : ref;
    const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
    const model = TV.buildModel(parsed.traces[0], { groupBy: gb, literal });
    const js = JSON.parse(JSON.stringify(dump(model, model.journey)));
    const out = [];
    diff(js, oracle, '', out);
    const label = `${name}.${gb}`.padEnd(30);
    if (!out.length) { console.log(`ok    ${label} spans=${js.spanCount} hops=${js.hops.length} edges=${js.edges.length} insights=${js.insights.length}`); continue; }
    failures++;
    const bySection = new Map();
    for (const d of out) {
      const sec = d[0].replace(/^\./, '').split(/[.[]/)[0];
      bySection.set(sec, (bySection.get(sec) || 0) + 1);
    }
    console.log(`DIFF  ${label} ${out.length} difference(s): ` + Array.from(bySection).map(([k, n]) => `${k}=${n}`).join(' '));
    for (const d of out.slice(0, verbose ? 200 : 8)) console.log(`        ${d[0]}  js=${short(d[1])}  oracle=${short(d[2])}`);
  }
}
console.log(failures ? `\n${failures} fixture/grouping pair(s) differ` : '\nall fixtures match the oracle');
process.exit(failures ? 1 : 0);
