# Agent v3 — the stop lever (cost control)

v3 keeps v2's cost/token telemetry but adds the control that v2 lacked, and
fixes the two storm bugs. The runaway anti-pattern (per-poll assessment) is
still enabled by default so the lever has something to stop.

## The lever

| Control | Mechanism | Effect |
| --- | --- | --- |
| **Budget circuit breaker** | `AGENT_BUDGET_USD` (default `0.05`) | When cumulative spend reaches the budget, all model calls are refused. Trips the moment `recordUsage` crosses the line. |
| **Manual kill switch** | `POST /cost/stop` / `POST /cost/resume` | Operator stops/allows all model spend immediately, regardless of budget. |
| **Live budget update** | `POST /cost/budget?usd=0.10` | Raises the budget; closes the breaker when the budget is back above spend. |
| **Storm fixes** | code | One diagnosis per incident again (v1 behaviour), and a single in-flight model call (`concurrency` refusals replace overlap). |

The gate (`spendBlockReason`) checks, in order: kill switch → budget breaker →
in-flight slot. Every refusal is counted in
`agent_model_calls_blocked_total{purpose,reason}` and gate transitions
(`breaker_opened`/`breaker_closed`/`spend_stopped`/`spend_resumed`) are logged
once, not per refused call.

**What the lever never touches:** probing, incident open/resolve, health
endpoints, and tracing. A tripped breaker or pulled kill switch must never fail
readiness — losing the model must not blind the monitor. `/ready` still only
describes the monitor loop, but its body now includes the full cost state.

## Endpoints (port 8090, additions)

| Endpoint | Behaviour |
| --- | --- |
| `GET /cost` | Spend, budget, remaining, breaker/kill-switch state, call and blocked counters |
| `POST /cost/stop` | Pull the kill switch |
| `POST /cost/resume` | Release the kill switch |
| `POST /cost/budget?usd=X` | Set the budget (closes the breaker if above spend) |

## New metrics

`agent_cost_budget_usd` (gauge), `agent_cost_breaker_open` (0/1),
`agent_cost_manual_stop` (0/1), `agent_model_calls_blocked_total{purpose,reason}`
(counter, reasons: `budget`, `stopped`, `concurrency`),
`agent_model_calls_inflight` (gauge, capped at 1).

## Dashboard

[Agent Cost — v3](http://localhost:3000/d/workshop-agent-cost-v3): spend vs
budget line, breaker and kill-switch states, remaining budget, blocked calls by
reason. Proof the lever works: the spend rate drops to zero while blocked calls
climb.

## Demo

```sh
AGENT_VERSION=v3 docker compose -f docker-compose-agent.yml up --build -d --wait

# Pull the kill switch — assessments stop billing, blocked{reason="stopped"} climbs:
curl -X POST localhost:8090/cost/stop
curl -s localhost:8090/cost | jq .
curl -X POST localhost:8090/cost/resume

# Force the breaker: set the budget below current spend, then restore:
curl -X POST 'localhost:8090/cost/budget?usd=0.0001'   # breaker OPEN
curl -X POST 'localhost:8090/cost/budget?usd=0.05'     # breaker closed

# Or let it trip naturally: AGENT_BUDGET_USD=0.002 in agent/.env and wait.
```

Rollback: `AGENT_VERSION=v2 docker compose -f docker-compose-agent.yml up -d --wait`.
