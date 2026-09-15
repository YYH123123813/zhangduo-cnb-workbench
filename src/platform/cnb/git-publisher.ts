import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type { Result } from '../../contracts/api';
import { failure } from '../result';
import { RepositorySlug } from './capabilities';
import { GitBranch, GitSha } from './snapshot';

interface PreparedCommit { revision: string; stagingKey: string }
interface Publication extends PreparedCommit { repository: string; branch: string; baseRevision: string }
interface Preparation { repository: string; branch: string; baseRevision: string; files: Record<string, string>; message: string }
export interface GitPublisher {
  readonly mode: 'fixture' | 'live';
  prepare(input: Preparation): Promise<Result<PreparedCommit>>;
  publish(input: Publication): Promise<Result<null>>;
}
export interface GitConnection { repository: string; username: string; token: string; writesAuthorized: boolean }
export type GitRunner = (cwd: string, args: string[], env: Record<string, string>, input?: string) => Promise<{ code: number; stdout: string }>;

const runGit: GitRunner = (cwd, args, env, input) => new Promise((accept, reject) => {
  const child = spawn('/usr/bin/git', args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let size = 0;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Git operation timed out')); }, 30_000);
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 2_000_000) { child.kill('SIGKILL'); reject(new Error('Git output exceeded budget')); } else chunks.push(chunk);
  });
  child.stderr.resume();
  child.stdin.on('error', () => { /* Process failures are handled by close/error without exposing request data. */ });
  child.on('error', () => { clearTimeout(timer); reject(new Error('Git process failed')); });
  child.on('close', (code) => { clearTimeout(timer); accept({ code: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8') }); });
  child.stdin.end(input);
});

// This object is never constructed by default Services. Live use needs a trusted server connection.
export class RestrictedGitPublisher implements GitPublisher {
  readonly mode: 'fixture' | 'live';
  private readonly runner: GitRunner;
  private binding?: string;
  constructor(private readonly connection: () => Result<GitConnection>, runner?: GitRunner) {
    this.mode = runner ? 'fixture' : 'live'; this.runner = runner ?? runGit;
  }

  private config(repository: string): Result<GitConnection> {
    const result = this.connection();
    if (!result.ok) return result;
    const parsed = z.object({ repository: RepositorySlug, username: z.string().regex(/^[A-Za-z0-9_.@-]{1,160}$/), token: z.string().min(1).max(4096).regex(/^\S+$/), writesAuthorized: z.literal(true) }).strict().safeParse(result.data);
    if (!parsed.success || parsed.data.repository !== repository) return failure('FORBIDDEN', 'Exact Git repository and write authorization are required', 'configure_authorized_git_transport');
    const binding = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    if (this.binding && this.binding !== binding) return failure('FORBIDDEN', 'Git credential binding changed', 'reestablish_trusted_connection');
    this.binding = binding;
    return { ok: true, data: parsed.data };
  }

  private directory(key: string, create: boolean): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid staging key');
    const root = resolve('.local/git-staging');
    if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
    if (realpathSync(root) !== root) throw new Error('Git staging cannot traverse symlinks');
    const directory = join(root, key);
    if (create) mkdirSync(directory, { mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Invalid staging directory');
    return directory;
  }

  private env(directory: string, config: GitConnection): Record<string, string> {
    const options = [
      ['http.https://cnb.cool/.extraHeader', `Authorization: Basic ${Buffer.from(`${config.username}:${config.token}`).toString('base64')}`],
      ['credential.helper', ''], ['core.hooksPath', '/dev/null'], ['http.followRedirects', 'false'],
      ['protocol.allow', 'never'], ['protocol.https.allow', 'always'], ['fetch.recurseSubmodules', 'false'],
      ['transfer.fsckObjects', 'true'], ['core.autocrlf', 'false'], ['commit.gpgSign', 'false'],
    ];
    return { PATH: '/usr/bin:/bin', HOME: directory, XDG_CONFIG_HOME: directory, LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
      GIT_AUTHOR_NAME: 'Zhangduo Approved Operation', GIT_AUTHOR_EMAIL: 'approved@invalid', GIT_COMMITTER_NAME: 'Zhangduo Approved Operation', GIT_COMMITTER_EMAIL: 'approved@invalid',
      GIT_CONFIG_COUNT: String(options.length),
      ...Object.fromEntries(options.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key!], [`GIT_CONFIG_VALUE_${index}`, value!]])) };
  }

  async prepare(input: Preparation): Promise<Result<PreparedCommit>> {
    const config = this.config(input.repository);
    if (!config.ok) return config;
    const files = Object.entries(input.files);
    if (!GitBranch.safeParse(input.branch).success || !GitSha.safeParse(input.baseRevision).success
      || !/^zhangduo-knowledge [a-f0-9]{64}$/.test(input.message) || !files.length || files.length > 20_001
      || files.some(([path, text]) => !/^(?:knowledge\/(?:snapshot\.json|nodes\/[a-f0-9]{64}\.md)|knowledge-index\/[a-f0-9]{64}\.md)$/.test(path) || Buffer.byteLength(text) > 1_000_000)
      || files.reduce((size, [, text]) => size + Buffer.byteLength(text), 0) > 5_000_000) return failure('VALIDATION', 'Git preparation exceeds its allowed paths or budget', 'reduce_knowledge_change');
    const stagingKey = randomBytes(32).toString('hex');
    try {
      const directory = this.directory(stagingKey, true), env = this.env(directory, config.data);
      const run = async (args: string[], text?: string) => { const result = await this.runner(directory, args, env, text); if (result.code !== 0) throw new Error('Git preparation failed'); return result.stdout.trim(); };
      await run(['init', '--bare', '--template=', `--object-format=${input.baseRevision.length === 40 ? 'sha1' : 'sha256'}`, '.']);
      const url = `https://cnb.cool/${config.data.repository}`;
      await run(['fetch', '--no-tags', '--depth=1', '--filter=blob:none', '--no-recurse-submodules', url, `refs/heads/${input.branch}`]);
      if (await run(['rev-parse', '--verify', 'FETCH_HEAD']) !== input.baseRevision) return failure('CONFLICT', 'Git branch moved before preparation', 'preview_again', 'preserved');
      await run(['read-tree', input.baseRevision]);
      for (const [path, text] of files) {
        const blob = GitSha.parse(await run(['hash-object', '-w', '--stdin'], text));
        await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
      }
      const tree = GitSha.parse(await run(['write-tree']));
      const revision = GitSha.parse(await run(['commit-tree', tree, '-p', input.baseRevision], `${input.message}\n`));
      return { ok: true, data: { revision, stagingKey } };
    } catch { return failure('UPSTREAM', 'Git preparation failed without updating the remote branch', 'check_git_transport', 'preserved'); }
  }

  async publish(input: Publication): Promise<Result<null>> {
    const config = this.config(input.repository);
    if (!config.ok) return config;
    if (!GitBranch.safeParse(input.branch).success || !GitSha.safeParse(input.baseRevision).success || !GitSha.safeParse(input.revision).success) return failure('VALIDATION', 'Invalid Git publication target', 'review_changes');
    let sent = false;
    try {
      const directory = this.directory(input.stagingKey, false), env = this.env(directory, config.data);
      const parent = await this.runner(directory, ['rev-parse', '--verify', `${input.revision}^`], env);
      if (parent.code !== 0 || parent.stdout.trim() !== input.baseRevision) return failure('VALIDATION', 'Prepared commit is not a child of the approved base', 'review_changes');
      const stillConfigured = this.config(input.repository);
      if (!stillConfigured.ok) return stillConfigured;
      const ref = `refs/heads/${input.branch}`;
      sent = true;
      const result = await this.runner(directory, ['push', '--porcelain', '--no-verify', `--force-with-lease=${ref}:${input.baseRevision}`, `https://cnb.cool/${config.data.repository}`, `${input.revision}:${ref}`], env);
      if (result.code === 0) return { ok: true, data: null };
      if (result.stdout.split('\n').some((line) => line.startsWith('!\t') && line.endsWith('[rejected] (stale info)'))) return failure('CONFLICT', 'Remote branch no longer matches the approved base', 'preview_again');
    } catch { /* A lost push response is never retried automatically. */ }
    return sent ? failure('UNKNOWN_RESULT', 'Git publication response was not verified', 'read_commit', 'unknown')
      : failure('UPSTREAM', 'Git publication did not start', 'check_git_transport', 'not_written');
  }
}
