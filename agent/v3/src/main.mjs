// v3: v2's cost observability plus the stop lever it was missing:
//   - budget circuit breaker (AGENT_BUDGET_USD): model calls blocked once
//     cumulative spend reaches the budget;
//   - manual kill switch: POST /cost/stop and /cost/resume;
//   - storm fixes: one diagnosis per incident again, one model call in flight;
//   - blocked-call telemetry: every refused call is counted by reason.
// Monitoring, health endpoints, and incident detection never depend on the
// model: blocking spend never blocks the monitor loop.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { traced, failed, traceHeaders, traceFields, shutdownTracing } from './telemetry.mjs';

const VERSION = 'v3';
const PROVIDER = process.env.PI_PROVIDER || 'anthropic';
const MODEL_ID = process.env.PI_MODEL || 'claude-sonnet-4-5';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const ASSESS_EVERY_POLL = (process.env.ASSESS_EVERY_POLL ?? 'true') !== 'false';
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

const metrics = {
  startedAt: Date.now(),
  calls: { assessment: 0, diagnosis: 0 },
  callFailures: { assessment: 0, diagnosis: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0,
  blocked: {}, // `${purpose}|${reason}` -> count
};
for (const purpose of ['assessment', 'diagnosis'])
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
  return `# HELP agent_model_calls_total Model calls by purpose (assessment = per-poll, diagnosis = per incident).
# TYPE agent_model_calls_total counter
agent_model_calls_total{purpose="assessment"} ${metrics.calls.assessment}
agent_model_calls_total{purpose="diagnosis"} ${metrics.calls.diagnosis}
# HELP agent_model_call_failures_total Model calls that errored, by purpose.
# TYPE agent_model_call_failures_total counter
agent_model_call_failures_total{purpose="assessment"} ${metrics.callFailures.assessment}
agent_model_call_failures_total{purpose="diagnosis"} ${metrics.callFailures.diagnosis}
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
    noTools: 'all', thinkingLevel: 'off', sessionManager: SessionManager.inMemory(),
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; session.abort().catch(() => {}); }, 90000);
  try {
    await session.prompt(prompt);
  } finally {
    clearTimeout(timer);
  }
  const message = [...session.messages].reverse().find(m => m.role === 'assistant');
  const usage = message?.usage;
  session.dispose();
  if (timedOut) throw new Error('model call exceeded 90 seconds');
  if (!message || message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(message?.errorMessage || 'no completed model response');
  }
  recordUsage(purpose, usage, model);
  return message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

// Spend-gated wrapper: checks the gate, takes the single in-flight slot,
// counts refusals. Returns null when refused.
function gatedCall(purpose, spanName, attributes, prompt) {
  const reason = spendBlockReason();
  if (reason) {
    refuseCall(purpose, reason);
    return null;
  }
  inflight += 1;
  return traced(spanName, { ...attributes, 'gen_ai.provider.name': PROVIDER, 'gen_ai.request.model': MODEL_ID },
    () => askModel(purpose, prompt))
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

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
log('started', {
  mode: 'observe-only', provider: PROVIDER, model: MODEL_ID, app,
  assessEveryPoll: ASSESS_EVERY_POLL, pollIntervalMs: POLL_INTERVAL_MS, budgetUsd,
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
  if (ASSESS_EVERY_POLL) assess(lastPoll); // gated; concurrent; never blocks the loop
  if (!incident && failures >= 3) {
    incident = { id: new Date().toISOString().replaceAll(':', '-'), openedAt: new Date().toISOString() };
    log('opened', { incident });
  }
  // Storm fix: one diagnosis per incident, one call in flight (v1 behaviour).
  if (incident && failures >= 3 && !diagnosing) {
    const current = incident;
    diagnosing = diagnose({ incident: current, ...lastPoll })
      .then(report => report && log('diagnosis', { incidentId: current.id, report }))
      .catch(error => { metrics.callFailures.diagnosis += 1; log('diagnosis_error', { incidentId: current.id, error: error.message }); })
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
