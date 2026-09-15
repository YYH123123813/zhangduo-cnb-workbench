import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalDemoRuntime } from '../src/platform/local-demo';
import { createApp } from '../src/server/app';
import { LOCAL_DEMO_KEY } from '../src/contracts/runtime';
import { CONTRACT_VERSION } from '../src/contracts/domain';
import { IntelligenceOverviewSchema, TrainingRunSchema, type IntelligenceCommand } from '../src/contracts/intelligence';

// In-process HTTP with an isolated synthetic CNB transport; never contacts the shared live server.
const runId = randomUUID(), runtimeId = `ai-joint-${runId}`;
const runtime = createLocalDemoRuntime(runtimeId), app = createApp(runtime.services, { runtime });
const directory = resolve('.local/fixture/intelligence-parallel/A', runId);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const workerHash = () => createHash('sha256').update(readFileSync('training/worker.py')).digest('hex');
const startedWorkerHash = workerHash();
let cookie = '';
async function request(input?: IntelligenceCommand) {
  const response = await app.request('/api/intelligence', { method: input ? 'POST' : 'GET',
    headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {}) });
  const result = await response.json();
  if (result.meta?.mode !== 'fixture') throw Error('Isolated synthetic mode required');
  return { status: response.status, result };
}
try {
  const connection = await app.request('/api/workspace/connect', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionKey: LOCAL_DEMO_KEY, confirmed: true }) });
  cookie = connection.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie || !(await connection.json()).ok) throw Error('Synthetic connection failed');
  let overview = IntelligenceOverviewSchema.parse((await request()).result.data);
  if (!overview.training.ready || overview.providers.some((p) => p.ready)) throw Error('Expected local worker and zero enabled API providers');
  const settings = await request({ action: 'settings', operationId: randomUUID(), expectedRevision: overview.revision,
    settings: { ...overview.settings, steps: 5 }, confirmed: true });
  if (!settings.result.ok) throw Error('Synthetic settings failed');
  overview = IntelligenceOverviewSchema.parse((await request()).result.data);
  const submitted = await request({ action: 'train', operationId: runId, expectedRevision: overview.revision, mode: 'smoke',
    nodeIds: [], nodeRevisions: {}, trainingConsent: true, confirmed: true });
  if (!submitted.result.ok) throw Error('Synthetic training was not accepted');
  const deadline = Date.now() + 660_000;
  let run = TrainingRunSchema.parse(submitted.result.data);
  while (run.state === 'running' && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1000));
    overview = IntelligenceOverviewSchema.parse((await request()).result.data);
    run = TrainingRunSchema.parse(overview.runs.find((r) => r.id === runId));
  }
  if (run.state !== 'completed' || !run.metrics?.reloadVerified || run.metrics.parameterDelta <= 0 || run.metrics.weightEffect <= 0)
    throw Error(`Synthetic worker did not complete verified training: ${run.state}, ${run.message}`);
  const activation = await request({ action: 'activate', operationId: randomUUID(), id: runId, confirmed: true });
  if (activation.status !== 422 || activation.result.ok) throw Error('Synthetic random model must not activate');
  if (workerHash() !== startedWorkerHash) throw Error('Worker changed during verification; rerun after B freezes its files');
  const report = { contractVersion: CONTRACT_VERSION, runtimeId, runId, mode: 'fixture', transport: 'in-process HTTP with synthetic CNB',
    realGradientTraining: true, realCNB: false, externalModelAPI: false, pretrainedModel: false, workerHash: startedWorkerHash,
    run, smokeActivationRejected: true, finishedAt: new Date().toISOString() };
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: resolve(directory, 'report.json'), runId, state: run.state, metrics: run.metrics, smokeActivationRejected: true }, null, 2));
} finally { runtime.close(); }
