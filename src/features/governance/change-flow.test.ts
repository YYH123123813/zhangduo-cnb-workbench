import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import type { Approval } from '../../contracts/domain';
import { prepareChanges } from './commit';
import { ChangeFlow, type RequestApi } from './change-flow';
import { ctx, node, snapshot } from './fixtures.test-support';

const response = <T>(data: T): ApiResponse<T> => ({ ok: true, data, meta: { mode: 'fixture', requestId: 'fixture-request', contractVersion: '1.4.0' } });
const failed = (code: 'UNKNOWN_RESULT' | 'CONFLICT' = 'UNKNOWN_RESULT'): ApiResponse<never> => ({ ok: false, error: { code, message: 'Fixture failure', retryable: false, dataState: code === 'CONFLICT' ? 'preserved' : 'unknown', nextAction: 'read_commit' }, meta: { mode: 'fixture', requestId: 'fixture-request', contractVersion: '1.4.0' } });
async function setup() {
  const prepared = await prepareChanges(ctx, snapshot(), { id: 'operation-one', workspaceId: ctx.workspaceId, baseRevision: 'fixture-r1', nodes: [node()], relations: [], withdrawnIds: [], reason: 'Explicit reason' }, true);
  const approval: Approval = { id: 'platform-approval', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'commit_knowledge', objectIds: ['node-1'], contentHash: prepared.changes.contentHash, baseRevision: prepared.changes.baseRevision, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const receipt = { changeSetId: prepared.changes.id, revision: 'fixture-r2', commitUrl: 'https://example.invalid/fixture-r2', indexing: 'pending' as const };
  const result = { state: 'verified' as const, receipt, snapshot: snapshot({ revision: receipt.revision, nodes: [{ ...prepared.changes.nodes[0]!, revision: receipt.revision }] }), snapshotVerified: true as const, retrievalVerified: false as const, historyRewritten: false as const };
  const request = vi.fn<RequestApi>(async (path) => path.endsWith('/revoke') ? response({ revoked: true }) : path.endsWith('/knowledge') ? response(approval) : path.endsWith('/verify') ? response(result) : response({ receipt, snapshotVerified: false }));
  const flow = new ChangeFlow(request);
  flow.prepare(prepared, ctx.actorId);
  return { flow, request, prepared, approval, result };
}

describe('governance knowledge submission lifecycle', () => {
  it('recovers the original registered approval by a read-only ID lookup without re-registering', async () => {
    const s = await setup(); s.request.mockRejectedValueOnce(new Error('Lost registration'));
    await s.flow.approve();
    s.request.mockResolvedValueOnce(response({ changeSetId: s.prepared.changes.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId, status: 'registered', approval: s.approval, absenceIsFinal: false }));
    await s.flow.recoverApproval();
    expect(s.flow.getSnapshot()).toMatchObject({ stage: 'approved', approval: s.approval, prepared: s.prepared });
    expect(s.request.mock.calls[1]).toEqual([`/api/workspace/approvals/knowledge/${s.prepared.changes.id}`]);
    expect(s.request.mock.calls.filter(([path, init]) => path.endsWith('/knowledge') && init?.method === 'POST')).toHaveLength(1);
    await s.flow.commit(); expect(s.flow.getSnapshot().stage).toBe('succeeded');
  });
  it.each(['not_registered', 'unknown', 'wrong_id', 'wrong_actor', 'wrong_hash'])('keeps %s readback locked to the original registration', async (status) => {
    const s = await setup(); s.request.mockRejectedValueOnce(new Error('Lost registration')); await s.flow.approve();
    s.request.mockResolvedValueOnce(response({ changeSetId: status === 'wrong_id' ? 'someone-else' : s.prepared.changes.id, actorId: status === 'wrong_actor' ? 'other-actor' : ctx.actorId, workspaceId: ctx.workspaceId,
      status: status.startsWith('wrong') ? 'registered' : status, approval: status.startsWith('wrong') ? { ...s.approval, ...(status === 'wrong_hash' ? { contentHash: 'wrong' } : {}) } : null, absenceIsFinal: false }));
    await s.flow.recoverApproval();
    expect(s.flow.getSnapshot()).toMatchObject({ stage: 'approval_unknown', prepared: s.prepared, approval: null });
    expect(s.flow.invalidate()).toBe(false); expect(s.request).toHaveBeenCalledTimes(2);
  });
  it.each(['revoked', 'expired'] as const)('allows a fresh preview only after %s is verified for the same approval', async (status) => {
    const s = await setup(); s.request.mockRejectedValueOnce(new Error('Lost registration')); await s.flow.approve();
    const clock = status === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(Date.parse(s.approval.expiresAt) + 1) : null;
    s.request.mockResolvedValueOnce(response({ changeSetId: s.prepared.changes.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId, status, approval: s.approval, absenceIsFinal: false }));
    try { await s.flow.recoverApproval(); } finally { clock?.mockRestore(); }
    expect(s.flow.getSnapshot().stage).toBe('idle'); expect(s.request).toHaveBeenCalledTimes(2);
  });
  it('revokes a recovered approval when the original basis changed before lookup completed', async () => {
    const s = await setup(); s.request.mockRejectedValueOnce(new Error('Lost registration')); await s.flow.approve();
    s.flow.observeRevision('new-head');
    s.request.mockResolvedValueOnce(response({ changeSetId: s.prepared.changes.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId, status: 'registered', approval: s.approval, absenceIsFinal: false }));
    await s.flow.recoverApproval();
    expect(s.flow.getSnapshot().stage).toBe('idle');
    expect(s.request.mock.calls.at(-1)?.[0]).toBe('/api/workspace/approvals/platform-approval/revoke');
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/commit'))).toBe(false);
  });
  it.each(['lost', 'unknown', 'partial', 'malformed', 'foreign'] as const)('locks the original registration after a %s approval response', async (scenario) => {
    const s = await setup();
    s.request.mockImplementationOnce(async () => {
      if (scenario === 'lost') throw new Error('Lost approval reply');
      if (scenario === 'malformed') return response({ id: 'cannot-verify' });
      if (scenario === 'foreign') return response({ ...s.approval, actorId: 'other-actor' });
      const error = failed();
      return !error.ok && scenario === 'partial' ? { ...error, error: { ...error.error, code: 'UPSTREAM', dataState: 'partial' } } : error;
    });
    await s.flow.approve();
    expect(s.flow.getSnapshot()).toMatchObject({ stage: 'approval_unknown', prepared: s.prepared, approval: null, error: { dataState: 'unknown' } });
    expect(s.flow.locked).toBe(true); expect(s.flow.invalidate()).toBe(false); expect(s.flow.finish()).toBe(false);
    s.flow.observeRevision('another-head');
    expect(s.flow.prepare({ ...s.prepared, changes: { ...s.prepared.changes, id: 'new-operation' } }, ctx.actorId)).toBe(false);
    await s.flow.approve(); await s.flow.commit(); await s.flow.verify(); await s.flow.revoke();
    expect(s.request).toHaveBeenCalledOnce();
    expect(s.flow.getSnapshot().prepared?.changes.id).toBe('operation-one');
  });
  it('preserves input but permits a new preview after a definite approval rejection', async () => {
    const s = await setup(); s.request.mockResolvedValueOnce(failed('CONFLICT'));
    await s.flow.approve();
    expect(s.flow.getSnapshot()).toMatchObject({ stage: 'ready', prepared: s.prepared });
    expect(s.flow.invalidate()).toBe(true);
    expect(s.request).toHaveBeenCalledOnce();
  });
  it('revokes an approval that expires before send without writing', async () => {
    const s = await setup(); await s.flow.approve();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(s.approval.expiresAt) + 1);
    try { await s.flow.commit(); } finally { clock.mockRestore(); }
    expect(s.flow.getSnapshot().stage).toBe('idle');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(0);
  });
  it('revokes a late approval if the workspace version changed while registering it', async () => {
    const s = await setup(); let resolve!: (response: ApiResponse<unknown>) => void;
    s.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = s.flow.approve(); s.flow.observeRevision('new-head');
    expect(s.flow.prepare(s.prepared, ctx.actorId)).toBe(false);
    resolve(response(s.approval)); await pending;
    expect(s.flow.getSnapshot().stage).toBe('idle');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/revoke'))).toHaveLength(1);
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(0);
  });
  it('does not treat a readback conflict as proof that an uncertain commit failed', async () => {
    const s = await setup(); await s.flow.approve(); s.request.mockImplementation(async () => failed()); await s.flow.commit();
    s.request.mockImplementation(async () => failed('CONFLICT')); await s.flow.verify();
    expect(s.flow.getSnapshot()).toMatchObject({ stage: 'unknown', prepared: s.prepared });
    expect(s.flow.invalidate()).toBe(false);
  });
  it('uses registered approval, verifies the commit, and can start a subsequent operation', async () => {
    const s = await setup();
    await s.flow.approve(); await s.flow.commit();
    expect(s.flow.getSnapshot().stage).toBe('succeeded');
    expect(s.request.mock.calls.map(([path]) => path)).toEqual(['/api/workspace/approvals/knowledge', '/api/governance/changes/commit', '/api/governance/changes/verify']);
    expect(s.flow.finish()).toBe(true);
    expect(s.flow.prepare({ ...s.prepared, changes: { ...s.prepared.changes, id: 'operation-two' } }, ctx.actorId)).toBe(true);
    expect(s.flow.getSnapshot().prepared?.changes.id).toBe('operation-two');
  });
  it('keeps the same payload and ID after an uncertain result and never resends the write', async () => {
    const s = await setup(); await s.flow.approve();
    s.request.mockImplementation(async () => failed());
    await s.flow.commit();
    expect(s.flow.getSnapshot().stage).toBe('unknown');
    expect(s.flow.invalidate()).toBe(false);
    expect(s.flow.prepare({ ...s.prepared, changes: { ...s.prepared.changes, id: 'new-id' } }, ctx.actorId)).toBe(false);
    await s.flow.commit();
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(1);
    s.request.mockImplementation(async () => response({ state: 'not_recorded', snapshotVerified: false }));
    await s.flow.verify();
    expect(s.flow.getSnapshot()).toMatchObject({ stage: 'unknown', prepared: s.prepared });
    s.request.mockImplementation(async () => response(s.result));
    await s.flow.verify();
    expect(s.flow.getSnapshot().stage).toBe('succeeded');
  });
  it('revokes an existing approval on invalidation, with no commit and no fake cancellation success', async () => {
    const s = await setup(); await s.flow.approve();
    s.request.mockImplementation(async () => failed());
    s.flow.invalidate();
    await vi.waitFor(() => expect(s.flow.getSnapshot().stage).toBe('revoke_unknown'));
    expect(s.flow.prepare(s.prepared, ctx.actorId)).toBe(false);
    s.request.mockImplementation(async () => response({ revoked: true }));
    await s.flow.revoke();
    expect(s.flow.getSnapshot().stage).toBe('idle');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(0);
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/revoke')).map(([path]) => path)).toEqual(Array(2).fill('/api/workspace/approvals/platform-approval/revoke'));
  });
  it('invalidates approved previews when the snapshot version changes', async () => {
    const s = await setup(); await s.flow.approve();
    s.flow.observeRevision('fixture-r2');
    await vi.waitFor(() => expect(s.flow.getSnapshot().stage).toBe('idle'));
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/revoke'))).toBe(true);
  });
  it('preserves prepared input after a definite failure and treats a lost transport reply as unknown', async () => {
    const s = await setup(); await s.flow.approve();
    s.request.mockImplementation(async () => failed('CONFLICT'));
    await s.flow.commit();
    expect(s.flow.getSnapshot()).toMatchObject({ stage: 'failed', prepared: s.prepared });
    const other = await setup(); await other.flow.approve();
    other.request.mockImplementation(async () => { throw new Error('transport interrupted'); });
    await other.flow.commit();
    expect(other.flow.getSnapshot()).toMatchObject({ stage: 'unknown', prepared: other.prepared });
  });
  it('does not send duplicate writes on repeated clicks or use another actor approval', async () => {
    const s = await setup();
    s.request.mockImplementation(async () => response({ ...s.approval, actorId: 'foreign' }));
    await s.flow.approve(); await s.flow.commit();
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/commit'))).toBe(false);
    const other = await setup(); await other.flow.approve();
    let settle!: (value: ApiResponse<unknown>) => void;
    other.request.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const pending = other.flow.commit(); await other.flow.commit();
    expect(other.request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(1);
    settle(failed()); await pending;
    expect(other.flow.getSnapshot().stage).toBe('unknown');
  });
});
