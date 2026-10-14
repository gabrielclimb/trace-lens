#!/usr/bin/env python3
"""Generate Trace Lens test fixtures from data/sample-trace.json (standard library only).

    python3 -I tests/make_fixtures.py

Writes tests/fixtures/:
  otlp-resourcespans.json  sample re-shaped as {resourceSpans:[{resource, scopeSpans:[{scope, spans}]}]};
                           timestamps and intValues as strings, ids base64, kinds as integers,
                           status codes as 'STATUS_CODE_*' strings, root parentSpanId omitted.
  jaeger.json              sample converted to Jaeger JSON (us times, CHILD_OF refs, processes).
  multi-trace.json         sample + a 6-span second trace (3 services, 1 ERROR, a Kafka pair), one {batches}.
  errors.json              20-span synthetic trace (4 services) exercising errors, an orphan, a repeated
                           query x6, a 4-consumer-group fan-out, clock skew, slow hop, async wait.
  synthetic-5k.json        deterministic ~5,000-span trace across 40 services (seeded).
All output is deterministic.
"""
import base64
import heapq
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SAMPLE = os.path.join(ROOT, 'data', 'sample-trace.json')
OUT = os.path.join(HERE, 'fixtures')

KIND_NUM = {'SPAN_KIND_UNSPECIFIED': 0, 'SPAN_KIND_INTERNAL': 1, 'SPAN_KIND_SERVER': 2,
            'SPAN_KIND_CLIENT': 3, 'SPAN_KIND_PRODUCER': 4, 'SPAN_KIND_CONSUMER': 5}
STATUS_STR = {0: 'STATUS_CODE_UNSET', 1: 'STATUS_CODE_OK', 2: 'STATUS_CODE_ERROR'}


def write(name, doc, indent=None):
    path = os.path.join(OUT, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=indent, separators=None if indent else (',', ':'))
        f.write('\n')
    return path


def b64(hex_id):
    return base64.b64encode(bytes.fromhex(hex_id)).decode('ascii') if hex_id else ''


def attr(k, v):
    if isinstance(v, bool):
        return {'key': k, 'value': {'boolValue': v}}
    if isinstance(v, int):
        return {'key': k, 'value': {'intValue': v}}
    if isinstance(v, float):
        return {'key': k, 'value': {'doubleValue': v}}
    return {'key': k, 'value': {'stringValue': str(v)}}


def attrs(d):
    return [attr(k, v) for k, v in d.items()]


def attr_plain(a):
    v = a.get('value') or {}
    for k in ('stringValue', 'intValue', 'doubleValue', 'boolValue', 'bytesValue'):
        if k in v:
            return v[k]
    return None


# ------------------------------------------------------------------------------------------
# sample re-shapes
# ------------------------------------------------------------------------------------------

def stringify_int_values(lst):
    out = []
    for a in lst or []:
        v = a.get('value') or {}
        if 'intValue' in v:
            out.append({'key': a['key'], 'value': {'intValue': str(v['intValue'])}})
        else:
            out.append(a)
    return out


def to_resource_spans(sample):
    rss = []
    for rs in sample['batches']:
        scope_spans = []
        for ils in rs['instrumentationLibrarySpans']:
            spans = []
            for s in ils['spans']:
                t = {'traceId': b64(s['traceId']), 'spanId': b64(s['spanId'])}
                if s.get('parentSpanId'):
                    t['parentSpanId'] = b64(s['parentSpanId'])
                t['name'] = s['name']
                t['kind'] = KIND_NUM[s['kind']]
                t['startTimeUnixNano'] = str(s['startTimeUnixNano'])
                t['endTimeUnixNano'] = str(s['endTimeUnixNano'])
                t['attributes'] = stringify_int_values(s.get('attributes'))
                if s.get('events'):
                    t['events'] = [{'timeUnixNano': str(e['timeUnixNano']), 'name': e['name'],
                                    'attributes': stringify_int_values(e.get('attributes'))} for e in s['events']]
                if s.get('links'):
                    t['links'] = [{'traceId': b64(l['traceId']), 'spanId': b64(l['spanId']),
                                   'attributes': stringify_int_values(l.get('attributes'))} for l in s['links']]
                st = s.get('status') or {}
                t['status'] = {'code': STATUS_STR[int(st.get('code') or 0)]}
                if st.get('message'):
                    t['status']['message'] = st['message']
                spans.append(t)
            scope_spans.append({'scope': ils.get('instrumentationLibrary') or {}, 'spans': spans})
        rss.append({'resource': {'attributes': stringify_int_values(rs['resource']['attributes'])},
                    'scopeSpans': scope_spans})
    return {'resourceSpans': rss}


def jaeger_tag(k, v):
    if isinstance(v, bool):
        return {'key': k, 'type': 'bool', 'value': v}
    if isinstance(v, int):
        return {'key': k, 'type': 'int64', 'value': v}
    if isinstance(v, float):
        return {'key': k, 'type': 'float64', 'value': v}
    return {'key': k, 'type': 'string', 'value': '' if v is None else str(v)}


def to_jaeger(sample):
    trace_id = None
    spans, processes = [], {}
    for i, rs in enumerate(sample['batches'], 1):
        res = {a['key']: attr_plain(a) for a in rs['resource']['attributes']}
        pid = 'p%d' % i
        processes[pid] = {'serviceName': res.get('service.name'),
                          'tags': [jaeger_tag(k, v) for k, v in res.items() if k != 'service.name']}
        for ils in rs['instrumentationLibrarySpans']:
            lib = ils.get('instrumentationLibrary') or {}
            for s in ils['spans']:
                trace_id = trace_id or s['traceId']
                start_us = s['startTimeUnixNano'] // 1000
                end_us = s['endTimeUnixNano'] // 1000
                tags = [jaeger_tag(a['key'], attr_plain(a)) for a in s.get('attributes') or []]
                kind = s['kind'][len('SPAN_KIND_'):].lower()
                if kind != 'unspecified':
                    tags.append(jaeger_tag('span.kind', kind))
                code = int((s.get('status') or {}).get('code') or 0)
                if code == 1:
                    tags.append(jaeger_tag('otel.status_code', 'OK'))
                elif code == 2:
                    tags.append(jaeger_tag('otel.status_code', 'ERROR'))
                    tags.append(jaeger_tag('error', True))
                if lib.get('name'):
                    tags.append(jaeger_tag('otel.scope.name', lib['name']))
                if lib.get('version'):
                    tags.append(jaeger_tag('otel.scope.version', lib['version']))
                refs = []
                if s.get('parentSpanId'):
                    refs.append({'refType': 'CHILD_OF', 'traceID': s['traceId'], 'spanID': s['parentSpanId']})
                    for l in s.get('links') or []:
                        refs.append({'refType': 'FOLLOWS_FROM', 'traceID': l['traceId'], 'spanID': l['spanId']})
                logs = [{'timestamp': e['timeUnixNano'] // 1000,
                         'fields': [jaeger_tag('event', e['name'])] +
                                   [jaeger_tag(a['key'], attr_plain(a)) for a in e.get('attributes') or []]}
                        for e in s.get('events') or []]
                spans.append({'traceID': s['traceId'], 'spanID': s['spanId'], 'operationName': s['name'],
                              'references': refs, 'startTime': start_us, 'duration': end_us - start_us,
                              'tags': tags, 'logs': logs, 'processID': pid, 'warnings': None, 'flags': 1})
    return {'data': [{'traceID': trace_id, 'spans': spans, 'processes': processes, 'warnings': None}],
            'total': 0, 'limit': 0, 'offset': 0, 'errors': None}


# ------------------------------------------------------------------------------------------
# small synthetic traces
# ------------------------------------------------------------------------------------------

def build_otlp(trace_id, services, span_defs, base_ns, string_times, scope_key='scopeSpans'):
    """services: {svc: resource dict}; span_defs: list of dicts with svc, id, parent, name, kind,
    start/end (ms floats), attrs, status (code, message), events [(ms, name, attrs)]."""
    by_svc = {}
    for d in span_defs:
        def t(ms_):
            ns = base_ns + round(ms_ * 1_000_000)
            return str(ns) if string_times else ns
        sp = {'traceId': trace_id, 'spanId': d['id'], 'parentSpanId': d.get('parent', ''), 'name': d['name'],
              'kind': d['kind'], 'startTimeUnixNano': t(d['start']), 'endTimeUnixNano': t(d['end']),
              'attributes': attrs(d.get('attrs', {})),
              'status': {'code': d.get('status', (0, ''))[0], 'message': d.get('status', (0, ''))[1]}}
        if d.get('events'):
            sp['events'] = [{'timeUnixNano': t(ems), 'name': en, 'attributes': attrs(ea)}
                            for ems, en, ea in d['events']]
        by_svc.setdefault(d['svc'], []).append(sp)
    lib_key = 'scope' if scope_key == 'scopeSpans' else 'instrumentationLibrary'
    return [{'resource': {'attributes': attrs(services[svc])},
             scope_key: [{lib_key: {'name': 'io.opentelemetry.synthetic', 'version': '1.0.0'}, 'spans': spans}]}
            for svc, spans in by_svc.items()]


def second_trace():
    tid = '7a1e0000000000000000000000000002'
    services = {
        'checkout-api': {'service.name': 'checkout-api', 'k8s.namespace.name': 'checkout',
                         'deployment.scope.name': 'platform', 'k8s.pod.name': 'checkout-api-5d9f7-x1'},
        'order-worker': {'service.name': 'order-worker', 'k8s.namespace.name': 'orders',
                         'deployment.scope.name': 'platform', 'k8s.pod.name': 'order-worker-77c4b-x2'},
        'stock-svc': {'service.name': 'stock-svc', 'k8s.namespace.name': 'stock',
                        'deployment.scope.name': 'forest', 'k8s.pod.name': 'stock-svc-6b8d9-x3'},
    }
    rpc = {'rpc.system': 'grpc', 'rpc.service': 'stock.v1.ReservationService', 'rpc.method': 'Reserve'}
    spans = [
        dict(svc='checkout-api', id='7a1e000000000001', name='POST /checkout', kind='SPAN_KIND_SERVER',
             start=0, end=40, attrs={'http.request.method': 'POST', 'http.route': '/checkout',
                                     'http.response.status_code': 202}, status=(1, '')),
        dict(svc='checkout-api', id='7a1e000000000002', parent='7a1e000000000001', name='orders send',
             kind='SPAN_KIND_PRODUCER', start=5, end=6,
             attrs={'messaging.system': 'kafka', 'messaging.destination.name': 'orders',
                    'messaging.operation': 'publish'}),
        dict(svc='order-worker', id='7a1e000000000003', parent='7a1e000000000002', name='orders process',
             kind='SPAN_KIND_CONSUMER', start=15, end=35,
             attrs={'messaging.system': 'kafka', 'messaging.source.name': 'orders', 'messaging.operation': 'process',
                    'messaging.kafka.consumer.group': 'order-worker'}),
        dict(svc='order-worker', id='7a1e000000000004', parent='7a1e000000000003',
             name='stock.v1.ReservationService/Reserve', kind='SPAN_KIND_CLIENT', start=16, end=30,
             attrs=dict(rpc, **{'rpc.grpc.status_code': 2})),
        dict(svc='stock-svc', id='7a1e000000000005', parent='7a1e000000000004',
             name='stock.v1.ReservationService/Reserve', kind='SPAN_KIND_SERVER', start=17, end=29,
             attrs=dict(rpc, **{'rpc.grpc.status_code': 2}), status=(2, 'out of stock'),
             events=[(28.5, 'exception', {'exception.type': 'OutOfStock', 'exception.message': 'out of stock'})]),
        dict(svc='stock-svc', id='7a1e000000000006', parent='7a1e000000000005', name='INSERT stock.reservations',
             kind='SPAN_KIND_CLIENT', start=18, end=20,
             attrs={'db.system': 'postgresql', 'db.name': 'stock', 'db.operation': 'INSERT',
                    'db.sql.table': 'reservations', 'db.statement': 'insert into reservations (id, quantity) values ($1, $2)',
                    'server.address': 'stock-db.internal'}),
    ]
    return build_otlp(tid, services, spans, 1791967800000000000, string_times=False,
                      scope_key='instrumentationLibrarySpans')


def multi_trace(sample):
    batches = list(sample['batches'])
    extra = second_trace()
    return {'batches': batches[:10] + extra + batches[10:]}


def errors_trace():
    tid = 'e7707e57000000000000000000000001'
    services = {
        'gateway-api': {'service.name': 'gateway-api', 'k8s.namespace.name': 'edge',
                        'deployment.scope.name': 'platform', 'k8s.pod.name': 'gateway-api-6f7c9-abcde',
                        'k8s.pod.ip': '10.20.30.40'},
        'orders-service': {'service.name': 'orders-service', 'k8s.namespace.name': 'orders',
                           'deployment.scope.name': 'platform', 'k8s.pod.name': 'orders-service-7b5d-fghij'},
        'invoicing-service': {'service.name': 'invoicing-service', 'k8s.namespace.name': 'orders',
                            'deployment.scope.name': 'forest', 'k8s.pod.name': 'invoicing-service-59f8-klmno'},
        'audit-worker': {'service.name': 'audit-worker', 'k8s.namespace.name': 'audit',
                         'deployment.scope.name': 'platform', 'k8s.pod.name': 'audit-worker-6c4d-pqrst'},
    }
    kafka_pub = {'messaging.system': 'kafka', 'messaging.destination.name': 'order-events',
                 'messaging.operation': 'publish'}

    def kafka_con(group):
        return {'messaging.system': 'kafka', 'messaging.destination.name': 'order-events',
                'messaging.operation': 'process', 'messaging.kafka.consumer.group': group}

    def rpc(service, method):
        return {'rpc.system': 'grpc', 'rpc.service': service, 'rpc.method': method, 'rpc.grpc.status_code': 0}

    stmt = 'select * from order_item where order_id = $1'
    spans = [
        dict(svc='gateway-api', id='aa00000000000001', name='POST /orders', kind='SPAN_KIND_SERVER', start=0, end=70,
             attrs={'http.request.method': 'POST', 'http.route': '/orders', 'url.scheme': 'https',
                    'http.response.status_code': 201}),
        # sync gRPC client; its server child (bb..01) starts 0.4 ms BEFORE it -> skew
        dict(svc='gateway-api', id='aa00000000000002', parent='aa00000000000001',
             name='orders.v1.OrderService/Create', kind='SPAN_KIND_CLIENT', start=1.0, end=65,
             attrs=dict(rpc('orders.v1.OrderService', 'Create'), **{'server.address': 'orders-service.orders.svc'})),
        dict(svc='orders-service', id='bb00000000000001', parent='aa00000000000002',
             name='orders.v1.OrderService/Create', kind='SPAN_KIND_SERVER', start=0.6, end=64.5,
             attrs=rpc('orders.v1.OrderService', 'Create')),
    ]
    for i in range(6):  # repeated statement x6 (N+1)
        spans.append(dict(svc='orders-service', id='bb0000000000000%d' % (i + 2), parent='bb00000000000001',
                          name='SELECT orders.order_item', kind='SPAN_KIND_CLIENT', start=2 + 5 * i, end=5 + 5 * i,
                          attrs={'db.system': 'postgresql', 'db.name': 'orders', 'db.operation': 'SELECT',
                                 'db.sql.table': 'order_item', 'db.statement': stmt,
                                 'server.address': 'orders-db.internal', 'server.port': 5432}))
    spans += [
        dict(svc='orders-service', id='bb00000000000008', parent='bb00000000000001', name='order-events send',
             kind='SPAN_KIND_PRODUCER', start=60, end=62, attrs=kafka_pub),
        # fan-out of order-events to 4 consumer groups (orders-service itself, gateway-api, invoicing, audit)
        dict(svc='orders-service', id='bb00000000000009', parent='bb00000000000008', name='order-events process',
             kind='SPAN_KIND_CONSUMER', start=63, end=64, attrs=kafka_con('orders-self')),
        dict(svc='gateway-api', id='aa00000000000003', parent='bb00000000000008', name='order-events receive',
             kind='SPAN_KIND_CONSUMER', start=64, end=66),  # topic only from the name
        dict(svc='invoicing-service', id='cc00000000000000', parent='bb00000000000008',
             name='OrderDeserializer.deserialize', kind='SPAN_KIND_CONSUMER', start=63.0, end=63.2,
             attrs={'topic': 'order-events', 'partition': 3, 'offset': 1200}),
        # slow hop (58 ms queue) and in-service wait (63 -> 120 ms) on the default journey
        dict(svc='invoicing-service', id='cc00000000000001', parent='bb00000000000008', name='order-events process',
             kind='SPAN_KIND_CONSUMER', start=120, end=155, attrs=kafka_con('invoicing')),
        dict(svc='invoicing-service', id='cc00000000000002', parent='cc00000000000001', name='IssueInvoice',
             kind='SPAN_KIND_INTERNAL', start=122, end=150, attrs={'code.function': 'issueInvoice'},
             status=(2, ''),
             events=[(149, 'exception', {'exception.type': 'InvoiceRejectedException',
                                         'exception.message': 'invoice rejected: missing tax id',
                                         'exception.stacktrace': 'InvoiceRejectedException: invoice rejected\n\tat Invoicing.issue'})]),
        dict(svc='invoicing-service', id='cc00000000000003', parent='cc00000000000001',
             name='audit.v1.AuditService/Record', kind='SPAN_KIND_CLIENT', start=151, end=153,
             attrs=rpc('audit.v1.AuditService', 'Record')),
        # sync server child ends 3 ms after its client parent -> skew; also the latest-ending span
        dict(svc='audit-worker', id='dd00000000000004', parent='cc00000000000003',
             name='audit.v1.AuditService/Record', kind='SPAN_KIND_SERVER', start=151.5, end=156,
             attrs=rpc('audit.v1.AuditService', 'Record')),
        # error via attribute only (status unset)
        dict(svc='audit-worker', id='dd00000000000001', parent='bb00000000000008', name='order-events process',
             kind='SPAN_KIND_CONSUMER', start=70, end=75, attrs=dict(kafka_con('audit'), error=True)),
        # second consumer span of the same producer in the same service (repeated consume); topic via parent
        dict(svc='audit-worker', id='dd00000000000002', parent='bb00000000000008', name='listen',
             kind='SPAN_KIND_CONSUMER', start=70.1, end=74),
        # orphan: parent missing; client.address matches gateway-api's k8s.pod.ip
        dict(svc='audit-worker', id='dd00000000000003', parent='deadbeefdeadbeef', name='GET /audit/health',
             kind='SPAN_KIND_SERVER', start=30, end=31,
             attrs={'http.request.method': 'GET', 'http.route': '/audit/health', 'client.address': '10.20.30.40',
                    'user_agent.original': 'kube-probe/1.29', 'http.response.status_code': 200}),
    ]
    return {'resourceSpans': build_otlp(tid, services, spans, 1791967700000000000, string_times=True)}


# ------------------------------------------------------------------------------------------
# synthetic 5k
# ------------------------------------------------------------------------------------------

SERVICES_5K = [
    ('edge-gateway', 'edge', 'platform', 'gateway'), ('api-gateway', 'gateway', 'platform', 'proxy'),
    ('storefront-bridge', 'cart-events', 'forest', 'worker'), ('cart-events', 'cart-events', 'forest', 'worker'),
    ('session-vault', 'vault', 'forest', 'api'), ('cdn-edge', 'cdn-edge', 'forest', 'worker'),
    ('wishlist-monitor', 'wishlist', 'forest', 'worker'), ('wishlist-worker', 'wishlist', 'platform', 'worker'),
    ('customers-api', 'customers', 'platform', 'api'), ('inventory-api', 'inventory', 'platform', 'api'),
    ('inventory-writer', 'inventory', 'platform', 'worker'), ('pricing-api', 'pricing', 'platform', 'api'),
    ('recommend-api', 'recommend', 'platform', 'api'), ('recommend-scorer', 'recommend', 'platform', 'api'),
    ('seller-api', 'seller', 'platform', 'api'), ('catalog-api', 'catalog', 'platform', 'api'),
    ('currency-api', 'currency', 'platform', 'api'), ('quota-api', 'quota', 'platform', 'api'),
    ('reviews-api', 'reviews', 'platform', 'api'), ('notifications-api', 'notifications', 'platform', 'api'),
    ('devices-api', 'devices', 'platform', 'api'), ('shipping-api', 'shipping', 'platform', 'api'),
    ('orders-worker', 'stock', 'platform', 'worker'), ('returns-worker', 'returns', 'platform', 'worker'),
    ('restock-worker', 'stock', 'platform', 'worker'), ('tax-worker', 'tax', 'platform', 'worker'),
    ('invoicing-worker', 'invoicing', 'platform', 'worker'), ('receipts-worker', 'invoicing', 'platform', 'worker'),
    ('email-worker', 'notifications', 'platform', 'worker'), ('sms-worker', 'notifications', 'platform', 'worker'),
    ('audit-worker', 'audit', 'platform', 'worker'), ('search-indexer', 'search', 'platform', 'worker'),
    ('reporting-worker', 'reporting', 'platform', 'worker'), ('stock-auditor', 'stock', 'platform', 'worker'),
    ('spam-filter-job', 'spam', 'platform', 'flink'), ('invoicing-job', 'invoicing', 'platform', 'flink'),
    ('sessionizer-job', 'sessions', 'platform', 'flink'), ('returns-job', 'returns', 'platform', 'flink'),
    ('alerts-job', 'alerts', 'platform', 'flink'), ('image-resizer', 'media', 'platform', 'http-api'),
]
BASE_5K = 1791967600000000000
Q = 256  # every timestamp is a multiple of 256 ns -> exactly representable as a JS number


def synthetic_5k(target=5000, seed=20261014):
    """Deterministic ~5k-span trace. Every timestamp is a multiple of 256 ns, so the JSON numbers
    are exactly representable as float64 and JS parses them without rounding."""
    rng = random.Random(seed)
    assert BASE_5K % Q == 0
    svc_info = {s[0]: s for s in SERVICES_5K}
    apis = [s[0] for s in SERVICES_5K if s[3] == 'api']
    consumers = [s[0] for s in SERVICES_5K if s[3] in ('worker', 'flink')]
    producers = [s[0] for s in SERVICES_5K if s[3] in ('worker', 'flink', 'api', 'gateway')]
    topics, own_topics = {}, {}
    for p in producers:
        for k in range(rng.randint(1, 2)):
            name = '%s-%s-v%d' % (p.rsplit('-', 1)[0],
                                  rng.choice(['events', 'transactions', 'updates', 'commands']), k + 1)
            if name in topics:
                continue
            pool = [c for c in consumers if c != p] + ([p] if rng.random() < 0.1 else [])
            topics[name] = rng.sample(pool, rng.choice([1, 1, 2, 2, 3, 4, 5, 6]))
            own_topics.setdefault(p, []).append(name)
    tid = '5e7e000000000000000000000000005c'
    used, spans, deferred, seq = set(), [], [], [0]
    MAX_CALL_DEPTH, MAX_KAFKA_DEPTH = 4, 10

    def new_id():
        while True:
            x = rng.getrandbits(64)
            if x and x not in used:
                used.add(x)
                return '%016x' % x

    def q(ns):
        return (ns // Q) * Q

    def us(a, b):
        return rng.randint(a, b) * 1000

    def full():
        return len(spans) >= target

    def emit(svc, sid, parent, name, kind, start, end, at, status=(0, ''), events=None, links=None):
        start, end = q(start), q(end)
        end = max(end, start)
        sp = {'svc': svc, 'traceId': tid, 'spanId': sid, 'parentSpanId': parent or '', 'name': name,
              'kind': 'SPAN_KIND_' + kind.upper(), 'startTimeUnixNano': BASE_5K + start,
              'endTimeUnixNano': BASE_5K + end, 'attributes': attrs(at),
              'status': {'code': status[0], 'message': status[1]}}
        if events:
            sp['events'] = [{'timeUnixNano': BASE_5K + q(t), 'name': n, 'attributes': attrs(a)} for t, n, a in events]
        if links:
            sp['links'] = [{'traceId': tid, 'spanId': l, 'attributes': []} for l in links]
        spans.append(sp)
        return sid

    def status_and_events(end):
        r = rng.random()
        if r < 0.012:
            msg = rng.choice(['', 'deadline exceeded', 'constraint violation'])
            return (2, msg), [(end, 'exception', {'exception.type': 'RuntimeException',
                                                  'exception.message': msg or 'unexpected failure'})]
        return ((1, '') if r < 0.3 else (0, '')), None

    def db_call(svc, parent, t, stmt=None, table=None):
        table = table or rng.choice(['customers', 'transactions', 'balances', 'events', 'outbox', 'settings'])
        op = rng.choice(['SELECT', 'SELECT', 'SELECT', 'INSERT', 'UPDATE'])
        stmt = stmt or '%s ... %s where id = $1' % (op.lower(), table)
        d = us(80, 3000)
        st, ev = status_and_events(t + d)
        dbn = svc.split('-')[0]
        emit(svc, new_id(), parent, '%s %s.%s' % (op, dbn, table), 'client', t, t + d,
             {'db.system': 'postgresql', 'db.name': dbn, 'db.operation': op, 'db.sql.table': table,
              'db.statement': stmt, 'server.address': '%s-db.cluster.internal' % dbn, 'server.port': 5432},
             st, ev)
        return t + d

    def schedule(consumer, producer_id, topic, ready, kdepth, slow_ok=True):
        queue = us(200, 15000) if (not slow_ok or rng.random() < 0.85) else us(40000, 400000)
        seq[0] += 1
        heapq.heappush(deferred, (ready + queue, seq[0], consumer, producer_id, topic, kdepth))

    def publish(svc, parent, t, topic, kdepth):
        d = us(100, 3000)
        sid = emit(svc, new_id(), parent, '%s send' % topic, 'producer', t, t + d,
                   {'messaging.system': 'kafka', 'messaging.destination.name': topic,
                    'messaging.operation': 'publish', 'messaging.destination.kind': 'topic'})
        for c in topics.get(topic, []):
            schedule(c, sid, topic, t + d, kdepth + 1)
        return t + d

    def serve(svc, parent, start, cdepth, kdepth, at, name):
        sid = new_id()
        t = work(svc, sid, start + us(20, 300), cdepth, kdepth, rng.randint(1, 5))
        end = t + us(20, 300)
        st, ev = status_and_events(end)
        emit(svc, sid, parent, name, 'server', start, end, at, st, ev)
        return end

    def grpc_call(svc, parent, t, callee, cdepth, kdepth):
        method = rng.choice(['Get', 'List', 'Create', 'Update', 'Check'])
        short = callee.split('-')[0]
        service = 'co.example.%s.v1.%sService' % (short, short.capitalize())
        rpc = {'rpc.system': 'grpc', 'rpc.service': service, 'rpc.method': method, 'rpc.grpc.status_code': 0}
        cid = new_id()
        if rng.random() < 0.01:
            s_start = t - us(100, 2000)  # clock skew: server starts before its client
        else:
            s_start = t + us(100, 900)
        s_end = serve(callee, cid, s_start, cdepth + 1, kdepth, rpc, '%s/%s' % (service, method))
        c_end = max(s_end + us(100, 900), t + us(200, 1200))
        if rng.random() < 0.01:
            c_end = max(t, s_end - us(1500, 4000))  # server ends > 1 ms after its client -> skew
        st, ev = status_and_events(c_end)
        emit(svc, cid, parent, '%s/%s' % (service, method), 'client', t, c_end,
             dict(rpc, **{'server.address': '%s-grpc.%s.svc' % (callee, svc_info[callee][1]),
                          'server.port': 6565}), st, ev)
        return c_end

    def http_model_call(svc, parent, t, cdepth, kdepth):
        cid, pid_, rid = new_id(), new_id(), new_id()
        p_start = t + us(200, 800)
        r_start = p_start + us(50, 300)
        m_start = r_start + us(200, 1500)
        m_end = serve('image-resizer', rid, m_start, cdepth + 1, kdepth,
                      {'http.method': 'POST', 'http.route': '/v1/resize', 'http.target': '/v1/resize',
                       'http.status_code': 200}, 'POST /v1/resize')
        r_end = m_end + us(50, 400)
        emit('api-gateway', rid, pid_, 'router upstream', 'client', r_start, r_end,
             {'http.request.method': 'POST', 'url.full': 'http://10.1.2.3:8080/v1/resize',
              'http.response.status_code': 200})
        p_end = r_end + us(50, 300)
        emit('api-gateway', pid_, cid, 'POST', 'server', p_start, p_end,
             {'http.request.method': 'POST', 'url.path': '/v1/resize', 'http.response.status_code': 200})
        c_end = p_end + us(100, 600)
        emit(svc, cid, parent, 'POST', 'client', t, c_end,
             {'http.request.method': 'POST', 'url.full': 'https://ml.example.internal/v1/resize',
              'http.response.status_code': 200})
        return c_end

    def work(svc, parent, t, cdepth, kdepth, n_ops):
        role = svc_info[svc][3]
        for _ in range(n_ops):
            if full():
                break
            r = rng.random()
            if r < 0.36 and role != 'http-api':
                if rng.random() < 0.08:  # N+1 query pattern
                    for _ in range(rng.randint(5, 12)):
                        t = db_call(svc, parent, t, 'select * from items where order_id = $1', 'items') + us(10, 100)
                else:
                    t = db_call(svc, parent, t) + us(10, 200)
            elif r < 0.56 and cdepth < MAX_CALL_DEPTH:
                callee = rng.choice(apis)
                if callee != svc:
                    t = grpc_call(svc, parent, t, callee, cdepth, kdepth) + us(10, 200)
            elif r < 0.60 and cdepth < MAX_CALL_DEPTH and role != 'http-api':
                t = http_model_call(svc, parent, t, cdepth, kdepth) + us(10, 200)
            elif r < 0.78 and own_topics.get(svc) and kdepth < MAX_KAFKA_DEPTH:
                t = publish(svc, parent, t, rng.choice(own_topics[svc]), kdepth) + us(10, 200)
            else:
                d = us(20, 4000)
                emit(svc, new_id(), parent, rng.choice(['validate', 'map', 'Processor#handle', 'cache.get',
                                                        'authorize method', 'serialize']), 'internal', t, t + d, {})
                t += d + us(5, 100)
        return t

    def consume(svc, producer_id, topic, start, kdepth):
        if svc_info[svc][3] == 'flink':
            # Flink style: every operator span is a sibling directly under the upstream producer span
            did = emit(svc, new_id(), producer_id, 'AvroDeserializer.deserialize-%s' % topic, 'consumer',
                       start, start + us(20, 200), {'topic': topic, 'partition': rng.randint(0, 11),
                                                     'offset': rng.randint(1000, 9999999)}, links=[producer_id])
            t = start + us(100, 2000)
            for k in range(rng.randint(2, 6)):
                if full():
                    break
                if rng.random() >= 0.15:  # otherwise same start as the previous operator (tie)
                    t += us(500, 5000) if rng.random() < 0.8 else us(60000, 500000)
                op = rng.choice(['Filter', 'Enricher', 'Router', 'Aggregator', 'HoldControl'])
                emit(svc, new_id(), producer_id, '%s.processElement%d' % (op, k % 2 + 1),
                     rng.choice(['internal', 'internal', 'consumer']), t, t + us(20, 600), {},
                     links=[producer_id, did])
            if own_topics.get(svc) and not full() and kdepth < MAX_KAFKA_DEPTH:
                sink_topic = rng.choice(own_topics[svc])
                t += us(200, 3000)
                sid = emit(svc, new_id(), producer_id, '%sSink' % sink_topic.split('-')[0].capitalize(), 'producer',
                           t, t + us(20, 200), {'topic': sink_topic, 'key': 'k-%d' % rng.randint(1, 999)},
                           links=[producer_id])
                for c in topics.get(sink_topic, []):
                    schedule(c, sid, sink_topic, t, kdepth + 1, slow_ok=False)
            return
        cid = new_id()
        if rng.random() < 0.5:
            at = {'messaging.system': 'kafka', 'messaging.operation': 'process', 'messaging.source.name': topic,
                  'messaging.kafka.consumer.group': svc,
                  'messaging.kafka.message.offset': rng.randint(1000, 9999999)}
        else:
            at = {'messaging.system': 'kafka', 'messaging.operation': 'process',
                  'messaging.destination.name': topic, 'messaging.kafka.consumer.group': svc}
        name = '%s process' % topic
        if rng.random() < 0.15:  # spring-style 'listen' sibling without attributes -> repeated consume
            lid = new_id()
            ls = start + us(5, 50)
            le = work(svc, lid, ls + us(5, 50), 0, kdepth, rng.randint(1, 3)) + us(5, 50)
            emit(svc, lid, producer_id, 'listen', 'consumer', ls, le, {})
            emit(svc, cid, producer_id, name, 'consumer', start, le + us(5, 50), at)
            return
        t = work(svc, cid, start + us(10, 200), 0, kdepth, rng.randint(1, 5))
        end = t + us(10, 200)
        st, ev = status_and_events(end)
        emit(svc, cid, producer_id, name, 'consumer', start, end, at, st, ev)

    root = new_id()
    t = us(100, 300)
    t = grpc_call('edge-gateway', root, t, 'customers-api', 0, 0) + us(10, 100)
    t = grpc_call('edge-gateway', root, t, 'recommend-api', 0, 0) + us(10, 100)
    t = http_model_call('edge-gateway', root, t, 0, 0) + us(10, 100)
    for tp in own_topics.get('edge-gateway', []):
        t = publish('edge-gateway', root, t, tp, 0) + us(10, 100)
    t = work('edge-gateway', root, t, 0, 0, 3)
    emit('edge-gateway', root, None, 'POST /v1/stock', 'server', 0, t + us(50, 300),
         {'http.request.method': 'POST', 'http.route': '/v1/stock', 'url.scheme': 'https',
          'http.response.status_code': 201, 'client.address': '10.9.8.7'})

    while deferred and not full():
        start, _, c, pid_, topic, kdepth = heapq.heappop(deferred)
        consume(c, pid_, topic, start, kdepth)

    # two orphans: replace the parent of two server spans with an id that is not in the trace
    servers = [s for s in spans if s['kind'] == 'SPAN_KIND_SERVER' and s['parentSpanId']]
    for s in rng.sample(servers, 2):
        s['parentSpanId'] = new_id()
    by_svc = {}
    for s in spans:
        by_svc.setdefault(s.pop('svc'), []).append(s)
    batches = []
    for name, ns, scope, _role in SERVICES_5K:
        if name not in by_svc:
            continue
        res = {'service.name': name, 'k8s.namespace.name': ns, 'deployment.scope.name': scope,
               'k8s.pod.name': '%s-%05x' % (name, rng.getrandbits(20))}
        batches.append({'resource': {'attributes': attrs(res)},
                        'instrumentationLibrarySpans': [{'instrumentationLibrary': {'name': 'synthetic',
                                                                                    'version': '1'},
                                                         'spans': by_svc[name]}]})
    return {'batches': batches}, len(spans)


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(SAMPLE, 'r', encoding='utf-8') as f:
        sample = json.load(f)
    write('otlp-resourcespans.json', to_resource_spans(sample))
    write('jaeger.json', to_jaeger(sample))
    write('multi-trace.json', multi_trace(sample))
    write('errors.json', errors_trace(), indent=1)
    doc, n = synthetic_5k()
    write('synthetic-5k.json', doc)
    print('fixtures written to %s (synthetic-5k: %d spans)' % (OUT, n))


if __name__ == '__main__':
    main()
