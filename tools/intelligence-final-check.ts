import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { demoEnvironment } from './local-server';

const stage = process.argv[2];
if (!['targeted', 'final', 'worker'].includes(stage ?? '')) throw Error('Expected targeted, final, or worker');
const directory = resolve('.local/fixture/intelligence-parallel/A', `final-20260916-${stage}-${randomUUID()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
function manifest() {
  const paths = execFileSync('rg', ['--files', 'src', 'tests', 'tools', 'training', '-g', '!vendor/**', '-g', '!**/vendor/**', '-g', '!**/.venv/**'], { encoding: 'utf8' })
    .trim().split('\n').filter((path) => /\.(?:ts|tsx|js|mjs|py|json|txt)$/.test(path));
  paths.push('package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json');
  return Object.fromEntries([...new Set(paths)].sort().map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
}
const before = manifest(), startedAt = new Date().toISOString();
writeFileSync(resolve(directory, 'source-before.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
const targeted = ['src/platform/intelligence.test.ts', 'src/platform/intelligence-safety.test.ts', 'src/platform/training-runner.test.ts',
  'src/platform/runtime.test.ts', 'src/app/api-client.test.ts', 'tests/integration/intelligence-http.test.ts',
  'tests/integration/intelligence-session.test.ts', 'tests/integration/intelligence-fixture.test.ts'];
const commands = stage === 'worker' ? [[process.execPath, '--import', 'tsx', 'tools/intelligence-training-smoke.ts']]
  : stage === 'targeted' ? [['pnpm', 'typecheck'], ['pnpm', 'exec', 'vitest', 'run', ...targeted, '--maxWorkers=2']]
    : [['pnpm', 'typecheck'], ['pnpm', 'check:boundaries'], ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=2'], ['pnpm', 'build']];
const results: { command: string[]; exitCode: number; signal: string | null; startedAt: string; finishedAt: string; log: string }[] = [];
for (const [index, argv] of commands.entries()) {
  const log = resolve(directory, `${index + 1}.log`), fd = openSync(log, 'wx', 0o600), start = new Date().toISOString();
  console.log(`Running ${argv.join(' ')}; log: ${log}`);
  const child = spawn(argv[0]!, argv.slice(1), { cwd: process.cwd(), env: demoEnvironment(process.env, 4514, 4514), stdio: ['ignore', fd, fd] });
  const outcome = await new Promise<{ exitCode: number; signal: string | null }>((done) => {
    child.once('error', () => done({ exitCode: 1, signal: null }));
    child.once('close', (code, signal) => done({ exitCode: code ?? 1, signal }));
  });
  closeSync(fd);
  results.push({ command: argv, ...outcome, startedAt: start, finishedAt: new Date().toISOString(), log });
  console.log(readFileSync(log, 'utf8').split('\n').slice(-18).join('\n'));
}
const after = manifest(), changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]);
writeFileSync(resolve(directory, 'source-after.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
const report = { stage, startedAt, finishedAt: new Date().toISOString(), privateEnvironment: false, realCNB: false,
  env: { ZHANGDUO_LOCAL_DEMO: 'true' }, results, changedFiles, sourceStable: changedFiles.length === 0 };
writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ directory, ...report }, null, 2));
if (results.some((row) => row.exitCode !== 0) || (stage === 'final' && changedFiles.length)) process.exitCode = 1;
