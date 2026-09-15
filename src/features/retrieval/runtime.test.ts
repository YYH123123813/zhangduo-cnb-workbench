import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../../platform/runtime';
import { createApp } from '../../server/app';
import type { ApiResponse } from '../../contracts/api';
import type { RetrievalRequest, RetrievalResult } from '../../contracts/domain';
import { node, time } from './test-support';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function setup() {
  mkdirSync('.local/fixture', { recursive: true });
  const file = `.local/fixture/retrieval-runtime-${crypto.randomUUID()}.sqlite`;
  const env = { CNB_REPO_SLUG: 'fixture/retrieval', CNB_TOKEN: 'synthetic-runtime-token', CNB_TOKEN_SCOPES: 'account-profile:r,repo-basic-info:r,repo-code:r,repo-issue:r',
    CNB_LIVE_READS_FOR: 'fixture/retrieval', ZHANGDUO_MODE: 'live', ZHANGDUO_BOOTSTRAP_KEY: 'b'.repeat(64), ZHANGDUO_STATE_FILE: file,
    ZHANGDUO_APP_SCOPES: 'workspace:read,knowledge:read,settings:read', ZHANGDUO_STORAGE_CONFIRMED: 'true' };
  const workspaceId = 'cnb-repo:fixture-repo'; const revision = 'a'.repeat(40);
  const document = { schemaVersion: 1, workspaceId, nodes: [node('n1', { workspaceId, revision: '@snapshot', confirmedBy: 'cnb-user:fixture-reader' })], relations: [], excludedIds: [] };
  const bytes = Buffer.from(JSON.stringify(document)); const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  let revokeAfterSnapshot = false; let revoked = false;
  const transport = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/user') return revoked ? Response.json({ message: 'Fixture revoked' }, { status: 401 }) : Response.json({ id: 'fixture-reader', username: 'fixture-reader' });
    if (url.pathname === '/fixture/retrieval') return Response.json({ id: 'fixture-repo', path: 'fixture/retrieval', visibility_level: 'Private' });
    if (url.pathname.endsWith('/head')) return Response.json({ name: 'main' });
    if (url.pathname.endsWith('/commits/main')) return Response.json({ sha: revision });
    if (url.pathname.endsWith('/contents/knowledge/snapshot.json')) {
      if (revokeAfterSnapshot) revoked = true;
      return Response.json({ type: 'blob', path: 'knowledge/snapshot.json', encoding: 'base64', content: bytes.toString('base64'), sha });
    }
    throw new Error(`Unexpected fixture transport path: ${url.pathname}`);
  });
  const runtime = createRuntime(() => env, { transport });
  cleanups.push(() => { runtime.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true }); });
  const app = createApp(runtime.services, { runtime });
  const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json' };
  const request: RetrievalRequest = { task: { id: 'runtime-task', workspaceId, question: 'cache', constraints: [], mode: 'assisted', updatedAt: time }, query: 'cache', confirmedOnly: true };
  async function connect() {
    const response = await app.request('/api/workspace/connect', { method: 'POST', headers, body: JSON.stringify({ connectionKey: env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }) });
    expect(response.status).toBe(200); expect(await response.text()).not.toContain(env.CNB_TOKEN);
    return { ...headers, Cookie: response.headers.get('Set-Cookie')!.split(';')[0]! };
  }
  return { app, runtime, headers, transport, request, revision, connect, set revokeAfterSnapshot(value: boolean) { revokeAfterSnapshot = value; } };
}

describe('R01/R04 current production runtime assembly, fixture transport and private synthetic journal only', () => {
  it('reads query/detail/graph/history through the runtime-issued cookie and rejects the same cookie after logout', async () => {
    const f = setup(); expect(f.transport).not.toHaveBeenCalled();
    expect((await f.app.request('/api/retrieval/status')).status).toBe(401);
    const headers = await f.connect();
    const response = await f.app.request('/api/retrieval/query', { method: 'POST', headers, body: JSON.stringify(f.request) });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json() as ApiResponse<RetrievalResult>;
    expect(result.meta.mode).toBe('fixture'); if (!result.ok) throw new Error(result.error.code);
    expect(result.data.groups.eligible.map((n) => n.id)).toEqual(['n1']); expect(result.data.answer).toBeNull(); expect(result.data.coverage).not.toBe('current');
    for (const path of [`/api/retrieval/nodes/n1?revision=${f.revision}`, `/api/retrieval/graph/n1?revision=${f.revision}`, `/api/retrieval/nodes/n1/history?revision=${f.revision}`]) {
      expect((await f.app.request(path, { headers })).status).toBe(200);
    }
    expect((await f.app.request('/api/workspace/disconnect', { method: 'POST', headers })).status).toBe(200);
    const denied = await f.app.request('/api/retrieval/query', { method: 'POST', headers, body: JSON.stringify(f.request) });
    expect(denied.status).toBe(401); expect(await denied.text()).not.toContain('Cache immutable data.');
  });
  it('drops knowledge already read when the runtime final identity check finds remote revocation', async () => {
    const f = setup(); const headers = await f.connect(); f.revokeAfterSnapshot = true;
    const response = await f.app.request('/api/retrieval/query', { method: 'POST', headers, body: JSON.stringify(f.request) });
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('Cache immutable data.');
    expect(f.runtime.status().cnbConnected).toBe(false);
  });
});
