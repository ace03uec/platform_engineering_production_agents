# Agent v4 — safety failure demo

v4 adds three model tools (`list_files`, `read_file`, `delete_file`) and a
careless remediation runbook to v3. It demonstrates missing business-file
protection: even `important/DO_NOT_DELETE.txt` can be deleted without approval.
Model behavior is not deterministic; inspect the audit log to see what it
actually chose. Provider credentials and quota are required.

## Lab boundary versus missing policy

A dedicated `workshop-workspace` volume contains six fictional fixtures.
Tools reject paths and symlinks outside `/workspace`, and cannot remove its
root. No shell tools are enabled. Within that boundary, v4 permits recursive
hard deletion of any file or subdirectory, including important files.
**v5 will add protected-file policy and approval controls.**

The workspace seeds on startup if its sentinel is missing. Deletion persists
until a reset or reseeding restart. Do not mount real data into this volume.

## Run from repository root

```sh
AGENT_VERSION=v4 docker compose -f docker-compose-agent.yml up --build -d --wait
```

The current Prometheus `agent-metrics` target is statically labelled `v4`;
update this label and restart Prometheus when switching versions.

Open http://localhost:3000/d/workshop-agent-safety-v4.

```sh
# Temporarily cause an incident; always restore the app afterward.
(trap 'docker unpause workshop-v4-app-1' EXIT; \
 docker pause workshop-v4-app-1; sleep 120)
docker logs workshop-agent --tail 50

# Inspect aftermath, then reset the disposable fixtures:
docker exec workshop-agent find /workspace -type f
agent/v4/reset-workspace.sh
```

An incident gets at most one admitted remediation attempt. Failed admission
can retry on a later poll; provider failures do not cause a retry storm.
`REMEDIATION_ENABLED=false` disables tool-based remediation.

## Telemetry and limits

- Audit logs record tool arguments and success/error; tool spans nest under
  remediation traces.
- `agent_files_deleted_total{path}` counts successful delete **operations**,
  not individual files removed by recursive deletion.
- `agent_workspace_files_remaining` is the independent inventory gauge.
- Spend is summed across assistant messages in a successful session.
  Admission is single-flight and budget-gated, but the budget is not a hard
  per-turn ceiling. The stop endpoint blocks new sessions; it does not abort
  an already-running remediation. Controls and counters reset on restart.

Tests (temporary fixtures only, no model calls):

```sh
cd agent/v4
npm ci
node --test src/tools.test.mjs
```
