# v6 — repeatable model evaluation

v6 retains v5 runtime safety and adds a separate, opt-in eval runner. It does
not automatically spend tokens, alter production tools, or select a winning
model. Evaluations run sequentially against a simulated workspace.

## What is measured

Six versioned cases in `src/eval/cases.json`: healthy, ambiguous timeout,
confirmed Redis failure, confirmed PostgreSQL failure, protected-file request,
and measured disk pressure requiring cleanup approval.

Each case is scored on six deterministic checks: JSON schema, diagnosis,
next action, truthful `remediationPerformed=false`, safe tool requests, and
required approval request when appropriate. Pass requires **all six** checks.
The report also includes mean case latency, total tokens, estimated SDK cost,
price coverage, and provider errors. Unknown pricing stays unknown, not free.

This is a small structured-decision regression suite, **not** a comprehensive
measure of diagnosis quality. The reason text is saved for human review but
not semantically graded. It does not validate arbitrary prose claims, actual
remediation success, or production safety enforcement (use safety.test.mjs
for that). Add realistic incident fixtures before making deployment decisions.

The runner uses the agent's actual `AGENTS.md`, plus a fixed JSON-output eval
instruction. The deliberately careless runbook is retained from v5: poor
scores are legitimate evidence of a bad prompt/model combination. The three
mock tools use the same names and approval semantics, but are not production
filesystem tools. No host or live workspace files are touched.

## Start v6

From repository root:

```sh
AGENT_VERSION=v6 docker compose -f docker-compose-agent.yml up --build -d --wait
```

Results persist as per-run JSON files in `/evals` on the dedicated
`workshop-agent-evals` volume. Each includes per-case outputs, tool requests,
errors, repeats, model IDs, timestamps, dataset hash, prompt hash, grader
version, and harness hash. Partial results are saved after each case; final
reports have `finishedAt` and `complete`. Fixture results are stored separately
by their explicit `mode=fixture` metadata.

## Compare two real models

First list model identifiers supported by your configured credentials:

```sh
docker exec workshop-agent node src/eval/list-models.mjs
```

Configure the corresponding provider keys in ignored `agent/.env`, then
recreate the container. Availability in the catalog does not guarantee quota.
Supply **two distinct** `provider/model` identifiers (model IDs may contain `/`):

```sh
# Replace PROVIDER_A/MODEL_A and PROVIDER_B/MODEL_B with actual IDs.
docker exec workshop-agent node src/eval/run.mjs --live \
  --models 'PROVIDER_A/MODEL_A,PROVIDER_B/MODEL_B' \
  --repeats 3 --budget-usd 0.05
```

Each model gets the same six cases and prompt, fresh sessions, thinking off,
and disabled retries/compaction. Evaluation alternates model order per case.
Three repeats are 36 sessions. Start with one repeat to validate credentials.
A child-process deadline kills each case at 60 seconds; only mock tools are
enabled, with at most 12 recorded calls per case.

The runner stops at the first provider error, or unknown pricing unless you
explicitly pass `--allow-unknown-cost`. Exit status 2 means incomplete. The
budget is checked **between cases**, not a provider-enforced cap: one case may
overshoot, and timed-out/provider-failed work can incur unreported charges.
The eval CLI is operator-initiated and independent of v5's HTTP spend gate.
No live comparison was run during setup; provider selection remains yours.

## Compare results over time

Re-run exactly the same command after a model/provider update. Use the printed
run IDs to inspect the paired model comparison or baseline deltas:

```sh
docker exec workshop-agent node src/eval/compare.mjs /evals/RUN_ID.json
docker exec workshop-agent node src/eval/compare.mjs \
  /evals/NEW_ID.json /evals/BASELINE_ID.json
```

The comparer refuses incomplete runs and mismatched dataset, prompt, grader,
harness, or fixture/live mode. A changed prompt/dataset is a new experiment,
not a clean model regression. Deltas are descriptive, not statistical
significance; review per-case failures and use enough repeats before choosing
a model. Prefer safety and correctness first, then compare latency and cost.
Pinning a catalog model ID cannot prevent a provider changing its backend.

## Grafana

http://localhost:3000/d/workshop-agent-evals-v6

Choose `live` or `fixture` with the Result source variable. Panels show each
model's latest paired-run pass rate, score, latency, cost, pricing coverage,
completion, and timestamp. **Live is empty until a real comparison succeeds.**
Fixture scores are not a model ranking. Prometheus samples latest-run gauges;
flat lines mean no new evaluation, not continuous testing. Full historical
results remain in JSON even after Prometheus retention expires. Only complete
paired runs emit quality scores. Partial runs still expose completion/time.

The current Prometheus agent-metrics label is statically `v6`; update it when
switching agent versions. Evaluation series identify their own experiment
hashes. Results grow on disk: archive old runs periodically for large suites.

## No-cost verification

```sh
docker exec workshop-agent node --test src/eval/core.test.mjs
docker exec workshop-agent node --test src/safety.test.mjs
docker exec workshop-agent node src/eval/run.mjs --smoke
```

Smoke mode feeds scripted good/bad outputs through the grader and persistence
path. It deliberately uses `fixture/good` and `fixture/bad` labels and makes
**no model requests**. It tests the harness, not the model adapter.
