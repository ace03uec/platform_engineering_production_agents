# Agent v0 — liveness/readiness + basic Pi debugging

The smallest useful Pi-based agent. It answers health checks, polls the app,
and on a sustained outage asks a Pi model for **one advisory diagnosis** per
incident. No tools, no state, no tracing.

Built on the Pi SDK (`@earendil-works/pi-coding-agent`): each diagnosis is a
throwaway in-memory session with all tools disabled (`noTools: 'all'`), a
90-second abort deadline, and `AGENTS.md` as the system prompt.

## Endpoints (port 8090)

| Endpoint | Behaviour |
| --- | --- |
| `GET /live` | 200 `{"status":"alive","version":"v0"}` whenever the HTTP server responds. |
| `GET /ready`, `GET /health` | 200 while the monitor completed a poll within the last 45 s and the process is not stopping; 503 otherwise. Body includes `version`, `ready`, `lastPoll`, `incident`, and the latest app probe outcomes. |

Readiness reflects the monitor loop, not the app and not model credentials:
v0 stays ready while the app is down or the model key is missing.

## Monitor and debugging

Every ten seconds v0 probes the app's `/health` and `/get` (five-second
timeout each) and logs one structured JSON line per poll. Three consecutive
failed polls open an incident; three consecutive successful polls resolve it.

When an incident opens, one Pi diagnosis runs concurrently (monitoring does
not wait for the model). The model receives only the bounded probe evidence —
HTTP statuses or transport errors — and returns impact, evidence, likely
cause/confidence, next diagnostic commands for the human, and a safe remedy.
The report (or the error) is logged:

```sh
docker logs workshop-agent --tail 5
# {"event":"opened","incident":{"id":"...","openedAt":"..."}}
# {"event":"diagnosis","incidentId":"...","report":"**Impact:** ..."}
# {"event":"resolved","incident":{...}}
```

Without a working model key the diagnosis logs `diagnosis_error` and
monitoring continues unaffected.

## Configuration

Set in the shared `agent/.env` at the repo's `agent/` root (see
`.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_PROVIDER` | `anthropic` | Model provider for diagnoses |
| `PI_MODEL` | `claude-sonnet-4-5` | Model ID |
| provider key, e.g. `OPENCODE_API_KEY` | — | API key for the chosen provider |

## Run

```sh
# From the repo root, with the app stack already up:
AGENT_VERSION=v0 docker compose -f docker-compose-agent.yml up --build -d --wait
```
