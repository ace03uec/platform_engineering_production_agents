# Agent v2 — cost observability (and a runaway spend)

v2 keeps v0/v1 behaviour — same health endpoints, incident thresholds, tracing,
advisory-only diagnoses — and adds token/cost instrumentation. It also ships a
**deliberate cost anti-pattern** for the workshop:

1. **Assessment every poll.** Every poll asks the model to classify app health
   (`agent.assessment`), healthy or not. Model spend is proportional to the
   poll rate and never stops.
2. **Re-diagnosis storm.** While an incident is open, v2 re-diagnoses on
   *every* failed poll instead of once per incident. No guard, no queueing,
   nothing awaited. An outage multiplies the burn rate.

There is no budget, no rate limit, and no circuit breaker — that is the point
of the exercise. Cost visibility exists; cost control does not.

## Metrics — `GET /metrics` (Prometheus text format)

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `agent_llm_cost_usd_total` | counter | — | Cumulative estimated spend (pi model pricing) |
| `agent_llm_tokens_total` | counter | `direction` | input/output/cache_read/cache_write tokens |
| `agent_model_calls_total` | counter | `purpose` | `assessment` (per-poll) vs `diagnosis` (per incident) |
| `agent_model_call_failures_total` | counter | `purpose` | Errored model calls |
| `agent_uptime_seconds` | gauge | — | Process uptime |

Cost comes from the message `usage.cost.total` reported by the Pi SDK, falling
back to the model's per-million-token rates when a provider reports zero.

## Dashboard

[Agent Cost — v2](http://localhost:3000/d/workshop-agent-cost-v2): cumulative
spend, burn rate ($/min), projected daily cost, tokens by direction, calls by
purpose, tokens per call. Panels use `version="v2"` series from the
`agent-metrics` Prometheus job.

## Watching the runaway

Baseline: ~6 assessment calls/min at the default 10 s poll.

```sh
AGENT_VERSION=v2 docker compose -f docker-compose-agent.yml up --build -d --wait
curl -s localhost:8090/metrics | grep -E 'cost|tokens_total.*input'
```

Accelerate it, either/or:

```sh
# 10x the poll rate (restart required):
echo POLL_INTERVAL_MS=1000 >> ../.env   # agent/.env

# Open an incident: every failed poll now also bills a diagnosis.
docker pause workshop-v4-app-1          # resume: docker unpause workshop-v4-app-1
```

`ASSESS_EVERY_POLL=false` (in `agent/.env`) disables the per-poll assessment
and leaves only the diagnosis storm.

Model configuration is unchanged (`agent/.env`, see `../v0/README.md`).
Rollback: `AGENT_VERSION=v1 docker compose -f docker-compose-agent.yml up -d --wait`.
