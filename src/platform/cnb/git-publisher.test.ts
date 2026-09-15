import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestrictedGitPublisher, type GitRunner } from './git-publisher';

const base = 'a'.repeat(40), revision = 'b'.repeat(40);
const created = new Set<string>();
afterEach(() => { for (const directory of created) rmSync(directory, { recursive: true, force: true }); created.clear(); });
function setup() {
  const runner = vi.fn<GitRunner>(async (directory, args) => {
    created.add(directory);
    return { code: 0, stdout: args[0] === 'rev-parse' ? `${base}\n` : ['hash-object', 'write-tree', 'commit-tree'].includes(args[0]!) ? `${revision}\n` : '' };
  });
  const git = new RestrictedGitPublisher(() => ({ ok: true, data: { repository: 'fixture/project', username: 'fixture-user', token: 'fixture-secret', writesAuthorized: true } }), runner);
  const input = { repository: 'fixture/project', branch: 'main', baseRevision: base, files: { 'knowledge/snapshot.json': '{}' }, message: `zhangduo-knowledge ${'d'.repeat(64)}` };
  return { git, input, runner };
}
describe('W07 restricted Git command boundary (no real Git commands)', () => {
  it('prepares one tree/commit, uses an exact remote lease, and keeps credentials out of argv/config files', async () => {
    const s = setup();
    const prepared = await s.git.prepare(s.input);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    expect((await s.git.publish({ ...s.input, ...prepared.data })).ok).toBe(true);
    expect(s.runner.mock.calls.filter(([, args]) => args[0] === 'commit-tree')).toHaveLength(1);
    const publish = s.runner.mock.calls.find(([, args]) => args[0] === 'push')!;
    expect(publish[1]).toContain(`--force-with-lease=refs/heads/main:${base}`);
    expect(publish[1]).toContain(`${revision}:refs/heads/main`);
    expect(s.runner.mock.calls.every(([, args]) => !args.join(' ').includes('fixture-secret'))).toBe(true);
    expect(publish[2]).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
    expect(s.runner.mock.calls.every(([directory]) => directory.includes('/.local/git-staging/'))).toBe(true);
  });
  it('rejects arbitrary paths, foreign repositories and branch flags before a command runs', async () => {
    for (const patch of [{ files: { '../secret': 'private' } }, { repository: 'other/repo' }, { branch: '--all' }]) {
      const s = setup(); expect((await s.git.prepare({ ...s.input, ...patch })).ok).toBe(false);
      expect(s.runner).not.toHaveBeenCalled();
    }
  });
  it('distinguishes an explicit stale-lease rejection from a lost push result', async () => {
    for (const lost of [false, true]) {
      const s = setup(); const prepared = await s.git.prepare(s.input);
      if (!prepared.ok) throw new Error('Expected preparation');
      const original = s.runner.getMockImplementation()!;
      s.runner.mockImplementation(async (...args) => {
        if (args[1][0] !== 'push') return original(...args);
        if (lost) throw new Error('Secret upstream error must not escape');
        return { code: 1, stdout: `!\t${revision}:refs/heads/main\t[rejected] (stale info)\n` };
      });
      expect(await s.git.publish({ ...s.input, ...prepared.data })).toMatchObject({ ok: false, error: { code: lost ? 'UNKNOWN_RESULT' : 'CONFLICT', dataState: lost ? 'unknown' : 'not_written' } });
    }
  });
});
