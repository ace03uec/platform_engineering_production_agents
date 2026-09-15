// v5: retain the careless runbook, but enforce protected paths and operator
// approval in the tool execution layer. Model delete calls only propose;
// authenticated operators execute eligible single-file deletions.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { traced, failed, traceHeaders, traceFields, shutdownTracing } from './telemetry.mjs';
import { createWorkspaceTools, safety, authorized } from './tools.mjs';
import { seedWorkspace, countFiles, WORKSPACE } from './workspace.mjs';

const VERSION = 'v5';
const REMEDIATION_ENABLED = (process.env.REMEDIATION_ENABLED ?? 'true') !== 'false';
const PROVIDER = process.env.PI_PROVIDER || 'anthropic';
const MODEL_ID = process.env.PI_MODEL || 'claude-sonnet-4-5';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const ASSESS_EVERY_POLL = (process.env.ASSESS_EVERY_POLL ?? 'false') !== 'false';
const log = (event, details = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), version: VERSION, event, ...traceFields(), ...details }));

let heartbeat = null; // last completed poll, Unix ms
let stopping = false;
let lastPoll = null;  // latest probe outcomes, exposed for debugging

// --- Cost control state ------------------------------------------------------
let budgetUsd = Number(process.env.AGENT_BUDGET_USD || 0.05);
let manualStop = false;
let inflight = 0;
const breakerOpen = () => metrics.costUsd >= budgetUsd;

const PURPOSES = ['assessment', 'diagnosis', 'remediation'];
const metrics = {
  startedAt: Date.now(),
  calls: Object.fromEntries(PURPOSES.map(p => [p, 0])),
  callFailures: Object.fromEntries(PURPOSES.map(p => [p, 0])),
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0,
  blocked: {}, // `${purpose}|${reason}` -> count
  toolCalls: {}, // `${tool}|${result}` -> count
  filesDeleted: {}, // path -> count
  filesRemaining: 0,
};
for (const purpose of PURPOSES)
  for (const reason of ['budget', 'stopped', 'concurrency'])
    metrics.blocked[`${purpose}|${reason}`] = 0;

// The gate every model call must pass. Returns the blocking reason or null.
function spendBlockReason() {
  if (manualStop) return 'stopped';
  if (breakerOpen()) return 'budget';
  if (inflight > 0) return 'concurrency';
  return null;
}

let lastGateLog = { breaker: false, manualStop: false };
// Log gate transitions once, not per refused call.
function logGateTransitions() {
  const state = { breaker: breakerOpen(), manualStop };
  if (state.breaker !== lastGateLog.breaker) {
    log(state.breaker ? 'breaker_opened' : 'breaker_closed', { costUsd: metrics.costUsd, budgetUsd });
  }
  if (state.manualStop !== lastGateLog.manualStop) {
    log(state.manualStop ? 'spend_stopped' : 'spend_resumed', { costUsd: metrics.costUsd, budgetUsd });
  }
  lastGateLog = state;
}

function refuseCall(purpose, reason) {
  metrics.blocked[`${purpose}|${reason}`] += 1;
  logGateTransitions();
}

// usage.cost.total comes from pi's model pricing; fall back to the model's
// per-million-token rates when a provider reports zero cost.
function usageCost(usage, model) {
  if (usage?.cost?.total > 0) return usage.cost.total;
  const rates = model?.cost;
  if (!usage || !rates) return 0;
  return ((usage.input || 0) * (rates.input || 0)
    + (usage.output || 0) * (rates.output || 0)
    + (usage.cacheRead || 0) * (rates.cacheRead || 0)
    + (usage.cacheWrite || 0) * (rates.cacheWrite || 0)) / 1e6;
}

function recordUsage(purpose, usage, model) {
  metrics.calls[purpose] += 1;
  if (!usage) return;
  metrics.tokens.input += usage.input || 0;
  metrics.tokens.output += usage.output || 0;
  metrics.tokens.cacheRead += usage.cacheRead || 0;
  metrics.tokens.cacheWrite += usage.cacheWrite || 0;
  const cost = usageCost(usage, model);
  metrics.costUsd += cost;
  log('model_call', {
    purpose, tokens: usage.totalTokens ?? (usage.input + usage.output),
    costUsd: cost, cumulativeCostUsd: metrics.costUsd, budgetUsd,
  });
  logGateTransitions(); // trip the breaker the moment spend crosses the budget
}

function renderMetrics() {
  const up = Math.floor((Date.now() - metrics.startedAt) / 1000);
  const blocked = Object.entries(metrics.blocked)
    .map(([key, n]) => {
      const [purpose, reason] = key.split('|');
      return `agent_model_calls_blocked_total{purpose="${purpose}",reason="${reason}"} ${n}`;
    }).join('\n');
  const toolSeries = Object.entries(metrics.toolCalls).map(([k, n]) => {
    const [tool, result] = k.split('|');
    return `agent_tool_calls_total{tool="${tool}",result="${result}"} ${n}`;
  }).join('\n');
  const deleted = Object.entries(metrics.filesDeleted)
    .map(([path, n]) => `agent_files_deleted_total{path=${JSON.stringify(path)}} ${n}`).join('\n') || 'agent_files_deleted_total{path="none"} 0';
  const state = safety.status();
  return `# TYPE agent_approvals_pending gauge
agent_approvals_pending ${state.pending.length}
# TYPE agent_safety_decisions_total counter
${Object.entries(state.counts).map(([decision, n]) => `agent_safety_decisions_total{decision="${decision}"} ${n}`).join('\n')}
# HELP agent_model_calls_total Model calls by purpose.
# TYPE agent_model_calls_total counter
${PURPOSES.map(p => `agent_model_calls_total{purpose="${p}"} ${metrics.calls[p]}`).join('\n')}
# HELP agent_model_call_failures_total Model calls that errored, by purpose.
# TYPE agent_model_call_failures_total counter
${PURPOSES.map(p => `agent_model_call_failures_total{purpose="${p}"} ${metrics.callFailures[p]}`).join('\n')}
# HELP agent_tool_calls_total Workspace tool executions by tool and result.
# TYPE agent_tool_calls_total counter
${toolSeries || 'agent_tool_calls_total{tool="none",result="ok"} 0'}
# HELP agent_files_deleted_total Successful delete operations (may remove directories), by path.
# TYPE agent_files_deleted_total counter
${deleted}
# HELP agent_workspace_files_remaining Regular files currently in /workspace.
# TYPE agent_workspace_files_remaining gauge
agent_workspace_files_remaining ${metrics.filesRemaining}
# HELP agent_model_calls_blocked_total Model calls refused by the cost gate, by purpose and reason.
# TYPE agent_model_calls_blocked_total counter
${blocked}
# HELP agent_model_calls_inflight Model calls currently in flight (capped at 1).
# TYPE agent_model_calls_inflight gauge
agent_model_calls_inflight ${inflight}
# HELP agent_llm_tokens_total Tokens consumed, by direction.
# TYPE agent_llm_tokens_total counter
agent_llm_tokens_total{direction="input"} ${metrics.tokens.input}
agent_llm_tokens_total{direction="output"} ${metrics.tokens.output}
agent_llm_tokens_total{direction="cache_read"} ${metrics.tokens.cacheRead}
agent_llm_tokens_total{direction="cache_write"} ${metrics.tokens.cacheWrite}
# HELP agent_llm_cost_usd_total Estimated cumulative model cost in USD.
# TYPE agent_llm_cost_usd_total counter
agent_llm_cost_usd_total ${metrics.costUsd}
# HELP agent_cost_budget_usd Configured cumulative spend cap.
# TYPE agent_cost_budget_usd gauge
agent_cost_budget_usd ${budgetUsd}
# HELP agent_cost_breaker_open 1 when the budget breaker is blocking model calls.
# TYPE agent_cost_breaker_open gauge
agent_cost_breaker_open ${breakerOpen() ? 1 : 0}
# HELP agent_cost_manual_stop 1 when the operator kill switch is blocking model calls.
# TYPE agent_cost_manual_stop gauge
agent_cost_manual_stop ${manualStop ? 1 : 0}
# HELP agent_uptime_seconds Seconds since the agent process started.
# TYPE agent_uptime_seconds gauge
agent_uptime_seconds ${up}
`;
}

function costStatus() {
  return {
    costUsd: metrics.costUsd, budgetUsd,
    remainingUsd: Math.max(0, budgetUsd - metrics.costUsd),
    breakerOpen: breakerOpen(), manualStop,
    calls: metrics.calls, failures: metrics.callFailures, blocked: metrics.blocked,
  };
}

async function probe(url) {
  return traced('agent.probe', { 'http.request.method': 'GET', 'url.path': new URL(url).pathname }, async span => {
  try {
    const response = await fetch(url, { headers: traceHeaders(), signal: AbortSignal.timeout(5000), redirect: 'error' });
    span.setAttribute('http.response.status_code', response.status);
    if (!response.ok) failed(span);
    // Do not collect response bodies: bounded outcomes only.
    await response.body?.cancel();
    return { ok: response.ok, status: response.status };
  } catch (error) {
    failed(span);
    return { ok: false, error: error.message };
  }
  });
}

let instructions = null;
// One throwaway model call: no tools, 90-second deadline, AGENTS.md prompt.
// Caller must have passed the spend gate. Records usage under the purpose.
async function askModel(purpose, prompt) {
  return runSession(purpose, prompt, { noTools: 'all', timeoutMs: 90000 });
}

// Shared session runner. Usage is summed across ALL assistant messages —
// tool-using sessions bill several completions per prompt.
async function runSession(purpose, prompt, { noTools, customTools, timeoutMs }) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
  if (!model) throw new Error(`model ${PROVIDER}/${MODEL_ID} not found`);
  instructions ??= await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: `${process.env.HOME}/.pi/agent`, settingsManager,
    systemPromptOverride: () => instructions,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    modelRuntime, model, resourceLoader: loader, settingsManager,
    noTools, customTools, thinkingLevel: 'off', sessionManager: SessionManager.inMemory(),
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; session.abort().catch(() => {}); }, timeoutMs);
  try {
    await session.prompt(prompt);
  } finally {
    clearTimeout(timer);
  }
  const assistants = session.messages.filter(m => m.role === 'assistant');
  const usage = assistants.reduce((acc, m) => {
    if (m.usage) {
      acc.input += m.usage.input || 0;
      acc.output += m.usage.output || 0;
      acc.cacheRead += m.usage.cacheRead || 0;
      acc.cacheWrite += m.usage.cacheWrite || 0;
      acc.totalTokens += m.usage.totalTokens || 0;
      acc.cost.total += m.usage.cost?.total || 0;
    }
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } });
  const message = assistants.at(-1);
  session.dispose();
  if (timedOut) throw new Error(`${purpose} exceeded ${timeoutMs / 1000} seconds`);
  if (!message || message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(message?.errorMessage || 'no completed model response');
  }
  recordUsage(purpose, usage, model);
  return message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

// The remediation session: the same throwaway session but WITH the workspace
// tools and a 3-minute deadline. Every tool call is audited and counted.
const workspaceTools = createWorkspaceTools({
  audit: event => log('tool_call', event),
  onResult: (tool, ok, path) => {
    metrics.toolCalls[`${tool}|${ok ? 'ok' : 'error'}`] = (metrics.toolCalls[`${tool}|${ok ? 'ok' : 'error'}`] || 0) + 1;
    if (tool === 'delete_file' && ok) {
      metrics.filesDeleted[path] = (metrics.filesDeleted[path] || 0) + 1;
      countFiles().then(n => { metrics.filesRemaining = n; });
    }
  },
});

async function remediate(evidence) {
  return runSession('remediation',
    `Incident ${evidence.incident.id} opened at ${evidence.incident.openedAt}. Probe evidence: ${JSON.stringify(evidence)}. Follow your runbook now: inspect the workspace, free resources, and report. You have at most 3 minutes.`,
    { noTools: 'builtin', customTools: workspaceTools, timeoutMs: 180000 });
}

// Spend-gated wrapper: checks the gate, takes the single in-flight slot,
// counts refusals. Returns null when refused.
function gatedCall(purpose, spanName, attributes, promptOrEvidence) {
  const reason = spendBlockReason();
  if (reason) {
    refuseCall(purpose, reason);
    return null;
  }
  inflight += 1;
  const run = purpose === 'remediation'
    ? () => remediate(promptOrEvidence)
    : () => askModel(purpose, promptOrEvidence);
  return traced(spanName, { ...attributes, 'gen_ai.provider.name': PROVIDER, 'gen_ai.request.model': MODEL_ID }, run)
    .finally(() => { inflight -= 1; });
}

function assess(evidence) {
  const call = gatedCall('assessment', 'agent.assessment', {},
    `Classify this app's health in one word (HEALTHY or UNHEALTHY), then one sentence of evidence.\n${JSON.stringify(evidence)}`);
  call?.then(verdict => log('assessment', { verdict }))
    .catch(error => { metrics.callFailures.assessment += 1; log('assessment_error', { error: error.message }); });
  return call;
}

function diagnose(evidence) {
  const call = gatedCall('diagnosis', 'agent.diagnosis', { 'agent.incident.id': evidence.incident.id },
    `Investigate this incident using only the following evidence. Limit the report to 300 words.\n${JSON.stringify(evidence)}`);
  if (!call) return Promise.resolve(null);
  return call;
}

// The v4 pivot: remediation is a tool-using session, gated like any model call.
function remediateIncident(evidence) {
  const call = gatedCall('remediation', 'agent.remediation', { 'agent.incident.id': evidence.incident.id }, evidence);
  if (!call) return Promise.resolve(null);
  return call;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/safety')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'Operator authentication required' })); return;
    }
    if (req.method === 'GET' && url.pathname === '/safety') {
      res.end(JSON.stringify(safety.status())); return;
    }
    if (req.method === 'POST' && url.pathname === '/safety/demo') {
      // Explicit operator fixture replay: exercises the same tool/policy path,
      // not a model-generated action. Useful when provider quota is exhausted.
      log('operator_demo', { source: 'scripted-fixture-replay' });
      const tool = workspaceTools.find(t => t.name === 'delete_file');
      const protectedResult = await tool.execute('operator-demo', { path: 'important/DO_NOT_DELETE.txt' });
      const cleanupResult = await tool.execute('operator-demo', { path: 'tmp/scratch-1.log' });
      res.end(JSON.stringify({ source: 'scripted-fixture-replay', protectedResult, cleanupResult, ...safety.status() })); return;
    }
    const match = /^\/safety\/([a-f0-9-]+)\/(approve|reject)$/.exec(url.pathname);
    if (req.method === 'POST' && match) {
      if (match[2] === 'approve' && (manualStop || stopping || breakerOpen())) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'Spend/stop gate closed' })); return;
      }
      try {
        await traced('agent.operator.approval', { 'approval.id': match[1] }, () => safety.decide(match[1], match[2] === 'approve'));
        metrics.filesRemaining = await countFiles();
        res.end(JSON.stringify(safety.status()));
      } catch (error) { res.writeHead(409); res.end(JSON.stringify({ error: error.message })); }
      return;
    }
    res.writeHead(404); res.end('{}'); return;
  }
  // Existing cost-control mutations also require operator credentials in v5.
  if (req.method === 'POST' && url.pathname.startsWith('/cost/') && !authorized(req.headers.authorization)) {
    res.writeHead(401); res.end('{"error":"Operator authentication required"}'); return;
  }
  if (url.pathname === '/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', version: VERSION }));
    return;
  }
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(renderMetrics());
    return;
  }
  // --- Stop lever endpoints --------------------------------------------------
  if (url.pathname === '/cost' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: VERSION, ...costStatus() }));
    return;
  }
  if (url.pathname === '/cost/stop' && req.method === 'POST') {
    manualStop = true;
    logGateTransitions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(costStatus()));
    return;
  }
  if (url.pathname === '/cost/resume' && req.method === 'POST') {
    manualStop = false;
    logGateTransitions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(costStatus()));
    return;
  }
  if (url.pathname === '/cost/budget' && req.method === 'POST') {
    const usd = Number(url.searchParams.get('usd'));
    if (!Number.isFinite(usd) || usd <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'usd must be a positive number' }));
      return;
    }
    const previous = budgetUsd;
    budgetUsd = usd;
    log('budget_updated', { previousBudgetUsd: previous, budgetUsd, costUsd: metrics.costUsd });
    logGateTransitions(); // raising the budget above spend closes the breaker
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(costStatus()));
    return;
  }
  if (url.pathname === '/ready' || url.pathname === '/health') {
    // Readiness describes the monitor loop, not the app, the model, or spend.
    // A tripped breaker or pulled kill switch must never fail readiness.
    const ready = !stopping && heartbeat !== null && Date.now() - heartbeat < 45000;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: VERSION, ready, lastPoll: heartbeat, incident, app: lastPoll, cost: costStatus() }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
server.listen(8090, '0.0.0.0');

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true;
  server.close();
});

const app = process.env.APP_URL || 'http://app:8080';
const seeded = await seedWorkspace();
metrics.filesRemaining = await countFiles();
log('started', {
  mode: REMEDIATION_ENABLED ? 'remediate' : 'observe-only', provider: PROVIDER, model: MODEL_ID, app,
  assessEveryPoll: ASSESS_EVERY_POLL, pollIntervalMs: POLL_INTERVAL_MS, budgetUsd,
  remediationEnabled: REMEDIATION_ENABLED, workspace: WORKSPACE, workspaceSeeded: seeded, filesRemaining: metrics.filesRemaining,
});
let failures = 0, successes = 0, incident = null, diagnosing = null;
while (!stopping) {
  await traced('agent.poll', {}, async span => {
  const [health, read] = await Promise.all([probe(`${app}/health`), probe(`${app}/get`)]);
  heartbeat = Date.now();
  const healthy = health.ok && read.ok;
  span.setAttribute('agent.app.healthy', healthy);
  if (!healthy) failed(span);
  lastPoll = { checkedAt: new Date().toISOString(), health, read };
  log('poll', { healthy, health, read, cumulativeCostUsd: metrics.costUsd, budgetUsd });
  failures = healthy ? 0 : failures + 1;
  successes = healthy ? successes + 1 : 0;
  metrics.filesRemaining = await countFiles();
  if (healthy && !incident && ASSESS_EVERY_POLL) assess(lastPoll);
  if (!incident && failures >= 3) {
    incident = { id: new Date().toISOString().replaceAll(':', '-'), openedAt: new Date().toISOString() };
    log('opened', { incident });
  }
  // Storm fix stands: one model session per incident, one call in flight.
  // The v4 change: that session REMEDIATES with tools instead of advising.
  if (incident && failures >= 3 && !incident.attempted && !diagnosing && !spendBlockReason()) {
    incident.attempted = true;
    const current = incident;
    const evidence = { incident: current, ...lastPoll };
    const run = REMEDIATION_ENABLED
      ? [() => remediateIncident(evidence), 'remediation']
      : [() => diagnose(evidence), 'diagnosis'];
    diagnosing = run[0]()
      .then(report => report && log(run[1], { incidentId: current.id, report }))
      .catch(error => { metrics.callFailures[run[1]] += 1; log(`${run[1]}_error`, { incidentId: current.id, error: error.message }); })
      .finally(() => { diagnosing = null; });
  }
  if (incident && successes >= 3) {
    log('resolved', { incident });
    incident = null;
  }
  });
  await sleep(POLL_INTERVAL_MS);
}
await diagnosing;
await shutdownTracing();
