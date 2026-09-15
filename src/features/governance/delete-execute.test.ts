import { describe, expect, it, vi } from 'vitest';
import type { DeleteReport } from '../../contracts/domain';
import { hashDeletePlan } from '../../contracts/hash';
import { ctx, fixture, json, ok, snapshot } from './fixtures.test-support';
import { deleteApproval, deletePlan } from './delete.fixtures.test-support';

describe('G09 approved deletion execution', () => {
  it('delegates a stable approved plan and exposes partial cleanup after a durable retrieval block', async () => {
    const plan = await deletePlan();
    const events: string[] = [];
    let snap = snapshot();
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snap)), previewDelete: vi.fn(async () => ok(plan)),
      executeDelete: vi.fn(async () => {
        snap = snapshot({ revision: 'fixture-r2', excludedIds: ['node-1'] }); events.push('blocked'); events.push('index-failed');
        return ok<DeleteReport>({ planId: plan.id, retrievalBlocked: true, layers: [{ name: 'worktree', state: 'done', detail: 'Removed' }, { name: 'index', state: 'failed', detail: 'Cleanup pending' }] });
      }),
    });
    const data = (await (await app.request('/api/governance/delete/execute', json('POST', { action: 'execute', plan, approval: deleteApproval(plan) }))).json()).data;
    expect(events).toEqual(['blocked', 'index-failed']);
    expect(data).toMatchObject({ state: 'blocked_cleanup_pending', retrievalVerified: true, physicalDeletionComplete: false });
    expect(data.report.layers.find((l: { name: string }) => l.name === 'index').state).toBe('failed');
  });
  it('invalidates consent when platform capabilities or user plan content change', async () => {
    const plan = await deletePlan();
    const changed = await deletePlan({ layers: [{ name: 'worktree', supported: false, reversible: false, consequence: 'Capability revoked' }] });
    const { app, services } = fixture({ previewDelete: vi.fn(async () => ok(changed)) });
    expect((await app.request('/api/governance/delete/execute', json('POST', { action: 'execute', plan, approval: deleteApproval(plan) }))).status).toBe(409);
    const tampered = { ...plan, objectIds: ['node-2'] };
    tampered.contentHash = await hashDeletePlan(tampered);
    expect((await app.request('/api/governance/delete/execute', json('POST', { action: 'execute', plan: tampered, approval: deleteApproval(plan) }))).status).toBe(409);
    expect(services.executeDelete).not.toHaveBeenCalled();
  });
  it('never claims success when the retrieval barrier was not established', async () => {
    const plan = await deletePlan();
    const { app } = fixture({ previewDelete: vi.fn(async () => ok(plan)), executeDelete: vi.fn(async () => ok<DeleteReport>({ planId: plan.id, retrievalBlocked: false, layers: [] })) });
    const response = await app.request('/api/governance/delete/execute', json('POST', { action: 'execute', plan, approval: deleteApproval(plan) }));
    expect(response.status).toBe(502);
    expect((await response.json()).error.dataState).toBe('partial');
  });
  it('cancels, rejects actor mismatch and preserves unknown results without retrying', async () => {
    const plan = await deletePlan();
    const { app, services } = fixture({ previewDelete: vi.fn(async () => ok(plan)), executeDelete: vi.fn(async () => ({ ok: false as const, error: { code: 'UNKNOWN_RESULT' as const, message: 'Read back', retryable: false, dataState: 'unknown' as const, nextAction: 'read_back' } })) });
    expect((await app.request('/api/governance/delete/execute', json('POST', { action: 'cancel' }))).status).toBe(200);
    expect(services.previewDelete).not.toHaveBeenCalled();
    expect((await app.request('/api/governance/delete/execute', json('POST', { action: 'execute', plan, approval: { ...deleteApproval(plan), actorId: `${ctx.actorId}-other` } }))).status).toBe(403);
    const result = await app.request('/api/governance/delete/execute', json('POST', { action: 'execute', plan, approval: deleteApproval(plan) }));
    expect(result.status).toBe(409);
    expect((await result.json()).error.dataState).toBe('unknown');
    expect(services.executeDelete).toHaveBeenCalledTimes(1);
  });
});
