import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from './server';
import { context, fixtureServices, request, snapshot } from './test-support';
import type { Services } from '../../contracts/ports';

export function appFor(services = fixtureServices()) { const app = new Hono(); registerRoutes(app, services); return app; }
export function post(app: Hono, body: unknown = request, signal?: AbortSignal) {
  return app.request(new Request('http://localhost/api/retrieval/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }));
}
describe('R01 task queries', () => {
  it('prevents response caching and never opens the unconfigured model send route', async () => {
    const services = fixtureServices(); const app = appFor(services);
    const response = await post(app);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const answer = await app.request('/api/retrieval/answer', { method: 'POST', body: '{}' });
    expect(answer.status).toBe(503); expect((await answer.json()).error.code).toBe('NOT_CONFIGURED');
    expect(services.complete).not.toHaveBeenCalled();
  });
  it('rejects contradictory duplicate condition IDs and overlong condition values', async () => {
    const services = fixtureServices(); const app = appFor(services);
    for (const constraints of [[{ id: 'same', text: 'A', confirmedBy: 'u1' }, { id: 'same', text: 'B', confirmedBy: 'u1' }], [{ id: 'c1', text: 'x'.repeat(1001) }]]) {
      expect((await post(app, { ...request, task: { ...request.task, constraints } })).status).toBe(422);
    }
    expect(services.snapshot).not.toHaveBeenCalled();
  });
  it('uses the trusted workspace, returns pinned originals and never writes or calls AI', async () => {
    const write = vi.fn();
    const services = fixtureServices({ saveDraft: write, appendEvidence: write });
    const response = await post(appFor(services));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.groups.eligible[0].id).toBe('n1');
    expect(body.data.snapshotRevision).toBe('fixture-r1');
    expect(body.data.answer).toBeNull();
    expect(body.meta.mode).toBe('fixture');
    expect(services.complete).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(request.task.constraints).toEqual([]);
  });
  it('rejects empty input and forged workspace or actor confirmations before reading', async () => {
    const services = fixtureServices(); const app = appFor(services);
    expect((await post(app, { ...request, query: '  ' })).status).toBe(422);
    expect((await post(app, { ...request, task: { ...request.task, workspaceId: 'w2' } })).status).toBe(403);
    expect((await post(app, { ...request, task: { ...request.task, constraints: [{ id: 'c1', text: 'ready', confirmedBy: 'other' }] } })).status).toBe(403);
    expect(services.snapshot).not.toHaveBeenCalled();
  });
  it('denies missing scopes and cancels without reading', async () => {
    const services = fixtureServices({ context: async () => ({ ok: true, data: { ...context, scopes: [] } }) });
    expect((await post(appFor(services))).status).toBe(403);
    expect(services.snapshot).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    const allowed = fixtureServices();
    const response = await post(appFor(allowed), request, controller.signal);
    expect(response.status).toBe(409);
    expect((await response.json()).error.dataState).toBe('not_written');
    expect(allowed.snapshot).not.toHaveBeenCalled();
  });
  it('does not leak upstream errors or accept a different workspace snapshot', async () => {
    const leaking = fixtureServices({ snapshot: async () => { throw new Error('Authorization Bearer private-text'); } });
    const response = await post(appFor(leaking));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-text');
    const wrong = fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot([], { workspaceId: 'w2' }) }) });
    expect((await post(appFor(wrong))).status).toBe(403);
  });
  it('returns actionable unconfigured state without pretending live access', async () => {
    const services = fixtureServices({ context: async () => ({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'private config', retryable: false, dataState: 'not_written', nextAction: 'configure_workspace' } }) });
    const response = await appFor(services).request('/api/retrieval/status');
    expect(response.status).toBe(503);
    const body = await response.json(); expect(body.meta.mode).toBe('unconfigured'); expect(body.error.code).toBe('NOT_CONFIGURED');
  });
});
