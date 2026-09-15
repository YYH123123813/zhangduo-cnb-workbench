import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../../platform/runtime';
import { createApp } from '../../server/app';
import type { GitRunner } from '../../platform/cnb/git-publisher';
import { SCOPES } from '../../contracts/scopes';
import type { RequestApi } from './approval-flow';
import { DataFlow, type DataAction, type SettingsData } from './data-flow';
import { node } from './fixtures.test-support';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
async function setup() {
  mkdirSync('.local/fixture', { recursive: true });
  const directory = mkdtempSync('.local/fixture/governance-runtime-');
  const file = `${directory}.sqlite`;
  const base = 'a'.repeat(40), actorId = 'cnb-user:fixture-user', workspaceId = 'cnb-repo:fixture-repo';
  const env: NodeJS.ProcessEnv = { CNB_REPO_SLUG: 'fixture/governance', CNB_TOKEN: 'governance-fixture-token', CNB_TOKEN_SCOPES: 'account-profile:r,repo-basic-info:r,repo-code:r',
    CNB_LIVE_READS_FOR: 'fixture/governance', ZHANGDUO_MODE: 'live', ZHANGDUO_BOOTSTRAP_KEY: 'a'.repeat(64), ZHANGDUO_STATE_FILE: file,
    ZHANGDUO_APP_SCOPES: Object.values(SCOPES).join(','), ZHANGDUO_STORAGE_CONFIRMED: 'true' };
  const document = { schemaVersion: 1, workspaceId, nodes: [node('k1', { workspaceId, revision: '@snapshot', confirmedBy: actorId })], relations: [], excludedIds: [] };
  const bytes = Buffer.from(JSON.stringify(document));
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const url = new URL(String(input));
    if (url.pathname === '/user') return Response.json({ id: 'fixture-user', username: 'fixture-user' });
    if (url.pathname.endsWith('/fixture/governance')) return Response.json({ id: 'fixture-repo', path: 'fixture/governance', visibility_level: 'Private' });
    if (url.pathname.endsWith('/head')) return Response.json({ name: 'main' });
    if (url.pathname.endsWith('/commits/main')) return Response.json({ sha: base });
    if (url.pathname.endsWith('/contents/knowledge/snapshot.json')) return Response.json({ type: 'blob', path: 'knowledge/snapshot.json', encoding: 'base64', content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
    throw new Error('Unexpected synthetic transport route');
  });
  const gitRunner = vi.fn<GitRunner>(async () => { throw new Error('Git is outside this controlled runtime regression'); });
  let runtime = createRuntime(() => env, { transport, gitRunner });
  let app = createApp(runtime.services, { runtime });
  let cookie = '';
  const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json' };
  const request = vi.fn<RequestApi>(async (path, init) => (await app.request(path, { ...init, headers: { ...headers, Cookie: cookie } })).json());
  const connect = async () => {
    const result = await app.request('/api/workspace/connect', { method: 'POST', headers, body: JSON.stringify({ connectionKey: env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }) });
    expect(result.status, JSON.stringify(runtime.status())).toBe(200); cookie = result.headers.get('Set-Cookie')!.split(';')[0]!;
    expect((await result.json()).meta.mode).toBe('fixture');
  };
  cleanups.push(() => { runtime.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true }); rmSync(directory, { recursive: true, force: true }); });
  await connect();
  const preview = async (kind: 'settings' | 'delete'): Promise<DataAction> => {
    const current = await request('/api/governance/settings'); expect(current.ok).toBe(true); if (!current.ok) throw new Error('No settings');
    const settings = current.data as SettingsData;
    const result = await request(`/api/governance/${kind === 'settings' ? 'settings' : 'delete/preview'}`, { method: kind === 'settings' ? 'PATCH' : 'POST', body: JSON.stringify(kind === 'settings'
      ? { action: 'preview', baseRevision: base, expectedSettingsRevision: settings.settingsRevision, expectedSettingsHash: settings.currentHash, patch: { aiAnswer: true } }
      : { action: 'preview', baseRevision: base, objectIds: ['k1'] }) });
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error('No preview');
    return { kind, workspaceId, preview: result.data } as DataAction;
  };
  return { request, preview, connect, actorId, env, transport, gitRunner, get runtime() { return runtime; },
    restart: () => { runtime.close(); runtime = createRuntime(() => env, { transport, gitRunner }); app = createApp(runtime.services, { runtime }); } };
}

describe('governance through actual shared runtime with synthetic connection and transport', () => {
  it('reads the original unknown settings receipt after restart and explicit reconnect without repeating PATCH', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    const flow = new DataFlow(s.request); flow.prepare(await s.preview('settings'), s.actorId); await flow.approve();
    const approvalId = flow.getSnapshot().approval!.id;
    s.request.mockImplementation(async (path, init) => {
      const result = await original(path, init);
      if (path.endsWith('/settings') && init?.body && JSON.parse(String(init.body)).action === 'execute') throw new Error('Lost save response');
      return result;
    });
    await flow.commit(); expect(flow.getSnapshot().stage).toBe('unknown');
    s.restart();
    expect(await s.request(`/api/governance/operations/settings/${approvalId}`)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    await s.connect();
    expect(await s.request(`/api/governance/operations/settings/${approvalId}`)).toMatchObject({ ok: true, data: { id: approvalId, readOnly: true, result: { state: 'verified', receipt: { approvalId, previousRevision: 0, revision: 1 } } } });
    await flow.verify(); expect(flow.getSnapshot().stage).toBe('succeeded');
    expect(s.request.mock.calls.filter(([path, init]) => path.endsWith('/settings') && init?.body && JSON.parse(String(init.body)).action === 'execute')).toHaveLength(1);
    expect(s.gitRunner).not.toHaveBeenCalled();
  });
  it('recovers a lost original approval across runtime restart and requires explicit execution', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const result = await original(path, init); if (path.endsWith('/approvals/governance')) throw new Error('Lost approval'); return result;
    });
    const flow = new DataFlow(s.request); flow.prepare(await s.preview('settings'), s.actorId); await flow.approve();
    const operationId = flow.getSnapshot().prepared!.operationId;
    s.restart(); await flow.recoverApproval(); expect(flow.getSnapshot().stage).toBe('approval_unknown');
    await s.connect(); await flow.recoverApproval();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'approved', prepared: { operationId } });
    expect(await s.request(`/api/governance/operations/settings_approval/${operationId}`)).toMatchObject({ ok: true, data: { id: operationId, readOnly: true, contentVerified: false, registration: { operationId, status: 'registered' } } });
    expect(await s.request('/api/governance/settings')).toMatchObject({ ok: true, data: { settingsRevision: 0 } });
    await flow.commit(); expect(flow.getSnapshot().stage).toBe('succeeded');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/approvals/governance'))).toHaveLength(1);
    expect(s.gitRunner).not.toHaveBeenCalled();
  });
  it('reads the same persisted delete report after reconnect without repeating deletion or exposing blocked content', async () => {
    const s = await setup(); const flow = new DataFlow(s.request); flow.prepare(await s.preview('delete'), s.actorId); await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('succeeded');
    const prepared = flow.getSnapshot().prepared!; if (prepared.kind !== 'delete') throw new Error('No delete plan');
    const path = `/api/governance/operations/delete/${encodeURIComponent(prepared.preview.plan.id)}`;
    s.restart(); expect(await s.request(path)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } }); await s.connect();
    const response = await s.request(path);
    expect(response).toMatchObject({ ok: true, data: { readOnly: true, result: { retrievalBlocked: true, reportAvailable: true, physicalDeletionComplete: false } } });
    expect(JSON.stringify(response)).not.toContain('Reuse only when the version');
    expect(await s.request('/api/governance/status')).toMatchObject({ ok: true, data: { snapshot: { nodes: [], excludedIds: ['k1'] } } });
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/delete/execute'))).toHaveLength(1);
    expect(s.gitRunner).not.toHaveBeenCalled();
  });
  it('rejects old governance contexts and writes when server permissions rotate', async () => {
    const s = await setup(); const flow = new DataFlow(s.request); flow.prepare(await s.preview('settings'), s.actorId); await flow.approve();
    s.env.ZHANGDUO_APP_SCOPES = 'workspace:read,knowledge:read'; await flow.commit();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'failed', error: { code: 'UNAUTHORIZED' } });
    expect(await s.request('/api/governance/audit')).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(s.gitRunner).not.toHaveBeenCalled();
  });
});
