import { describe, expect, it } from 'vitest';
import { demoEnvironment, ownsSupervisor, parseLocalServerState } from '../../tools/local-server';

describe('local fixture service lifecycle safety', () => {
  const state = { pid: 12345, nonce: 'a'.repeat(32), root: '/test/project', webPort: 4312, apiPort: 4313,
    mode: 'fixture', startedAt: '2026-09-16T00:00:00Z' };
  it('drops private CNB, model, client and runtime injection configuration', () => {
    const env = demoEnvironment({ PATH: '/bin', HOME: '/home/test', CNB_TOKEN: 'private', CNB_LIVE_WRITES_FOR: 'private/repo',
      VITE_SECRET: 'private', NODE_OPTIONS: '--require=private.js', ZHANGDUO_REVIEW_CATALOG_FILE: '/private/file' }, 4312, 4313);
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/test', ZHANGDUO_LOCAL_DEMO: 'true', WEB_PORT: '4312', API_PORT: '4313' });
  });
  it('requires this project, fixture mode, distinct loopback ports and a bounded process identity', () => {
    expect(parseLocalServerState(state, '/test/project')).toEqual(state);
    for (const changed of [{ ...state, mode: 'live' }, { ...state, pid: -1 }, { ...state, root: '/another' },
      { ...state, webPort: 4313 }, { ...state, apiPort: 80 }, { ...state, nonce: '../x' }]) {
      expect(parseLocalServerState(changed, '/test/project')).toBeNull();
    }
  });
  it('never signals a reused PID or another project process', () => {
    const script = '/test/project/tools/local-server.ts';
    const command = `/usr/local/bin/node --import tsx ${script} serve ${state.nonce}`;
    expect(ownsSupervisor(command, script, state.nonce)).toBe(true);
    expect(ownsSupervisor(command.replace('serve', 'start'), script, state.nonce)).toBe(false);
    expect(ownsSupervisor(command, '/other/project/tools/local-server.ts', state.nonce)).toBe(false);
    expect(ownsSupervisor(command, script, 'b'.repeat(32))).toBe(false);
    expect(ownsSupervisor('/usr/bin/unrelated-service', script, state.nonce)).toBe(false);
  });
});
