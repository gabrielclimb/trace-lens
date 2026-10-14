# Trace Lens: static site served by an unprivileged nginx (runs as non-root on port 8080).
FROM nginxinc/nginx-unprivileged:1.27-alpine

LABEL org.opencontainers.image.title="Trace Lens" \
      org.opencontainers.image.description="Explore Grafana Tempo / OpenTelemetry traces grouped by service: flow map, swimlanes, critical path and insights." \
      org.opencontainers.image.licenses="NOASSERTION"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY data/sample-trace.js /usr/share/nginx/html/data/sample-trace.js
COPY docker/local-trace.js /usr/share/nginx/html/data/local-trace.js

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
