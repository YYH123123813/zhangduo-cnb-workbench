import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { z } from 'zod';
import { createApp } from '../src/server/app';
import { createLocalDemoRuntime } from '../src/platform/local-demo';
import { PythonTraining, type TrainingExecutor } from '../src/platform/training-runner';
import { CONTRACT_VERSION } from '../src/contracts/domain';
import { demoEnvironment } from './local-server';
import { FixtureControl, simulatedTraining, syntheticGateway } from './intelligence-fixture-adapters';
import { seedIntelligenceFixture } from './intelligence-fixture-seed';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const directory = join(root, '.local/fixture/intelligence-final'), stateFile = join(directory, 'preview.json'), logFile = join(directory, 'preview.log');
const controlFile = join(directory, 'control.json');
const State = z.object({ pid: z.number().int().positive(), nonce: z.string().regex(/^[a-f0-9]{32}$/), root: z.string(),
  port: z.number().int().min(1024).max(65399), runtimeId: z.string().regex(/^final-preview-[a-f0-9]{16}$/),
  worker: z.boolean(), simulatedTraining: z.boolean().default(false), version: z.string(), startedAt: z.iso.datetime(), sourceHash: z.string() }).strict();
type PreviewState = z.infer<typeof State>;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function regular(path: string) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw Error('Unsafe preview metadata file');
}
function prepare() {
  for (const path of [join(root, '.local'), join(root, '.local/fixture'), directory]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw Error('Unsafe preview directory');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}
function readState(): PreviewState | null {
  regular(stateFile); if (!existsSync(stateFile)) return null;
  const state = State.parse(JSON.parse(readFileSync(stateFile, 'utf8')));
  if (state.root !== root) throw Error('Preview belongs to another project'); return state;
}
function owned(state: PreviewState) {
  try { return execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim().endsWith(`--import tsx ${script} serve ${state.nonce}`); }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw Error('Cannot verify preview process ownership'); }
}
function details(state: PreviewState, running: boolean) {
  return { ...state, running, mode: 'fixture', web: `http://localhost:${state.port}`, api: `http://localhost:${state.port}/api`,
    syntheticModel: true, realCNB: false, privateEnvironment: false, logFile, stateFile,
    stop: 'node --import tsx tools/intelligence-fixture.ts stop', browser: 'Use a fresh browser context; do not reuse the live 127.0.0.1 profile.' };
}
async function healthy(state: PreviewState) {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const result = await response.json();
    return response.ok && result.meta?.mode === 'fixture' && result.meta?.contractVersion === state.version;
  } catch { return false; }
}
async function start(worker: boolean, simulated: boolean) {
  if (worker && simulated) throw Error('Choose actual worker or simulated training, never both');
  prepare(); const lock = join(directory, 'preview-start.lock');
  const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const previous = readState();
    if (previous && owned(previous)) { console.log(JSON.stringify({ ...details(previous, true), healthy: await healthy(previous), reused: true }, null, 2)); return; }
    const nonce = randomBytes(16).toString('hex'), runtimeId = previous?.runtimeId ?? `final-preview-${randomBytes(8).toString('hex')}`;
    regular(logFile); const log = openSync(logFile, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    if (simulated) { regular(controlFile); writeFileSync(controlFile, JSON.stringify({ training: 'complete' }), { mode: 0o600 }); }
    const child = spawn(process.execPath, ['--import', 'tsx', script, 'serve', nonce], { cwd: root, detached: true, stdio: ['ignore', log, log],
      env: { ...demoEnvironment(process.env, 4514, 4514), FINAL_FIXTURE_ID: runtimeId, FINAL_FIXTURE_WORKER: worker ? 'python' : 'disabled', FINAL_FIXTURE_SIMULATED: String(simulated) } });
    child.unref(); closeSync(log);
    await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = readState();
      if (state?.nonce === nonce && await healthy(state)) { console.log(JSON.stringify(details(state, true), null, 2)); return; }
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Preview exited before ready; inspect its own log');
      await delay(250);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw Error('Preview not ready; inspect its registered log');
  } finally { closeSync(fd); unlinkSync(lock); }
}
async function serve(nonce: string) {
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^final-preview-[a-f0-9]{16}$/.test(process.env.FINAL_FIXTURE_ID ?? '')) throw Error('Invalid preview identity');
  prepare();
  const worker = process.env.FINAL_FIXTURE_WORKER === 'python', python = new PythonTraining('');
  const simulated = process.env.FINAL_FIXTURE_SIMULATED === 'true';
  const simulation = simulatedTraining(() => {
    regular(controlFile); if (!existsSync(controlFile)) return 'complete';
    if (lstatSync(controlFile).size > 512) throw Error('Invalid fixture control');
    return z.object({ training: FixtureControl }).strict().parse(JSON.parse(readFileSync(controlFile, 'utf8'))).training;
  });
  let active = 0, stopping = false;
  const training: TrainingExecutor = { ready: () => worker && python.ready(), pretrainedReady: () => false,
    run: async (input) => { if (!worker || stopping) throw Error('Preview training is disabled'); active++;
      try { return await python.run(input); } finally { active--; } },
    infer: async () => { throw Error('No pretrained adapter is available in this preview'); },
    inspect: (...args) => python.inspect(...args), remove: (...args) => python.remove(...args) };
  const runtimeId = process.env.FINAL_FIXTURE_ID!, runtime = createLocalDemoRuntime(runtimeId, { aiGateway: syntheticGateway(), trainingExecutor: simulated ? simulation : training });
  let port = 4514;
  const app = createApp(runtime.services, { runtime, trustedOrigins: Array.from({ length: 50 }, (_, i) => `http://localhost:${4514 + i}`) });
  if (simulated) console.log(JSON.stringify({ syntheticSeed: await seedIntelligenceFixture(app) }));
  const listener = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    if (stopping) { res.writeHead(503); res.end('Preview is stopping'); return; }
    if (req.url?.startsWith('/api/')) void listener(req, res);
    else vite.middlewares(req, res);
  });
  const { createServer: createViteServer } = await import('vite'), { default: react } = await import('@vitejs/plugin-react');
  const { clientBoundary } = await import('./client-boundary');
  const vite = await createViteServer({ configFile: false, envDir: false, root, plugins: [clientBoundary(), react(), {
    name: 'explicit-synthetic-preview', transformIndexHtml: () => [{ tag: 'div', attrs: { role: 'status', 'data-fixture-notice': 'true',
      style: 'padding:10px 20px;background:#fff4c2;color:#312d1d;font:14px sans-serif' }, injectTo: 'body-prepend',
      children: simulated ? '合成验收：模型回复与训练指标均为模拟数据，不代表真实模型训练。' : '隔离合成预览：非真实 CNB，模型回复为模拟数据。' }],
  }],
    server: { middlewareMode: true, hmr: { server }, host: '127.0.0.1', allowedHosts: ['localhost', '127.0.0.1'],
      watch: { followSymlinks: false, ignored: ['**/.local/**', '**/training/.venv/**', '**/training/vendor/**'] },
      fs: { strict: true, deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/*.sqlite*', '**/src/platform/**', '**/src/server/**'] } } });
  let closed = false;
  async function close() { if (closed) return; closed = true; await vite.close(); server.close(() => runtime.close()); server.closeIdleConnections(); }
  const stop = () => { if (stopping) return; stopping = true; void (async () => {
    await simulation.shutdown();
    while (active) await delay(100);
    await delay(0); await close();
  })(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  for (; port < 4564; port++) {
    const listening = await new Promise<boolean>((done, reject) => {
      const error = (e: NodeJS.ErrnoException) => { server.off('listening', success); if (e.code === 'EADDRINUSE') done(false); else reject(e); };
      const success = () => { server.off('error', error); done(true); };
      server.once('error', error); server.once('listening', success); server.listen(port, '127.0.0.1');
    });
    if (listening) break;
  }
  if (port >= 4564) { await close(); throw Error('No free dedicated fixture port'); }
  const sources = ['src/contracts/domain.ts', 'src/app/App.tsx', 'src/app/api-client.ts', 'src/app/conversation-panel.tsx', 'src/app/intelligence-panel.tsx', 'src/platform/intelligence.ts', 'src/platform/runtime.ts', 'tools/intelligence-fixture.ts', 'tools/intelligence-fixture-adapters.ts', 'tools/intelligence-fixture-seed.ts'];
  const sourceHash = createHash('sha256').update(sources.map((path) => `${path}:${createHash('sha256').update(readFileSync(join(root, path))).digest('hex')}`).join('\n')).digest('hex');
  const state: PreviewState = { pid: process.pid, nonce, root, port, runtimeId, worker, simulatedTraining: simulated, version: CONTRACT_VERSION, startedAt: new Date().toISOString(), sourceHash };
  const temp = `${stateFile}.${nonce}`; writeFileSync(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 }); regular(stateFile); renameSync(temp, stateFile);
  console.log(JSON.stringify(details(state, true), null, 2));
}
async function main() {
  const action = process.argv[2]; if (action === 'serve') return serve(process.argv[3] ?? '');
  if (action === 'start') return start(process.argv.includes('--worker'), process.argv.includes('--simulated-training'));
  if (!['status', 'stop', 'control'].includes(action ?? '')) throw Error('Expected start [--worker|--simulated-training], status, stop, or control complete|fail|hold');
  const state = readState(); if (!state) { console.log('No registered final fixture preview'); return; }
  const running = owned(state);
  if (action === 'control') {
    if (!running || !state.simulatedTraining) throw Error('Control requires the registered simulated-training fixture');
    const training = FixtureControl.parse(process.argv[3]); regular(controlFile);
    writeFileSync(controlFile, JSON.stringify({ training }), { mode: 0o600 }); console.log(JSON.stringify({ syntheticOnly: true, training })); return;
  }
  if (action === 'stop' && running) {
    process.kill(state.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 100 && owned(state); attempt++) await delay(200);
    if (owned(state)) throw Error('Preview is still waiting for its own worker; do not kill unrelated processes');
  }
  console.log(JSON.stringify({ ...details(state, action === 'stop' ? false : running), healthy: action === 'status' && running ? await healthy(state) : false }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === script) void main().catch(() => { console.error('Final fixture operation failed. Inspect only its registered log and process metadata.'); process.exitCode = 1; });
