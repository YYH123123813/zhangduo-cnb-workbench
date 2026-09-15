import { describe, expect, it, vi } from 'vitest';
import type { Approval, ChangeSet } from '../../contracts/domain';
import { hashChangeSet } from '../../contracts/hash';
import { ctx, fixture, json, node, ok, snapshot } from './fixtures.test-support';

async function submitted() {
  const changes: ChangeSet = { id: 'revision-readback', workspaceId: ctx.workspaceId, baseRevision: 'fixture-r1', nodes: [node('node-1', { humanStatement: 'Revised statement', authorship: 'human_edited', evidenceStatus: 'unverified' })], relations: [], withdrawnIds: [], reason: 'Revise the statement', contentHash: 'pending' };
  changes.contentHash = await hashChangeSet(changes);
  const approval: Approval = { id: 'registered-by-fixture', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'commit_knowledge', contentHash: changes.contentHash, objectIds: ['node-1'], baseRevision: changes.baseRevision, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const receipt = { changeSetId: changes.id, revision: 'fixture-r2', commitUrl: 'https://example.invalid/fixture-r2', indexing: 'pending' as const };
  const committed = snapshot({ revision: receipt.revision, nodes: [{ ...changes.nodes[0]!, revision: receipt.revision }] });
  return { changes, approval, receipt, committed };
}

describe('G01 commit recovery and fixed-version readback', () => {
  it('advertises the knowledge approval port without claiming that approval exists', async () => {
    const s = await submitted();
    const { app, services } = fixture({ approveKnowledge: vi.fn(async () => ok(s.approval)) });
    const { contentHash: _, ...changes } = s.changes;
    const response = await (await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes }))).json();
    expect(response.data).toMatchObject({ approvalStatus: 'required', executionEnabled: false });
    expect(services.approveKnowledge).not.toHaveBeenCalled();
  });
  it('delegates an existing operation to platform idempotency before rejecting a stale base', async () => {
    const s = await submitted();
    const { app, services } = fixture({ commit: vi.fn(async () => ok(s.receipt)), readCommit: vi.fn(async () => ok(s.receipt)), snapshot: vi.fn(async (_ctx, revision) => ok(revision ? s.committed : snapshot({ revision: 'fixture-r3' }))) });
    const response = await (await app.request('/api/governance/changes/commit', json('POST', { action: 'commit', changes: s.changes, approval: s.approval }))).json();
    expect(response).toMatchObject({ ok: true, data: { receipt: s.receipt, snapshotVerified: true, retrievalVerified: false } });
    expect(services.commit).toHaveBeenCalledWith(ctx, s.changes, s.approval);
    expect(services.snapshot).toHaveBeenCalledWith(ctx, 'fixture-r2');
  });
  it('reads a fixed committed snapshot and never uses HEAD as proof of its content', async () => {
    const s = await submitted();
    const { app, services } = fixture({ readCommit: vi.fn(async () => ok(s.receipt)), snapshot: vi.fn(async (_ctx, revision) => ok(revision ? s.committed : snapshot())) });
    const response = await (await app.request('/api/governance/changes/verify', json('POST', { action: 'verify', changes: s.changes }))).json();
    expect(response).toMatchObject({ ok: true, data: { state: 'verified', snapshotVerified: true, snapshot: s.committed } });
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('does not treat an absent operation or a mismatched object as successful verification', async () => {
    const s = await submitted();
    const missing = fixture({ readCommit: vi.fn(async () => ok(null)) });
    const response = await (await missing.app.request('/api/governance/changes/verify', json('POST', { action: 'verify', changes: s.changes }))).json();
    expect(response).toMatchObject({ ok: true, data: { state: 'not_recorded', snapshotVerified: false } });
    const wrong = fixture({ readCommit: vi.fn(async () => ok(s.receipt)), snapshot: vi.fn(async () => ok({ ...s.committed, nodes: [node('node-1', { revision: 'fixture-r2' })] })) });
    const mismatch = await wrong.app.request('/api/governance/changes/verify', json('POST', { action: 'verify', changes: s.changes }));
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error.dataState).toBe('unknown');
  });
  it('rejects tampering and cancels readback without accessing platform data', async () => {
    const s = await submitted();
    const { app, services } = fixture({ readCommit: vi.fn(async () => ok(s.receipt)) });
    expect((await app.request('/api/governance/changes/verify', json('POST', { action: 'verify', changes: { ...s.changes, reason: 'Changed after hashing' } }))).status).toBe(409);
    expect((await app.request('/api/governance/changes/verify', json('POST', { action: 'cancel' }))).status).toBe(200);
    expect(services.readCommit).not.toHaveBeenCalled();
  });
  it('keeps a thrown write result unknown and never automatically repeats the commit', async () => {
    const s = await submitted();
    const { app, services } = fixture({ commit: vi.fn(async () => { throw new Error('private transport details'); }) });
    const response = await (await app.request('/api/governance/changes/commit', json('POST', { action: 'commit', changes: s.changes, approval: s.approval }))).json();
    expect(response).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', retryable: false } });
    expect(JSON.stringify(response)).not.toContain('private transport');
    expect(services.commit).toHaveBeenCalledOnce();
  });
});
