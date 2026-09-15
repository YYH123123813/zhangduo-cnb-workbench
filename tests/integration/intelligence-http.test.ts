import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/platform/services';
import { platformFixture } from './platform-fixture';
import { createLocalDemoRuntime } from '../../src/platform/local-demo';
import { LOCAL_DEMO_KEY } from '../../src/contracts/runtime';
import { contentHash } from '../../src/contracts/hash';

const bindingHeader = 'X-Zhangduo-Session-Binding';

describe('intelligence shared HTTP boundary', () => {
  it('rejects an old page binding before reading or writing through a changed cookie identity', async () => {
    const f = await platformFixture(), app = createApp(f.services);
    try {
      const sessionResponse = await app.request('/api/workspace/session', { headers: f.headers });
      const { data: session } = await sessionResponse.json();
      const binding = await contentHash({ ...session, scopes: [...session.scopes].sort() });
      const operationId = randomUUID();
      for (const next of [
        { ...session, actorId: 'other-actor' },
        { ...session, workspace: { ...session.workspace, id: 'other-workspace' } },
        { ...session, scopes: [...session.scopes, 'synthetic:extra'] },
        { ...session, workspace: { ...session.workspace, visibility: 'public' as const } },
      ]) {
        const token = f.sessions.issue(next);
        const headers = { Cookie: `zhangduo_session=${token}`, Origin: 'http://localhost', 'Content-Type': 'application/json', [bindingHeader]: binding };
        const read = await app.request('/api/intelligence', { headers });
        expect(read.status).toBe(403);
        const write = await app.request('/api/intelligence', { method: 'POST', headers,
          body: JSON.stringify({ action: 'create_chat', operationId, title: 'Old page private draft', retentionDays: 30, confirmed: true }) });
        expect(write.status).toBe(403);
        expect(f.journal.records(next.workspace.id, next.actorId, 'intelligence_chat')).toHaveLength(0);
      }
      expect(f.transport).not.toHaveBeenCalled();
    } finally { f.journal.close(); }
  });
  it('echoes only a verified session binding and does not treat it as credentials', async () => {
    const f = await platformFixture(), app = createApp(f.services);
    try {
      const { data: session } = await (await app.request('/api/workspace/session', { headers: f.headers })).json();
      const binding = await contentHash({ ...session, scopes: [...session.scopes].sort() });
      const valid = await app.request('/api/intelligence', { headers: { ...f.headers, [bindingHeader]: binding } });
      expect(valid.status).toBe(200); expect(valid.headers.get(bindingHeader)).toBe(binding);
      const invalid = await app.request('/api/intelligence', { headers: { ...f.headers, [bindingHeader]: '0'.repeat(64) } });
      expect(invalid.status).toBe(403); expect(invalid.headers.get(bindingHeader)).toBeNull();
      expect((await app.request('/api/intelligence', { headers: { [bindingHeader]: binding } })).status).toBe(401);
    } finally { f.journal.close(); }
  });
  it('exposes authenticated no-store readback of the original intelligence operation', async () => {
    const f = await platformFixture(), app = createApp(f.services), operationId = randomUUID();
    try {
      expect((await app.request(`/api/intelligence/operations/${operationId}`)).status).toBe(401);
      const created = await app.request('/api/intelligence', { method: 'POST', headers: f.headers,
        body: JSON.stringify({ action: 'create_chat', operationId, title: 'Private synthetic title', retentionDays: 30, confirmed: true }) });
      expect(created.status).toBe(200);
      const response = await app.request(`/api/intelligence/operations/${operationId}`, { headers: f.headers });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const result = await response.json();
      expect(result).toMatchObject({ ok: true, data: { operationId, action: 'create_chat', state: 'completed', readOnly: true, absenceIsFinal: false } });
      expect(JSON.stringify(result)).not.toContain('Private synthetic title');
      expect((await app.request('/api/intelligence/operations/not-an-operation', { headers: f.headers })).status).toBe(422);
    } finally { f.journal.close(); }
  });
  it('requires session, rejects forged consent and preserves normal workspace routes', async () => {
    const f = await platformFixture(); const app = createApp(f.services);
    try {
      expect((await app.request('/api/intelligence')).status).toBe(401);
      expect((await app.request('/api/intelligence', { headers: f.headers })).status).toBe(200);
      const invalid = await app.request('/api/intelligence', { method: 'POST', headers: f.headers, body: JSON.stringify({ action: 'create_chat', operationId: randomUUID(), title: 'test', retentionDays: 30, confirmed: false }) });
      expect(invalid.status).toBe(422);
      expect(f.journal.records(f.ctx.workspaceId, f.ctx.actorId, 'intelligence_chat')).toHaveLength(0);
      const cross = await app.request('/api/intelligence', { method: 'POST', headers: { ...f.headers, Origin: 'https://untrusted.example' }, body: '{}' });
      expect(cross.status).toBe(403);
    } finally { f.journal.close(); }
  });
  it('keeps unknown replies blocked and cannot read another actor conversation', async () => {
    const f = await platformFixture();
    const send = vi.fn(async () => { throw Error('transport lost'); });
    const services = createServices({ ...f.options, aiGateway: { status: () => [{ id: 'local', ready: true, model: 'test' }], send } });
    try {
      const id = randomUUID();
      await services.intelligenceCommand!(f.ctx, { action: 'create_chat', title: 'test', operationId: id, retentionDays: 30, confirmed: true });
      const operation = { action: 'send' as const, operationId: randomUUID(), confirmed: true as const, id, expectedRevision: 1, text: 'source content', provider: 'local' as const, modelConsent: true as const };
      expect((await services.intelligenceCommand!(f.ctx, operation)).ok).toBe(false);
      expect((await services.intelligenceCommand!(f.ctx, operation)).ok).toBe(false); expect(send).toHaveBeenCalledTimes(1);
      const token = f.sessions.issue({ actorId: 'other-actor', workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: ['conversation:read'] });
      const ctx = f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
      if (!ctx.ok) throw Error('Expected context');
      expect((await services.intelligenceCommand!(ctx.data, { action: 'read_chat', id })).ok).toBe(false);
    } finally { f.journal.close(); }
  });
  it('connects new API to actual local runtime without any model calls', async () => {
    const runtime = createLocalDemoRuntime(`intelligence-${randomUUID()}`), app = createApp(runtime.services, { runtime });
    try {
      const connected = await app.request('/api/workspace/connect', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionKey: LOCAL_DEMO_KEY, confirmed: true }) });
      const cookie = connected.headers.get('set-cookie')!.split(';')[0]!;
      const response = await app.request('/api/intelligence', { headers: { Cookie: cookie } });
      expect(response.status).toBe(200); const result = await response.json();
      expect(result.meta.mode).toBe('fixture'); expect(result.data.samples).toHaveLength(2);
      expect(result.data.providers.every((p: { ready: boolean }) => !p.ready)).toBe(true);
    } finally { runtime.close(); }
  });
});
