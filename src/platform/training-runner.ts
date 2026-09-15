import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync, statSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { IntelligenceSettings, TrainingRun, TrainingSample } from '../contracts/intelligence';
import { TrainingRunSchema } from '../contracts/intelligence';

const TRAINING_FAILURES = {
  INVALID_DATASET: '训练样本为空或格式不合法，请重新选择非零权重知识。',
  INVALID_SAMPLE: '训练样本格式不合法，请核对知识及来源。', INVALID_WEIGHT: '样本权重不合法，未接纳训练结果。',
  INSUFFICIENT_GROUPS: '至少需要两段独立来源对话，不能混用训练与验证数据。',
  SAMPLE_TOO_LONG: '授权样本超过本地模型长度范围；未截断来源，请缩小范围。',
  INVALID_MODEL: '本地基础模型或 safetensors 不完整，未启动可用模型。',
  INVALID_TOKENIZER: '本地分词器不完整，需核对 EOS 和 tokenizer 文件。',
  RELOAD_MISMATCH: '模型保存后重载不一致，训练结果未接纳。',
  NO_PARAMETER_UPDATE: '没有核验到参数更新，训练结果未接纳。', NO_WEIGHT_EFFECT: '未核验到样本权重影响，训练结果未接纳。',
  NONFINITE_LOSS: '训练损失出现非有限数值，训练结果未接纳。', NONFINITE_GRADIENT: '训练梯度出现非有限数值，训练结果未接纳。',
  RUN_ALREADY_STARTED: '原训练目录已有一次尝试，不会覆盖或自动重跑。',
  INVALID_REQUEST: '训练参数不合法，未启用模型。', NO_TRAINABLE_PARAMETERS: '当前模型没有可训练的适配器参数。',
} as const;
export class TrainingFailure extends Error {
  constructor(readonly code: keyof typeof TRAINING_FAILURES) { super(TRAINING_FAILURES[code]); }
}

export interface TrainingExecutor {
  ready(): boolean;
  pretrainedReady(): boolean;
  run(input: { workspace: string; mode: 'fixture' | 'live'; run: TrainingRun; samples: TrainingSample[]; settings: IntelligenceSettings }): Promise<NonNullable<TrainingRun['metrics']>>;
  infer(workspace: string, mode: 'fixture' | 'live', runId: string, text: string): Promise<unknown>;
  inspect?(workspace: string, mode: 'fixture' | 'live', runId: string): 'running' | 'stopped' | 'unknown';
  remove?(workspace: string, mode: 'fixture' | 'live', runId: string): void;
}
export class PythonTraining implements TrainingExecutor {
  private readonly python: string;
  private readonly worker: string;
  private readonly active = new Set<string>();
  constructor(private readonly pretrained = '', private readonly root = process.cwd()) {
    this.root = realpathSync(root);
    this.python = resolve(this.root, 'training/.venv/bin/python'); this.worker = resolve(this.root, 'training/worker.py');
  }
  ready() { return existsSync(this.python) && existsSync(this.worker); }
  pretrainedReady() {
    if (!this.ready() || !this.pretrained || !isAbsolute(this.pretrained)) return false;
    try {
      if (!existsSync(resolve(this.pretrained, 'config.json')) || !['tokenizer.json', 'tokenizer.model', 'vocab.json'].some((name) => existsSync(resolve(this.pretrained, name)))) return false;
      if (existsSync(resolve(this.pretrained, 'model.safetensors'))) return true;
      const index = resolve(this.pretrained, 'model.safetensors.index.json');
      if (!existsSync(index) || statSync(index).size > 1_000_000) return false;
      const data = JSON.parse(readFileSync(index, 'utf8')) as { weight_map?: Record<string, unknown> };
      if (!data.weight_map || typeof data.weight_map !== 'object') return false;
      const shards = Object.values(data.weight_map);
      return shards.length > 0 && shards.every((name) => typeof name === 'string' && /^[A-Za-z0-9_.-]+\.safetensors$/.test(name) && existsSync(resolve(this.pretrained, name)));
    } catch { return false; }
  }
  private directory(workspace: string, mode: 'fixture' | 'live', id: string, create = false) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) || !['fixture', 'live'].includes(mode)) throw Error('Invalid training identity');
    const root = resolve(this.root, '.local');
    const parts = [root, mode, 'training', createHash('sha256').update(workspace).digest('hex'), id];
    let directory = '';
    for (const part of parts) {
      directory = directory ? resolve(directory, part) : part;
      if (existsSync(directory)) { if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory()) throw Error('Training path escape'); }
      else if (create) mkdirSync(directory, { mode: 0o700 });
      if (existsSync(directory)) {
        const rel = relative(root, realpathSync(directory));
        if (rel.startsWith('..') || isAbsolute(rel)) throw Error('Training path escape');
      }
    }
    return directory;
  }
  private processFile(directory: string) {
    const path = resolve(directory, 'process.json');
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('Process metadata path escape');
    return path;
  }
  inspect(workspace: string, mode: 'fixture' | 'live', id: string): 'running' | 'stopped' | 'unknown' {
    try {
      const directory = this.directory(workspace, mode, id);
      if (this.active.has(directory)) return 'running';
      const path = this.processFile(directory);
      if (!existsSync(path) || statSync(path).size > 4096) return 'unknown';
      const state = JSON.parse(readFileSync(path, 'utf8')) as { state: string; pid?: number };
      if (state.state === 'finished') return 'stopped';
      if (state.state !== 'running' || !Number.isSafeInteger(state.pid) || state.pid! <= 0) return 'unknown';
      try { process.kill(state.pid!, 0); return 'running'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stopped' : 'unknown'; }
    } catch { return 'unknown'; }
  }
  private execute(args: string[], directory: string, stdin?: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      if (this.active.has(directory)) throw Error('A worker is already using this adapter');
      const metadata = this.processFile(directory);
      writeFileSync(metadata, JSON.stringify({ state: 'starting' }), { mode: 0o600 });
      const child = spawn(this.python, [this.worker, ...args], { cwd: this.root, env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
        TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2',
        HF_HOME: resolve(this.root, '.local/training-cache'), XDG_CACHE_HOME: resolve(this.root, '.local/training-cache'),
      }, stdio: ['pipe', 'pipe', 'pipe'] });
      this.active.add(directory);
      let size = 0, settled = false, failed: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const chunks: Buffer[] = [];
      const done = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); this.active.delete(directory);
        try { writeFileSync(this.processFile(directory), JSON.stringify({ state: 'finished', pid: child.pid ?? null }), { mode: 0o600 }); }
        catch { error ??= Error('Process completion metadata unavailable'); }
        if (error) reject(error); else resolvePromise(Buffer.concat(chunks).toString('utf8'));
      };
      const terminate = (error: Error) => {
        if (failed || settled) return; failed = error; child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      const timer = setTimeout(() => terminate(Error('Training process timed out')), 600_000);
      child.on('spawn', () => {
        try { writeFileSync(this.processFile(directory), JSON.stringify({ state: 'running', pid: child.pid }), { mode: 0o600 }); }
        catch { terminate(Error('Process identity could not be recorded')); }
      });
      child.stdout.on('data', (value: Buffer) => { size += value.byteLength; if (size > 200_000) terminate(Error('Training output budget')); else chunks.push(value); });
      child.stderr.on('data', () => {});
      child.on('error', () => done(Error('Training environment unavailable')));
      child.on('close', (code) => done(failed ?? (code === 0 ? undefined : Error('Training process failed; no model was activated'))));
      child.stdin.on('error', () => {}); child.stdin.end(stdin ?? '');
    });
  }
  async run(input: Parameters<TrainingExecutor['run']>[0]) {
    const directory = this.directory(input.workspace, input.mode, input.run.id, true);
    writeFileSync(resolve(directory, 'request.json'), JSON.stringify({ mode: input.run.mode, samples: input.samples, settings: input.settings, baseModel: this.pretrained }), { mode: 0o600, flag: 'wx' });
    try { await this.execute(['train', directory], directory); }
    catch (error) {
      const path = resolve(directory, 'error.json');
      let code: unknown;
      try { if (existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).size <= 4096) code = JSON.parse(readFileSync(path, 'utf8')).code; }
      catch { /* Only whitelisted error codes may cross the worker boundary. */ }
      if (typeof code === 'string' && Object.hasOwn(TRAINING_FAILURES, code)) throw new TrainingFailure(code as keyof typeof TRAINING_FAILURES);
      throw error;
    }
    const path = resolve(directory, 'metrics.json');
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > 100_000) throw Error('Metrics budget or path escape');
    return TrainingRunSchema.shape.metrics.unwrap().parse(JSON.parse(readFileSync(path, 'utf8')));
  }
  async infer(workspace: string, mode: 'fixture' | 'live', id: string, text: string) {
    const directory = this.directory(workspace, mode, id);
    return JSON.parse(await this.execute(['infer', directory], directory, JSON.stringify({ text })));
  }
  remove(workspace: string, mode: 'fixture' | 'live', id: string) {
    if (this.inspect(workspace, mode, id) !== 'stopped') throw Error('Worker termination is not verified');
    rmSync(this.directory(workspace, mode, id), { recursive: true });
  }
}
