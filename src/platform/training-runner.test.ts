import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PythonTraining, TrainingFailure } from './training-runner';
import { DEFAULT_INTELLIGENCE, type TrainingRun } from '../contracts/intelligence';

const metrics = { beforeLoss: 2, afterLoss: 1, heldOutBefore: 2, heldOutAfter: 1, parameterDelta: 1,
  trainableParameters: 8, totalParameters: 100, steps: 5, weightEffect: 0.1, reloadVerified: true, validationGroups: 1 };
function fixture(program?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zhangduo-process-test-'))), id = randomUUID();
  mkdirSync(join(root, 'training/.venv/bin'), { recursive: true });
  writeFileSync(join(root, 'training/worker.py'), '# Synthetic process fixture, not a model.\n');
  const script = program ?? `const fs = require('node:fs'), path = require('node:path');
if (process.env.CNB_TOKEN || process.env.ZHANGDUO_OPENAI_API_KEY) process.exit(9);
const directory = process.argv.at(-1);
fs.writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify(${JSON.stringify(metrics)}));
process.stdout.write('{}');`;
  writeFileSync(join(root, 'training/.venv/bin/python'), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  const run: TrainingRun = { id, mode: 'smoke', state: 'running', createdAt: new Date().toISOString(), datasetHash: 'synthetic',
    settingsRevision: 0, sampleCount: 16, nodeRefs: [], message: 'Synthetic subprocess lifecycle test, not real gradient training.' };
  const directory = join(root, '.local/fixture/training', createHash('sha256').update('test-workspace').digest('hex'), id);
  const executor = new PythonTraining('', root);
  const input = { workspace: 'test-workspace', mode: 'fixture' as const, run, samples: [], settings: DEFAULT_INTELLIGENCE };
  return { root, run, directory, executor, input };
}

it('records worker completion, prevents in-flight cleanup, and survives runner reconstruction', async () => {
  const f = fixture();
  try {
    expect(f.executor.ready()).toBe(true);
    expect(f.executor.inspect('test-workspace', 'fixture', f.run.id)).toBe('unknown');
    const job = f.executor.run(f.input);
    expect(f.executor.inspect('test-workspace', 'fixture', f.run.id)).toBe('running');
    expect(() => f.executor.remove('test-workspace', 'fixture', f.run.id)).toThrow('termination');
    expect(await job).toEqual(metrics);
    const restored = new PythonTraining('', f.root);
    expect(restored.inspect('test-workspace', 'fixture', f.run.id)).toBe('stopped');
    expect(JSON.parse(readFileSync(join(f.directory, 'process.json'), 'utf8')).state).toBe('finished');
    restored.remove('test-workspace', 'fixture', f.run.id);
    expect(existsSync(f.directory)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('rejects duplicate artifact identities before launching another process', async () => {
  const f = fixture();
  try {
    await f.executor.run(f.input);
    await expect(f.executor.run(f.input)).rejects.toThrow();
    expect(f.executor.inspect('test-workspace', 'fixture', f.run.id)).toBe('stopped');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('treats missing process evidence and a still-existing PID conservatively', async () => {
  const f = fixture();
  try {
    mkdirSync(f.directory, { recursive: true });
    expect(f.executor.inspect('test-workspace', 'fixture', f.run.id)).toBe('unknown');
    writeFileSync(join(f.directory, 'process.json'), JSON.stringify({ state: 'running', pid: process.pid }));
    expect(f.executor.inspect('test-workspace', 'fixture', f.run.id)).toBe('running');
    expect(() => f.executor.remove('test-workspace', 'fixture', f.run.id)).toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('does not write through a symlinked private-storage root', async () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'zhangduo-outside-test-'));
  try {
    symlinkSync(outside, join(f.root, '.local'), 'dir');
    await expect(f.executor.run(f.input)).rejects.toThrow('escape');
    expect(existsSync(join(outside, 'fixture'))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

it('waits for a bounded-output worker to exit before marking it stopped', async () => {
  const f = fixture("process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync(require('node:path').join(process.argv.at(-1), 'terminated.txt'), 'stopped'); process.exit(0); }, 150)); process.stdout.write('x'.repeat(210000)); setInterval(() => {}, 1000);");
  try {
    await expect(f.executor.run(f.input)).rejects.toThrow('output budget');
    expect(existsSync(join(f.directory, 'terminated.txt'))).toBe(true);
    expect(f.executor.inspect('test-workspace', 'fixture', f.run.id)).toBe('stopped');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('maps only allowlisted error codes and does not expose worker paths or raw messages', async () => {
  const f = fixture("require('node:fs').writeFileSync(require('node:path').join(process.argv.at(-1), 'error.json'), JSON.stringify({code:'SAMPLE_TOO_LONG',message:'PRIVATE_SAMPLE_AND_PATH'})); process.exit(1);");
  try {
    let error: unknown;
    try { await f.executor.run(f.input); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(TrainingFailure);
    expect((error as TrainingFailure).code).toBe('SAMPLE_TOO_LONG');
    expect(String(error)).not.toContain('PRIVATE_SAMPLE_AND_PATH');
    expect(f.executor.inspect('test-workspace', 'fixture', f.run.id)).toBe('stopped');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('requires local tokenizer and safetensors files before advertising pretrained readiness', () => {
  const f = fixture(), base = join(f.root, 'base');
  try {
    mkdirSync(base);
    writeFileSync(join(base, 'config.json'), '{}');
    const executor = new PythonTraining(base, f.root);
    expect(executor.pretrainedReady()).toBe(false);
    writeFileSync(join(base, 'tokenizer.json'), '{}');
    expect(executor.pretrainedReady()).toBe(false);
    writeFileSync(join(base, 'model.safetensors'), 'synthetic static readiness fixture, not loadable weights');
    expect(executor.pretrainedReady()).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
