#!/usr/bin/env python3
"""Generate the fictional demo trace shipped as data/sample-trace.{json,js}.

Everything here is invented: an online shop's order pipeline (hosts use example.internal, IPs use
TEST-NET 192.0.2.0/24). It is shaped like a Grafana/Tempo "Download trace" export and is built to
exercise every feature: Kafka hops and fan-out, a slow consumer, a Flink job holding messages, gRPC,
HTTP via an API gateway, Postgres/ClickHouse queries (incl. an N+1), an error with an exception event,
an orphan span, a clock-skewed child and a deploy-scope crossing (forest -> platform).

Usage: python3 tests/make_demo_trace.py   (writes data/sample-trace.json and data/sample-trace.js)
"""
import hashlib
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
BASE_NS = 1768471200_000_000_000  # 2026-01-15T10:00:00Z

SERVICES = {
    # service: (namespace, scope, language, pod suffix, extra resource attrs)
    "storefront-gateway": ("storefront", "forest", "java", "7c9d5f6b8-k2x4p", {}),
    "order-intake": ("storefront", "forest", "java", "5b8f9c7d6-q8w2e", {}),
    "audit-trail": ("audit", "forest", "java", "6d7c8b9a5-m3n7v", {}),
    "order-orchestrator": ("orders", "platform", "java", "69b7c8d5f-h4j6k", {}),
    "pricing-api": ("pricing", "platform", "python", "7f8e9d6c5-b2v4n", {}),
    "api-gateway": ("gateway", "platform", "go", "5c6d7e8f9-p1o2i", {}),
    "route-planner": ("routing", "platform", "python", "8a9b7c6d5-u7y6t", {}),
    "fulfillment-job": ("fulfillment", "platform", "java", "taskmanager-2", {"k8s.pod.ip": "192.0.2.41"}),
    "notification-service": ("notifications", "platform", "java", "7d6c5b4a3-r5e4w", {}),
    "analytics-sink": ("analytics", "platform", "java", "6e5d4c3b2-a1s2d", {}),
    "shipping-calculator": ("shipping", "platform", "java", "5f4e3d2c1-f3g4h", {}),
    "warehouse-gateway": ("warehouse", "platform", "java", "4a5b6c7d8-j5k6l", {}),
    "inventory-api": ("warehouse", "platform", "java", "3b4c5d6e7-z7x8c", {}),
    "tracking-service": ("tracking", "platform", "java", "2c3d4e5f6-v9b8n", {}),
    "invoice-service": ("invoicing", "platform", "java", "1d2e3f4a5-m6n5b", {}),
}

LIBS = {
    "kafka": ("io.opentelemetry.spring-kafka-2.7", "2.10.0-alpha"),
    "db": ("io.opentelemetry.jdbc", "2.10.0-alpha"),
    "grpc": ("io.opentelemetry.grpc-1.6", "2.10.0-alpha"),
    "http": ("io.opentelemetry.apache-httpclient-5.2", "2.10.0-alpha"),
    "app": ("io.opentelemetry.spring-boot", "2.10.0"),
    "flink": ("io.opentelemetry.contrib.flink", "0.1.0"),
    "gateway": ("github.com/envoyproxy/envoy", ""),
    "fastapi": ("opentelemetry.instrumentation.fastapi", "0.49b0"),
}

KINDS = {"server": "SPAN_KIND_SERVER", "client": "SPAN_KIND_CLIENT", "producer": "SPAN_KIND_PRODUCER",
         "consumer": "SPAN_KIND_CONSUMER", "internal": "SPAN_KIND_INTERNAL"}

_counter = [0]
spans = []  # (service, lib, span dict)
offsets = {}


def sid():
    _counter[0] += 1
    return hashlib.sha256(f"demo-span-{_counter[0]}".encode()).hexdigest()[:16]


def ns(ms):
    return BASE_NS + int(round(ms * 1_000_000))


def val(v):
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": v}
    if isinstance(v, float):
        return {"doubleValue": v}
    return {"stringValue": str(v)}


def kv(d):
    return [{"key": k, "value": val(v)} for k, v in d.items()]


def span(svc, name, kind, start, end, parent=None, attrs=None, lib="app", error=None, events=None, links=None, parent_id=None):
    s = {
        "traceId": TRACE_ID,
        "spanId": sid(),
        "parentSpanId": parent_id if parent_id is not None else (parent["spanId"] if parent else ""),
        "traceState": "",
        "name": name,
        "kind": KINDS[kind],
        "startTimeUnixNano": ns(start),
        "endTimeUnixNano": ns(end),
        "attributes": kv(attrs or {}),
        "droppedAttributesCount": 0,
        "droppedEventsCount": 0,
        "droppedLinksCount": 0,
        "status": {"code": 2, "message": error} if error else {"code": 0, "message": ""},
    }
    if events:
        s["events"] = [{"timeUnixNano": ns(t), "name": n, "attributes": kv(a), "droppedAttributesCount": 0} for t, n, a in events]
    if links:
        s["links"] = [{"traceId": TRACE_ID, "spanId": l["spanId"], "attributes": [], "droppedAttributesCount": 0} for l in links]
    spans.append((svc, lib, s))
    return s


def next_offset(topic):
    offsets[topic] = offsets.get(topic, 1_204_311 + 97_013 * len(offsets)) + 1
    return offsets[topic]


def produce(svc, topic, start, end, parent=None, key="ord_01J9Z8Q4K2", name=None, lib="kafka"):
    return span(svc, name or f"{topic} publish", "producer", start, end, parent, {
        "messaging.system": "kafka",
        "messaging.destination.name": topic,
        "messaging.operation": "publish",
        "messaging.kafka.message.key": key,
        "messaging.destination.partition.id": "3",
        "server.address": "kafka.example.internal",
    }, lib=lib)


def consume(svc, topic, start, end, producer, group=None, op="process", name=None, lib="kafka"):
    return span(svc, name or f"{topic} {op}", "consumer", start, end, producer, {
        "messaging.system": "kafka",
        "messaging.destination.name": topic,
        "messaging.operation": op,
        "messaging.kafka.consumer.group": group or svc,
        "messaging.kafka.message.offset": next_offset(topic + (group or svc)),
        "messaging.destination.partition.id": "3",
    }, lib=lib)


def db(svc, op, table, start, end, parent, statement, dbname, system="postgresql", host=None):
    return span(svc, f"{op} {dbname}.{table}", "client", start, end, parent, {
        "db.system": system,
        "db.name": dbname,
        "db.operation": op,
        "db.sql.table": f"{dbname}.{table}",
        "db.statement": statement,
        "db.user": f"{svc.replace('-', '_')}_app",
        "server.address": host or f"{dbname}-db.cluster.example.internal",
        "server.port": 8123 if system == "clickhouse" else 5432,
    }, lib="db")


def grpc_pair(client_svc, server_svc, service, method, start, end, parent, net=0.5, skew=0.0):
    attrs = {"rpc.system": "grpc", "rpc.service": service, "rpc.method": method, "rpc.grpc.status_code": 0}
    c = span(client_svc, f"{service}/{method}", "client", start, end, parent,
             dict(attrs, **{"server.address": f"{server_svc}.example.internal", "server.port": 9090}), lib="grpc",
             events=[(start + 0.05, "message", {"message.type": "SENT", "message.id": 1}),
                     (end - 0.05, "message", {"message.type": "RECEIVED", "message.id": 1})])
    s = span(server_svc, f"{service}/{method}", "server", start + net - skew, end - net - skew, c,
             dict(attrs, **{"network.peer.address": "192.0.2.77", "network.peer.port": 50412}), lib="grpc",
             events=[(start + net - skew + 0.05, "message", {"message.type": "RECEIVED", "message.id": 1}),
                     (end - net - skew - 0.05, "message", {"message.type": "SENT", "message.id": 1})])
    return c, s


def route_call(start, end, parent=None, parent_id=None, client_ip="192.0.2.88", ua="python-httpx/0.27.2",
               route="3f2b1c9e-8d7a-4e6b-9c5d-1a2b3c4d5e6f"):
    """api-gateway server -> upstream client -> route-planner server -> RoutePlanner.estimate."""
    path = f"/v1/routes/{route}/estimate"
    srv = span("api-gateway", "POST", "server", start, end, parent, {
        "http.request.method": "POST", "url.path": path, "url.scheme": "https",
        "server.address": "route-planner.example.internal", "client.address": client_ip,
        "network.peer.address": client_ip, "user_agent.original": ua,
        "http.response.status_code": 200}, lib="gateway", parent_id=parent_id)
    up = span("api-gateway", "router upstream", "client", start + 0.2, end - 0.2, srv, {
        "http.request.method": "POST", "url.full": "http://192.0.2.120:8080" + path,
        "server.address": "192.0.2.120", "server.port": 8080, "http.response.status_code": 200}, lib="gateway")
    rp = span("route-planner", "POST /v1/routes/{route_id}/estimate", "server", start + 0.9, end - 0.6, up, {
        "http.request.method": "POST", "http.route": "/v1/routes/{route_id}/estimate", "url.path": path,
        "http.response.status_code": 200, "client.address": "192.0.2.10"}, lib="fastapi")
    span("route-planner", "RoutePlanner.estimate", "internal", start + 1.2, end - 1.1, rp,
         {"routing.algorithm": "contraction-hierarchies", "routing.legs": 3})
    return srv


def build():
    # 1. An order enters through the storefront (deploy scope "forest")
    root = produce("storefront-gateway", "orders-raw", 0.0, 9.5)
    # consumed twice by the same consumer group (redelivery) + once, slowly, by a monitor
    consume("order-intake", "orders-raw", 9.8, 10.1, root, group="order-intake")
    oi = consume("order-intake", "orders-raw", 10.0, 13.9, root, group="order-intake")
    span("order-intake", "OrderValidator#validate", "internal", 10.3, 11.7, oi, {"code.function": "validate"})
    val_ = produce("order-intake", "orders-validated", 11.9, 13.6, oi)
    consume("audit-trail", "orders-raw", 151.7, 152.1, root)

    # 2-3. Crosses from the "forest" scope into the platform: the orchestrator picks it up late (slow
    # consumer) and prices it via gRPC; pricing asks the route planner through the API gateway
    oo = consume("order-orchestrator", "orders-validated", 139.0, 212.0, val_)
    svc = span("order-orchestrator", "OrderService#place", "internal", 139.3, 211.5, oo, {"code.function": "place"})
    db("order-orchestrator", "SELECT", "order", 140.0, 141.2, svc,
       "select o.id, o.total_minor, o.currency, o.status from orders.order o where o.id = ?", "orders")
    db("order-orchestrator", "SELECT", "customer", 141.4, 142.0, svc,
       "select c.id, c.tier, c.country from orders.customer c where c.id = ?", "orders")
    _, ps = grpc_pair("order-orchestrator", "pricing-api", "example.pricing.v1.PricingService", "Quote", 142.5, 176.0, svc, net=0.6)
    pq = span("pricing-api", "PricingEngine.quote", "internal", 143.4, 175.2, ps, {"code.function": "quote"})
    db("pricing-api", "SELECT", "promotion", 143.6, 144.4, pq,
       "select id, rule, discount_bps from pricing.promotion where active = ?", "pricing")
    hc = span("pricing-api", "POST", "client", 145.0, 174.5, pq, {
        "http.request.method": "POST",
        "url.full": "https://route-planner.example.internal/v1/routes/3f2b1c9e-8d7a-4e6b-9c5d-1a2b3c4d5e6f/estimate",
        "server.address": "route-planner.example.internal", "http.response.status_code": 200}, lib="http")
    route_call(145.8, 174.2, hc)
    db("order-orchestrator", "INSERT", "order_event", 177.0, 178.4, svc,
       "insert into orders.order_event (order_id, type, payload, created_at) values (?, ?, ?, ?)", "orders")
    db("order-orchestrator", "UPDATE", "order", 178.6, 179.5, svc,
       "update orders.order set status = ?, quote_id = ?, version = ? where id = ? and version = ?", "orders")
    oe = produce("order-orchestrator", "order-events", 180.0, 188.0, svc)

    # 4. Fan-out of order-events to four consumer groups
    # 4a. Flink job: operator spans are all siblings under the producer; it holds the order ~400 ms
    span("fulfillment-job", "KafkaSource.read", "consumer", 189.2, 189.4, oe, {
        "messaging.system": "kafka", "messaging.destination.name": "order-events", "messaging.operation": "receive",
        "messaging.kafka.consumer.group": "fulfillment-job", "messaging.kafka.message.offset": 88_120_554}, lib="flink", links=[oe])
    span("fulfillment-job", "EnrichProcessor.processElement", "internal", 189.6, 189.9, oe, {"key": "ord_01J9Z8Q4K2"}, lib="flink", links=[oe])
    span("fulfillment-job", "BatchWindowProcessor.processElement1", "internal", 240.0, 240.2, oe, {"key": "ord_01J9Z8Q4K2"}, lib="flink", links=[oe])
    # the Flink job also calls the route planner with an uninstrumented HTTP client -> orphan span in the gateway
    route_call(240.5, 262.0, parent_id="9e3f1c0a7b2d4e65", client_ip="192.0.2.41", ua="Apache-HttpClient/5.3.1 (Java/21.0.4)",
               route="7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f")
    span("fulfillment-job", "BatchWindowProcessor.onTimer", "internal", 590.3, 590.5, oe, {"key": "ord_01J9Z8Q4K2"}, lib="flink",
         events=[(590.4, "batch.decision", {"batch.decision": "RELEASE", "batch.trigger": "TIMER_EXPIRED"})], links=[oe])
    sink = span("fulfillment-job", "WarehouseDispatchSink", "producer", 590.8, 592.6, oe, {
        "messaging.system": "kafka", "messaging.destination.name": "warehouse-dispatch", "messaging.operation": "publish"},
        lib="flink", links=[oe])

    # 4b. Notifications: external push provider fails once, then the retry succeeds
    nc = consume("notification-service", "order-events", 190.1, 420.0, oe)
    ns_ = span("notification-service", "NotificationService#send", "internal", 190.4, 419.8, nc, {"code.function": "send"})
    db("notification-service", "SELECT", "preference", 190.6, 191.5, ns_,
       "select channel, locale from notifications.preference where customer_id = ?", "notifications")
    span("notification-service", "POST", "client", 192.0, 392.0, ns_, {
        "http.request.method": "POST", "url.full": "https://push.example.com/v1/messages",
        "server.address": "push.example.com", "http.response.status_code": 503}, lib="http",
        error="503 Service Unavailable",
        events=[(391.9, "exception", {
            "exception.type": "org.springframework.web.client.HttpServerErrorException$ServiceUnavailable",
            "exception.message": "503 Service Unavailable from POST https://push.example.com/v1/messages",
            "exception.stacktrace": "HttpServerErrorException$ServiceUnavailable: 503 Service Unavailable\n\tat ...PushClient.send(PushClient.java:88)"})])
    span("notification-service", "POST", "client", 395.0, 418.0, ns_, {
        "http.request.method": "POST", "url.full": "https://push.example.com/v1/messages",
        "server.address": "push.example.com", "http.response.status_code": 200, "http.request.resend_count": 1}, lib="http")

    # 4c. Analytics
    an = consume("analytics-sink", "order-events", 190.4, 191.2, oe)
    db("analytics-sink", "INSERT", "order_events", 190.6, 191.0, an,
       "INSERT INTO analytics.order_events FORMAT RowBinary", "analytics", system="clickhouse",
       host="clickhouse.example.internal")

    # 4d. Shipping: computes a quote and publishes back to the orchestrator (a "back in time" edge on the map)
    sc = consume("shipping-calculator", "order-events", 191.0, 215.0, oe)
    db("shipping-calculator", "SELECT", "rate", 191.5, 192.3, sc,
       "select carrier, base_minor, per_kg_minor from shipping.rate where zone = ? and service_level = ?", "shipping")
    db("shipping-calculator", "INSERT", "quote", 192.5, 193.4, sc,
       "insert into shipping.quote (order_id, carrier, amount_minor, currency) values (?, ?, ?, ?)", "shipping")
    sq = produce("shipping-calculator", "shipping-quoted", 194.0, 199.0, sc)
    so = consume("order-orchestrator", "shipping-quoted", 212.5, 220.0, sq)
    db("order-orchestrator", "UPDATE", "order", 213.0, 214.0, so,
       "update orders.order set shipping_minor = ?, version = ? where id = ? and version = ?", "orders")

    # 5. Warehouse: the gateway consumes the Flink output and calls inventory over gRPC (with an N+1 query)
    wg = consume("warehouse-gateway", "warehouse-dispatch", 594.0, 655.0, sink)
    _, st = grpc_pair("warehouse-gateway", "inventory-api", "example.inventory.v1.StockService", "GetStock", 594.5, 612.0, wg)
    t = 596.0
    for _ in range(8):
        db("inventory-api", "SELECT", "stock_item", t, t + 1.4, st,
           "select s.sku, s.bin, s.quantity from inventory.stock_item s where s.sku = ?", "inventory")
        t += 1.6
    _, sh = grpc_pair("warehouse-gateway", "inventory-api", "example.inventory.v1.ShipmentService", "CreateShipment", 612.5, 640.0, wg,
                      skew=1.8)  # inventory-api's clock runs behind: its server span starts before the client call
    db("inventory-api", "INSERT", "shipment", 613.5, 615.0, sh,
       "insert into inventory.shipment (id, order_id, created_at) values (?, ?, ?)", "inventory")
    db("inventory-api", "INSERT", "shipment_line", 615.2, 616.4, sh,
       "insert into inventory.shipment_line (shipment_id, sku, quantity) values (?, ?, ?)", "inventory")
    db("inventory-api", "INSERT", "shipment_line", 616.6, 617.7, sh,
       "insert into inventory.shipment_line (shipment_id, sku, quantity) values (?, ?, ?)", "inventory")
    db("inventory-api", "UPDATE", "stock_item", 618.0, 627.5, sh,
       "update inventory.stock_item set quantity = quantity - ?, version = ? where sku = ? and version = ?", "inventory")
    db("inventory-api", "UPDATE", "stock_item", 627.8, 638.6, sh,
       "update inventory.stock_item set quantity = quantity - ?, version = ? where sku = ? and version = ?", "inventory")
    sc_ = produce("warehouse-gateway", "shipments-created", 641.0, 648.0, wg)

    # 6. Downstream of the warehouse
    # Flink propagates the *input* message's context to every operator, so its consumer of
    # shipments-created shows up as a child of the order-events producer (re-linked by the model).
    span("fulfillment-job", "ShipmentResultProcessor.processResult", "consumer", 650.0, 650.3, oe, {
        "messaging.system": "kafka", "messaging.destination.name": "shipments-created", "messaging.operation": "process",
        "messaging.kafka.consumer.group": "fulfillment-job"}, lib="flink", links=[oe])
    tr = consume("tracking-service", "shipments-created", 649.2, 655.4, sc_)
    db("tracking-service", "SELECT", "parcel", 650.0, 651.5, tr,
       "select id, carrier, status from tracking.parcel where shipment_id = ?", "tracking")
    ie = consume("invoice-service", "shipments-created", 649.5, 668.3, sc_)
    db("invoice-service", "INSERT", "invoice_line", 650.2, 667.9, ie,
       "insert into invoicing.invoice_line (order_id, issued_at, amount_minor, description) values (?, ?, ?, ?)",
       "invoicing")


def export():
    batches = {}
    for svc, lib, s in spans:
        batches.setdefault(svc, {}).setdefault(lib, []).append(s)
    out = []
    for svc, libs in batches.items():
        nsp, scope, lang, pod, extra = SERVICES[svc]
        res = {
            "deployment.scope.name": scope,
            "k8s.namespace.name": nsp,
            "k8s.pod.name": f"{svc}-{pod}",
            "k8s.node.name": f"node-{int(hashlib.md5(svc.encode()).hexdigest(), 16) % 6 + 1}.example.internal",
            "service.name": svc,
            "service.version": "1.42.0",
            "telemetry.sdk.language": lang,
            "telemetry.sdk.name": "opentelemetry",
        }
        res.update(extra)
        out.append({
            "resource": {"attributes": kv(res), "droppedAttributesCount": 0},
            "instrumentationLibrarySpans": [
                {"spans": ss, "instrumentationLibrary": {"name": LIBS[lib][0], "version": LIBS[lib][1]}}
                for lib, ss in libs.items()
            ],
        })
    return {"batches": out}


if __name__ == "__main__":
    build()
    doc = export()
    text = json.dumps(doc, separators=(",", ":"))
    with open(os.path.join(ROOT, "data", "sample-trace.json"), "w") as f:
        f.write(text)
    with open(os.path.join(ROOT, "data", "sample-trace.js"), "w") as f:
        f.write("// Fictional demo trace generated by tests/make_demo_trace.py: no real data.\n")
        f.write("window.TV_SAMPLE_TRACE = " + text + ";\nwindow.TV_SAMPLE_NAME = \"demo-trace.json\";\n")
    print(f"wrote {len(spans)} spans across {len({s for s, _, _ in spans})} services")
