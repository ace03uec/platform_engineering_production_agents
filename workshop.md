# Workshop starting point

Baseline recorded on 14 September 2026. This document describes the current v4 implementation that we will begin with in the workshop. The next variation has not been designed or implemented yet.

We start with a working create/read application, an observe-only Pi incident agent, and observability for both. Participants can inspect health, request metrics, traces, logs, and incident records. The agent currently receives only a small subset of that information.

## 1. The running system

```text
HTTP client → Go app → PgBouncer → PostgreSQL
                    → Redis

Agent → app health/read probes
      → Prometheus readiness probe
      → Pi model investigation when an incident opens

Prometheus → app /metrics
           → Blackbox Exporter → app and agent health endpoints

App and agent → OpenTelemetry Collector → ClickHouse
Grafana → Prometheus and ClickHouse
```

| Component | Current responsibility |
| --- | --- |
| Go app | Creates and reads items; exposes health endpoints, metrics, and request traces. |
| PostgreSQL | Stores items with an `id` and `name`. The app creates the table at startup. |
| PgBouncer | Shares five PostgreSQL server connections in transaction pooling mode. The Go connection pool also has a maximum of five connections. |
| Redis | Counts valid create/read attempts in `workshop:requests` before SQL runs. It is a required dependency, not a cache. |
| Agent | Detects sustained availability failures and requests one advisory Pi diagnosis per incident. |
| Prometheus | Stores application metrics and external health-probe measurements, collected every five seconds. |
| Blackbox Exporter | Makes HTTP health checks on behalf of Prometheus. |
| OpenTelemetry Collector | Receives app and agent spans and exports them to ClickHouse. |
| ClickHouse | Stores traces in `otel.otel_traces`. |
| Grafana | Displays the provisioned App Health, Agent Health, and Workshop Traces dashboards. |

Run commands in this document from `v4/`:

```sh
docker compose up --build -d --wait
docker compose ps
```

Model diagnosis requires a provider key in `agent/.env`; follow [agent setup](agent/README.md#start). Monitoring and incident resolution detection work without a key, but model investigation will report an error. Grafana's first startup downloads its pinned ClickHouse plugin and requires internet access.

## 2. Application endpoints and their information

Default application address: [localhost:8080](http://localhost:8080).

| Endpoint | Information or behavior | How to interpret it |
| --- | --- | --- |
| `POST /post` | Accepts `{"name":"First item"}` and returns the created item with HTTP 201. | Exercises Redis and a PostgreSQL write through PgBouncer. |
| `GET /get` | Returns up to 100 items ordered by ID. | Exercises Redis and a PostgreSQL read through PgBouncer. |
| `GET /get?id=1` | Returns one item, or 404 if it is absent. | A missing item is different from a dependency failure. |
| `GET /live` | Returns `{"status":"alive"}` with HTTP 200. | The HTTP server can respond; dependencies are not checked. |
| `GET /ready` | Pings PostgreSQL through PgBouncer, then Redis, under a three-second context deadline. | HTTP 200 means both checks passed. A dependency failure returns 503; the first failure ends the check. |
| `GET /health` | Alias for readiness. | Used by the existing agent and Docker health check. |
| `GET /metrics` | Prometheus text metrics. | Provides request counts, latency distributions, and Go/process measurements. |

An app can be live but unready: for example, its HTTP server can respond while Redis is unavailable. Readiness checks dependency connectivity; it does not prove that every business operation or write will succeed.

```sh
curl -i http://localhost:8080/live
curl -i http://localhost:8080/ready
curl -i -X POST http://localhost:8080/post \
  -H 'Content-Type: application/json' \
  -d '{"name":"First item"}'
curl -i http://localhost:8080/get
```

Normal read probes from the agent also increment Redis and contribute to application request metrics. The Redis counter measures attempts that reach the increment, not successfully completed database operations.

## 3. Simulated failure information

Both create/read routes accept a `fails` query parameter:

| Flag | Simulated condition |
| --- | --- |
| `db_conn` | Database connection failure |
| `db_space` | Database disk full |
| `redis` | Redis failure |
| `app` | Application error |

```sh
curl -i 'http://localhost:8080/get?fails=db_conn,redis'
```

The response reports the requested flags and returns 503, or 500 if `app` is included. Unknown flags return 400. Valid simulated failures are logged and attached to the request span as `workshop.failures`.

These failures affect only that request and return before Redis or SQL work. The next normal request can succeed. They provide error examples in metrics, traces, and logs, but do not create a dependency outage or trigger the agent's normal health/read probes to fail.

## 4. Health dashboards

Open [Grafana](http://localhost:3000), using the local default login `admin` / `workshop` unless customized.

- [App Health](http://localhost:3000/d/workshop-app-health): checks the app's `/live` and `/ready` endpoints.
- [Agent Health](http://localhost:3000/d/workshop-agent-health): checks the agent's `/live` and `/ready` endpoints on port 8090.

Both dashboards contain the same five kinds of information:

| Panel | Meaning |
| --- | --- |
| Liveness | Whether the service responds successfully to its HTTP liveness check. |
| Readiness | Whether the service's readiness condition passes. App and agent readiness have different meanings. |
| Probe collection | Whether Prometheus successfully collected the probe result from Blackbox Exporter. This measures the observation path. |
| Liveness and readiness history | When the checks passed or failed over the selected time range. |
| HTTP probe duration | How long the external health checks took, in seconds. This is not create/read request latency. |

`UP` means a successful check, `DOWN` means a failed check, and `UNKNOWN` means the required probe telemetry is unavailable. Missing information must not be read as a healthy service.

Agent `/live` checks its HTTP server. Agent `/ready` and `/health` require a completed monitor poll within the last 45 seconds and a monitor that is not stopping. Their response also includes `mode`, `ready`, `incident`, and `lastPoll` (Unix milliseconds, or null before the first completed poll).

Agent readiness does not require a healthy app or working model credentials. A healthy agent can be observing a broken application. The external dashboard checks run every five seconds without reading items or calling a model, and do not initiate remediation.

## 5. Application metrics

Open [Prometheus](http://localhost:9090).

| Measurement | Information available |
| --- | --- |
| `workshop_http_requests_total` | Completed create/read request counts, separated by `method`, `route`, and HTTP `status`. Includes error responses. |
| `workshop_http_request_duration_seconds` | A histogram of create/read duration in seconds, with the same labels. Supports latency percentile estimates. |
| Go/process metrics | Runtime and process measurements, such as memory and garbage collection, exposed by the registered collectors. |
| `probe_success` | Whether a Blackbox HTTP check passed. |
| `probe_duration_seconds` | Duration of a Blackbox check. |
| `up` | Whether Prometheus successfully scraped a target. For health probes, this is distinct from the endpoint passing its check. |

Useful queries:

```promql
workshop_http_requests_total
rate(workshop_http_requests_total[1m])
histogram_quantile(0.95, sum by (le, route) (rate(workshop_http_request_duration_seconds_bucket[5m])))
```

The rate query gives requests per second for each label combination. The percentile query estimates the duration below which 95% of requests fall, per route, over five minutes. Sparse traffic can make short-window estimates less useful.

Only matched `/get` and `/post` routes produce application request metrics and traces. Health and metrics requests are excluded. There are no configured PostgreSQL, PgBouncer, or Redis metric exporters, and the agent does not currently query these Prometheus measurements.

## 6. Traces: application and agent execution

Open [Workshop Traces](http://localhost:3000/d/workshop-traces/workshop-traces). A trace groups related work; each span records one operation's timing, status, and selected attributes.

The dashboard provides trace count, error span count, p95 span duration, and the latest 500 spans for the selected range and filters. These are span measurements; they are not interchangeable with HTTP request metrics. Select a trace ID or paste one into the Trace ID field to inspect up to 1,000 spans across retained data, independently of the time picker. Details include parent span IDs, status, and attributes; the display is a table rather than a waterfall.

### Application spans

Service `workshop-app` produces one span per matched create/read request. It records the method, route, HTTP status, and valid simulated failure flags when present. HTTP 5xx responses mark the span as an error. Each response includes `X-Trace-ID` for lookup.

Current spans cover the whole request. They do not separate Redis time, connection waiting, or PostgreSQL query time. Item data, request bodies, and raw query strings are not recorded.

### Agent spans

Service `workshop-agent` records this monitoring structure:

```text
agent.poll
├── agent.probe.health
├── agent.probe.read
│   └── GET /get   (workshop-app)
└── agent.probe.prometheus
```

The read probe passes W3C `traceparent` context to the app, allowing its Go span to appear in the same trace. Probe spans include HTTP status when available and an error status for failed probes. Healthy monitoring produces these traces even without model credentials.

An incident investigation produces `pi.investigate`, with `pi.turn` and `pi.model` spans as execution reaches those stages. Available attributes include incident ID, initialized Pi session ID, provider/model, reported input/output tokens, cache token usage, and estimated USD cost. Token/cost values are trace attributes, not Prometheus metrics. Reports include an investigation `traceId`.

The investigation trace links to the triggering poll through an OpenTelemetry span link; the current dashboard does not display those links. Tool-span handling exists for future use, but the current Pi session has no tools. Prompts, model responses, tool payloads, credentials, and raw exception messages are excluded from exported agent traces.

The monitor owns investigation spans so it can close and mark them failed if its worker crashes or exceeds the 90-second deadline. Export is asynchronous and can lag by a few seconds. In-memory queues can lose spans during outages or process termination; trace delivery is not guaranteed. ClickHouse traces expire after seven days.

## 7. What the agent actually knows and does

The monitor concurrently probes app `/health`, app `/get`, and Prometheus `/-/ready`, each with a five-second timeout, then sleeps ten seconds after its processing. Poll start times can therefore be more than ten seconds apart.

Its incident decision uses only app health and read success:

1. Three consecutive failing polls open an incident.
2. One Pi investigation is dispatched for that incident, with a hard 90-second deadline. Monitoring continues while it runs.
3. Three consecutive successful polls resolve the incident.

Prometheus readiness is supplementary evidence and does not determine whether an app incident opens. It only says that Prometheus is ready, not that all scrape targets are healthy.

The model receives static instructions from `agent/AGENTS.md`, the incident record, the current poll timestamp, probe success/status or transport errors, and the triggering trace context. Probe response bodies are discarded: the model does not receive item contents or even the health response's dependency-specific error body. A trace ID is a reference, not the trace's contents.

| Information or capability | Available to a participant | Used by the current agent/model |
| --- | --- | --- |
| App health/read outcomes | HTTP requests and agent logs | Yes: bounded probe outcomes |
| Prometheus readiness | HTTP request | Yes: supplementary probe outcome |
| Health dashboard history | Grafana/Prometheus | No |
| Request metrics and latency | Prometheus | No |
| App and agent traces | Grafana/ClickHouse | Exported by the system, but not retrieved for diagnosis |
| Container logs | Docker Compose | No log-reading tool |
| PostgreSQL/PgBouncer/Redis inspection | Human-run commands | No infrastructure tools |
| Remediation | Human-run operations | No execution capability |

Pi produces an advisory report: impact, evidence, likely cause and confidence, missing evidence, suggested human-run diagnostics, and a proposed remedy. It cannot execute commands or validate recovery through prose. There is no approval controller, checkout lab, job pausing, or session termination in this baseline.

Investigation attempts are saved before dispatch to avoid repeating model calls after restart. Failed or interrupted investigations are not automatically retried. A later, separate incident can trigger another model call. There is no exact token or dollar cap.

## 8. Logs and incident records

```sh
docker compose logs --tail=100 app agent
docker compose exec agent node -e "console.log(require('fs').readFileSync('/data/state.json','utf8'))"
docker compose exec agent ls /data/incidents
docker compose exec redis redis-cli GET workshop:requests
```

App logs include startup, simulated failures, and dependency errors. They are not a complete per-request access log. Agent logs include startup, incident opening/resolution, diagnosis reports, and investigation errors. `escalated` means a log entry; no email, Slack message, or page is delivered.

`/data/state.json` holds consecutive failure/success counts, the current incident, its attempt marker when present, and the latest evidence. `/data/incidents/<id>.json` stores lifecycle information and evidence; `<id>.report.json` stores the diagnosis or error and investigation trace ID. The lifecycle file is updated on transitions rather than being an append-only event ledger.

Agent records survive restarts in `agent-data`. Agent Docker logs rotate, but incident files need manual retention management. PostgreSQL, Prometheus, ClickHouse, and Grafana also use named volumes. `docker compose down` preserves these volumes; Redis's counter is disposable. This setup expects one agent replica.

## 9. Recorded verification and workshop boundary

During the baseline inspection on 14 September 2026:

- All ten Compose services were running; every configured container health check passed. Blackbox Exporter and the Collector have no Compose health check.
- `go test ./...` passed in `app/` (cached result).
- All ten Node tests passed using `npm test` in `agent/`, covering health semantics, incident transitions, telemetry projection, failure handling, and trace-context propagation.
- No outage or live model investigation was triggered during that inspection. Container health does not verify model credentials, dashboard rendering, or end-to-end trace delivery.

This is a dated snapshot, not a guarantee of the stack's state at workshop time. Recheck with `docker compose ps` and the health endpoints before beginning. The baseline contains uncommitted changes and is not identified by a dedicated baseline commit.

The workshop begins with this observable application and observe-only investigator. The next variation will be developed from here; no additional agent tools, detection rules, or recovery workflow are assumed.
