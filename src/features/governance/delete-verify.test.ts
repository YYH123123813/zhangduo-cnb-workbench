import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, json, ok, relation, snapshot } from './fixtures.test-support';
import { deletePlan } from './delete.fixtures.test-support';

describe('G10 deletion and withdrawal readback', () => {
  it('does not substitute another plan for the original ID even with the same selected objects', async () => {
    const other = await deletePlan({ id: 'other-plan' });
    const { app } = fixture({ readDeletePlan: vi.fn(async () => ok(other)), readDeleteReport: vi.fn(async () => ok({ planId: other.id, retrievalBlocked: true, layers: [] })), snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['node-1'] }))) });
    const response = await app.request('/api/governance/delete/verify', json('POST', { action: 'verify', objectIds: ['node-1'], planId: 'original-plan' }));
    expect(response.status).toBe(409); expect((await response.json()).error.dataState).toBe('unknown');
  });
  it('verifies the current exclusion barrier without claiming physical erasure', async () => {
    const { app, services } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ revision: 'fixture-r2', excludedIds: ['node-1'] }))) });
    const data = (await (await app.request('/api/governance/delete/verify', json('POST', { action: 'verify', objectIds: ['node-1'], planId: 'plan-1' }))).json()).data;
    expect(data).toMatchObject({ retrievalBlocked: true, physicalDeletionComplete: false, reportAvailable: false, snapshotRevision: 'fixture-r2' });
    expect(services.executeDelete).not.toHaveBeenCalled();
    expect(services.semanticQuery).not.toHaveBeenCalled();
  });
  it('recognizes a withdrawn relation and does not treat missing objects as a durable block', async () => {
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ relations: [relation('edge-1', 'node-2', 'node-1', { state: 'withdrawn' })] }))) });
    const data = (await (await app.request('/api/governance/delete/verify', json('POST', { action: 'verify', objectIds: ['edge-1', 'missing'] }))).json()).data;
    expect(data.objects).toEqual([{ id: 'edge-1', state: 'withdrawn', blocked: true }, { id: 'missing', state: 'not_present', blocked: false }]);
    expect(data.retrievalBlocked).toBe(false);
  });
  it('rejects client-provided deletion evidence and cancels or denies unauthorized inspection', async () => {
    const { app, services } = fixture();
    expect((await app.request('/api/governance/delete/verify', json('POST', { action: 'verify', objectIds: ['node-1'], report: { allDeleted: true } }))).status).toBe(422);
    await app.request('/api/governance/delete/verify', json('POST', { action: 'cancel' }));
    expect(services.snapshot).not.toHaveBeenCalled();
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/delete/verify', json('POST', { action: 'verify', objectIds: ['node-1'] }))).status).toBe(403);
  });
});
