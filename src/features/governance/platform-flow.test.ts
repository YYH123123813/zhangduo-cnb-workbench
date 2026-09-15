import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import type { OperationJournal } from '../../platform/journal';
import { ChangeFlow, type RequestApi } from './change-flow';
import type { Relation, Settings } from '../../contracts/domain';
import type { ChangePreview } from './revisions';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup() {
  const s = await platformFixture(); journals.push(s.journal);
  let app = createApp(s.services);
  const request: RequestApi = async (path, init) => (await app.request(path, { ...init, headers: s.headers })).json();
  const send = async (path: string, body?: unknown, method = 'POST') => {
    const result = await request(path, body === undefined ? undefined : { method, body: JSON.stringify(body) });
    return result;
  };
  const prepare = async (operationId: string, patch: object, revision = s.base) => {
    const preview = await send('/api/governance/nodes/k1', { action: 'preview', operationId, baseRevision: revision, nodeRevision: revision, reason: 'Fixture human revision', patch }, 'PATCH');
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error('Preview failed');
    const prepared = await send('/api/governance/changes/prepare', { action: 'prepare', changes: (preview.data as { changes: unknown }).changes });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) throw new Error('Preparation failed');
    const flow = new ChangeFlow(request);
    flow.prepare(prepared.data as Parameters<ChangeFlow['prepare']>[0], s.ctx.actorId);
    return flow;
  };
  return { ...s, send, prepare, request, rebuild: () => { app = createApp(createServices(s.options)); } };
}

describe('governance UI protocol with shared platform adapters and controlled transports', () => {
  it('withdraws a formal relation after an endpoint revision, without promoting its stale evidence', async () => {
    const s = await setup(); s.initial.nodes.push({ ...s.node, id: 'k2' });
    const edge: Relation = { id: 'e1', workspaceId: s.ctx.workspaceId, source: { workspaceId: s.ctx.workspaceId, objectId: 'k2', revision: '@snapshot' }, target: { workspaceId: s.ctx.workspaceId, objectId: 'k1', revision: '@snapshot' }, type: 'depends_on', rationale: 'Synthetic premise', evidenceIds: ['source1'], state: 'confirmed', proposedBy: s.ctx.actorId, confirmedBy: s.ctx.actorId, confirmedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
    s.documents.set(s.base, { ...s.initial, relations: [edge] });
    const edit = await s.prepare('changed-endpoint', { humanStatement: 'Different premise' }); await edit.approve(); await edit.commit();
    expect(edit.getSnapshot().stage, JSON.stringify(edit.getSnapshot())).toBe('succeeded');
    const revision = edit.getSnapshot().result!.receipt.revision;
    const preview = await s.send('/api/governance/relations/e1', { action: 'preview', operationId: 'withdraw-stale-edge', baseRevision: revision, reason: 'Withdraw outdated dependency', patch: { state: 'withdrawn' } }, 'PATCH');
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    const prepared = await s.send('/api/governance/changes/prepare', { action: 'prepare', changes: (preview.data as ChangePreview).changes });
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    const flow = new ChangeFlow(s.request); flow.prepare(prepared.data as Parameters<ChangeFlow['prepare']>[0], s.ctx.actorId);
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
    expect(flow.getSnapshot().result!.snapshot.excludedIds).toContain('e1');
    expect(flow.getSnapshot().result!.snapshot.relations[0]!.state).toBe('withdrawn');
  });
  it('registers real fixture approval, commits and reads a new version, then handles the next operation', async () => {
    const s = await setup();
    const first = await s.prepare('revision-one', { humanStatement: 'New explicit fixture statement' });
    await first.approve(); await first.commit();
    expect(first.getSnapshot().stage, JSON.stringify(first.getSnapshot())).toBe('succeeded');
    const revision = first.getSnapshot().result!.receipt.revision;
    expect(first.getSnapshot().result!.snapshot.nodes[0]!.humanStatement).toBe('New explicit fixture statement');
    expect(first.finish()).toBe(true);
    const second = await s.prepare('revision-two', { boundaries: ['Second edit boundary'] }, revision);
    await second.approve(); await second.commit();
    expect(second.getSnapshot().stage, JSON.stringify(second.getSnapshot())).toBe('succeeded');
    expect(s.git.publish).toHaveBeenCalledTimes(2);
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { nodes: [expect.objectContaining({ humanStatement: 'Original fixture conclusion' })] } });
  });
  it('recovers a lost publication reply through rebuilt Services with the same operation and one publication', async () => {
    const s = await setup(); const original = vi.mocked(s.git.publish).getMockImplementation()!;
    vi.mocked(s.git.publish).mockImplementation(async (input) => { await original(input); return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Lost fixture reply', retryable: false, dataState: 'unknown', nextAction: 'read_commit' } }; });
    const flow = await s.prepare('lost-reply', { humanStatement: 'Written once' });
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('unknown');
    s.rebuild(); await flow.verify();
    expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
    expect(s.git.publish).toHaveBeenCalledOnce();
  });
  it('rejects a revoked approval and restores a Git-withdrawn node from a trusted historical snapshot', async () => {
    const s = await setup(); const rejected = await s.prepare('revoked', { humanStatement: 'Must not publish' });
    await rejected.approve();
    await s.services.revokeApproval!(s.ctx, rejected.getSnapshot().approval!.id);
    await rejected.commit();
    expect(rejected.getSnapshot().stage).toBe('failed'); expect(s.git.publish).not.toHaveBeenCalled();
    const withdrawal = await s.prepare('withdrawal', { lifecycle: 'withdrawn' });
    await withdrawal.approve(); await withdrawal.commit();
    expect(withdrawal.getSnapshot().stage, JSON.stringify(withdrawal.getSnapshot())).toBe('succeeded');
    const revision = withdrawal.getSnapshot().result!.receipt.revision;
    const restored = await s.send('/api/governance/rollback', { action: 'preview', operationId: 'historical-restore', nodeId: 'k1', baseRevision: revision, historicalRevision: s.base, reason: 'Restore reviewed historical content' });
    expect(restored.ok, JSON.stringify(restored)).toBe(true); if (!restored.ok) return;
    const value = restored.data as { changes: unknown; restoration: unknown };
    const prepared = await s.send('/api/governance/changes/prepare', { action: 'prepare', changes: value.changes, restoration: value.restoration });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true); if (!prepared.ok) return;
    const flow = new ChangeFlow(s.request); flow.prepare(prepared.data as Parameters<ChangeFlow['prepare']>[0], s.ctx.actorId);
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
    expect(flow.getSnapshot().result!.snapshot.excludedIds).not.toContain('k1');
    expect(flow.getSnapshot().result!.receipt.indexing).toBe('pending');
    expect(await s.services.snapshot(s.ctx, revision)).toMatchObject({ ok: true, data: { excludedIds: ['k1'] } });
  });
  it('uses independent settings versions and delegates repeat approval idempotency to platform CAS', async () => {
    const s = await setup();
    const current = await s.send('/api/governance/settings');
    expect(current.ok).toBe(true); if (!current.ok) return;
    const initial = current.data as { settings: Settings; currentHash: string; settingsRevision: number };
    expect(initial.settingsRevision).toBe(0);
    const preview = await s.send('/api/governance/settings', { action: 'preview', baseRevision: s.base, expectedSettingsHash: initial.currentHash, expectedSettingsRevision: 0, patch: { aiAnswer: true } }, 'PATCH');
    expect(preview.ok, JSON.stringify(preview)).toBe(true); if (!preview.ok) return;
    const p = preview.data as { settings: Settings; expectedSettingsHash: string; expectedSettingsRevision: number; baseRevision: string };
    const approval = await s.send('/api/workspace/approvals/governance', { purpose: 'settings', settings: p.settings, baseRevision: p.baseRevision, expectedSettingsHash: p.expectedSettingsHash, expectedSettingsRevision: p.expectedSettingsRevision, confirmed: true });
    expect(approval.ok).toBe(true); if (!approval.ok) return;
    for (let i = 0; i < 2; i++) {
      const saved = await s.send('/api/governance/settings', { action: 'execute', settings: p.settings, baseRevision: p.baseRevision, expectedSettingsHash: p.expectedSettingsHash, expectedSettingsRevision: p.expectedSettingsRevision, approval: approval.data }, 'PATCH');
      expect(saved).toMatchObject({ ok: true, data: { verified: true, settingsRevision: 1, modelEnforcementVerified: false } });
    }
  });
  it('accepts 1.5.0 deletion plans, reads each layer, and never restores or exports a deleted object', async () => {
    const s = await setup();
    const preview = await s.send('/api/governance/delete/preview', { action: 'preview', objectIds: ['k1'], baseRevision: s.base });
    expect(preview.ok, JSON.stringify(preview)).toBe(true); if (!preview.ok) return;
    const plan = (preview.data as { plan: { id: string } }).plan;
    const approval = await s.send('/api/workspace/approvals/governance', { purpose: 'delete', planId: plan.id, confirmed: true });
    expect(approval.ok).toBe(true); if (!approval.ok) return;
    const executed = await s.send('/api/governance/delete/execute', { action: 'execute', plan, approval: approval.data });
    expect(executed, JSON.stringify(executed)).toMatchObject({ ok: true, data: { retrievalVerified: true, physicalDeletionComplete: false } });
    s.rebuild();
    const verified = await s.send('/api/governance/delete/verify', { action: 'verify', objectIds: ['k1'], planId: plan.id });
    expect(verified).toMatchObject({ ok: true, data: { reportAvailable: true, retrievalBlocked: true, physicalDeletionComplete: false, layers: expect.arrayContaining([expect.objectContaining({ name: 'git_history', state: 'unknown' })]) } });
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { nodes: [], excludedIds: ['k1'] } });
    expect((await s.send('/api/governance/rollback', { action: 'preview', operationId: 'no-bypass', nodeId: 'k1', baseRevision: s.base, historicalRevision: s.base, reason: 'Must remain blocked' })).ok).toBe(false);
    expect((await s.send('/api/governance/export', { action: 'preview', objectIds: ['k1'], baseRevision: s.base })).ok).toBe(false);
    expect(s.git.publish).not.toHaveBeenCalled();
  });
});
