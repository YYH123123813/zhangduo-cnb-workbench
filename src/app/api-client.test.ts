import { afterEach, expect, it, vi } from 'vitest';
import { apiRequest, bindIntelligenceSession } from './api-client';
import { SESSION_BINDING_HEADER, workspaceSessionBinding, type WorkspaceSession } from '../contracts/session';
import { CONTRACT_VERSION } from '../contracts/domain';

const session: WorkspaceSession = { actorId: 'synthetic-a', workspace: { id: 'workspace-a', slug: 'fixture/a', mode: 'fixture', visibility: 'private' }, scopes: ['workspace:read'] };
const cleanups: (() => void)[] = [];
const bind = (value = session) => { const cleanup = bindIntelligenceSession(value); cleanups.push(cleanup); return cleanup; };
const envelope = () => ({ ok: true, data: { synthetic: true }, meta: { requestId: 'fixture-api', mode: 'fixture', contractVersion: CONTRACT_VERSION } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); });

it('does not send an intelligence request before a page has a verified identity', async () => {
  const transport = vi.fn(async () => Response.json({ ok: true, data: { private: true }, meta: {} }));
  vi.stubGlobal('fetch', transport);
  expect(await apiRequest('/api/intelligence')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'not_written' } });
  expect(transport).not.toHaveBeenCalled();
});

it('pins the page fingerprint, preserves Headers inputs and does not expose credentials', async () => {
  bind(); const fingerprint = await workspaceSessionBinding(session);
  const transport = vi.fn<typeof fetch>(async (_path, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get(SESSION_BINDING_HEADER)).toBe(fingerprint);
    expect(headers.get('X-Synthetic')).toBe('retained');
    expect(headers.has('Cookie')).toBe(false); expect(headers.has('Authorization')).toBe(false);
    return Response.json(envelope(), { headers: { [SESSION_BINDING_HEADER]: fingerprint } });
  });
  vi.stubGlobal('fetch', transport);
  expect(await apiRequest('/api/intelligence', { headers: new Headers({ 'X-Synthetic': 'retained', [SESSION_BINDING_HEADER]: 'forged' }) })).toMatchObject({ ok: true });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('cancels a request when the page changes before asynchronous fingerprinting finishes', async () => {
  bind(); const transport = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', transport);
  const pending = apiRequest('/api/intelligence'); bind({ ...session, actorId: 'synthetic-b' });
  expect(await pending).toMatchObject({ ok: false, error: { dataState: 'not_written' } });
  expect(transport).not.toHaveBeenCalled();
});

it.each(['GET', 'POST'])('discards a late %s response after identity replacement even if transport ignores abort', async (method) => {
  bind(); const fingerprint = await workspaceSessionBinding(session), response = deferred<Response>(), entered = deferred<void>();
  const transport = vi.fn<typeof fetch>(async () => { entered.resolve(); return response.promise; }); vi.stubGlobal('fetch', transport);
  const pending = apiRequest('/api/intelligence', { method }); await entered.promise;
  bind({ ...session, actorId: 'synthetic-b' });
  const late = Response.json(envelope(), { headers: { [SESSION_BINDING_HEADER]: fingerprint } }), read = vi.spyOn(late, 'json');
  response.resolve(late);
  expect(await pending).toMatchObject({ ok: false, error: { dataState: method === 'POST' ? 'unknown' : 'preserved' } });
  expect(read).not.toHaveBeenCalled();
});

it('checks identity again after asynchronously reading a response body', async () => {
  bind(); const fingerprint = await workspaceSessionBinding(session), parsed = deferred<unknown>(), entered = deferred<void>();
  const response = Response.json(envelope(), { headers: { [SESSION_BINDING_HEADER]: fingerprint } });
  vi.spyOn(response, 'json').mockImplementation(() => { entered.resolve(); return parsed.promise; });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const pending = apiRequest('/api/intelligence'); await entered.promise;
  bind({ ...session, actorId: 'synthetic-b' }); parsed.resolve(envelope());
  expect(await pending).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
});

it('does not let an old cleanup erase the newly mounted page binding', async () => {
  const oldCleanup = bind(); const next = { ...session, actorId: 'synthetic-b' };
  bind(next); oldCleanup(); const fingerprint = await workspaceSessionBinding(next);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope(), { headers: { [SESSION_BINDING_HEADER]: fingerprint } })));
  expect(await apiRequest('/api/intelligence')).toMatchObject({ ok: true });
});

it('fails closed against a missing or wrong backend echo without reading private data', async () => {
  bind();
  for (const value of [null, '0'.repeat(64)]) {
    const response = Response.json(envelope(), { headers: value ? { [SESSION_BINDING_HEADER]: value } : {} }), read = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn(async () => response));
    expect(await apiRequest('/api/intelligence')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(read).not.toHaveBeenCalled();
  }
});

it('leaves non-intelligence APIs on their existing transport path', async () => {
  const transport = vi.fn<typeof fetch>(async (_path, init) => {
    expect(new Headers(init?.headers).has(SESSION_BINDING_HEADER)).toBe(false);
    return Response.json(envelope());
  });
  vi.stubGlobal('fetch', transport);
  expect(await apiRequest('/api/workspace/session')).toMatchObject({ ok: true });
});
