// v0: minimal Pi-based incident agent. Serves liveness/readiness, polls the
// app, and on a sustained outage asks a Pi model for one advisory diagnosis.
// No tools, no state, no tracing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const VERSION = 'v0';
const PROVIDER = process.env.PI_PROVIDER || 'anthropic';
const MODEL_ID = process.env.PI_MODEL || 'claude-sonnet-4-5';
const log = (event, details = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), version: VERSION, event, ...details }));

let heartbeat = null; // last completed poll, Unix ms
let stopping = false;
let lastPoll = null;  // latest probe outcomes, exposed for debugging

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    // Do not collect response bodies: bounded outcomes only.
    await response.body?.cancel();
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// One advisory Pi diagnosis per incident. No tools: the model reasons over the
// probe evidence only and proposes diagnostics for the human to run.
async function diagnose(evidence) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
  if (!model) throw new Error(`model ${PROVIDER}/${MODEL_ID} not found`);
  const instructions = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
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
    await session.prompt(`Investigate this incident using only the following evidence. Limit the report to 300 words.\n${JSON.stringify(evidence)}`);
  } finally {
    clearTimeout(timer);
  }
  const message = [...session.messages].reverse().find(m => m.role === 'assistant');
  session.dispose();
  if (timedOut) throw new Error('diagnosis exceeded 90 seconds');
  if (!message || message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(message?.errorMessage || 'no completed model response');
  }
  return message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

const server = createServer((req, res) => {
  if (req.url === '/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', version: VERSION }));
    return;
  }
  if (req.url === '/ready' || req.url === '/health') {
    // Readiness describes the monitor loop, not the app or the model.
    const ready = !stopping && heartbeat !== null && Date.now() - heartbeat < 45000;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: VERSION, ready, lastPoll: heartbeat, incident, app: lastPoll }));
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
log('started', { mode: 'observe-only', provider: PROVIDER, model: MODEL_ID, app });
let failures = 0, successes = 0, incident = null, diagnosing = null;
while (!stopping) {
  const [health, read] = await Promise.all([probe(`${app}/health`), probe(`${app}/get`)]);
  heartbeat = Date.now();
  const healthy = health.ok && read.ok;
  lastPoll = { checkedAt: new Date().toISOString(), health, read };
  log('poll', { healthy, health, read });
  failures = healthy ? 0 : failures + 1;
  successes = healthy ? successes + 1 : 0;
  if (!incident && failures >= 3) {
    incident = { id: new Date().toISOString().replaceAll(':', '-'), openedAt: new Date().toISOString() };
    log('opened', { incident });
    // Diagnosis runs concurrently: monitoring must not wait for the model.
    const current = incident;
    diagnosing = diagnose({ incident: current, ...lastPoll })
      .then(report => log('diagnosis', { incidentId: current.id, report }))
      .catch(error => log('diagnosis_error', { incidentId: current.id, error: error.message }))
      .finally(() => { diagnosing = null; });
  } else if (incident && successes >= 3) {
    log('resolved', { incident });
    incident = null;
  }
  await sleep(10000);
}
await diagnosing;
