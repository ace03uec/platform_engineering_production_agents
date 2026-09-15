# Agent v1 — trace observability

Same health endpoints, ten-second monitor, incident thresholds, and advisory-only
Pi diagnosis as v0. Adds OpenTelemetry without enabling tools or remediation.

- `agent.poll`: one root span per monitor iteration, including app health.
- `agent.probe`: child spans for `/health` and `/get`, including HTTP status.
  W3C trace context is forwarded to the app to correlate downstream spans.
- `agent.diagnosis`: asynchronous child span for the entire Pi diagnosis,
  including provider, model, and incident ID; failures have error status.
- Poll logs include trace/span IDs. Prompts, reports, credentials, and provider
  error bodies are not exported as span attributes.

Spans are batch-exported over OTLP HTTP to the existing collector and ClickHouse,
with service name `workshop-agent` and service version `v1`. Completed spans appear
in Grafana; an in-flight diagnosis is not visible until it ends. This version
traces the diagnosis as a whole, not individual model streaming events.

```sh
AGENT_VERSION=v1 docker compose -f docker-compose-agent.yml up --build -d --wait
```

Open http://localhost:3000/d/workshop-traces/workshop-traces?var-service=workshop-agent
and click a trace ID for its spans. Agent Health remains available at
http://localhost:3000/d/workshop-agent-health.

Model configuration remains in `agent/.env`; see `../v0/README.md`.
Rollback with `AGENT_VERSION=v0 docker compose -f docker-compose-agent.yml up -d --wait`.
