import { describe, expect, it } from 'vitest';
import { SessionRegistry } from './identity';
import { createServices } from './services';
import { createApp } from '../server/app';

const workspace = { id: 'w1', slug: 'fixture/project', visibility: 'private' as const, mode: 'fixture' as const };
const now = Date.parse('2026-09-05T05:00:00Z');

function setup(scopes = ['workspace:read']) {
  let clock = now;
  const sessions = new SessionRegistry(() => clock);
  const token = sessions.issue({ actorId: 'u1', workspace, scopes }, 60_000);
  const services = createServices({ sessions });
  const request = (headers: Record<string, string> = {}) => new Request('http://localhost/api/workspace', { headers: { Cookie: `zhangduo_session=${token}`, ...headers } });
  return { services, sessions, token, request, expire: () => { clock += 60_000; } };
}

describe('W02 trusted session and workspace', () => {
  it('binds the actor, mode and scopes from server-owned session state', async () => {
    const { services, request } = setup();
    const context = await services.context(request({ 'X-Mode': 'live', 'X-Scopes': '*' }));
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.data).toMatchObject({ actorId: 'u1', workspaceId: 'w1', mode: 'fixture', scopes: ['workspace:read'] });
    expect(await services.workspace(context.data)).toEqual({ ok: true, data: workspace });
    expect(await services.workspace({ ...context.data, workspaceId: 'private-other' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('rejects forged identity claims, missing permission and missing sessions', async () => {
    const { services, request } = setup([]);
    expect(await services.context(request({ 'X-Workspace': 'private-other' }))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const ctx = await services.context(request());
    if (ctx.ok) expect(await services.workspace(ctx.data)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await services.context(new Request('http://localhost/'))).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('invalidates previously issued contexts on expiry or revocation', async () => {
    for (const action of ['expire', 'revoke']) {
      const { services, request, sessions, token, expire } = setup();
      const ctx = await services.context(request());
      if (action === 'expire') expire(); else sessions.revoke(token);
      expect(await services.context(request())).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      if (ctx.ok) expect(await services.workspace(ctx.data)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    }
  });

  it('rejects ambiguous cookies and ambiguous authentication mechanisms', async () => {
    const { services, request, token } = setup();
    expect(await services.context(request({ Cookie: `zhangduo_session=${token}; zhangduo_session=another` }))).toMatchObject({ ok: false });
    expect(await services.context(request({ Authorization: `Bearer ${token}` }))).toMatchObject({ ok: false });
  });

  it('serves /api/workspace with trusted fixture metadata and no token', async () => {
    const { services, request, token } = setup();
    const response = await createApp(services).request(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(workspace);
    expect(body.meta.mode).toBe('fixture');
    expect(JSON.stringify(body)).not.toContain(token);
    expect((await createApp().request('/api/workspace')).status).toBe(503);
  });
});
