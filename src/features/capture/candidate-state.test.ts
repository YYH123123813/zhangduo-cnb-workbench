import { describe, expect, it, vi } from 'vitest';
import type { Approval, Candidate } from '../../contracts/domain';
import type { CandidateState } from '../../contracts/candidates';
import type { Services } from '../../contracts/ports';
import { hashConversation } from '../../contracts/hash';
import { conversation, ctx, fixture, post } from './fixtures.test-support';
import { prepareModelInput } from './model-input';

async function setup() {
  const value = structuredClone(conversation); value.contentHash = await hashConversation(value);
  let batch: CandidateState = { conversationId: value.id, conversationHash: value.contentHash, candidates: [], revision: 0, state: 'missing', retentionDays: 7 };
  const complete = vi.fn<Services['complete']>(async () => ({ ok: true, data: { value: { candidates: [] }, modelId: 'fixture-empty', generatedAt: new Date().toISOString() } }));
  const saveCandidates = vi.fn<Services['saveCandidates']>(async (_ctx, _id, candidates, options) => { batch = { ...batch, candidates, state: 'available', revision: 1, modelApprovalId: options?.modelApproval.id, expiresAt: new Date(Date.now() + 86400000).toISOString() }; return { ok: true, data: candidates }; });
  const readModelOperation = vi.fn<NonNullable<Services['readModelOperation']>>(async () => ({ ok: true, data: null }));
  const { app, services } = fixture({ complete, saveCandidates, readModelOperation,
    readConversation: async () => ({ ok: true, data: value }), readCandidates: async () => ({ ok: true, data: batch.candidates }),
    readCandidateState: async () => ({ ok: true, data: structuredClone(batch) }),
    settings: async () => ({ ok: true, data: { aiExtraction: true, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } }),
  });
  const scope = { task: { id: value.taskId, workspaceId: ctx.workspaceId, question: '减少重复请求', constraints: [], mode: 'assisted' as const, updatedAt: new Date().toISOString() }, segmentIds: [value.segments[0]!.id], scopeConfirmed: true as const };
  const preview = await prepareModelInput(services, ctx, value.id, scope); if (!preview.ok) throw new Error('fixture preview failed');
  const approval: Approval = { ...preview.data.approvalRequest, id: 'fixture-approval', workspaceId: ctx.workspaceId, actorId: ctx.actorId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const request = { ...scope, approval, retentionDays: 7, confirmed: true };
  return { app, services, value, request, complete, saveCandidates, readModelOperation, setBatch: (next: Partial<CandidateState>) => { batch = { ...batch, ...next }; } };
}
describe('C10/C12 shared 1.9 candidate batch contract', () => {
  it('passes the original approval, hash, CAS revision and explicit retention into persistence', async () => {
    const s = await setup(); const response = await post(s.app, `/api/capture/${s.value.id}/extract`, s.request);
    expect(response.status).toBe(200);
    expect(s.saveCandidates.mock.calls[0]).toEqual([ctx, s.value.id, [], { modelApproval: s.request.approval, expectedConversationHash: s.value.contentHash, expectedRevision: 0, retentionDays: 7, confirmed: true }]);
    expect(await response.json()).toMatchObject({ data: { state: 'empty', batch: { state: 'available', revision: 1, modelApprovalId: s.request.approval.id } } });
  });
  it('keeps missing, expired and completed-empty batches distinct and never repeats the empty extraction', async () => {
    const s = await setup(); expect(await (await s.app.request(`/api/capture/${s.value.id}/candidates`)).json()).toMatchObject({ data: { state: 'missing', batch: { revision: 0 } } });
    expect((await post(s.app, `/api/capture/${s.value.id}/extract`, s.request)).status).toBe(200);
    expect((await post(s.app, `/api/capture/${s.value.id}/extract`, s.request)).status).toBe(200); expect(s.complete).toHaveBeenCalledOnce();
    s.setBatch({ state: 'expired', candidates: [], expiresAt: '2000-01-01T00:00:00Z' });
    expect(await (await s.app.request(`/api/capture/${s.value.id}/candidates`)).json()).toMatchObject({ data: { state: 'expired' } });
    expect((await post(s.app, `/api/capture/${s.value.id}/extract`, s.request)).status).toBe(409); expect(s.complete).toHaveBeenCalledOnce();
  });
  it('refuses omitted retention or absent batch/operation ports before calling the model', async () => {
    const s = await setup();
    expect((await post(s.app, `/api/capture/${s.value.id}/extract`, { ...s.request, retentionDays: undefined })).status).toBe(422);
    const read = s.services.readCandidateState; delete s.services.readCandidateState;
    expect((await post(s.app, `/api/capture/${s.value.id}/extract`, s.request)).status).toBe(503);
    s.services.readCandidateState = read; delete s.services.readModelOperation;
    expect((await post(s.app, `/api/capture/${s.value.id}/extract`, s.request)).status).toBe(503);
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('does not repeat any recorded model operation to fill a missing candidate batch', async () => {
    for (const state of ['sending', 'done', 'unknown', 'discarded'] as const) {
      const s = await setup(); s.readModelOperation.mockResolvedValue({ ok: true, data: { approvalId: s.request.approval.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'extract', contentHash: s.request.approval.contentHash, baseRevision: s.value.contentHash, state } });
      expect((await post(s.app, `/api/capture/${s.value.id}/extract`, s.request)).status).toBe(409); expect(s.complete).not.toHaveBeenCalled(); expect(s.saveCandidates).not.toHaveBeenCalled();
      expect(await (await s.app.request(`/api/capture/${s.value.id}/model-operations/${s.request.approval.id}`)).json()).toMatchObject({ ok: true, data: { state } });
    }
  });
  it('refuses malformed or foreign batch receipts before sending', async () => {
    for (const change of [{ conversationId: 'foreign' }, { conversationHash: 'stale' }, { state: 'available' as const, revision: 1 }, { candidates: [{} as Candidate] }]) {
      const s = await setup(); s.setBatch(change);
      expect((await post(s.app, `/api/capture/${s.value.id}/extract`, s.request)).status).toBe(409); expect(s.complete).not.toHaveBeenCalled();
    }
  });
});
