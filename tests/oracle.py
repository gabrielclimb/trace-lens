#!/usr/bin/env python3
"""Trace Lens oracle: an independent Python reference of SPEC.md section 1-2
(parse + model + journey + insights), written from the spec alone.

Usage:
    python3 -I tests/oracle.py <trace.json> [--groupBy service|namespace|scope]
                                            [--target spanId] [--trace-index N] [--js-numbers]

Prints the DUMP FORMAT JSON used to cross-check the JS core. Standard library only.

Precision: every timestamp is kept as an exact integer number of nanoseconds relative to
the trace's earliest span start; values are converted to ms (rounded half away from zero to
3 decimals) only when dumped.

Interpretation choices for points the spec leaves open are marked "ORACLE CHOICE" below.
"""
import argparse
import base64
import binascii
import json
import re
import sys
from fractions import Fraction

NS_PER_MS = 1_000_000
CATEGORIES = ('messaging', 'db', 'rpc', 'http', 'internal')
KINDS = ('unspecified', 'internal', 'server', 'client', 'producer', 'consumer')
KIND_BY_NUM = {0: 'unspecified', 1: 'internal', 2: 'server', 3: 'client', 4: 'producer', 5: 'consumer'}
HTTP_KEYS = ('http.request.method', 'http.method', 'url.full', 'http.url', 'http.route', 'http.target')
MAX_SAFE = 2 ** 53
HEX_RE = re.compile(r'^[0-9a-fA-F]+$')
# ORACLE CHOICE: "<topic> (send|publish|process|receive)" -- topic is one whitespace-free token.
NAME_TOPIC_RE = re.compile(r'^(\S+) (send|publish|process|receive)$')
PRODUCER_OPS = ('publish', 'send', 'create')
CONSUMER_OPS = ('receive', 'process', 'deliver', 'settle')
IP_HINT_KEYS = ('user_agent.original', 'client.address', 'http.user_agent', 'net.peer.ip')
IP_MATCH_KEYS = ('k8s.pod.ip', 'network.peer.address', 'client.address', 'net.peer.ip',
                 'net.sock.peer.addr', 'network.local.address', 'host.ip')


def ms(ns):
    return ns / NS_PER_MS


def r3(ns):
    """Exact ns (int or Fraction) -> ms rounded half away from zero to 3 decimals."""
    us = Fraction(ns) / 1000
    q = int(abs(us) + Fraction(1, 2))
    return (-q if us < 0 else q) / 1000


def truthy(v):
    """JS-like truthiness for attribute values."""
    return v is not None and v is not False and v != '' and v != 0


def first_truthy(*vals):
    for v in vals:
        if truthy(v):
            return v
    return ''


def as_str(v):
    if v is None:
        return ''
    if isinstance(v, bool):
        return 'true' if v else 'false'
    return v if isinstance(v, str) else str(v)


# --------------------------------------------------------------------------------------------
# 1. parse
# --------------------------------------------------------------------------------------------

def norm_id(v):
    if v is None:
        return ''
    s = str(v).strip()
    if not s:
        return ''
    if HEX_RE.match(s) and len(s) in (16, 32):
        return s.lower()
    t = s.replace('-', '+').replace('_', '/')
    t += '=' * (-len(t) % 4)
    try:
        return base64.b64decode(t, validate=True).hex()
    except (binascii.Error, ValueError):
        return s.lower()


def norm_parent_id(v):
    h = norm_id(v)
    return '' if (not h or set(h) == {'0'}) else h


def conv_value(v):
    if not isinstance(v, dict):
        return None
    if 'stringValue' in v:
        return v['stringValue']
    if 'intValue' in v:
        x = v['intValue']
        if isinstance(x, str):
            try:
                n = int(x.strip())
            except ValueError:
                return x
            return x if abs(n) > MAX_SAFE else n
        return x
    if 'doubleValue' in v:
        x = v['doubleValue']
        try:
            return float(x)
        except (TypeError, ValueError):
            return x
    if 'boolValue' in v:
        return bool(v['boolValue'])
    if 'bytesValue' in v:
        return v['bytesValue']
    if 'arrayValue' in v:
        return [conv_value(x) for x in ((v.get('arrayValue') or {}).get('values') or [])]
    if 'kvlistValue' in v:
        return kv_to_dict((v.get('kvlistValue') or {}).get('values'))
    return None


def kv_to_dict(lst):
    out = {}
    for kv in lst or []:
        if isinstance(kv, dict) and 'key' in kv:
            out[kv['key']] = conv_value(kv.get('value'))
    return out


# --js-numbers: emulate JSON.parse in JS, which rounds integer JSON *numbers* to the nearest
# float64 (~256 ns at epoch-ns magnitude). String timestamps stay exact (the JS core uses BigInt).
JS_NUMBERS = False


def to_ns(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return int(float(v)) if JS_NUMBERS else v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return int(s)
        except ValueError:
            try:
                return int(float(s))
            except ValueError:
                return None
    return None


def norm_kind(k):
    if k is None or isinstance(k, bool):
        return 'unspecified'
    if isinstance(k, int):
        return KIND_BY_NUM.get(k, 'unspecified')
    s = str(k).strip()
    if s.isdigit():
        return KIND_BY_NUM.get(int(s), 'unspecified')
    s = s.lower()
    if s.startswith('span_kind_'):
        s = s[len('span_kind_'):]
    return s if s in KINDS else 'unspecified'


def norm_status_code(code):
    if code is None:
        return 'unset'
    if isinstance(code, bool):
        return 'unset'
    if isinstance(code, int):
        return {1: 'ok', 2: 'error'}.get(code, 'unset')
    s = str(code).strip().upper()
    if s in ('1', 'STATUS_CODE_OK', 'OK'):
        return 'ok'
    if s in ('2', 'STATUS_CODE_ERROR', 'ERROR'):
        return 'error'
    return 'unset'


def apply_error_attrs(status, attrs):
    if attrs.get('error') is True or attrs.get('otel.status_code') == 'ERROR':
        return 'error'
    return status


def collect_resource_spans(doc):
    """List of OTLP ResourceSpans, or None when the document is not OTLP."""
    if isinstance(doc, list):
        out, ok = [], False
        for item in doc:
            r = collect_resource_spans(item)
            if r is not None:
                out.extend(r)
                ok = True
            elif isinstance(item, dict) and ('scopeSpans' in item or 'instrumentationLibrarySpans' in item):
                out.append(item)
                ok = True
        return out if ok else None
    if isinstance(doc, dict):
        if isinstance(doc.get('batches'), list):
            return doc['batches']
        if isinstance(doc.get('resourceSpans'), list):
            return doc['resourceSpans']
        if isinstance(doc.get('trace'), dict):
            return collect_resource_spans(doc['trace'])
    return None


def parse_otlp(rss):
    raw = []
    for rs in rss:
        if not isinstance(rs, dict):
            continue
        resource = kv_to_dict((rs.get('resource') or {}).get('attributes'))
        blocks = list(rs.get('scopeSpans') or []) + list(rs.get('instrumentationLibrarySpans') or [])
        for blk in blocks:
            sc = blk.get('scope') or blk.get('instrumentationLibrary') or {}
            scope = {'name': sc.get('name') or '', 'version': sc.get('version') or ''}
            for sp in blk.get('spans') or []:
                attrs = kv_to_dict(sp.get('attributes'))
                st = sp.get('status') or {}
                status = apply_error_attrs(norm_status_code(st.get('code')), attrs)
                start = to_ns(sp.get('startTimeUnixNano'))
                end = to_ns(sp.get('endTimeUnixNano'))
                raw.append({
                    'traceId': norm_id(sp.get('traceId')),
                    'spanId': norm_id(sp.get('spanId')),
                    'parentSpanId': norm_parent_id(sp.get('parentSpanId')),
                    'name': as_str(sp.get('name')),
                    'kind': norm_kind(sp.get('kind')),
                    'startNs': start,
                    'endNs': end,
                    'status': {'code': status, 'message': as_str(st.get('message'))},
                    'attrs': attrs,
                    'resource': resource,
                    'scope': scope,
                    'events': [{'timeNs': to_ns(e.get('timeUnixNano')), 'name': as_str(e.get('name')),
                                'attrs': kv_to_dict(e.get('attributes'))} for e in sp.get('events') or []],
                    'links': [{'traceId': norm_id(l.get('traceId')), 'spanId': norm_id(l.get('spanId')),
                               'attrs': kv_to_dict(l.get('attributes'))} for l in sp.get('links') or []],
                })
    return raw


JAEGER_CONSUMED_TAGS = ('span.kind', 'otel.status_code', 'otel.status_description', 'otel.scope.name',
                        'otel.scope.version', 'otel.library.name', 'otel.library.version',
                        'internal.span.format')


def jaeger_tags(lst):
    out = {}
    for t in lst or []:
        if isinstance(t, dict) and 'key' in t:
            out[t['key']] = t.get('value')
    return out


def parse_jaeger(doc):
    raw = []
    for tr in doc.get('data') or []:
        procs = tr.get('processes') or {}
        for sp in tr.get('spans') or []:
            tags = jaeger_tags(sp.get('tags'))
            proc = procs.get(sp.get('processID')) or sp.get('process') or {}
            resource = jaeger_tags(proc.get('tags'))
            if proc.get('serviceName') is not None:
                resource['service.name'] = proc['serviceName']
            refs = [r for r in sp.get('references') or [] if isinstance(r, dict)]
            pref = next((r for r in refs if r.get('refType') == 'CHILD_OF'), None)
            if pref is None:
                pref = next((r for r in refs if r.get('refType') == 'FOLLOWS_FROM'), None)
            links = [r for r in refs if r is not pref]
            otel_code = as_str(tags.get('otel.status_code')).upper()
            # ORACLE CHOICE: Jaeger otel.status_code=OK -> 'ok' (spec only defines the error mapping).
            status = 'ok' if otel_code == 'OK' else 'unset'
            if tags.get('error') in (True, 'true') or otel_code == 'ERROR':
                status = 'error'
            attrs = {k: v for k, v in tags.items() if k not in JAEGER_CONSUMED_TAGS}
            start_us = to_ns(sp.get('startTime'))
            dur_us = to_ns(sp.get('duration'))
            start = None if start_us is None else start_us * 1000
            end = None if (start is None or dur_us is None) else start + dur_us * 1000
            events = []
            for lg in sp.get('logs') or []:
                fields = jaeger_tags(lg.get('fields'))
                name = fields.pop('event', None)
                ts = to_ns(lg.get('timestamp'))
                events.append({'timeNs': None if ts is None else ts * 1000,
                               'name': as_str(name) if name is not None else 'log', 'attrs': fields})
            raw.append({
                'traceId': norm_id(sp.get('traceID') or tr.get('traceID')),
                'spanId': norm_id(sp.get('spanID')),
                'parentSpanId': norm_parent_id(pref.get('spanID')) if pref else '',
                'name': as_str(sp.get('operationName')),
                # ORACLE CHOICE: Jaeger span without a span.kind tag -> 'unspecified'.
                'kind': norm_kind(tags.get('span.kind')),
                'startNs': start,
                'endNs': end,
                'status': {'code': status, 'message': as_str(tags.get('otel.status_description'))},
                'attrs': attrs,
                'resource': resource,
                'scope': {'name': as_str(tags.get('otel.scope.name') or tags.get('otel.library.name')),
                          'version': as_str(tags.get('otel.scope.version') or tags.get('otel.library.version'))},
                'events': events,
                'links': [{'traceId': norm_id(r.get('traceID')), 'spanId': norm_id(r.get('spanID')),
                           'attrs': {}} for r in links],
            })
    return raw


def parse(doc):
    warnings = []
    rss = collect_resource_spans(doc)
    if rss is not None:
        fmt, raw = 'otlp', parse_otlp(rss)
    elif isinstance(doc, dict) and isinstance(doc.get('data'), list):
        fmt, raw = 'jaeger', parse_jaeger(doc)
    else:
        raise ValueError('Unrecognized trace format: expected OTLP ({batches|resourceSpans}) or Jaeger ({data:[...]}) JSON')
    by_trace = {}
    for r in raw:
        if r['startNs'] is None:
            warnings.append('span %s has no start time; skipped' % r['spanId'])
            continue
        if r['endNs'] is None:
            r['endNs'] = r['startNs']
        by_trace.setdefault(r['traceId'], []).append(r)
    traces = []
    for tid, spans in by_trace.items():
        seen, kept = set(), []
        for r in spans:
            if r['spanId'] in seen:
                warnings.append('duplicate span id %s in trace %s; kept the first' % (r['spanId'], tid))
                continue
            seen.add(r['spanId'])
            kept.append(r)
        t0 = min(r['startNs'] for r in kept)
        for r in kept:
            r['start'] = r['startNs'] - t0
            r['end'] = r['endNs'] - t0
            for e in r['events']:
                e['time'] = None if e['timeNs'] is None else e['timeNs'] - t0
        traces.append({'traceId': tid, 't0Ns': t0, 'spans': kept})
    if not traces:
        raise ValueError('No spans found in the input')
    traces.sort(key=lambda t: -len(t['spans']))  # stable: ties keep first-appearance order
    return {'format': fmt, 'traces': traces, 'warnings': warnings}


# --------------------------------------------------------------------------------------------
# 2. model
# --------------------------------------------------------------------------------------------

class Span:
    pass


class Op:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def url_path(u):
    if not truthy(u):
        return ''
    s = as_str(u)
    i = s.find('://')
    if i >= 0:
        rest = s[i + 3:]
        j = rest.find('/')
        s = rest[j:] if j >= 0 else ''
    for ch in '?#':
        s = s.split(ch, 1)[0]
    return s


def url_host(u):
    s = as_str(u)
    i = s.find('://')
    if i < 0:
        return ''
    rest = s[i + 3:]
    for ch in '/?#':
        rest = rest.split(ch, 1)[0]
    rest = rest.rsplit('@', 1)[-1]
    return rest.split(':', 1)[0]


def short_rpc(service):
    s = as_str(service)
    return s.rsplit('.', 1)[-1] if s else ''


def categorize(s):
    a = s.attrs
    if 'db' in a or any(k.startswith('db.') for k in a):
        return 'db'
    if 'rpc.system' in a or 'rpc.service' in a:
        return 'rpc'
    if any(k in a for k in HTTP_KEYS):
        return 'http'
    if any(k.startswith('messaging.') for k in a) or s.kind in ('producer', 'consumer') or 'topic' in a:
        return 'messaging'
    return 'internal'


def build_op(s):
    a = s.attrs
    cat = s.category
    if cat == 'messaging':
        system = as_str(first_truthy(a.get('messaging.system')))
        operation = as_str(first_truthy(a.get('messaging.operation'), a.get('messaging.operation.type')))
        m = NAME_TOPIC_RE.match(s.name)
        # ORACLE CHOICE: role = kind (producer/consumer) first, then messaging.operation, then the name verb.
        if s.kind == 'producer':
            role = 'producer'
        elif s.kind == 'consumer':
            role = 'consumer'
        elif operation.lower() in PRODUCER_OPS:
            role = 'producer'
        elif operation.lower() in CONSUMER_OPS:
            role = 'consumer'
        elif m:
            role = 'producer' if m.group(2) in ('send', 'publish') else 'consumer'
        else:
            role = ''
        dest = as_str(first_truthy(a.get('messaging.destination.name'), a.get('messaging.destination'),
                                   a.get('messaging.source.name'), a.get('topic'), m.group(1) if m else ''))
        own_dest = bool(dest)
        p = s.parent
        if not dest and role == 'consumer' and p is not None and p.category == 'messaging' and p.op.role == 'producer':
            dest = p.op.destination
        partition = first_truthy(a.get('messaging.kafka.partition'), a.get('messaging.kafka.destination.partition'),
                                 a.get('messaging.destination.partition.id'), a.get('messaging.kafka.source.partition'),
                                 a.get('partition'))
        offset = first_truthy(a.get('messaging.kafka.message.offset'), a.get('messaging.kafka.offset'),
                              a.get('kafka.message.offset'), a.get('offset'))
        group = first_truthy(a.get('messaging.kafka.consumer.group'), a.get('messaging.consumer.group.name'),
                             a.get('messaging.kafka.consumer_group'))
        verb = operation or ('publish' if role == 'producer' else 'process')
        return Op(system=system, destination=dest, ownDestination=own_dest, operation=operation, role=role,
                  partition=partition, offset=offset, consumerGroup=as_str(group),
                  summary=('%s → %s' % (verb, dest)) if dest else verb)
    if cat == 'db':
        system = as_str(first_truthy(a.get('db.system'), a.get('db.system.name')))
        # ORACLE CHOICE: db name falls back to the bare `db` attribute.
        name = as_str(first_truthy(a.get('db.name'), a.get('db.namespace'), a.get('db')))
        table = as_str(first_truthy(a.get('db.sql.table'), a.get('db.collection.name')))
        operation = as_str(first_truthy(a.get('db.operation'), a.get('db.operation.name')))
        statement = as_str(first_truthy(a.get('db.statement'), a.get('db.query.text')))
        host = as_str(first_truthy(a.get('server.address'), a.get('net.peer.name'),
                                   url_host(a.get('db.connection_string'))))
        summary = ' '.join(x for x in (system, operation, table or name) if x) or s.name
        return Op(system=system, name=name, table=table, operation=operation, statement=statement, host=host,
                  summary=summary)
    if cat == 'rpc':
        service = as_str(first_truthy(a.get('rpc.service')))
        method = as_str(first_truthy(a.get('rpc.method')))
        system = as_str(first_truthy(a.get('rpc.system')))
        status = a.get('rpc.grpc.status_code')
        return Op(system=system, service=service, method=method, grpcStatus=status,
                  summary=' '.join(x for x in (system, '/'.join(y for y in (short_rpc(service), method) if y)) if x))
    if cat == 'http':
        method = as_str(first_truthy(a.get('http.request.method'), a.get('http.method')))
        route = as_str(first_truthy(a.get('http.route')))
        path = as_str(first_truthy(a.get('url.path'), url_path(a.get('http.target'))))
        url = as_str(first_truthy(a.get('url.full'), a.get('http.url')))
        status = first_truthy(a.get('http.response.status_code'), a.get('http.status_code'))
        host = as_str(first_truthy(a.get('server.address'), a.get('http.host'), url_host(url)))
        target = route or path or url_path(url)
        summary = ' '.join(x for x in (method, target) if x)
        if truthy(status):
            summary += ' → %s' % status
        return Op(method=method, route=route, path=path, url=url, urlPath=url_path(url), statusCode=status,
                  host=host, summary=summary or s.name)
    return Op(summary=s.name)


def hop_type(p, c):
    if p.kind == 'producer' or c.kind == 'consumer':
        return 'kafka'
    for x in (p, c):
        if x.category == 'messaging' and x.op.system.lower() in ('kafka', ''):
            return 'kafka'
    if p.category == 'rpc' or c.category == 'rpc':
        return 'grpc'
    if p.category == 'http' or c.category == 'http':
        return 'http'
    return 'call'


def hop_label(t, p, c):
    if t == 'kafka':
        pd = p.op.destination if p.category == 'messaging' else ''
        cd = c.op.destination if c.category == 'messaging' else ''
        return pd or cd or ''
    if t == 'grpc':
        # ORACLE CHOICE: take each field from the child first (if rpc), then the parent (if rpc).
        rs = [x for x in (c, p) if x.category == 'rpc']
        service = next((x.op.service for x in rs if x.op.service), '')
        method = next((x.op.method for x in rs if x.op.method), '')
        return '/'.join(x for x in (short_rpc(service), method) if x)
    if t == 'http':
        # ORACLE CHOICE: method from child then parent; target = child route|path|url-path, then parent's.
        hs = [x for x in (c, p) if x.category == 'http']
        method = next((x.op.method for x in hs if x.op.method), '')
        target = ''
        for x in hs:
            target = x.op.route or x.op.path or x.op.urlPath
            if target:
                break
        if target and not any(x.op.route for x in hs):
            target = template_path(target)
        return ' '.join(x for x in (method, target) if x)


UUID_SEG = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')


def template_path(path):
    out = []
    for seg in path.split('/'):
        if UUID_SEG.match(seg):
            seg = '{uuid}'
        elif re.fullmatch(r'[0-9]+', seg):
            seg = '{id}'
        elif re.fullmatch(r'[0-9a-fA-F]{16,}', seg):
            seg = '{hex}'
        out.append(seg)
    return '/'.join(out)
    return c.name


def union_len(intervals):
    total = 0
    cs = ce = None
    for s, e in sorted((s, e) for s, e in intervals if e > s):
        if cs is None:
            cs, ce = s, e
        elif s <= ce:
            if e > ce:
                ce = e
        else:
            total += ce - cs
            cs, ce = s, e
    if cs is not None:
        total += ce - cs
    return total


def merge_intervals(intervals):
    out = []
    for s, e in sorted((s, e) for s, e in intervals if e >= s):
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1][1] = e
        else:
            out.append([s, e])
    return out


def median(values):
    v = sorted(values)
    n = len(v)
    if n == 0:
        return 0
    if n % 2:
        return Fraction(v[n // 2])
    return Fraction(v[n // 2 - 1] + v[n // 2], 2)


def group_key(s, group_by):
    if group_by == 'namespace':
        return s.namespace
    if group_by == 'scope':
        return s.deployScope
    return s.service


def build_model(trace, group_by='service'):
    warnings = []
    spans = []
    for i, r in enumerate(trace['spans']):
        s = Span()
        s.file_index = i
        s.id = r['spanId']
        s.parentId = r['parentSpanId']
        s.traceId = r['traceId']
        s.name = r['name']
        s.kind = r['kind']
        s.start = r['start']
        s.end = r['end']
        s.duration = s.end - s.start
        s.status = r['status']['code']
        s.statusMessage = r['status']['message']
        s.isError = s.status == 'error'
        s.attrs = r['attrs']
        s.resource = r['resource']
        s.scope = r['scope']
        s.events = r['events']
        s.links = r['links']
        res = s.resource
        s.service = as_str(first_truthy(res.get('service.name'))) or 'unknown-service'
        s.namespace = as_str(first_truthy(res.get('k8s.namespace.name'), res.get('service.namespace'))) or s.service
        # ORACLE CHOICE: span.deployScope uses the same 'unknown' fallback as the scope grouping.
        s.deployScope = as_str(first_truthy(res.get('deployment.scope.name'))) or 'unknown'
        s.pod = as_str(first_truthy(res.get('k8s.pod.name')))
        s.group = group_key(s, group_by)
        s.parent = None
        s.children = []
        s.depth = 0
        s.isOrphan = False
        s.hopIn = None
        spans.append(s)

    by_id = {s.id: s for s in spans}
    roots, orphans = [], []
    for s in spans:
        if s.parentId == '':
            roots.append(s)
        elif s.parentId in by_id and s.parentId != s.id:
            s.parent = by_id[s.parentId]
            s.parent.children.append(s)
        else:
            s.isOrphan = True
            orphans.append(s)

    # depth (iterative); spans unreachable from roots/orphans sit on a parent cycle -> break it.
    visited = set()
    order = []  # parents before children

    def walk(start_spans):
        stack = list(reversed(start_spans))
        for x in start_spans:
            x.depth = 0
        while stack:
            x = stack.pop()
            if id(x) in visited:
                continue
            visited.add(id(x))
            order.append(x)
            for ch in reversed(x.children):
                ch.depth = x.depth + 1
                stack.append(ch)

    walk(roots + orphans)
    for s in spans:
        if id(s) not in visited:
            warnings.append('parent cycle at span %s; treated as orphan' % s.id)
            if s.parent is not None:
                s.parent.children.remove(s)
            s.parent = None
            s.isOrphan = True
            orphans.append(s)
            walk([s])

    spans.sort(key=lambda x: (x.start, x.depth, x.file_index))
    for i, s in enumerate(spans):
        s.index = i
    for s in spans:
        s.children.sort(key=lambda x: x.index)

    for s in spans:
        s.category = categorize(s)
    for s in order:  # parents first: consumer destination may fall back to the parent producer's
        s.op = build_op(s)

    for s in spans:
        clipped = [(max(c.start, s.start), min(c.end, s.end)) for c in s.children]
        s.selfTime = max(0, s.duration - union_len(clipped))

    # causal links (SPEC 2, clarified): a consumer whose context was propagated from a producer of a
    # *different* topic (Flink forwards the input record's context) is re-linked to the latest producer of
    # its own topic that started before it, inside its structural parent's subtree (and not its own).
    def in_subtree(q, p):
        x = q.parent
        while x is not None:
            if x is p:
                return True
            x = x.parent
        return False

    for s in spans:
        s.causalParent = s.parent
        s.causalChildren = []
    producers = {}
    for s in spans:
        if s.category == 'messaging' and s.op.role == 'producer' and s.op.destination:
            producers.setdefault(s.op.destination, []).append(s)
    for c in spans:
        p = c.parent
        if p is None or c.category != 'messaging' or c.op.role != 'consumer' or not c.op.ownDestination:
            continue
        topic = c.op.destination
        if p.category == 'messaging' and p.op.role == 'producer' and p.op.destination == topic:
            continue
        for q in reversed([q for q in producers.get(topic, []) if q.start <= c.start]):
            if q is c or not in_subtree(q, p) or in_subtree(q, c):
                continue
            c.causalParent = q
            break
    for s in spans:
        if s.causalParent is not None:
            s.causalParent.causalChildren.append(s)

    # hops & edges
    hops = []
    for s in spans:
        p = s.causalParent
        if p is None or p.group == s.group:
            continue
        t = hop_type(p, s)
        h = {'parent': p, 'child': s, 'from': p.group, 'to': s.group, 'type': t, 'label': hop_label(t, p, s),
             'async': t == 'kafka' or s.start >= p.end, 'latency': s.start - p.start,
             'queue': max(0, s.start - p.end)}
        s.hopIn = h
        hops.append(h)
    edges, edge_by_id = [], {}
    for h in hops:
        eid = '%s→%s|%s|%s' % (h['from'], h['to'], h['type'], h['label'])
        e = edge_by_id.get(eid)
        if e is None:
            e = {'id': eid, 'from': h['from'], 'to': h['to'], 'type': h['type'], 'label': h['label'],
                 'async': False, 'hops': []}
            edge_by_id[eid] = e
            edges.append(e)
        e['hops'].append(h)
        # ORACLE CHOICE: an edge is async when any of its hops is async.
        e['async'] = e['async'] or h['async']
    for e in edges:
        lat = [h['latency'] for h in e['hops']]
        e['count'] = len(e['hops'])
        e['latencyMin'] = min(lat)
        e['latencyMax'] = max(lat)
        e['latencyAvg'] = Fraction(sum(lat), len(lat))
        e['queueMax'] = max(h['queue'] for h in e['hops'])

    # groups
    groups, gmap = [], {}
    for s in spans:
        g = gmap.get(s.group)
        if g is None:
            g = {'key': s.group, 'spans': []}
            gmap[s.group] = g
            groups.append(g)
        g['spans'].append(s)
    for g in groups:
        ss = g['spans']
        g['services'] = sorted({s.service for s in ss})
        g['namespaces'] = sorted({s.namespace for s in ss})
        g['scopes'] = sorted({s.deployScope for s in ss})
        g['first'] = min(s.start for s in ss)
        # ORACLE CHOICE: group.last = latest span END.
        g['last'] = max(s.end for s in ss)
        g['intervals'] = merge_intervals([(s.start, s.end) for s in ss])
        g['activeTime'] = union_len([(s.start, s.end) for s in ss])
        g['selfTime'] = sum(s.selfTime for s in ss)
        g['spanCount'] = len(ss)
        g['errorCount'] = sum(1 for s in ss if s.isError)
        g['categoryTime'] = {c: sum(s.selfTime for s in ss if s.category == c) for c in CATEGORIES}
        g['categoryCount'] = {c: sum(1 for s in ss if s.category == c) for c in CATEGORIES}
        dbs = [s for s in ss if s.category == 'db']
        g['dbCalls'] = len(dbs)
        g['dbTime'] = sum(s.duration for s in dbs)
        msg = [s for s in ss if s.category == 'messaging' and s.op.destination]
        g['topicsProduced'] = sorted({s.op.destination for s in msg if s.op.role == 'producer'})
        g['topicsConsumed'] = sorted({s.op.destination for s in msg if s.op.role == 'consumer'})
        g['inEdges'] = [e for e in edges if e['to'] == g['key']]
        g['outEdges'] = [e for e in edges if e['from'] == g['key']]
        g['journeyTime'] = 0
    groups.sort(key=lambda g: g['first'])  # stable: ties keep first-span order
    for i, g in enumerate(groups):
        g['order'] = i

    # topics
    topics, tmap = [], {}
    for s in spans:
        if s.category != 'messaging' or not s.op.destination or s.op.role not in ('producer', 'consumer'):
            continue
        t = tmap.get(s.op.destination)
        if t is None:
            t = {'name': s.op.destination, 'system': s.op.system, 'producers': [], 'consumers': []}
            tmap[t['name']] = t
            topics.append(t)
        if not t['system'] and s.op.system:
            t['system'] = s.op.system
        t['producers' if s.op.role == 'producer' else 'consumers'].append(s)
    for t in topics:
        t['producerGroups'] = sorted({s.group for s in t['producers']})
        t['consumerGroups'] = sorted({s.group for s in t['consumers']})
        t['deliveries'] = [h for h in hops if h['type'] == 'kafka' and h['label'] == t['name']]
        lat = [h['latency'] for h in t['deliveries']]
        t['latencyMin'] = min(lat) if lat else None
        t['latencyMax'] = max(lat) if lat else None
        t['latencyAvg'] = Fraction(sum(lat), len(lat)) if lat else None

    # databases
    databases, dmap = [], {}
    for s in spans:
        if s.category != 'db':
            continue
        key = '%s/%s@%s' % (s.op.system, s.op.name, s.op.host)
        d = dmap.get(key)
        if d is None:
            d = {'key': key, 'system': s.op.system, 'name': s.op.name, 'host': s.op.host, 'spans': []}
            dmap[key] = d
            databases.append(d)
        d['spans'].append(s)
    for d in databases:
        d['groups'] = sorted({s.group for s in d['spans']})
        d['count'] = len(d['spans'])
        d['time'] = sum(s.duration for s in d['spans'])
        tables = {}
        for s in d['spans']:
            tb = tables.setdefault(s.op.table, {'table': s.op.table, 'count': 0, 'time': 0})
            tb['count'] += 1
            tb['time'] += s.duration
        d['tables'] = sorted(tables.values(), key=lambda x: -x['time'])

    model = {
        'traceId': trace['traceId'], 't0Ns': trace['t0Ns'], 'groupBy': group_by,
        'duration': max(s.end for s in spans), 'spans': spans, 'byId': by_id,
        'roots': roots, 'orphans': orphans, 'groups': groups, 'groupByKey': gmap,
        'edges': edges, 'hops': hops, 'topics': topics, 'databases': databases, 'warnings': warnings,
    }
    model['stats'] = {
        'spanCount': len(spans), 'groupCount': len(groups), 'errorCount': sum(1 for s in spans if s.isError),
        'orphanCount': len(orphans), 'maxDepth': max(s.depth for s in spans),
        'byKind': {k: sum(1 for s in spans if s.kind == k) for k in KINDS if any(s.kind == k for s in spans)},
        'byCategory': {c: sum(1 for s in spans if s.category == c) for c in CATEGORIES},
    }
    model['journey'] = compute_journey(model, None)
    for row in model['journey']['byGroup']:
        gmap[row['group']]['journeyTime'] = row['total']
    model['insights'] = compute_insights(model)
    return model


# --------------------------------------------------------------------------------------------
# 2.1 journey
# --------------------------------------------------------------------------------------------

def default_target(model):
    best = None
    for s in model['spans']:  # ORACLE CHOICE: full ties (same end & start) -> first in span order
        if best is None or s.end > best.end or (s.end == best.end and s.start >= best.start):
            best = s
    return best


def compute_journey(model, target_id):
    target = model['byId'].get(target_id) if target_id else None
    if target is None:
        target = default_target(model)
    chain = []
    x = target
    while x is not None:
        chain.append(x)
        x = x.causalParent
    chain.reverse()
    segs, warnings = [], []
    cursor = [chain[0].start]

    def add(typ, group, span, to_span, start, end, label, hop_t=None):
        if end < start:
            warnings.append('clock skew: %s segment for %s is %.3f ms' % (typ, span.id, ms(end - start)))
            return
        start = max(start, cursor[0])  # SPEC 2.1 (clarified): segments never overlap
        if end <= start:
            return
        cursor[0] = end
        segs.append({'type': typ, 'group': group, 'span': span, 'toSpan': to_span, 'start': start, 'end': end,
                     'duration': end - start, 'label': label, 'hopType': hop_t})

    for p, c in zip(chain, chain[1:]):
        if c.group == p.group:
            add('work', p.group, p, None, p.start, c.start, p.op.summary)
            continue
        first = c
        for ch in p.causalChildren:
            if ch.group == c.group and ch.start < first.start:
                first = ch
        hop = c.hopIn
        add('work', p.group, p, None, p.start, min(p.end, first.start), p.op.summary)
        if first.start > p.end:
            # ORACLE CHOICE: transit.group = the owning span p's group; label/type from the chain hop (p, c).
            add('transit', p.group, p, first, p.end, first.start, hop['label'], hop['type'])
        if c is not first and c.start > first.start:
            # ORACLE CHOICE: wait.span = first (the first delivery), wait.toSpan = c.
            add('wait', c.group, first, c, first.start, c.start, hop['label'], hop['type'])
    add('work', target.group, target, None, target.start, target.end, target.op.summary)
    # ORACLE CHOICE: segments are emitted in chain order, then stable-sorted by start ("time order").
    segs.sort(key=lambda sg: sg['start'])

    by_group = {}
    for sg in segs:
        if sg['type'] == 'transit':
            continue
        row = by_group.setdefault(sg['group'], {'group': sg['group'], 'work': 0, 'wait': 0, 'total': 0})
        row[sg['type']] += sg['duration']
        row['total'] += sg['duration']
    return {
        'target': target, 'chain': chain, 'segments': segs,
        'byGroup': sorted(by_group.values(), key=lambda r: -r['total']),
        'workTotal': sum(sg['duration'] for sg in segs if sg['type'] == 'work'),
        'transitTotal': sum(sg['duration'] for sg in segs if sg['type'] == 'transit'),
        'waitTotal': sum(sg['duration'] for sg in segs if sg['type'] == 'wait'),
        'total': target.end - chain[0].start,
        'warnings': warnings,
    }


# --------------------------------------------------------------------------------------------
# 2.2 insights
# --------------------------------------------------------------------------------------------

def fmt_ms(ns):
    v = ms(ns)
    if v < 1:
        return '%d µs' % round(v * 1000)
    if v < 100:
        return '%.1f ms' % v
    if v < 1000:
        return '%d ms' % round(v)
    return '%.2f s' % (v / 1000)


def compute_insights(model):
    spans, hops, edges = model['spans'], model['hops'], model['edges']
    gmap, journey = model['groupByKey'], model['journey']
    out = []

    def add(kind, severity, title, detail, metric, span_ids, group_keys):
        out.append({'kind': kind, 'severity': severity, 'title': title, 'detail': detail, 'metric': metric,
                    'spanIds': list(dict.fromkeys(span_ids)), 'groupKeys': list(dict.fromkeys(group_keys))})

    # 1. error -- metric = span duration
    for s in spans:
        if not s.isError:
            continue
        msg = s.statusMessage
        if not msg:
            for e in s.events:
                if e['name'] == 'exception':
                    msg = as_str(e['attrs'].get('exception.message') or e['attrs'].get('exception.type'))
                    if msg:
                        break
        add('error', 'critical', '%s: %s failed' % (s.group, s.name), msg, s.duration, [s.id], [s.group])

    # 2. slow-hop -- one per async hop; metric = queue
    async_hops = [h for h in hops if h['async']]
    if async_hops:
        threshold = max(Fraction(25 * NS_PER_MS), 4 * median([h['queue'] for h in async_hops]))
        def first_delivery(h):
            # SPEC 2.2 (clarified): later siblings in the same service are in-service processing, not transport
            c = h['child']
            for lst in (h['parent'].causalChildren, c.parent.children if c.parent is not None else []):
                for k in lst:
                    if k is not c and k.group == c.group and (k.start < c.start or (k.start == c.start and k.index < c.index)):
                        return False
            return True

        for h in async_hops:
            if h['queue'] >= threshold and first_delivery(h):
                add('slow-hop', 'warning', '%s queue: %s → %s' % (fmt_ms(h['queue']), h['from'], h['to']),
                    'via %s %s' % (h['type'], h['label']), h['queue'], [h['parent'].id, h['child'].id],
                    [h['from'], h['to']])

    # 3. orphan -- metric = span duration; groupKeys = the orphan's group only (caller only in detail)
    for s in model['orphans']:
        hints = ['%s=%s' % (k, as_str(s.attrs[k])) for k in IP_HINT_KEYS if truthy(s.attrs.get(k))]
        ips = {as_str(s.attrs[k]) for k in ('client.address', 'net.peer.ip', 'network.peer.address')
               if truthy(s.attrs.get(k))}
        callers = set()
        for o in spans:
            if o is s:
                continue
            if o.group != s.group:
                for src in (o.resource, o.attrs):
                    if any(isinstance(v, str) and v in ips for v in src.values()):
                        callers.add(o.group)
            if o.kind in ('server', 'consumer') and o.parent is not None and o.parent.group != s.group and any(
                    isinstance(o.attrs.get(k), str) and o.attrs.get(k) in ips
                    for k in ('client.address', 'net.peer.ip', 'network.peer.address')):
                callers.add(o.parent.group)
        detail = 'The caller is not instrumented or the span was dropped.'
        if hints:
            detail += ' ' + ', '.join(hints) + '.'
        if callers:
            detail += ' Likely caller: ' + ', '.join(sorted(callers)) + '.'
        add('orphan', 'warning', 'Missing parent span %s for %s: %s' % (s.parentId[:8], s.group, s.name), detail,
            s.duration, [s.id], [s.group] + sorted(callers))

    # 4. async-wait -- wait segments >= 50 ms on the default journey
    for sg in journey['segments']:
        if sg['type'] == 'wait' and sg['duration'] >= 50 * NS_PER_MS:
            sev = 'warning' if sg['duration'] >= 250 * NS_PER_MS else 'info'
            add('async-wait', sev, '%s waiting inside %s' % (fmt_ms(sg['duration']), sg['group']),
                'between %s and %s' % (sg['span'].name, sg['toSpan'].name), sg['duration'],
                [sg['span'].id, sg['toSpan'].id], [sg['group']])

    # 5. repeated-query -- metric = count
    rq = {}
    for s in spans:
        if s.category == 'db':
            rq.setdefault((s.group, s.op.statement or s.name), []).append(s)
    for (g, stmt), ss in rq.items():
        if len(ss) >= 5:
            total = sum(s.duration for s in ss)
            add('repeated-query', 'warning' if len(ss) >= 10 else 'info',
                '%s: same query x%d' % (g, len(ss)), '%s (total %s)' % (stmt[:120], fmt_ms(total)), len(ss),
                [s.id for s in ss], [g])

    # 6. repeated-consume -- producer span's consumer children grouped by child group (any group)
    # SPEC 2.2 (clarified): bucket per consumer service + Kafka consumer group; one card per producer service/topic/consumer
    repeats = {}
    for p in spans:
        if p.category != 'messaging' or p.op.role != 'producer':
            continue
        byg = {}
        for c in p.causalChildren:
            if c.category == 'messaging' and c.op.role == 'consumer':
                byg.setdefault((c.group, c.op.consumerGroup or ''), []).append(c)
        for (g, cg), cs in byg.items():
            if any(c.op.ownDestination for c in cs):
                cs = [c for c in cs if c.op.ownDestination]
            if len(cs) >= 2:
                topic = p.op.destination or cs[0].op.destination
                r = repeats.setdefault((p.group, topic, g, cg), {'from': p.group, 'group': g, 'max': 0, 'ids': []})
                r['max'] = max(r['max'], len(cs))
                r['ids'] += [p.id] + [c.id for c in cs]
    for r in repeats.values():
        add('repeated-consume', 'info', '%s consumed one message %d times' % (r['group'], r['max']), '', r['max'],
            r['ids'], [r['from'], r['group']])

    # 7. fan-out -- metric = consumer group count; spanIds = producer spans
    for t in model['topics']:
        if len(t['consumerGroups']) >= 4:
            add('fan-out', 'info', '%s fans out to %d services' % (t['name'], len(t['consumerGroups'])),
                ', '.join(t['consumerGroups']), len(t['consumerGroups']), [s.id for s in t['producers']],
                t['producerGroups'] + t['consumerGroups'])

    # 8. scope-crossing -- per edge, group scope sets differ; metric = hop count
    # SPEC 2.2 (clarified): a hop crosses when its two spans' deploy scopes differ; one card per service pair
    crossings = {}
    for h in hops:
        a, b = h['parent'].deployScope, h['child'].deployScope
        if a != b:
            crossings.setdefault((h['from'], h['to'], a, b), []).append(h)
    for (f, t, a, b), hs in crossings.items():
        add('scope-crossing', 'info', '%s → %s: %s → %s' % (a, b, f, t), '', len(hs),
            [x for h in hs for x in (h['parent'].id, h['child'].id)], [f, t])

    # 9. hotspot -- top 3 groups by journeyTime (> 0); spanIds = chain spans of that group
    total = journey['total']
    ranked = sorted([g for g in model['groups'] if g['journeyTime'] > 0], key=lambda g: (-g['journeyTime'], g['key']))
    for g in ranked[:3]:
        pct = round(100 * g['journeyTime'] / total) if total else 0
        add('hotspot', 'info', '%s: %s (%d%% of journey)' % (g['key'], fmt_ms(g['journeyTime']), pct), '',
            g['journeyTime'], [s.id for s in journey['chain'] if s.group == g['key']] +
            [x.id for sg in journey['segments'] if sg['group'] == g['key'] and sg['type'] != 'transit'
             for x in (sg['span'], sg['toSpan']) if x is not None], [g['key']])

    # 10. skew -- one per parent/child pair; metric = skew amount
    for c in spans:
        p = c.parent
        if p is None:
            continue
        if hop_type(p, c) != 'kafka' and c.start < p.start:
            add('skew', 'info', '%s starts %s before its parent' % (c.name, fmt_ms(p.start - c.start)),
                '%s → %s' % (p.group, c.group), p.start - c.start, [p.id, c.id], [p.group, c.group])
        elif p.kind == 'client' and c.kind == 'server' and c.end - p.end > NS_PER_MS and c.start < p.end:
            add('skew', 'info', '%s ends %s after its client' % (c.name, fmt_ms(c.end - p.end)),
                '%s → %s' % (p.group, c.group), c.end - p.end, [p.id, c.id], [p.group, c.group])

    sev_rank = {'critical': 0, 'warning': 1, 'info': 2}
    out.sort(key=lambda i: (sev_rank[i['severity']], -i['metric']))
    for n, i in enumerate(out):
        i['id'] = '%s-%d' % (i['kind'], n)
    return out


# --------------------------------------------------------------------------------------------
# dump
# --------------------------------------------------------------------------------------------

COUNT_METRIC_KINDS = ('repeated-query', 'repeated-consume', 'fan-out', 'scope-crossing')


def dump(model, journey):
    def seg_out(sg):
        return {'type': sg['type'], 'group': sg['group'], 'start': r3(sg['start']), 'end': r3(sg['end'])}

    spans = {}
    for s in model['spans']:
        h = s.hopIn
        spans[s.id] = {
            'group': s.group, 'category': s.category, 'kind': s.kind, 'depth': s.depth,
            'start': r3(s.start), 'end': r3(s.end), 'duration': r3(s.duration), 'selfTime': r3(s.selfTime),
            'status': s.status,
            'opDestination': s.op.destination if s.category == 'messaging' else None,
            'hopIn': {'from': h['from'], 'type': h['type'], 'label': h['label']} if h else None,
        }
    groups = [{
        'key': g['key'], 'spanCount': g['spanCount'], 'first': r3(g['first']), 'last': r3(g['last']),
        'activeTime': r3(g['activeTime']), 'selfTime': r3(g['selfTime']), 'errorCount': g['errorCount'],
        'dbCalls': g['dbCalls'], 'dbTime': r3(g['dbTime']), 'topicsProduced': g['topicsProduced'],
        'topicsConsumed': g['topicsConsumed'], 'categoryTime': {c: r3(g['categoryTime'][c]) for c in CATEGORIES},
        'journeyTime': r3(g['journeyTime']),
    } for g in sorted(model['groups'], key=lambda g: g['key'])]
    hops = [{
        'parent': h['parent'].id, 'child': h['child'].id, 'from': h['from'], 'to': h['to'], 'type': h['type'],
        'label': h['label'], 'async': h['async'], 'latency': r3(h['latency']), 'queue': r3(h['queue']),
    } for h in sorted(model['hops'], key=lambda h: (h['parent'].id, h['child'].id))]
    edges = [{
        'id': e['id'], 'count': e['count'], 'latencyMin': r3(e['latencyMin']), 'latencyAvg': r3(e['latencyAvg']),
        'latencyMax': r3(e['latencyMax']), 'queueMax': r3(e['queueMax']), 'async': e['async'],
    } for e in sorted(model['edges'], key=lambda e: e['id'])]
    topics = [{
        'name': t['name'], 'producerGroups': t['producerGroups'], 'consumerGroups': t['consumerGroups'],
        'deliveries': len(t['deliveries']),
    } for t in sorted(model['topics'], key=lambda t: t['name'])]
    databases = [{
        'key': d['key'], 'count': d['count'], 'time': r3(d['time']), 'groups': d['groups'],
    } for d in sorted(model['databases'], key=lambda d: d['key'])]
    jr = {
        'target': journey['target'].id,
        'chain': [s.id for s in journey['chain']],
        'segments': [seg_out(sg) for sg in journey['segments']],
        'byGroup': [{'group': r['group'], 'work': r3(r['work']), 'wait': r3(r['wait']), 'total': r3(r['total'])}
                    for r in sorted(journey['byGroup'], key=lambda r: r['group'])],
        'transitTotal': r3(journey['transitTotal']), 'workTotal': r3(journey['workTotal']),
        'waitTotal': r3(journey['waitTotal']), 'total': r3(journey['total']),
    }
    insights = []
    for i in model['insights']:
        metric = i['metric'] if i['kind'] in COUNT_METRIC_KINDS else r3(i['metric'])
        insights.append({'kind': i['kind'], 'severity': i['severity'], 'metric': metric,
                         'spanIds': sorted(i['spanIds']), 'groupKeys': sorted(i['groupKeys'])})
    insights.sort(key=lambda i: (i['kind'], ','.join(i['spanIds']), ','.join(i['groupKeys'])))
    return {
        'traceId': model['traceId'], 'groupBy': model['groupBy'], 'spanCount': len(model['spans']),
        'duration': r3(model['duration']), 'maxDepth': model['stats']['maxDepth'],
        'roots': sorted(s.id for s in model['roots']), 'orphans': sorted(s.id for s in model['orphans']),
        'spans': spans, 'groups': groups, 'hops': hops, 'edges': edges, 'topics': topics,
        'databases': databases, 'journey': jr, 'insights': insights,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('trace')
    ap.add_argument('--groupBy', default='service', choices=('service', 'namespace', 'scope'))
    ap.add_argument('--target', default=None, help='journey target span id (default: latest-ending span)')
    ap.add_argument('--trace-index', type=int, default=0, help='trace index after sorting by span count desc')
    ap.add_argument('--js-numbers', action='store_true',
                    help='round integer JSON-number timestamps to float64 first, like JSON.parse in JS')
    args = ap.parse_args(argv)
    global JS_NUMBERS
    JS_NUMBERS = args.js_numbers
    with open(args.trace, 'r', encoding='utf-8') as f:
        doc = json.load(f)
    res = parse(doc)
    model = build_model(res['traces'][args.trace_index], args.groupBy)
    journey = compute_journey(model, args.target) if args.target else model['journey']
    json.dump(dump(model, journey), sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
