import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Port = z.number().int().min(1024).max(65399);
const State = z.object({ pid: z.number().int().positive(), nonce: z.string().regex(/^[a-f0-9]{32}$/), root: z.string(),
  webPort: Port, apiPort: Port, mode: z.literal('fixture'), startedAt: z.iso.datetime() }).strict();
type LocalServerState = z.infer<typeof State>;
const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const directory = join(root, '.local/fixture'), stateFile = join(directory, 'local-server.json'), logFile = join(directory, 'local-server.log');
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function demoEnvironment(source: NodeJS.ProcessEnv, webPort: number, apiPort: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ZHANGDUO_LOCAL_DEMO: 'true', WEB_PORT: String(webPort), API_PORT: String(apiPort) };
}
export function parseLocalServerState(value: unknown, expectedRoot: string): LocalServerState | null {
  const parsed = State.safeParse(value);
  return parsed.success && parsed.data.root === expectedRoot && parsed.data.webPort !== parsed.data.apiPort ? parsed.data : null;
}
export function ownsSupervisor(command: string, scriptPath: string, nonce: string): boolean {
  return /^[a-f0-9]{32}$/.test(nonce) && command.trim().endsWith(`--import tsx ${scriptPath} serve ${nonce}`);
}
function ownFile(path: string) {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw Error(`Not a regular local service file: ${path}`);
}
function prepareDirectory() {
  for (const path of [join(root, '.local'), directory]) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw Error('Unsafe local service directory');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}
function readState() {
  ownFile(stateFile);
  if (!existsSync(stateFile)) return null;
  return parseLocalServerState(JSON.parse(readFileSync(stateFile, 'utf8')), root);
}
function owned(state: LocalServerState) {
  try { return ownsSupervisor(execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), script, state.nonce); }
  catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw Error('Cannot verify service process ownership; no process was started or signalled');
  }
}
function existingProjectProcesses(): number[] {
  const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return processes.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line); if (!match) return [];
    const pid = Number(match[1]), command = match[2]!;
    if (pid === process.pid || !/\bnode\b/.test(command) || !/(?:vite(?:\.js)?|tools\/dev\.mjs|src\/server\/main\.ts)(?:\s|$)/.test(command)) return [];
    try {
      const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return cwd.split('\n').includes(`n${root}`) ? [pid] : [];
    } catch (error) { if ((error as { status?: number }).status === 1) return []; throw error; }
  });
}
async function free(port: number) {
  return new Promise<boolean>((done, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? done(false) : reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}
async function healthy(state: LocalServerState) {
  try {
    const api = await fetch(`http://127.0.0.1:${state.apiPort}/api/health`, { signal: AbortSignal.timeout(1000) });
    const result = await api.json() as { ok?: boolean; data?: { status?: string }; meta?: { mode?: string } };
    const web = await fetch(`http://127.0.0.1:${state.webPort}/`, { signal: AbortSignal.timeout(1000) });
    await web.body?.cancel();
    return api.ok && web.ok && result.ok && result.meta?.mode === 'fixture' && result.data?.status !== 'unconfigured';
  } catch { return false; }
}
function describe(state: LocalServerState, running: boolean) {
  return { state: running ? 'running' : 'stopped', mode: state.mode, pid: state.pid,
    web: `http://127.0.0.1:${state.webPort}`, api: `http://127.0.0.1:${state.apiPort}`, logFile, stateFile, stop: 'pnpm local:stop' };
}
async function start() {
  prepareDirectory();
  const lock = join(directory, 'local-server-start.lock');
  const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const prior = readState();
    if (prior && owned(prior)) { console.log(JSON.stringify({ ...describe(prior, true), healthy: await healthy(prior), reused: true }, null, 2)); return; }
    const existing = existingProjectProcesses();
    if (existing.length) throw Error(`Existing shared project service must be reused. PIDs: ${existing.join(', ')}. No second instance started.`);
    const nonce = randomBytes(16).toString('hex'); ownFile(logFile);
    const log = openSync(logFile, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const child = spawn(process.execPath, ['--import', 'tsx', script, 'serve', nonce], {
      cwd: root, env: demoEnvironment(process.env, 4312, 4313), detached: true, stdio: ['ignore', log, log],
    });
    child.unref(); closeSync(log);
    await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = readState();
      if (state?.nonce === nonce && await healthy(state)) { console.log(JSON.stringify(describe(state, true), null, 2)); return; }
      await wait(200);
    }
    const state = readState();
    if (state?.nonce === nonce && owned(state)) process.kill(state.pid, 'SIGTERM');
    throw Error(`Local service did not become ready; inspect ${logFile}`);
  } finally { closeSync(fd); unlinkSync(lock); }
}
async function serve(nonce: string) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw Error('Invalid service identity');
  prepareDirectory();
  let webPort = 4312;
  for (; webPort < 4412; webPort += 2) if (await free(webPort) && await free(webPort + 1)) break;
  if (webPort >= 4412) throw Error('No free loopback port pair');
  const apiPort = webPort + 1, env = demoEnvironment(process.env, webPort, apiPort);
  const require = createRequire(import.meta.url), vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const children = [
    spawn(process.execPath, ['--import', 'tsx', join(root, 'src/server/main.ts')], { cwd: root, env, stdio: 'inherit' }),
    spawn(process.execPath, [vite, '--host', '127.0.0.1'], { cwd: root, env, stdio: 'inherit' }),
  ];
  let stopping = false;
  function stop() {
    if (stopping) return; stopping = true;
    for (const child of children) child.kill('SIGTERM');
    setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 4000).unref();
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  for (const child of children) {
    child.on('error', () => { process.exitCode = 1; stop(); });
    child.on('exit', (code) => { if (!stopping) { process.exitCode = code || 1; stop(); } });
  }
  const state: LocalServerState = { pid: process.pid, nonce, root, webPort, apiPort, mode: 'fixture', startedAt: new Date().toISOString() };
  const temp = `${stateFile}.${nonce}`; writeFileSync(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  ownFile(stateFile); renameSync(temp, stateFile);
  console.log(`Local synthetic service ${nonce}: Web ${webPort}, API ${apiPort}. No real CNB or models.`);
}
async function main() {
  const action = process.argv[2];
  if (action === 'serve') return serve(process.argv[3] ?? '');
  if (action === 'start') return start();
  if (!['status', 'stop'].includes(action ?? '')) throw Error('Expected start, status, or stop');
  const state = readState();
  if (!state) { console.log('No managed local fixture service.'); return; }
  const running = owned(state);
  if (action === 'stop' && running) {
    process.kill(state.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 60 && owned(state); attempt++) await wait(100);
    if (owned(state)) throw Error('The verified local supervisor is still stopping');
  }
  console.log(JSON.stringify({ ...describe(state, action === 'stop' ? false : running), healthy: action === 'status' && running ? await healthy(state) : false }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === script) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
