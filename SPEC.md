# Trace Lens — build spec (the contract every file is written against)

A local, offline, zero-dependency single-page tool to explore distributed traces exported from
Grafana Tempo (OTLP JSON) — **grouped by service** (`service.name`, switchable to
k8s namespace or deployment scope). The user opens `index.html` by double-click (`file://`).

UI copy is **English** (engineering tool). Code comments sparse, idiomatic vanilla JS.

## Hard constraints

- **Works from `file://`**: NO ES modules, NO `fetch()` of local files, NO build step, NO external
  network (no CDNs, no web fonts). Classic `<script>` tags only. Everything hangs off `window.TV`.
- Every JS file is wrapped as an IIFE that attaches to a shared global so it also loads in Node:
  ```js
  (function (TV) {
    'use strict';
    // ...
  })(globalThis.TV = globalThis.TV || {});
  ```
  Core files (`js/core/*.js`) must not touch `document`/`window` at load time (Node-testable).
- **Untrusted data**: span names, attribute values, service names come from the trace. Insert into the
  DOM only via `textContent` / `TV.util.el()` / `setAttribute`; **never** `innerHTML` with data.
- Must stay responsive at **5,000 spans** (perf test uses a synthetic trace). The demo sample trace has 68.
- Modern evergreen Chrome/Firefox/Safari. No polyfills.

## Directory layout & ownership

```
index.html                 shell
css/base.css               DONE (do not restructure) — tokens (light/dark) + shared components; read it before styling
css/app.css                shell — layout of header/toolbar/tabs/main/side panel, drop overlay, dialogs
css/<view>.css             each view owns its own stylesheet (map.css, timeline.css, ...)
js/core/util.js            core — helpers, formatting, DOM, tooltip, intervals, categories
js/core/parse.js           core — TV.parse(json) → normalized traces
js/core/model.js           core — TV.buildModel(trace, opts), TV.computeJourney(model, targetId), insights
js/core/store.js           core — TV.store (state + pub/sub), TV.views registry, TV.store.matches(span)
js/app.js                  shell — bootstrap, loading (drop/file/paste/sample), header, tabs, toolbar, side panel host
js/views/map.js            Flow map (service graph)
js/views/timeline.js       Swimlane timeline grouped by service
js/views/journey.js        Critical-path journey ("where did the time go")
js/views/services.js            service table (+ Topics and Databases sub-tables)
js/views/tree.js           Span tree waterfall
js/views/insights.js       Auto-detected insights list
js/views/detail.js         Side panel: span / service / trace details
data/sample-trace.js       window.TV_SAMPLE_TRACE = <OTLP json>; window.TV_SAMPLE_NAME = "..."
data/sample-trace.json     same data as raw JSON (for Node tests / drag-drop)
tests/core.test.js         Node test of core against sample (node tests/core.test.js)
tests/oracle.py            independent Python reference of the core metrics
dev/harness.html           per-view dev harness: dev/harness.html?view=<id>
```

Stylesheets: `css/base.css`, `css/app.css`, then every `css/<view>.css`.
Script load order in `index.html` and `dev/harness.html`:
`util.js, parse.js, model.js, store.js, views/*.js, data/sample-trace.js, app.js` (harness: its own
inline bootstrap instead of app.js).

---

## 1. `TV.parse(json, opts?) → ParseResult`

```
ParseResult = { format: 'otlp'|'jaeger', traces: Trace[], warnings: string[] }
Trace       = { traceId: string, t0Epoch: number /* ms since epoch of earliest span start */, spans: RawSpan[] }
RawSpan = {
  traceId, spanId, parentSpanId /* '' when root */,          // lowercase hex strings
  name, kind,          // 'server'|'client'|'producer'|'consumer'|'internal'|'unspecified'
  start, end,          // ms (float) relative to the trace's earliest span start (>= 0)
  startEpochMs,        // number, ms since epoch
  status: { code: 'ok'|'error'|'unset', message: string },
  attrs: { [key]: value },       // flattened, see "attribute values"
  resource: { [key]: value },
  scope: { name, version },      // instrumentationLibrary / scope
  events: [{ time /* ms rel trace t0 */, name, attrs }],
  links:  [{ traceId, spanId, attrs }],
}
```

Accepted inputs (detect automatically; throw `Error` with a human message when nothing matches):
- OTLP/Tempo: `{batches:[ResourceSpans]}` (Grafana "Download trace" / Tempo API), `{resourceSpans:[...]}`,
  `{trace:{resourceSpans|batches}}`, or a top-level array of any of those. Inside ResourceSpans accept
  both `instrumentationLibrarySpans`+`instrumentationLibrary` and `scopeSpans`+`scope`.
- Jaeger JSON: `{data:[{traceID, spans:[{traceID, spanID, operationName, references:[{refType, traceID, spanID}],
  startTime /*µs*/, duration /*µs*/, tags:[{key,type,value}], logs:[{timestamp, fields}], processID, warnings}],
  processes:{ p1:{ serviceName, tags } } }]}`. `CHILD_OF` (or first `FOLLOWS_FROM`) → parent; other
  references → links. `span.kind` tag → kind; `error=true` tag or `otel.status_code=ERROR` → error.
  `processes[pid].serviceName` → `resource['service.name']`, process tags → resource.
- Spans are split into traces by traceId (a file may hold several traces). Sort `traces` by span count desc.

Normalization rules:
- Attribute values: `stringValue`, `intValue` (number **or string** → Number; keep string if > 2^53),
  `doubleValue`, `boolValue`, `bytesValue` (keep string), `arrayValue.values` → JS array of converted
  values, `kvlistValue.values` → plain object. Missing value → `null`.
- IDs: if `/^[0-9a-f]+$/i` and length 16 or 32 → lowercase. Otherwise treat as base64 (Tempo protobuf-JSON)
  → hex. Empty/missing parent → `''`. All-zero parent id → `''`.
- Timestamps (`startTimeUnixNano`, `endTimeUnixNano`, event `timeUnixNano`) may be numbers (already
  float-rounded by JSON.parse — ~256 ns precision, acceptable) **or strings** (use `BigInt` to subtract
  the trace minimum before converting to ms so precision is kept). Missing end → end = start.
- Kind: `'SPAN_KIND_SERVER'` style strings or numbers (0 unspecified, 1 internal, 2 server, 3 client,
  4 producer, 5 consumer) → lowercase short form.
- Status: `code` 0/`STATUS_CODE_UNSET`/missing → `unset`; 1/`STATUS_CODE_OK` → `ok`; 2/`STATUS_CODE_ERROR`
  → `error`. Also error if attrs `error === true` or `otel.status_code === 'ERROR'`.
- Duplicate spanIds within a trace: keep the first, push a warning.

## 2. `TV.buildModel(trace, opts) → Model`

`opts = { groupBy: 'service'|'namespace'|'scope' }` (default `'service'`).
`TV.GROUPINGS = [{id:'service', label:'Service'}, {id:'namespace', label:'Namespace'}, {id:'scope', label:'Deploy scope'}]`.
Group key of a span: service → `resource['service.name']`; namespace → `resource['k8s.namespace.name']
|| resource['service.namespace'] || service`; scope → `resource['deployment.scope.name'] || 'unknown'`.
Missing service name → `'unknown-service'`.

```
Model = {
  traceId, t0Epoch, duration /* max span end, ms */, groupBy,
  spans: Span[]            // sorted by start asc, then depth asc; span.index = position
  byId: Map<string, Span>,
  roots: Span[],           // parentId === ''
  orphans: Span[],         // parentId !== '' but parent not in trace (treated as extra roots)
  groups: Group[],         // sorted by group.first asc; group.order = index
  groupByKey: Map<string, Group>,
  edges: Edge[],           // group-level, aggregated
  hops: Hop[],             // every cross-group parent→child relation
  topics: Topic[], databases: Database[],
  journey: Journey,        // TV.computeJourney(model, latestEndingSpan.id)
  insights: Insight[],
  stats: { spanCount, groupCount, errorCount, orphanCount, maxDepth, byKind:{}, byCategory:{} },
  warnings: string[],
}

Span = {
  id, parentId, traceId, name, kind, start, end, duration, startEpochMs,
  status /*'ok'|'error'|'unset'*/, statusMessage, isError,
  attrs, resource, scope, events, links /* [{traceId, spanId, attrs, target: Span|null}] */,
  service, namespace, deployScope, pod /* resource['k8s.pod.name'] */, group /* key per groupBy */,
  parent: Span|null, children: Span[] /* sorted by start */, depth /* 0 for roots & orphans */,
  category: 'messaging'|'db'|'rpc'|'http'|'internal',
  op: Op, selfTime, isOrphan, index,
  hopIn: Hop|null,         // set when parent exists and parent.group !== span.group
}
```

**Category** (first match wins):
1. `db` — any attr key starting with `db.` (e.g. `db.system`, `db.statement`) or attr `db`.
2. `rpc` — `rpc.system` / `rpc.service` present.
3. `http` — any of `http.request.method`, `http.method`, `url.full`, `http.url`, `http.route`, `http.target`.
4. `messaging` — any key starting with `messaging.`, or kind `producer`/`consumer`, or (`topic` attr present).
5. `internal` — everything else.

**Op** (short structured description, `op.summary` is a one-line human string):
- messaging: `{system, destination, operation, role:'producer'|'consumer', partition, offset, consumerGroup}`;
  destination = `messaging.destination.name` || `messaging.destination` || `messaging.source.name` ||
  `topic` || topic parsed from name `"<topic> (send|publish|process|receive)"` || (consumer: the parent
  producer's destination) || `''`. summary e.g. `"publish → orders-raw"`.
- db: `{system, name, table, operation, statement, host}`; summary `"postgresql UPDATE inventory.stock_item"`.
- rpc: `{system, service, method, grpcStatus}`; summary `"grpc StockService/GetStock"` (last segment of service).
- http: `{method, route, url, statusCode, host}`; summary `"POST /v1/routes/{route_id}/estimate → 200"`.
- internal: `{}`; summary = `name`.

**selfTime** = `duration` − length of the union of children intervals clipped to `[start, end]` (≥ 0).

**Hop** = `{ parent: Span, child: Span, from: groupKey, to: groupKey, type, label, async, latency, queue }`
for every parent→child pair whose groups differ.
- `type`: `'kafka'` if parent.kind==='producer' or child.kind==='consumer' or either category is messaging
  with messaging.system kafka/unknown; `'grpc'` if either is rpc; `'http'` if either is http; else `'call'`.
- `label`: kafka → topic (parent destination, else child destination); grpc → `rpc.service` short + `/method`;
  http → `METHOD route|path|url-path`; call → child.name.
- `async`: `type==='kafka'` or `child.start >= parent.end`.
- `latency = child.start − parent.start`; `queue = max(0, child.start − parent.end)`.
- *Clarified:* hops/edges/topic deliveries/journey use `span.causalParent` (= `parent`, except a consumer with its **own** topic T whose parent is not a producer of T is re-linked to the latest producer of T started before it inside its parent's subtree — Flink forwards the input record's context to every sink; also `causalChildren`, `causalInferred`, `hop.inferred`, `model.inferredLinks`); `parent/children/depth` stay structural.
- *Clarified:* http labels without an `http.route` template ids in the path (`{uuid}`, `{id}`, `{hex}`) so edges aggregate.

**Edge** (aggregate of hops by `from`,`to`,`type`,`label`):
`{ id: from+'→'+to+'|'+type+'|'+label, from, to, type, label, async, hops: Hop[], count,
   latencyMin, latencyAvg, latencyMax, queueMax }`.

**Group**:
```
{ key, label /* = key */, order, spans: Span[],
  services: string[], namespaces: string[], scopes: string[],
  first, last, activeTime /* union length of span intervals */, intervals: [[s,e],...] /* merged */,
  selfTime /* sum of span.selfTime */, spanCount, errorCount,
  categoryTime: {messaging, db, rpc, http, internal}  /* sum selfTime per category */,
  categoryCount: {...},
  dbCalls, dbTime /* sum duration of db spans */,
  topicsProduced: string[], topicsConsumed: string[],
  inEdges: Edge[], outEdges: Edge[],
  journeyTime /* ms of work+wait attributed to this group on model.journey (0 if not on path) */ }
```

**Topic** `{ name, system, producers: Span[], consumers: Span[], producerGroups: string[],
consumerGroups: string[], deliveries: Hop[] /* kafka hops with this label */, latencyMin, latencyAvg, latencyMax }`.
A span is a producer of topic T if role producer & destination T; consumer if role consumer & destination T.

**Database** `{ key /* system/name@host */, system, name, host, spans: Span[], groups: string[], count,
time /* sum duration */, tables: [{table, count, time}] /* sorted by time desc */ }`.

### 2.1 Journey (critical path) — `TV.computeJourney(model, targetSpanId) → Journey`

Default target = the span with the greatest `end` (ties → latest start). The **chain** is the ancestor
path root→…→target (orphans act as roots). Walk consecutive pairs `(p, c)` and emit **non-overlapping**
segments:

- same group (`c.group === p.group`): `work` segment for p over `[p.start, c.start]`.
- different group (a hop): let `first` = the earliest-starting child of `p` whose group is `c.group`
  (the first delivery of that message/call into that service).
  - `work` for p over `[p.start, min(p.end, first.start)]`.
  - if `first.start > p.end`: `transit` segment `[p.end, first.start]` (queue / transport; label = hop label, type = hop type).
  - if `c !== first` and `c.start > first.start`: `wait` segment attributed to `c.group` over
    `[first.start, c.start]` (in-service async processing — e.g. a Flink operator chain holding the
    message; all those Flink spans are siblings under the Kafka producer span).
- Finally `work` for the target over `[target.start, target.end]`.

Clamp negative lengths to 0 (clock skew) and drop zero-length segments; record skew in `journey.warnings`.
*Clarified:* the chain follows `causalParent` and `first` is picked among `p.causalChildren`; a segment that starts before the previous one ended is clipped to it, so segments are time-ordered, non-overlapping and sum to `total`; a full tie for the default target → the later span in span order.

```
Journey = {
  target: Span, chain: Span[],
  segments: [{ type:'work'|'transit'|'wait', group, span /* owning span (for transit: the parent p) */,
               toSpan /* transit/wait: the span reached */, start, end, duration, label }],
  byGroup: [{ group, work, wait, total }]   // sorted by total desc
  transitTotal, workTotal, waitTotal,
  total /* target.end - chain[0].start */,
  warnings: string[]
}
```
`span.onJourney` is NOT stored on spans (the journey target changes); views use a `Set` of chain ids.

### 2.2 Insights — `model.insights: Insight[]`

`{ id, kind, severity: 'critical'|'warning'|'info', title, detail, metric /* number, ms or count */,
   spanIds: string[], groupKeys: string[] }` sorted by severity then metric desc. Kinds:

1. `error` (critical) — each error span (title: `"<group>: <name> failed"`, detail: status message / exception event message).
2. `slow-hop` (warning) — async hops whose `queue` ≥ max(25 ms, 4 × median queue of all async hops).
   Title like `"125.4 ms queue: order-intake → order-orchestrator"`, detail names topic.
3. `orphan` (warning) — each orphan: `"Missing parent span <id8> for <group>: <name>"`; detail: the
   caller is not instrumented or the span was dropped; include hints from attrs (`user_agent.original`,
   `client.address`, `http.user_agent`, `net.peer.ip`) and, if any other span's resource/attrs contains the same
   IP (e.g. `k8s.pod.ip`, `network.peer.address`, `client.address` on a different group), name that group as the
   likely caller.
4. `async-wait` (info, warning if ≥ 250 ms) — `wait` segments on the default journey ≥ 50 ms.
5. `repeated-query` (warning if count ≥ 10 else info) — same group + same `db.statement` (fallback name)
   executed ≥ 5 times; metric = count; detail includes total time.
6. `repeated-consume` (info) — the same producer span consumed ≥ 2 times by the same consumer group
   (e.g. one `publish` → 2 `process` spans in order-intake).
7. `fan-out` (info) — topics with ≥ 4 consumer groups.
8. `scope-crossing` (info) — edges whose `from`/`to` groups have different `deployScope`s (e.g. `forest → platform`).
9. `hotspot` (info) — top 3 groups by `journeyTime` on the default journey with % of journey total.
10. `skew` (info) — child span starting before its sync parent starts, or a sync child (client→server)
    ending > 1 ms after its parent ends.

*Clarified (most useful for Kafka/Flink debugging; the oracle follows these):* `slow-hop` only for the first delivery of a parent into a service (later same-service siblings are in-service waits — 3 cards on the sample, not 23) ·
`orphan` groupKeys include the likely callers, and a server/consumer span whose peer address is the orphan's client IP points at its parent's service ·
`repeated-consume` buckets consumers by service + Kafka consumer group, ignores context-inheriting operator spans when the bucket has real receive spans, and aggregates one card per producer service + topic + consumer service (metric = max repeat) ·
`scope-crossing` = hops whose two spans' `deployScope`s differ, one card per service pair, spanIds = both ends ·
`hotspot` spanIds = the group's chain spans + its work/wait segment spans · async relations are never `skew`.

## 3. `TV.store` and `TV.views` (js/core/store.js)

```
TV.store.get() → state                      // the live object; treat as read-only
TV.store.set(patch)                         // shallow merge; derived fields recomputed; notifies
TV.store.subscribe(fn /* (state, changed:Set<string>) */) → unsubscribe
TV.store.load(json, sourceName)             // parse + pick trace 0 + build model; throws on bad input
TV.store.matches(span) → boolean            // THE filter predicate every view uses
TV.store.groupMatches(groupKey) → boolean   // group has ≥1 matching span and passes selectedGroups
```

State:
```
{
  parse: ParseResult|null, sourceName: string, traceIndex: 0,
  groupBy: 'service',
  model: Model|null,            // derived: rebuilt when parse / traceIndex / groupBy change
  journey: Journey|null,        // derived: computeJourney(model, pathTargetId || default)
  pathTargetId: null,
  selectedSpanId: null, hoverSpanId: null,
  selectedGroups: [],           // focus filter; [] = all
  hoverGroup: null,
  search: '',                   // case-insensitive substring over name, group, op.summary, attr values
  filters: { categories: [] /* [] = all */, errorsOnly: false, minDuration: 0 },
  timeWindow: null,             // [startMs, endMs] zoom shared by timeline & tree
  view: 'map',                  // active tab id
  theme: 'auto',                // 'auto'|'light'|'dark'
  sidePanelOpen: true,
}
```
When `model` is rebuilt: clear `selectedSpanId` if it no longer exists, clear `selectedGroups`,
`hoverGroup`, `pathTargetId`, `timeWindow`. `changed` contains every key whose value changed (including
derived `model` / `journey`). `matches(span)` = passes search AND categories AND errorsOnly AND
`duration >= minDuration` AND (`selectedGroups` empty or contains span.group). **Views dim
non-matching items (opacity ~0.18) rather than removing them**, except the tree (may hide) and tables
(hide rows, show "N hidden by filters").

Views registry:
```
TV.views.register({ id, title, order, slot: 'main'|'side', shortcut /* '1'..'6' */,
  mount(container: HTMLElement, api) → { update(state, changed:Set<string>), destroy?() } })
TV.views.list() → sorted defs;  TV.views.get(id)
api = { store: TV.store, util: TV.util, selectSpan(id, {reveal}), selectGroup(key, {additive}),
        setPathTarget(spanId), showView(id) }
```
The shell creates `api` (the harness creates a compatible one). A view is mounted once (lazily on first
show) and then gets `update(state, changed)` calls; on first show after mount it receives
`update(state, new Set(['*']))` = "render everything". Views must not leak listeners on re-render and must
handle `state.model === null` (render an empty hint). Views must handle container resize
(`ResizeObserver`).

Interaction conventions (all views):
- click span → `api.selectSpan(id)` · hover span → `store.set({hoverSpanId})` (cheap; views may cross-highlight).
- click service (node / lane label / table row) → `api.selectGroup(key)` (solo; clicking the solo-selected one
  again clears); with Shift/Cmd/Ctrl → `api.selectGroup(key, {additive:true})` toggles membership.
- "Path to here" → `api.setPathTarget(spanId)` (sets `pathTargetId` and switches to journey view).
- Keyboard (shell): `/` focus search, `Esc` clear span selection then group selection, `1`–`6` switch tab,
  `[`/`]` previous/next span in time order (selected).

## 4. `TV.util` (js/core/util.js)

```
fmtMs(ms)            → '850 µs' (<1) | '12.8 ms' (<100: 1 decimal) | '142 ms' (<1000) | '1.77 s'
fmtOffset(ms)        → '+12.8 ms' style (for t+ offsets)
fmtEpoch(epochMs)    → 'Oct 14 2026 09:25:03.220' (local time)
fmtCount(n)          → '1,234'
pct(part, whole)     → '12%'
el(tag, props?, ...children)   // props: {class, style(obj|string), dataset, attrs, on:{evt:fn}, text, title}
                               // children: Node | string (→ text node) | null/false (skipped) | arrays
svg(tag, attrs?, ...children)  // SVG namespace equivalent
clear(node)
CATEGORIES = [{id:'messaging', label:'Kafka / messaging'}, {id:'db', label:'Database'},
              {id:'rpc', label:'gRPC'}, {id:'http', label:'HTTP'}, {id:'internal', label:'Internal'}]
catClass(cat)        → 'cat-<id>'   (CSS supplies fill/background/stroke via tokens)
mergeIntervals(list) → merged sorted [[s,e]]; unionLength(list) → number
niceTicks(min, max, approxCount) → number[]
debounce(fn, ms), rafThrottle(fn)
copyText(text)       → Promise (navigator.clipboard with textarea fallback)
truncateMiddle(str, max)
shortTopic(name)     → strip common prefixes only if longer than 40 chars (keep readable)
shortRpc(service)    → last dotted segment ('example.inventory.v1.StockService' → 'StockService')
tooltip.show(clientX, clientY, content /* Node | [label, value][] rows */), tooltip.move(x,y), tooltip.hide()
  // single shared absolutely-positioned div.tv-tooltip, flips to stay in viewport, pointer-events:none
statusIcon(status)   → small Node ('!' in a critical-colored circle for error; nothing otherwise)
median(arr), quantile(arr, q)
```
`util.js` must not touch the DOM at load (create the tooltip div lazily).

## 5. Visual language (css/base.css tokens — views use only these)

`css/base.css` already exists and defines every token below plus shared components: `.tv-btn` (`--ghost`, `--icon`, `--sm`),
`.tv-seg` (segmented control; `aria-pressed` on buttons), `.tv-chip`, `.tv-badge` (`--strong`, `--critical`, `--warning`),
`.tv-status` (`--critical|--warning|--info|--good`), `.tv-svc` (service name chip), `.tv-input`, `.tv-select`, `.tv-check`,
`.tv-card`, `.tv-section-title`, `.tv-empty`, `.tv-table` (`th.is-sortable`, `td.num`, `tr.is-selected`), `.tv-kv` (dl grid),
`.tv-tooltip` (+ `.tv-tt-title`, `.tv-tt-rows`, `.tv-tt-label`, `.tv-tt-value`, `.tv-tt-key` with `--c`), `.tv-dot`, `.tv-key`,
`.tv-hatch`, `.tv-dots`, `.tv-num`, `.tv-mono`, `.tv-muted`, `.tv-secondary`, `.tv-ellipsis`, `.is-dimmed`, `.is-hidden`,
plus `--pattern-ink`, `--shadow-pop`, `--dim`, `--font-ui`, `--font-mono`, `--fs-xs|sm|md|lg`, `--radius-sm|md|lg`.
Add new shared pieces only in your own css file, prefixed with your view id (e.g. `.tl-…` for timeline).

Color encodes **category**, never service identity (27+ services cannot get distinct hues). service identity is
carried by position + text labels. Categorical slots (validated palette, fixed order):

| token | light | dark | meaning |
|---|---|---|---|
| `--cat-messaging` | `#2a78d6` | `#3987e5` | Kafka / messaging |
| `--cat-db` | `#eb6834` | `#d95926` | Database |
| `--cat-rpc` | `#1baf7a` | `#199e70` | gRPC |
| `--cat-http` | `#eda100` | `#c98500` | HTTP |
| `--cat-internal` | `#a3a29b` | `#6b6a65` | Internal (neutral) |
| `--status-critical` | `#d03b3b` | `#d03b3b` | error (always with icon + label) |
| `--status-warning` | `#fab219` | `#fab219` | warning (icon + label) |
| `--status-good` | `#0ca30c` | `#0ca30c` | |
| `--surface-0` | `#f9f9f7` | `#0d0d0d` | page plane |
| `--surface-1` | `#fcfcfb` | `#1a1a19` | chart/card surface |
| `--surface-2` | `#ffffff` | `#232322` | raised (tooltip, popover, node fill) |
| `--surface-hover` | `rgba(11,11,11,.05)` | `rgba(255,255,255,.06)` | hover wash |
| `--text-1` | `#0b0b0b` | `#ffffff` | primary ink (also selection outline) |
| `--text-2` | `#52514e` | `#c3c2b7` | secondary ink |
| `--text-3` | `#898781` | `#898781` | muted (axes, hints) |
| `--grid` | `#e1e0d9` | `#2c2c2a` | gridlines |
| `--axis` | `#c3c2b7` | `#383835` | baselines, edges at rest |
| `--border` | `rgba(11,11,11,.10)` | `rgba(255,255,255,.10)` | hairlines |
| `--focus` | `#2a78d6` | `#3987e5` | keyboard focus ring |

Dark tokens are declared under both `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }`
and `:root[data-theme="dark"] {…}`. Utility classes in base.css: `.cat-<id>` sets `fill`, `background-color`
and `--c` for that category; `.cat-stroke-<id>` sets `stroke`. Transit (queue) segments use a hatched
neutral pattern; `wait` segments use a dotted/striped pattern — define `.tv-hatch` / `.tv-dots`
(CSS `repeating-linear-gradient`) for HTML, and each SVG view defines its own `<pattern>` using `--text-3`.

Marks: thin bars (span bars 6–14 px tall), 2 px radius, 1 px surface gap between adjacent bars,
recessive gridlines/axes, selected = 1.5–2 px `--text-1` outline, hover = lighten + outline,
dimmed = opacity .18. Errors: `--status-critical` outline + `!` marker, never color alone.
Typography: `system-ui, -apple-system, "Segoe UI", sans-serif`, 12–13 px UI, `tabular-nums` for numbers in
tables/axes, `ui-monospace, SFMono-Regular, Menlo, monospace` for IDs/SQL. Every chart has a legend for
categories (shell renders one global legend in the toolbar; views may add a local one). Every hoverable
mark has a tooltip (values lead, labels follow) and every tooltip value is also reachable via the detail
panel or a table.

## 6. Shell layout (index.html + js/app.js + css/base.css)

```
┌ header: ◉ Trace Lens · trace <id8…> (copy) · <start time> · <duration> · <N spans> · <N services> · <N errors>
│         [trace ▾ if >1] [Group by: Service | Namespace | Scope] [Open file] [theme ◐]
├ toolbar: [🔍 search /] [Kafka][DB][gRPC][HTTP][Internal] chips (= category filter + legend)
│          [errors only] [min dur ▾ 0/1/5/10/50/100 ms] [focused services: chip × …] [clear]
├ tabs: Flow map(1) | Timeline(2) | Journey(3) | services(4) | Spans(5) | Insights(6) (+ badge counts)
├ main view (flex 1)                              │ side panel (detail view; resizable 320–640 px; collapsible)
```
- Loading: drag-and-drop anywhere (full-window overlay), "Open file" (`<input type=file accept=.json>`),
  paste JSON (Cmd/Ctrl+V when focus is not in an input, and a "Paste JSON" button opening a textarea dialog).
  On start, auto-load `window.TV_SAMPLE_TRACE` if defined; otherwise show an empty-state drop zone with
  instructions ("In Grafana: Explore → Tempo → trace → Download → JSON").
- Parse errors → inline error banner, never a blank page.
- Persist `theme`, `groupBy`, `view`, side panel width in `localStorage` (try/catch, optional).
  `location.hash` mirrors the view (`#map`).
- Header numbers come from `state.model.stats` / `model.duration` / `model.t0Epoch`.

## 7. Views (behavioral spec — each in its own file + css)

### map — Flow map
Service graph of services. **Layered left→right layout** in causal order: rank(g) = 0 when no time-forward
in-edge; rank(b) = max(rank(a)+1) over edges a→b where a.first ≤ b.first (time-forward); edges that go
backward in time are drawn as curved "return" edges (dashed lighter). Order nodes within a column by
barycenter of predecessors (several sweeps) to reduce crossings. Node = rounded rect on `--surface-2`
with hairline border: service label (truncate middle, full in tooltip), a sub-line (`N spans · active 12.3 ms`),
a thin stacked bar of `categoryTime`, error badge, scope badge (e.g. `FOREST`) when the group's scope differs
from the majority scope. Groups with the same deployScope that differ from the majority are enclosed in
a dashed labeled boundary box ("forest") if they're contiguous enough — otherwise badge only.
Edges: smooth cubic paths, width ∝ log2(count+1), **dashed for async (kafka)**, solid for sync; color =
`--axis` at rest, category color of the hop type on hover/selection (kafka→messaging, grpc→rpc, http→http);
arrowheads. Edge label (on hover, or always when "Labels" toggle on): `topic-or-rpc · ×N · 9.1 ms`.
Journey overlay (toggle, on by default): edges & nodes on `state.journey` chain drawn with `--text-1` 2px.
Toggle "Topics as nodes": insert Kafka topic pill nodes between producers and consumers (producer→topic→
consumers) to make fan-out explicit. Toggle "Databases": cylinder-ish nodes connected to their groups.
Hover node → highlight its neighborhood, dim the rest; click node → select group; click edge → tooltip
pinned with its hops list (each clickable → selectSpan(child)). Pan (drag background) + zoom (wheel,
pinch) + "Fit" button; fits on first render and on groupBy change. Respects `store.groupMatches`.

### timeline — Swimlanes by service
One lane per group (order: first start; option: by journey time, by self time). Left gutter (resizable,
~220 px): service label, span count, caret to expand. **Collapsed lane**: spans greedily packed into sub-rows
(max 4 rows; overflow spans drawn on the last row), bars colored by category, thin. **Expanded lane**:
one row per span of that group, indented by depth-within-group, name label inside/next to the bar.
Top: time axis (relative ms, nice ticks, gridlines) + overview minimap of the whole trace showing activity
density; brush on the minimap sets `timeWindow`; wheel + Ctrl/Cmd (or pinch) zooms around the cursor;
drag pans; double-click resets. Hop connectors: elbow/curve from the parent bar (at parent row) to the
child bar start, dashed for async — drawn for the selected/hovered span's hops and for the journey chain
(toggle "All hops" draws every hop faintly). Journey chain spans get a `--text-1` outline. A "Journey"
pseudo-lane pinned at top renders the journey segments (work in category color, transit hatched, wait
dotted). Render bars on `<canvas>` (devicePixelRatio aware) for perf, with DOM/SVG for labels/axis, and
a hit-test for hover/click. Must stay smooth (≥ 30 fps zoom/pan) at 5,000 spans. Tooltip on hover.
Selected span: outline + its ancestors' lanes subtly highlighted. Shares `timeWindow` with tree.

### journey — Where did the time go?
Explains `state.journey` (default target = latest-ending span). Header: target picker (`<select>` listing
per-group last-ending span + current target; "or click any span → Path to here"), totals:
`total · work · queue/transport · in-service wait`. (1) A single full-width stacked bar of the segments in time
order (work = category color of the segment's span, transit = hatched, wait = dotted), with labels for
segments ≥ 4% width, tooltip per segment. (2) A vertical **step list** (subway-map style): per chain step
the service name, span name + op summary, start offset `t+`, a mini segment bar on a shared time scale, and
between steps a connector row showing the transit/wait (type icon/label, topic or rpc, duration); connectors
with queue ≥ 25 ms or flagged by insights are emphasized (warning icon + label). Click a step → selectSpan.
(3) "Time by service on this path": ranked horizontal bars of `byGroup` (work solid, wait dotted) + one
"Queues / transport" row; click → selectGroup.

### svc — service table
Sub-tabs: **services** | **Topics** | **Databases**. services table columns: service (with namespace/scope badges),
Spans, Errors, First (t+), Last (t+), Active, Self time, Journey time, DB calls / DB time, Topics out / in,
an **activity strip** (tiny inline bar over the full trace duration showing `intervals`), and a category
self-time stacked bar. Sortable (click header; default: First). Click row → selectGroup; expand row → topics
produced/consumed, DB tables, top 5 operations by total duration (clickable → select first span), in/out
edges with counts and latency. Topics table: topic, producers, consumer services (count + names), deliveries,
latency min/avg/max. Databases table: db, system, host (truncated), services, queries, total time, top tables.
"Copy CSV" button for the visible table. Respects filters (hide non-matching rows; footer shows hidden count).

### tree — Span tree
Classic collapsible waterfall: row = span (indent by depth, caret, service label chip in muted ink, name,
category dot, duration bar on the shared time scale honoring `timeWindow`, duration text, error icon).
**Group boundary marker**: when a span's group differs from its parent's, show a small "→ service" hop badge
with hop type (Kafka/gRPC/HTTP) and latency. Toggle "Collapse by service": collapse each maximal same-group
subtree into one summary row ("inventory-api · 15 spans · 31.2 ms"), expandable. Filtering: hide
non-matching spans but keep their ancestors (dimmed) for context. Orphans appear as extra roots with a
"missing parent" badge. Virtualized rendering (only visible rows in the DOM) so 5,000 spans scroll smoothly.
Keyboard: ↑/↓ move selection, ←/→ collapse/expand. Selecting a span elsewhere scrolls it into view.

### insights — Insights
Cards grouped by severity (Critical / Warning / Info), each with icon + severity label (never color alone),
title, detail, metric, and actions: "Show span" (selectSpan first spanId + switch to timeline),
"Focus services" (selectGroup(s)), "Path to here" when relevant. Summary line at top
(`2 warnings · 7 info`). Empty state: "No issues detected".

### detail — side panel (slot 'side')
- Span selected: header (status icon, name, service chip (click → selectGroup), kind, category). Facts grid:
  start `t+` & absolute time, duration, self time, depth, span id (copy), trace id (copy), parent (clickable
  name or "missing <id>"), children count. **Op card** per category: db → statement in a monospace block
  (wrap) + system/db/table/host; messaging → topic, operation, partition/offset/key, consumer group;
  rpc → service/method/status; http → method/url/status. If the span is a hop target, show "← from
  <service> via <type> <label> · latency/queue". Sections (collapsible): Attributes (filterable key/value
  table, values monospace, copy on click), Resource (collapsed by default), Events (time relative to span
  start; consecutive identical event names collapsed into one row "234 × message" expandable), Links
  (clickable when target in trace), Children (clickable list with service + duration). Actions: "Path to here",
  "Focus service", "Copy span JSON" (the RawSpan-ish object without parent/children refs).
- Else one group selected: service summary (stats grid, category bar, inbound/outbound edges with counts &
  latency, topics, databases, top operations).
- Else: trace summary (counts, roots, orphans, duration, journey headline) + hint.

## 8. Testing tools

Core: `node tests/core.test.js` (plain assertions) and `node tests/compare.js` (JS core vs the Python oracle in
`tests/oracle-out`, every fixture × service/namespace, 0.002 ms tolerance; regenerate with `python3 -I tests/run_oracle.py`).

Headless Chrome helper (parallel-safe, one browser per run):
```
node $TOOLS/browse.js "file://$PROJECT/index.html#timeline" --shot /tmp/x.png --width 1440 --height 900 \
     [--theme dark] [--wait 800] [--eval "JS expression"] [--script my-steps.js]
```
`$TOOLS` is a local folder with `browse.js` (puppeteer-core driving the system Chrome); it is not part of this repo.
(`--script` file: `module.exports = async (page, {sleep}) => result`; puppeteer-core is resolvable via
`NODE_PATH=$TOOLS/node_modules`). Read screenshots with the Read tool to look at them. Prints console
errors + page errors — the app must produce **zero** console errors.

Reference numbers for the demo sample trace (`data/sample-trace.json`, generated by `tests/make_demo_trace.py`, fully
fictional): 1 trace `4bf92f3577b34da6a3ce929d0e0e4736`, 68 spans, 15 services, 13 namespaces, 2 deploy scopes (`forest`,
`platform`), duration 668.3 ms, 1 root (storefront-gateway `orders-raw publish`), 1 orphan (api-gateway `POST`,
parent `9e3f1c0a7b2d4e65` missing; likely caller fulfillment-job via `k8s.pod.ip`), 1 error span, max depth 12.
