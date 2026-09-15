import { describe, expect, it, vi } from 'vitest';
import { CONTRACT_VERSION, type Approval } from '../../contracts/domain';
import type { ApiResponse } from '../../contracts/api';
import { contentHash, hashConversation } from '../../contracts/hash';
import { conversation, ctx } from './fixtures.test-support';
import type { ExtractionOperation } from '../../contracts/extraction';
import { discoverModelOperations, readDiscoveredModelRecovery, readModelRecovery } from './model-recovery';

async function setup() {
  const source = { ...conversation, contentHash: await hashConversation(conversation) };
  const approval: Approval = { id: 'original-model-operation', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'model_input', objectIds: ['segment-1'], contentHash: 'original-input-hash', baseRevision: source.contentHash, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const extraction: ExtractionOperation = { operationId: approval.id, modelApprovalId: approval.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
    conversationId: source.id, conversationHash: source.contentHash, inputHash: approval.contentHash, sourceIds: approval.objectIds,
    stage: 'saved_empty', settingsRevision: 0, batchRevision: 1, candidateContentHash: await contentHash([]),
    updatedAt: new Date().toISOString(), retryAllowed: false };
  const batch = { conversationId: source.id, conversationHash: source.contentHash, state: 'available', candidates: [], revision: 1, modelApprovalId: approval.id, retentionDays: 7, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const delivery = { conversationId: source.id, conversationHash: source.contentHash, candidates: [], state: 'empty', batch };
  const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, data, meta: { requestId: 'fixture', mode: 'fixture', contractVersion: CONTRACT_VERSION } });
  const request = vi.fn(async (path: string, _init?: RequestInit) => ok(path.endsWith('/candidates') ? delivery : path.includes('/extractions') ? { conversationId: source.id, conversationHash: source.contentHash, operations: [extraction], absenceIsFinal: false, retryAllowed: false } : extraction));
  return { source, approval, extraction, batch, delivery, request, ok, run: () => readModelRecovery(request, source, approval) };
}
describe('C12 exact model operation recovery', () => {
  it('recognizes a completed empty batch belonging to the original operation using only GET', async () => {
    const s = await setup(); expect(await s.run()).toMatchObject({ ok: true, data: { state: 'complete', delivery: { state: 'empty' } } });
    expect(s.request.mock.calls.map(([path]) => path)).toEqual([`/api/workspace/extraction-operations/${s.approval.id}`, `/api/capture/${s.source.id}/candidates`]);
    expect(s.request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(await s.run()).toMatchObject({ ok: true, data: { stage: 'saved_empty', extraction: { operationId: s.approval.id, batchRevision: 1 } } });
  });
  it('does not use another operation or batch to release unknown state', async () => {
    for (const field of ['operationId', 'modelApprovalId', 'actorId', 'workspaceId', 'conversationId', 'conversationHash', 'inputHash', 'sourceIds']) {
      const s = await setup();
      const value = field === 'sourceIds' ? ['other-source'] : 'other';
      s.request.mockImplementationOnce(async () => s.ok({ ...s.extraction, [field]: value }));
      expect(await s.run(), field).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    }
    const s = await setup(); s.batch.modelApprovalId = 'another-approval';
    expect(await s.run()).toMatchObject({ ok: true, data: { state: 'unknown', stage: 'saved_empty' } });
  });
  it.each(['model_sending', 'model_done', 'candidate_saving', 'unknown'])('keeps %s unresolved when the candidate batch is missing without repeating extraction', async (stage) => {
      const s = await setup();
      s.request.mockResolvedValueOnce(s.ok({ ...s.extraction, stage })).mockResolvedValueOnce(s.ok({ ...s.delivery, state: 'missing', batch: { conversationId: s.source.id, conversationHash: s.source.contentHash, state: 'missing', revision: 0, candidates: [], retentionDays: 7 } }));
      expect(await s.run()).toMatchObject({ ok: true, data: { state: 'unknown', stage } });
      expect(s.request).toHaveBeenCalledTimes(2);
  });
  it('returns the explicit rejected_without_save terminal only when the batch is still missing', async () => {
    const s = await setup();
    s.request.mockResolvedValueOnce(s.ok({ ...s.extraction, stage: 'rejected_without_save', rejectionReason: 'invalid_reference' })).mockResolvedValueOnce(s.ok({ ...s.delivery, state: 'missing', batch: { conversationId: s.source.id, conversationHash: s.source.contentHash, state: 'missing', revision: 0, candidates: [], retentionDays: 7 } }));
    expect(await s.run()).toMatchObject({ ok: true, data: { state: 'rejected_without_save', stage: 'rejected_without_save', extraction: { rejectionReason: 'invalid_reference' } } });
  });
  it('does not treat a saved terminal as complete when the original batch is missing or mismatched', async () => {
    const s = await setup();
    s.request.mockResolvedValueOnce(s.ok({ ...s.extraction, stage: 'saved_empty', batchRevision: 1 })).mockResolvedValueOnce(s.ok({ ...s.delivery, state: 'missing', batch: { conversationId: s.source.id, conversationHash: s.source.contentHash, state: 'missing', revision: 0, candidates: [], retentionDays: 7 } }));
    expect(await s.run()).toMatchObject({ ok: true, data: { state: 'unknown', stage: 'saved_empty' } });
  });
  it('does not release an available saved terminal without the candidate batch content hash', async () => {
    const s = await setup();
    const { candidateContentHash: _candidateContentHash, ...withoutHash } = s.extraction;
    s.request.mockResolvedValueOnce(s.ok({ ...withoutHash, stage: 'saved_empty', batchRevision: 1 }));
    expect(await s.run()).toMatchObject({ ok: true, data: { state: 'unknown', stage: 'saved_empty' } });
  });
  it('does not release a saved terminal when the candidate batch content hash is mismatched', async () => {
    const s = await setup();
    s.request.mockResolvedValueOnce(s.ok({ ...s.extraction, stage: 'saved_empty', candidateContentHash: 'different-candidate-batch' }));
    expect(await s.run()).toMatchObject({ ok: true, data: { state: 'unknown', stage: 'saved_empty' } });
  });
  it('discovers original operations by conversationId without selecting or writing one', async () => {
    const s = await setup();
    const result = await discoverModelOperations(s.request, s.source);
    expect(result).toMatchObject({ ok: true, data: { conversationId: s.source.id, operations: [{ operationId: s.approval.id, stage: 'saved_empty' }], absenceIsFinal: false, retryAllowed: false } });
    expect(s.request.mock.calls).toEqual([[`/api/workspace/conversations/${s.source.id}/extractions`, { signal: undefined }]]);
  });
  it('keeps an empty discovery explicitly non-final', async () => {
    const s = await setup();
    s.request.mockResolvedValueOnce(s.ok({ conversationId: s.source.id, conversationHash: s.source.contentHash, operations: [], absenceIsFinal: false, retryAllowed: false }));
    expect(await discoverModelOperations(s.request, s.source)).toMatchObject({ ok: true, data: { operations: [], absenceIsFinal: false, retryAllowed: false } });
  });
  it('does not let two same-content operations cross-identify', async () => {
    const s = await setup();
    const other = { ...s.extraction, operationId: 'another-operation', modelApprovalId: 'another-operation' };
    s.request.mockResolvedValueOnce(s.ok({ conversationId: s.source.id, conversationHash: s.source.contentHash, operations: [s.extraction, other], absenceIsFinal: false, retryAllowed: false }));
    const discovered = await discoverModelOperations(s.request, s.source);
    expect(discovered).toMatchObject({ ok: true, data: { operations: [{ operationId: s.approval.id }, { operationId: 'another-operation' }] } });

    s.request.mockResolvedValueOnce(s.ok(other));
    const mismatched = await readModelRecovery(s.request, s.source, s.approval);
    expect(mismatched).toMatchObject({ ok: false, error: { dataState: 'unknown' } });

    s.request.mockResolvedValueOnce(s.ok(other));
    const selectedOther = await readDiscoveredModelRecovery(s.request, s.source, 'another-operation');
    expect(selectedOther).toMatchObject({ ok: true, data: { extraction: { operationId: 'another-operation' }, state: 'unknown' } });
  });
});
