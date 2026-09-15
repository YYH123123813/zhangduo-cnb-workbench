import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, json, ok } from './fixtures.test-support';
import { deletePlan } from './delete.fixtures.test-support';

const input = { action: 'preview', objectIds: ['node-1'], baseRevision: 'fixture-r1' };
describe('G08 layered deletion preview', () => {
  it('shows all seven layers and distinguishes unsupported from missing capability', async () => {
    const plan = await deletePlan();
    const { app, services } = fixture({ previewDelete: vi.fn(async () => ok(plan)) });
    const data = (await (await app.request('/api/governance/delete/preview', json('POST', input))).json()).data;
    expect(data.plan).toEqual(plan);
    expect(data.layers).toHaveLength(7);
    expect(data.layers.find((l: { name: string }) => l.name === 'git_history').capability).toBe('unsupported');
    expect(data.layers.find((l: { name: string }) => l.name === 'backup').capability).toBe('unknown');
    expect(data.physicalDeletionComplete).toBe(false);
    expect(services.executeDelete).not.toHaveBeenCalled();
  });
  it('rejects tampered, foreign and expanded platform plans', async () => {
    for (const plan of [{ ...await deletePlan(), contentHash: 'wrong' }, await deletePlan({ workspaceId: 'foreign' }), await deletePlan({ objectIds: ['node-1', 'node-2'] })]) {
      const { app } = fixture({ previewDelete: vi.fn(async () => ok(plan)) });
      const response = await app.request('/api/governance/delete/preview', json('POST', input));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
  it('does not call the platform for cancellation, denied scope or a stale basis', async () => {
    const { app, services } = fixture();
    expect((await app.request('/api/governance/delete/preview', json('POST', { action: 'cancel' }))).status).toBe(200);
    expect((await app.request('/api/governance/delete/preview', json('POST', { ...input, baseRevision: 'old' }))).status).toBe(409);
    expect(services.previewDelete).not.toHaveBeenCalled();
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/delete/preview', json('POST', input))).status).toBe(403);
  });
});
