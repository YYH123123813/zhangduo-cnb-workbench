import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCOPES } from '../contracts/scopes';
import { createRuntime } from './runtime';
import { createApp } from '../server/app';
import { readRuntimeConfig } from './runtime-config';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function setup() {
  mkdirSync('.local/fixture', { recursive: true });
  const directory = mkdtempSync(resolve('.local/runtime-fixture-'));
  const file = join('.local/fixture', `runtime-fixture-${directory.split('-').at(-1)}.sqlite`);
  const env: NodeJS.ProcessEnv = { CNB_REPO_SLUG: 'fixture/project', CNB_TOKEN: 'fixture-server-token', CNB_TOKEN_SCOPES: 'account-profile:r,repo-basic-info:r,repo-code:r,repo-issue:r',
    CNB_LIVE_READS_FOR: 'fixture/project', ZHANGDUO_MODE: 'live', ZHANGDUO_BOOTSTRAP_KEY: 'b'.repeat(64), ZHANGDUO_STATE_FILE: file,
    ZHANGDUO_APP_SCOPES: Object.values(SCOPES).join(','), ZHANGDUO_STORAGE_CONFIRMED: 'true' };
  const user = { id: 'user-1', username: 'fixture-user', email: 'private@example.invalid' };
  const repository = { id: 'repo-1', path: 'fixture/project', visibility_level: 'Private' };
  const transport = vi.fn<typeof fetch>(async (input) => new URL(String(input)).pathname === '/user' ? Response.json(user) : Response.json(repository));
  const runtime = createRuntime(() => env, { transport });
  cleanups.push(() => { runtime.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true }); rmSync(directory, { recursive: true, force: true }); });
  const app = createApp(runtime.services, { runtime });
  const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json' };
  const connect = () => app.request('/api/workspace/connect', { method: 'POST', headers, body: JSON.stringify({ connectionKey: env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }) });
  return { runtime, app, connect, env, headers, transport, user, repository, file };
}

describe('W02/W03 actual server runtime bootstrap', () => {
  it('imports a private reviewed catalog only after verifying the configured workspace, using synthetic CNB transport', async () => {
    const s = setup(); s.runtime.close();
    const catalog = s.file.replace('.sqlite', '.review.json');
    const workspaceId = 'cnb-repo:repo-1';
    const question = { id: 'runtime-q', workspaceId, revision: 'q1', nodeRef: { workspaceId, objectId: 'k1', revision: 'a'.repeat(40) },
      kind: 'recall', prompt: 'Prerequisite?', standardAnswer: 'PRIVATE_RUBRIC', hints: ['one', 'two', 'three'],
      rubric: { version: 'rubric1', criteria: [{ id: 'c1', description: 'Prerequisite', expectedEvidence: 'PRIVATE_RUBRIC', required: true }], necessaryConditions: [] },
      review: { status: 'approved', reviewedBy: 'server-reviewer', reviewedAt: '2026-09-12T00:00:00Z' } };
    writeFileSync(catalog, JSON.stringify({ operationId: 'catalog1', workspaceId, questions: [question], retentionDays: 30, confirmed: true }), { mode: 0o600 });
    cleanups.push(() => rmSync(catalog, { force: true }));
    s.env.ZHANGDUO_REVIEW_CATALOG_FILE = catalog;
    const runtime = createRuntime(() => s.env, { transport: s.transport }); cleanups.push(() => runtime.close());
    const app = createApp(runtime.services, { runtime });
    const connected = await app.request('/api/workspace/connect', { method: 'POST', headers: s.headers, body: JSON.stringify({ connectionKey: s.env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }) });
    expect(connected.status).toBe(200);
    const headers = { ...s.headers, Cookie: connected.headers.get('Set-Cookie')!.split(';')[0]! };
    const status = await (await app.request('/api/workspace/review-runtime', { headers })).json();
    expect(status).toMatchObject({ ok: true, data: { catalog: 'ready', availableQuestionCount: 1, unassistedCertification: false } });
    expect(JSON.stringify(status)).not.toContain('PRIVATE_RUBRIC');
    chmodSync(catalog, 0o644);
    const denied = await app.request('/api/workspace/connect', { method: 'POST', headers: s.headers, body: JSON.stringify({ connectionKey: s.env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }) });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps missing configuration explicit without network requests or creating fixture success', async () => {
    const runtime = createRuntime(() => ({})); cleanups.push(() => runtime.close());
    const app = createApp(runtime.services, { runtime });
    expect((await (await app.request('/api/health')).json()).data).toMatchObject({ status: 'unconfigured', cnbConnected: false });
    expect((await app.request('/api/workspace/session')).status).toBe(503);
    expect((await (await app.request('/api/workspace/connection')).json()).data.missing).toContain('ZHANGDUO_STATE_FILE');
  });
  it('requires explicit server configuration, an exact local connection key and same-origin confirmation before probing CNB', async () => {
    const s = setup();
    expect(s.transport).not.toHaveBeenCalled();
    for (const request of [
      { headers: s.headers, body: { connectionKey: 'c'.repeat(64), confirmed: true } },
      { headers: s.headers, body: { connectionKey: s.env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true, actorId: 'forged' } },
      { headers: { ...s.headers, Origin: 'https://untrusted.invalid' }, body: { connectionKey: s.env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true } },
    ]) expect((await s.app.request('/api/workspace/connect', { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) })).status).toBeGreaterThanOrEqual(400);
    expect(s.transport).not.toHaveBeenCalled();
    expect(readRuntimeConfig({ ...s.env, ZHANGDUO_STATE_FILE: ':memory:' }).ok).toBe(false);
    expect(readRuntimeConfig({ ...s.env, ZHANGDUO_APP_SCOPES: '*' }).ok).toBe(false);
  });
  it('connects the actual Services using verified CNB IDs and an HttpOnly cookie, then logs out all prior contexts', async () => {
    const s = setup(), response = await s.connect();
    expect(response.status).toBe(200);
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/api');
    const headers = { ...s.headers, Cookie: cookie.split(';')[0]! };
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, data: { actorId: 'cnb-user:user-1', workspace: { id: 'cnb-repo:repo-1', mode: 'fixture', visibility: 'private' } } });
    expect(JSON.stringify(body)).not.toContain(s.env.CNB_TOKEN); expect(JSON.stringify(body)).not.toContain(s.user.email);
    const context = await s.runtime.services.context(new Request('http://localhost', { headers })); if (!context.ok) throw new Error('Expected bound context');
    expect((await s.runtime.services.readDraftState!(context.data, 'missing-draft')).ok).toBe(true);
    expect((await s.runtime.services.readHandoffOperation!(context.data, 'missing-change'))).toMatchObject({ ok: true, data: { state: 'missing', readOnly: true, absenceIsFinal: false } });
    expect((await s.runtime.services.readHandoffOperationReceipt!(context.data, 'missing-change'))).toEqual({ ok: true, data: null });
    expect((await s.app.request('/api/workspace/session', { headers })).status).toBe(200);
    expect((await s.app.request('/api/workspace/disconnect', { method: 'POST', headers })).status).toBe(200);
    expect((await s.runtime.services.workspace(context.data)).ok).toBe(false);
    expect((await s.app.request('/api/workspace/session', { headers })).status).toBe(401);
  });
  it('accepts an exactly authorized dotted namespace without weakening identity checks', async () => {
    const s = setup();
    s.runtime.close();
    s.env.CNB_REPO_SLUG = 'Yang.nby/yang';
    s.env.CNB_LIVE_READS_FOR = 'Yang.nby/yang';
    s.repository.path = 'Yang.nby/yang';
    expect(readRuntimeConfig(s.env).ok).toBe(true);
    const runtime = createRuntime(() => s.env, { transport: s.transport });
    cleanups.push(() => runtime.close());
    const app = createApp(runtime.services, { runtime });
    const connect = () => app.request('/api/workspace/connect', {
      method: 'POST', headers: s.headers,
      body: JSON.stringify({ connectionKey: s.env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }),
    });
    const response = await connect();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: {
      actorId: 'cnb-user:user-1', workspace: { slug: 'Yang.nby/yang', visibility: 'private', mode: 'fixture' },
    } });
    expect(s.transport.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cnb.cool/user', 'https://api.cnb.cool/Yang.nby/yang',
    ]);
    s.transport.mockClear();
    s.transport.mockImplementation(async () => Response.json({}, { status: 403 }));
    expect((await connect()).status).toBe(403);
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('rejects public or mismatched repositories and invalidates sessions on token rotation', async () => {
    const s = setup(); s.repository.visibility_level = 'Public';
    expect((await s.connect()).status).toBe(403); s.repository.visibility_level = 'Private';
    s.repository.path = 'other/repository'; expect((await s.connect()).status).toBe(403); s.repository.path = 'fixture/project';
    const response = await s.connect(); const Cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
    const context = await s.runtime.services.context(new Request('http://localhost', { headers: { Cookie } })); if (!context.ok) throw new Error('Expected context');
    s.env.CNB_TOKEN = 'rotated-secret';
    expect((await s.runtime.services.workspace(context.data)).ok).toBe(false);
    expect((await s.app.request('/api/workspace/session', { headers: { Cookie } })).status).toBe(401);
  });
  it.each(['before', 'during'])('does not revoke a valid session when a read is cancelled %s verification', async (when) => {
    const s = setup(), response = await s.connect();
    const Cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
    const context = await s.runtime.services.context(new Request('http://localhost', { headers: { Cookie } }));
    if (!context.ok) throw new Error('Expected context');
    const controller = new AbortController();
    s.transport.mockClear();
    if (when === 'before') controller.abort();
    else s.transport.mockImplementationOnce(async () => { controller.abort(); return Response.json(s.user); });
    const cancelled = await s.runtime.services.context(new Request('http://localhost', { headers: { Cookie }, signal: controller.signal }));
    expect(cancelled.ok).toBe(false);
    expect(s.transport).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(s.runtime.status().state).toBe('connected');
    expect((await s.runtime.services.workspace(context.data)).ok).toBe(true);
    expect((await s.app.request('/api/workspace/session', { headers: { Cookie } })).status).toBe(200);
  });
  it('restores connection health after a transient identity read failure is reverified', async () => {
    const s = setup(), response = await s.connect();
    const Cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
    s.transport.mockImplementationOnce(async () => { throw new Error('synthetic temporary transport failure'); });
    expect((await s.app.request('/api/workspace/session', { headers: { Cookie } })).status).not.toBe(200);
    expect(s.runtime.status().state).toBe('unreachable');
    expect((await s.app.request('/api/workspace/session', { headers: { Cookie } })).status).toBe(200);
    expect(s.runtime.status().state).toBe('connected');
  });
  it.each([401, 403])('revokes existing contexts when CNB denies a previously verified account with %s', async (status) => {
    const s = setup(), response = await s.connect();
    const Cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
    const context = await s.runtime.services.context(new Request('http://localhost', { headers: { Cookie } })); if (!context.ok) throw new Error('Expected context');
    s.transport.mockImplementation(async () => Response.json({}, { status }));
    expect((await s.app.request('/api/workspace/session', { headers: { Cookie } })).status).toBe(status);
    expect((await s.runtime.services.workspace(context.data)).ok).toBe(false);
  });
  it('recovers the same server owner binding after restart but never restores a prior browser session', async () => {
    const s = setup(), response = await s.connect();
    const Cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
    s.runtime.close();
    const restarted = createRuntime(() => s.env, { transport: s.transport });
    try {
      const app = createApp(restarted.services, { runtime: restarted });
      expect((await app.request('/api/workspace/session', { headers: { Cookie } })).status).toBe(401);
      const connected = await app.request('/api/workspace/connect', { method: 'POST', headers: s.headers, body: JSON.stringify({ connectionKey: s.env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }) });
      expect((await connected.json()).data).toMatchObject({ actorId: 'cnb-user:user-1', workspace: { id: 'cnb-repo:repo-1' } });
    } finally { restarted.close(); }
  });
});
