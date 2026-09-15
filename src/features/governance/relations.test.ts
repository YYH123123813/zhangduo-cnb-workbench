import { describe, expect, it, vi } from 'vitest';
import type { Approval, ChangeSet } from '../../contracts/domain';
import { hashChangeSet } from '../../contracts/hash';
import { ctx, fixture, json, node, now, ok, relation, snapshot } from './fixtures.test-support';

export function withdrawal(): ChangeSet {
  return { id: 'withdraw-1', workspaceId: ctx.workspaceId, baseRevision: 'fixture-r1', nodes: [], relations: [relation('edge-1', 'node-2', 'node-1', { state: 'withdrawn' })], withdrawnIds: ['edge-1'], reason: 'Incorrect prerequisite', contentHash: 'fixture-port-validated-hash' };
}
export function approval(changes = withdrawal(), purpose: Approval['purpose'] = 'commit_knowledge'): Approval {
  return { id: 'approval-1', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose, objectIds: [...new Set([...changes.nodes, ...changes.relations].map((item) => item.id).concat(changes.withdrawnIds))], contentHash: changes.contentHash, baseRevision: changes.baseRevision, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
}
const edit = { action: 'preview', operationId: 'edit-edge', baseRevision: 'fixture-r1', reason: 'Correct direction', patch: { reverse: true, rationale: 'Updated evidence', evidenceIds: ['source-1'] } };

describe('G03 relation editing and commit boundary', () => {
  it('retargets a relation using the current authorized target version, leaving the old edge unchanged', async () => {
    const current = snapshot({ nodes: [node(), node('node-2'), node('node-3', { revision: 'target-current' })] });
    const { app, services } = fixture({ snapshot: vi.fn(async () => ok(current)) });
    const response = await app.request('/api/governance/relations/edge-1', json('PATCH', { ...edit, patch: { targetId: 'node-3', rationale: 'Reviewed replacement prerequisite', evidenceIds: ['source-1'] } }));
    expect(response.status).toBe(200);
    const value = (await response.json()).data;
    expect(value.changes.relations[0]).toMatchObject({ source: { objectId: 'node-2' }, target: { workspaceId: ctx.workspaceId, objectId: 'node-3', revision: 'target-current' }, state: 'proposed' });
    expect(value.before.relations[0]).toEqual(current.relations[0]); expect(current.relations[0]!.target.objectId).toBe('node-1');
    expect((await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes: value.changes }))).status).toBe(200);
    expect(services.commit).not.toHaveBeenCalled();
  });
  it.each(['missing', 'self', 'blocked', 'unconfirmed', 'unknown_evidence'])('rejects %s relation targets or support before formal confirmation', async (scenario) => {
    const current = snapshot({ nodes: [node(), node('node-2'), node('node-3', { ...(scenario === 'unconfirmed' ? { confirmation: 'draft', confirmedBy: undefined, confirmedAt: undefined } : {}) })], excludedIds: scenario === 'blocked' ? ['node-3'] : [] });
    const { app, services } = fixture({ snapshot: vi.fn(async () => ok(current)) });
    const response = await app.request('/api/governance/relations/edge-1', json('PATCH', { ...edit, patch: { targetId: scenario === 'self' ? 'node-2' : scenario === 'missing' ? 'not-in-workspace' : 'node-3', rationale: 'Explicit reason', evidenceIds: [scenario === 'unknown_evidence' ? 'forged-evidence' : 'source-1'] } }));
    expect(response.status).toBeGreaterThanOrEqual(400); expect(services.commit).not.toHaveBeenCalled();
  });
  it('rejects unsupported evidence even when a client bypasses the relation preview', async () => {
    const { app } = fixture(); const changes = { ...withdrawal(), relations: [relation('edge-1', 'node-2', 'node-1', { evidenceIds: ['not-an-endpoint-source'] })], withdrawnIds: [] };
    const { contentHash: _hash, ...unhashed } = changes;
    const response = await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes: unhashed }));
    expect(response.status).toBe(422);
  });
  it('previews rejection of a formal relation as an explicit withdrawal accepted by the commit contract', async () => {
    const { app } = fixture();
    const response = await (await app.request('/api/governance/relations/edge-1', json('PATCH', { ...edit, patch: { state: 'rejected' } }))).json();
    expect(response.data.changes.relations[0].state).toBe('withdrawn');
    expect(response.data.changes.withdrawnIds).toEqual(['edge-1']);
    expect(response.data.warnings.join(' ')).toContain('撤回');
  });
  it('previews changed direction and evidence without overwriting the old edge', async () => {
    const { app, services } = fixture();
    const result = await (await app.request('/api/governance/relations/edge-1', json('PATCH', edit))).json();
    expect(result.data.before.relations[0]).toEqual(relation());
    expect(result.data.changes.relations[0]).toMatchObject({ source: { objectId: 'node-1' }, target: { objectId: 'node-2' }, state: 'proposed' });
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('validates relation evidence and retains withdrawn IDs in the preview', async () => {
    const { app } = fixture();
    const invalid = await app.request('/api/governance/relations/edge-1', json('PATCH', { ...edit, patch: { evidenceIds: [] } }));
    expect(invalid.status).toBe(422);
    const result = await (await app.request('/api/governance/relations/edge-1', json('PATCH', { ...edit, patch: { state: 'withdrawn' } }))).json();
    expect(result.data.changes.withdrawnIds).toEqual(['edge-1']);
  });
  it('delegates an approved, version-bound changeset to the single commit port', async () => {
    const commit = vi.fn(async () => ok({ changeSetId: 'withdraw-1', revision: 'fixture-r2', commitUrl: 'https://example.invalid/fixture-r2', indexing: 'pending' as const }));
    const { app } = fixture({ commit });
    const changes = withdrawal();
    changes.contentHash = await hashChangeSet(changes);
    const consent = approval(changes);
    const result = await (await app.request('/api/governance/changes/commit', json('POST', { action: 'commit', changes, approval: consent }))).json();
    expect(commit).toHaveBeenCalledWith(ctx, changes, consent);
    expect(result.data.receipt.indexing).toBe('pending');
    expect(result.data.retrievalVerified).toBe(false);
  });
  it('rejects mismatched, expired, missing or foreign consent before writing', async () => {
    const { app, services } = fixture();
    const consent = approval();
    for (const bad of [undefined, { ...consent, contentHash: 'other' }, { ...consent, objectIds: ['node-1'] }, { ...consent, expiresAt: now }, { ...consent, actorId: 'another-actor' }]) {
      const response = await app.request('/api/governance/changes/commit', json('POST', { action: 'commit', changes: withdrawal(), approval: bad }));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('preserves UNKNOWN_RESULT and reuses operation identity instead of automatic retries', async () => {
    const commit = vi.fn(async () => ({ ok: false as const, error: { code: 'UNKNOWN_RESULT' as const, message: 'Read back required', retryable: false, dataState: 'unknown' as const, nextAction: 'read_back' } }));
    const { app } = fixture({ commit });
    const input = { action: 'commit', changes: withdrawal(), approval: approval() };
    input.changes.contentHash = await hashChangeSet(input.changes);
    input.approval = approval(input.changes);
    for (let i = 0; i < 2; i++) {
      const response = await app.request('/api/governance/changes/commit', json('POST', input));
      expect(response.status).toBe(409);
      expect((await response.json()).error.dataState).toBe('unknown');
    }
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]).toEqual(commit.mock.calls[1]);
  });
  it('cancels without a commit and rejects changed HEAD', async () => {
    const { app, services } = fixture();
    await app.request('/api/governance/changes/commit', json('POST', { action: 'cancel' }));
    expect(services.commit).not.toHaveBeenCalled();
    const changes = { ...withdrawal(), baseRevision: 'old' };
    expect((await app.request('/api/governance/changes/commit', json('POST', { action: 'commit', changes, approval: approval(changes) }))).status).toBe(409);
  });
  it('rejects a payload changed after its content hash was approved', async () => {
    const { app, services } = fixture();
    const changes = withdrawal();
    changes.contentHash = await hashChangeSet(changes);
    const consent = approval(changes);
    changes.reason = 'Tampered reason';
    const response = await app.request('/api/governance/changes/commit', json('POST', { action: 'commit', changes, approval: consent }));
    expect(response.status).toBe(409);
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('prepares a canonical consent payload but does not mint a registered approval', async () => {
    const { app, services } = fixture();
    const { contentHash: _hash, ...changes } = withdrawal();
    const result = await (await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes }))).json();
    expect(result.data.changes.contentHash).toBe(await hashChangeSet(result.data.changes));
    expect(result.data.approvalStatus).toBe('unavailable');
    expect(result.data.approval).toBeUndefined();
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('does not promote a proposed edge without evidence when preparing consent', async () => {
    const { app } = fixture();
    const { contentHash: _hash, ...changes } = withdrawal();
    changes.relations = [relation('edge-1', 'node-2', 'node-1', { state: 'proposed', evidenceIds: [], confirmedBy: undefined, confirmedAt: undefined })];
    changes.withdrawnIds = [];
    const response = await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes }));
    expect(response.status).toBe(422);
  });
});
