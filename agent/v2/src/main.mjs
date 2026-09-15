// v2: v1 (health endpoints, tracing, per-incident diagnosis) plus cost/token
// observability — and a deliberate runaway-spend anti-pattern: every poll asks
// the model to assess app health, and an open incident re-diagnoses on every
// failed poll. GET /metrics exposes cumulative counters for Grafana.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { traced, failed, traceHeaders, traceFields, shutdownTracing } from './telemetry.mjs';

const VERSION = 'v2';
const PROVIDER = process.env.PI_PROVIDER || 'anthropic';
const MODEL_ID = process.env.PI_MODEL || 'claude-sonnet-4-5';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
// The anti-pattern under study: model spend proportional to poll rate.
const ASSESS_EVERY_POLL = (process.env.ASSESS_EVERY_POLL ?? 'true') !== 'false';
const log = (event, details = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), version: VERSION, event, ...traceFields(), ...details }));

let heartbeat = null; // last completed poll, Unix ms
let stopping = false;
let lastPoll = null;  // latest probe outcomes, exposed for debugging

// Cumulative cost/token counters. Counters only go up; /metrics renders them.
const metrics = {
  startedAt: Date.now(),
  calls: { assessment: 0, diagnosis: 0 },
  callFailures: { assessment: 0, diagnosis: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0,
};

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
    costUsd: cost, cumulativeCostUsd: metrics.costUsd,
  });
}

function renderMetrics() {
  const up = Math.floor((Date.now() - metrics.startedAt) / 1000);
  return `# HELP agent_model_calls_total Model calls by purpose (assessment = per-poll, diagnosis = per incident).
# TYPE agent_model_calls_total counter
agent_model_calls_total{purpose="assessment"} ${metrics.calls.assessment}
agent_model_calls_total{purpose="diagnosis"} ${metrics.calls.diagnosis}
# HELP agent_model_call_failures_total Model calls that errored, by purpose.
# TYPE agent_model_call_failures_total counter
agent_model_call_failures_total{purpose="assessment"} ${metrics.callFailures.assessment}
agent_model_call_failures_total{purpose="diagnosis"} ${metrics.callFailures.diagnosis}
# HELP agent_llm_tokens_total Tokens consumed, by direction.
# TYPE agent_llm_tokens_total counter
agent_llm_tokens_total{direction="input"} ${metrics.tokens.input}
agent_llm_tokens_total{direction="output"} ${metrics.tokens.output}
agent_llm_tokens_total{direction="cache_read"} ${metrics.tokens.cacheRead}
agent_llm_tokens_total{direction="cache_write"} ${metrics.tokens.cacheWrite}
# HELP agent_llm_cost_usd_total Estimated cumulative model cost in USD.
# TYPE agent_llm_cost_usd_total counter
agent_llm_cost_usd_total ${metrics.costUsd}
# HELP agent_uptime_seconds Seconds since the agent process started.
# TYPE agent_uptime_seconds gauge
agent_uptime_seconds ${up}
`;
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
// Records token/cost usage under the given purpose. Returns the reply text.
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

// Runaway driver, part 1: the model "confirms" every poll, healthy or not.
// Cost is proportional to poll rate and never stops. Failures are logged and
// counted; monitoring never waits on the model.
function assess(evidence) {
  traced('agent.assessment', { 'gen_ai.provider.name': PROVIDER, 'gen_ai.request.model': MODEL_ID },
    () => askModel('assessment',
      `Classify this app's health in one word (HEALTHY or UNHEALTHY), then one sentence of evidence.\n${JSON.stringify(evidence)}`))
    .then(verdict => log('assessment', { verdict }))
    .catch(error => { metrics.callFailures.assessment += 1; log('assessment_error', { error: error.message }); });
}

// Runaway driver, part 2: unlike v0/v1 (one diagnosis per incident), v2
// re-diagnoses on every failed poll while the incident is open.
function diagnose(evidence) {
  return traced('agent.diagnosis', {
    'agent.incident.id': evidence.incident.id, 'gen_ai.provider.name': PROVIDER, 'gen_ai.request.model': MODEL_ID,
  }, () => askModel('diagnosis',
    `Investigate this incident using only the following evidence. Limit the report to 300 words.\n${JSON.stringify(evidence)}`));
}

const server = createServer((req, res) => {
  if (req.url === '/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', version: VERSION }));
    return;
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(renderMetrics());
    return;
  }
  if (req.url === '/ready' || req.url === '/health') {
    // Readiness describes the monitor loop, not the app, the model, or spend.
    const ready = !stopping && heartbeat !== null && Date.now() - heartbeat < 45000;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: VERSION, ready, lastPoll: heartbeat, incident, app: lastPoll, costUsd: metrics.costUsd }));
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
log('started', { mode: 'observe-only', provider: PROVIDER, model: MODEL_ID, app, assessEveryPoll: ASSESS_EVERY_POLL, pollIntervalMs: POLL_INTERVAL_MS });
let failures = 0, successes = 0, incident = null, diagnosing = Promise.resolve();
while (!stopping) {
  await traced('agent.poll', {}, async span => {
  const [health, read] = await Promise.all([probe(`${app}/health`), probe(`${app}/get`)]);
  heartbeat = Date.now();
  const healthy = health.ok && read.ok;
  span.setAttribute('agent.app.healthy', healthy);
  if (!healthy) failed(span);
  lastPoll = { checkedAt: new Date().toISOString(), health, read };
  log('poll', { healthy, health, read, cumulativeCostUsd: metrics.costUsd });
  failures = healthy ? 0 : failures + 1;
  successes = healthy ? successes + 1 : 0;
  if (ASSESS_EVERY_POLL) assess(lastPoll); // concurrent: never blocks the loop
  if (!incident && failures >= 3) {
    incident = { id: new Date().toISOString().replaceAll(':', '-'), openedAt: new Date().toISOString() };
    log('opened', { incident });
  }
  if (incident && failures >= 3) {
    // Bug under study: no once-per-incident guard and no queueing — a new
    // diagnosis every failed poll, each billed, none awaited.
    const current = incident;
    diagnosing = diagnose({ incident: current, ...lastPoll })
      .then(report => log('diagnosis', { incidentId: current.id, report }))
      .catch(error => { metrics.callFailures.diagnosis += 1; log('diagnosis_error', { incidentId: current.id, error: error.message }); });
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
