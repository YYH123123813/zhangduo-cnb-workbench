import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { assertClientEnvironment, assertClientModule } from '../../tools/client-boundary';

describe('W03 HTTP and browser build boundaries', () => {
  it('denies cross-origin unsafe requests before feature handlers', async () => {
    const response = await createApp().request('/api/capture/conversations', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(403);
    expect((await response.json()).error.dataState).toBe('not_written');
  });

  it('does not cache private API responses and marks them nosniff', async () => {
    const response = await createApp().request('/api/workspace');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('rejects oversized requests before reading private payloads into a feature', async () => {
    const response = await createApp().request('/api/capture/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2000001' }, body: '{}' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'VALIDATION', dataState: 'not_written' });
  });

  it('rejects server implementation imports at any depth of a client graph', () => {
    expect(() => assertClientModule('/project/src/app/App.tsx')).not.toThrow();
    expect(() => assertClientModule('/project/src/contracts/hash.ts')).not.toThrow();
    for (const path of ['/project/src/platform/cnb/client.ts', '/project/src/server/app.ts', '/project/src/features/capture/server.ts']) expect(() => assertClientModule(path)).toThrow();
  });

  it('blocks exposed credentials without printing their value', () => {
    expect(() => assertClientEnvironment({ VITE_CNB_TOKEN: 'private-secret' })).toThrow('Client-exposed secret');
    try { assertClientEnvironment({ VITE_MODEL_API_KEY: 'private-secret' }); } catch (error) { expect(String(error)).not.toContain('private-secret'); }
  });
});
