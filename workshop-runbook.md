# Workshop command runbook

Run sections in order, one code block at a time. Pause at each observation before continuing. Use the same terminal for version switches; a second terminal is useful for following logs.

These commands assume Docker Compose, Python 3, curl, and the default localhost ports. Run from the repository root. Model demos need working provider credentials and quota in ignored `agent/.env`. Do not display that file while presenting.

## 0. Start the application and prepare version switching

```sh
cd /Users/giridaranmanivannan/Projects/platform_engineering_production_agents
```

Optional teardown when starting from an existing session. This preserves all data volumes, including previous traces and evaluation results.

```sh
docker compose -f docker-compose-agent.yml down
docker compose -f docker-compose-app.yml down
```

Start the application and observability stack:

```sh
docker compose -f docker-compose-app.yml up --build -d --wait
docker compose -f docker-compose-app.yml ps
curl -i http://localhost:8080/ready
```

Define this helper once in your terminal. Each call builds and starts one agent version, updates the static Prometheus agent-metrics version label, and restarts Prometheus to load it. It edits only that label in `observability/prometheus.yml`; the app stack stays running. If you open a new terminal, define the helper again.

```sh
workshop_version() {
  case "$1" in
    v0|v1|v2|v3|v4|v5|v6) ;;
    *) echo 'Use v0 through v6'; return 1 ;;
  esac
  AGENT_VERSION="$1" docker compose -f docker-compose-agent.yml up --build -d --wait || return
  python3 - "$1" <<'PY'
import re
import sys
from pathlib import Path

path = Path('observability/prometheus.yml')
text = path.read_text()
pattern = r'(  - job_name: agent-metrics\n(?:(?!  - job_name:).)*?\n          version: )v\d+'
updated, count = re.subn(pattern, lambda m: m[1] + sys.argv[1], text, flags=re.S)
if count != 1:
    raise SystemExit('Expected one agent-metrics version label; inspect prometheus.yml')
path.write_text(updated)
PY
  if [ "$?" -ne 0 ]; then return 1; fi
  docker compose -f docker-compose-app.yml restart prometheus || return
  curl -fsS http://localhost:8090/live
  echo
}
```

Grafana: <http://localhost:3000>, default login `admin` / `workshop` unless customized. Use a recent time range such as **Last 5 minutes** with auto-refresh. Allow a few scrapes after each switch. Old data remains visible in historical ranges.

Use the generic Agent Health dashboard below; the version-specific v0/v1 health dashboards require extra probe labels that the current Prometheus configuration does not supply.

## 1. v0 — Is the agent alive and ready?

```sh
workshop_version v0
curl -i http://localhost:8080/live
curl -i http://localhost:8080/ready
curl -i http://localhost:8090/live
curl -i http://localhost:8090/ready
```

Exercise a normal write and read:

```sh
curl -i -X POST http://localhost:8080/post \
  -H 'Content-Type: application/json' \
  -d '{"name":"Workshop item"}'
curl -i http://localhost:8080/get
```

Open [App Health](http://localhost:3000/d/workshop-app-health) and [Agent Health](http://localhost:3000/d/workshop-agent-health).

**Ask:** If Redis goes down, should the agent become unready too?

```sh
docker compose -f docker-compose-app.yml stop redis
curl -i http://localhost:8080/live
curl -i http://localhost:8080/ready
curl -i http://localhost:8090/ready
```

Watch until three failed polls open an incident, usually around 30–45 seconds. A model diagnosis can take longer. Run in a second terminal, then press Ctrl-C to stop following logs (this does not stop the agent):

```sh
docker logs --follow --since 2m workshop-agent
```

**Observe:** App liveness remains 200, app readiness returns 503, and the agent remains ready. Look for `opened`, followed by `diagnosis` or `diagnosis_error`. Readiness proves the monitor is polling; it does not prove model access or diagnostic correctness. v0 cannot execute its suggested remedy.

Restore Redis, then wait for three successful polls and a `resolved` log before continuing:

```sh
docker compose -f docker-compose-app.yml start redis
curl -i http://localhost:8080/ready
docker logs --since 2m workshop-agent
```

Do not substitute `/get?fails=redis` for this outage: simulated flags affect only that request, not the agent's normal probes.

## 2. v1 — What is the agent doing?

```sh
workshop_version v1
curl -i http://localhost:8090/ready
curl -i http://localhost:8080/get
docker logs --tail 10 workshop-agent
```

Open [Workshop Traces](http://localhost:3000/d/workshop-traces/workshop-traces?var-service=workshop-agent). Inspect a poll trace and its probe spans; the read probe propagates trace context to the app.

Trigger an investigation:

```sh
docker compose -f docker-compose-app.yml stop redis
```

Follow logs until the incident opens and the diagnosis completes or fails:

```sh
docker logs --follow --since 1m workshop-agent
```

**Observe:** Inspect `agent.diagnosis` in Grafana. It appears after the span ends and export completes. v1 traces the whole diagnosis, not individual streaming events. Ask what the trace proves and what is still unknown.

Press Ctrl-C, restore Redis, and wait for resolution:

```sh
docker compose -f docker-compose-app.yml start redis
curl -i http://localhost:8080/ready
docker logs --since 2m workshop-agent
```

## 3. v2 — Can we see the cost growing?

v2 deliberately calls the model on every poll and repeatedly diagnoses an open incident. It has no budget control. Keep this demonstration brief and stop v2 when done; leaving the app healthy does not stop its assessments.

```sh
workshop_version v2
curl -sS http://localhost:8090/metrics
```

Open [Agent Cost v2](http://localhost:3000/d/workshop-agent-cost-v2). Wait for a few completed model calls, then inspect the metrics again:

```sh
curl -sS http://localhost:8090/metrics
docker logs --tail 20 workshop-agent
```

**Observe:** `agent_model_calls_total`, `agent_llm_tokens_total`, and estimated `agent_llm_cost_usd_total`. At the default interval, assessment attempts occur roughly six times a minute even when healthy. Failed provider calls are not evidence of successful model usage; inspect failures if cost stays flat. Rate panels need multiple scrapes.

Optional brief outage to demonstrate repeated diagnosis calls:

```sh
docker compose -f docker-compose-app.yml stop redis
```

After the incident opens and a few failed polls occur:

```sh
curl -sS http://localhost:8090/metrics
docker compose -f docker-compose-app.yml start redis
```

Stop v2 before discussing the results:

```sh
docker compose -f docker-compose-agent.yml stop agent
```

**Ask:** Seeing the bill is useful, but what can the operator do to stop it?

## 4. v3 — Stop spending while monitoring continues

```sh
workshop_version v3
curl -sS http://localhost:8090/cost
```

Open [Agent Cost v3](http://localhost:3000/d/workshop-agent-cost-v3). After some model usage, activate the stop control:

```sh
curl -sS -X POST http://localhost:8090/cost/stop
curl -i http://localhost:8090/ready
curl -sS http://localhost:8090/cost
```

Wait a few polls, then inspect blocked calls:

```sh
curl -sS http://localhost:8090/metrics
```

**Observe:** Readiness stays healthy and new model calls are blocked with reason `stopped`. An already-running call may finish and record usage; this is an admission gate, not a provider cancellation guarantee.

Resume and demonstrate the budget breaker:

```sh
curl -sS -X POST http://localhost:8090/cost/resume
curl -sS -X POST 'http://localhost:8090/cost/budget?usd=0.0001'
curl -sS http://localhost:8090/cost
```

The breaker opens immediately only if recorded spend has reached that budget. With no usage yet, wait for a successful call. This threshold is not a hard cap on an in-flight call's cost.

Restore the default budget, then stop new calls while discussing:

```sh
curl -sS -X POST 'http://localhost:8090/cost/budget?usd=0.05'
curl -sS -X POST http://localhost:8090/cost/stop
```

If spend already exceeds $0.05, restoring that value does not close the breaker. Cost controls and counters reset on agent restart/version switch.

## 5. v4 — What can an unsafe tool policy allow?

v4 operates only on fictional files in the dedicated `/workspace` volume. Its tools can delete important fixtures without approval. Keep real data out of this volume. The actual model action is not deterministic.

```sh
workshop_version v4
sh agent/v4/reset-workspace.sh
docker exec workshop-agent find /workspace -type f
```

Open [Agent Safety v4](http://localhost:3000/d/workshop-agent-safety-v4).

Pause the app for two minutes to trigger the incident. The subshell trap resumes it on exit or interruption. While this runs, follow logs in a second terminal.

```sh
(
  trap 'docker unpause workshop-v4-app-1' EXIT
  docker pause workshop-v4-app-1 || exit 1
  sleep 120
)
```

```sh
docker logs --tail 80 workshop-agent
docker exec workshop-agent find /workspace -type f
curl -sS http://localhost:8090/metrics
```

**Observe:** Read the tool audit events and remaining-file inventory. Do not claim deletion occurred unless the evidence shows it. Missing credentials, exhausted budget, or model choices may prevent deletion. Successful tool execution does not prove the app recovered because of that action.

Wait for the remediation session to finish (or stop the agent). If it is still running, stop it before switching; reset fixtures in v5 after the old process is gone:

```sh
docker compose -f docker-compose-agent.yml stop agent
curl -i http://localhost:8080/ready
```

Emergency recovery if the app remains paused:

```sh
docker unpause workshop-v4-app-1
```

## 6. v5 — Enforce policy and require operator approval

Before starting v5, ensure `agent/.env` contains an unquoted `OPERATOR_TOKEN` of at least 24 random characters. This command preserves a valid existing token and generates one only if missing/too short, without printing it:

```sh
python3 - <<'PY'
from pathlib import Path
import secrets

path = Path('agent/.env')
lines = path.read_text().splitlines() if path.exists() else []
tokens = [line.split('=', 1)[1].strip() for line in lines if line.startswith('OPERATOR_TOKEN=')]
if len(tokens) != 1 or len(tokens[0]) < 24:
    lines = [line for line in lines if not line.startswith('OPERATOR_TOKEN=')]
    lines.append('OPERATOR_TOKEN=' + secrets.token_hex(24))
    path.write_text('\n'.join(lines) + '\n')
    path.chmod(0o600)
print('Operator token configured; value hidden.')
PY
workshop_version v5
sh agent/v5/reset-workspace.sh
```

Open [Agent Safety v5](http://localhost:3000/d/workshop-agent-safety-v5).

Run the provider-independent demonstration:

```sh
python3 agent/v5/operator.py demo
python3 agent/v5/operator.py status
```

**Observe:** The protected-file request is denied; `tmp/scratch-1.log` becomes pending. This is a **scripted replay through the actual policy code**, not a model-generated decision. No deletion happens merely because a request is pending.

Copy the pending request ID from the output and replace `REQUEST_ID` below. Review the path before approving. Approvals expire after five minutes.

```sh
python3 agent/v5/operator.py approve REQUEST_ID
python3 agent/v5/operator.py status
docker exec workshop-agent find /workspace -type f
```

Alternatively, reject instead of approving:

```sh
python3 agent/v5/operator.py reject REQUEST_ID
```

**Observe:** Approval is single-use and rechecks the file and policy. The important file remains protected. Stop/budget controls can block approval execution too; inspect status if it fails. Do not reset fixtures between requesting and approving, since that changes the file identity.

After completing or rejecting the request, reset the fixtures:

```sh
sh agent/v5/reset-workspace.sh
```

## 7. v6 — Did the model make the right decision?

```sh
workshop_version v6
docker exec workshop-agent node src/eval/run.mjs --smoke
```

Open [Agent Evaluations v6](http://localhost:3000/d/workshop-agent-evals-v6) and select **fixture** as Result source.

**Observe:** Smoke mode feeds scripted good/bad decisions into the grader without model calls. It demonstrates the evaluation harness, not model quality. The runtime agent retains v5 behavior; smoke mode does not change its separate monitoring/model activity.

For a real comparison, list available model identifiers:

```sh
docker exec workshop-agent node src/eval/list-models.mjs
```

Replace both placeholders with distinct `provider/model` identifiers for credentials you have configured. Start with one repeat: six cases per model, twelve sessions total.

```sh
docker exec workshop-agent node src/eval/run.mjs --live \
  --models 'PROVIDER_A/MODEL_A,PROVIDER_B/MODEL_B' \
  --repeats 1 --budget-usd 0.05
```

The budget is checked between cases; a case can overshoot. The eval runner is independent of the HTTP cost stop control. Provider errors or unknown pricing stop the run; exit status 2 means incomplete. Do not present an incomplete run as a valid comparison.

Use the printed run ID, replacing `RUN_ID`:

```sh
docker exec workshop-agent node src/eval/compare.mjs /evals/RUN_ID.json
```

Select **live** in Grafana after a complete real comparison. Discuss correctness and safety failures before cost and latency. These six structured cases do not establish general production correctness. Reports persist in the evaluation volume.

## 8. Finish or return to the opening

To return to the healthy v0 opening, first restore Redis and ensure the app is not paused, then switch:

```sh
docker compose -f docker-compose-app.yml start redis
workshop_version v0
curl -i http://localhost:8080/ready
curl -i http://localhost:8090/ready
```

Or stop the workshop, retaining all volumes:

```sh
docker compose -f docker-compose-agent.yml down
docker compose -f docker-compose-app.yml down
```

Do not add `--volumes` unless you intentionally want to erase the saved workshop data.
