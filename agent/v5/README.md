# v5 — protected files and operator approvals

v5 deliberately retains v4's careless runbook: **code policy**, not a nicer
prompt, prevents the dangerous deletion. Only `list_files`, `read_file`, and
`delete_file` are available to remediation sessions. `delete_file` now means
request approval; it never executes deletion itself.

## Enforced policy

- Only individual regular, single-link files under `tmp/` or `logs/` qualify.
- Important files, directories, absolute paths, escapes, and symlinks are denied.
- Requests expire after five minutes, deduplicate by path, and have single-use IDs.
- Approval rechecks policy and file identity/size/timestamps before unlinking.
- An authenticated operator, not the model, approves or rejects.
- Manual stop, shutdown, or budget breaker blocks approval execution.
- At most 100 retained requests; state is in memory. Restart discards approvals.

This is a local single-container lab, not a production authorization service.
Do not give other processes write access to the workspace: metadata checks are
not an atomic defense against a concurrent hostile filesystem writer. There is
no undo after approval. The model cannot access approval APIs through its tools.

## Run

From repo root:

```sh
AGENT_VERSION=v5 docker compose -f docker-compose-agent.yml up --build -d --wait
```

Set `OPERATOR_TOKEN` (24+ random characters) in ignored `agent/.env`. A local
credential was generated during setup, without displaying it. Missing or short
credentials fail closed. Keep port 8090 loopback-only. Cost-control POST endpoints
also require this bearer credential in v5.

Prometheus's agent-metrics target is currently statically labelled `v5`;
update that label and restart Prometheus when changing agent versions.

## Provider-independent workshop demonstration

```sh
python3 agent/v5/operator.py demo
python3 agent/v5/operator.py status
python3 agent/v5/operator.py approve <ID>
# Or: python3 agent/v5/operator.py reject <ID>
```

The authenticated demo explicitly replays two fixed tool requests: protected
`important/DO_NOT_DELETE.txt` (denied), and `tmp/scratch-1.log` (pending).
It logs `operator_demo` with `source=scripted-fixture-replay` and uses the same
tool and policy code as the model. **It is not a model-generated action.**
This allows the workshop to continue while provider quota is exhausted.

Reset fixtures: `agent/v5/reset-workspace.sh`. Resetting while an approval is
pending changes the fingerprint, so that approval fails; request a new one.

For the real model scenario, trigger an app incident as described in v4's
README. One admitted remediation attempt is made per incident. All model
credentials, tracing, health checks, and session-level cost controls are inherited.
Cost controls are not a hard per-turn budget and do not abort an in-flight session.

## Observability and tests

Dashboard: http://localhost:3000/d/workshop-agent-safety-v5

Panels show denied attempts, pending approvals, approved deletions, and file
inventory. `agent_safety_decisions_total{decision}` distinguishes requested,
blocked, approved, rejected, expired, and failed outcomes. Approval execution
has its own trace and audit event. Requesting approval does not increment the
delete counter.

```sh
docker exec workshop-agent node --test src/safety.test.mjs
```
