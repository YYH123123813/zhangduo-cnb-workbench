import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ApiResponse } from '../../contracts/api';
import type { Approval } from '../../contracts/domain';
import { contentHash, hashModelInput } from '../../contracts/hash';
import { ModelApprovalRequestSchema, ModelOperationReceiptSchema } from '../../contracts/model';
import { answerLeaveState, answerOperationLabels, answerOperationState, createAnswerFlow, type AnswerCall, type AnswerState } from './answer-client';
import type { AnswerPreview } from './api';
import { latestRead } from './client-state';
import { node, request } from './test-support';

const meta = { requestId: 'fixture', mode: 'fixture' as const, contractVersion: '1.23.0' };
const success = (data: unknown): ApiResponse<unknown> => ({ ok: true, data, meta });
async function setup() {
  const input = { purpose: 'answer' as const, text: 'Exact approved input <script>untrusted</script>', sourceIds: ['s-n1'] };
  const preview: AnswerPreview = { input, baseRevision: 'fixture-r1', objectIds: ['n1'], contentHash: await hashModelInput(input) };
  const approval: Approval = { id: 'approved', actorId: 'u1', workspaceId: 'w1', purpose: 'model_input', objectIds: ['n1'], baseRevision: preview.baseRevision,
    contentHash: preview.contentHash, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  let approveResponse: Promise<ApiResponse<unknown>> | undefined;
  const call = vi.fn<AnswerCall>(async (path) => path.endsWith('/preview') ? success(preview) : path.endsWith('/model') ? approveResponse ?? success(approval)
    : path.includes('/operations/') ? success({ approvalId: approval.id, actorId: approval.actorId, workspaceId: approval.workspaceId,
      purpose: 'answer', contentHash: approval.contentHash, baseRevision: approval.baseRevision, state: 'done' }) : success({ revoked: true }));
  const states: AnswerState[] = []; const onFailure = vi.fn(); const onResult = vi.fn(); const reader = latestRead();
  const flow = createAnswerFlow({ request, actorId: 'u1', reader, call, onState: (state) => states.push(state), onFailure, onResult });
  return { flow, call, states, preview, approval, onFailure, onResult, reader, set approveResponse(response: Promise<ApiResponse<unknown>>) { approveResponse = response; } };
}

describe('R09 explicit browser approval lifecycle, no real HTTP', () => {
  it('keeps preview, approved, sending, unknown, not_sent, done and discarded distinct', async () => {
    const f = await setup();
    expect(answerOperationState({ phase: 'preview', receipt: null, operation: null, uncertain: false })).toBe('preview');
    expect(answerOperationState({ phase: 'approved', receipt: null, operation: f.approval, uncertain: false })).toBe('approved');
    expect(answerOperationState({ phase: 'sending', receipt: null, operation: f.approval, uncertain: true })).toBe('sending');
    expect(answerOperationState({ phase: 'done', receipt: null, operation: f.approval, uncertain: true })).toBe('unknown');
    expect(answerOperationState({ phase: 'done', receipt: { approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.approval.contentHash, baseRevision: f.approval.baseRevision, state: 'done' }, operation: f.approval, uncertain: false })).toBe('done');
    expect(answerOperationState({ phase: 'done', receipt: { approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.approval.contentHash, baseRevision: f.approval.baseRevision, state: 'discarded' }, operation: f.approval, uncertain: false })).toBe('discarded');
    expect(answerOperationState({ phase: 'done', receipt: { approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.approval.contentHash, baseRevision: f.approval.baseRevision, state: 'done' }, operation: f.approval, uncertain: true })).toBe('unknown');
    expect(answerOperationLabels.not_sent).toBe('平台已证明未发送');
    expect(ModelOperationReceiptSchema.safeParse({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.approval.contentHash, baseRevision: f.approval.baseRevision, state: 'not_sent' }).success).toBe(true);
  });
  it('requires preview, unchecked-by-default confirmation, and a separate send command', async () => {
    const f = await setup();
    await f.flow.approve(false); await f.flow.send(); expect(f.call).not.toHaveBeenCalled();
    await f.flow.preview(); expect(f.flow.state.phase).toBe('preview');
    await f.flow.approve(false); expect(f.call).toHaveBeenCalledTimes(1);
    await f.flow.approve(true); expect(f.flow.state.phase).toBe('approved');
    expect(f.call.mock.calls.map(([path]) => path)).toEqual(['/api/retrieval/answer/preview', '/api/workspace/approvals/model']);
    const sent = JSON.parse(f.call.mock.calls[1]![1]!.body as string);
    expect(sent).toEqual({ input: f.preview.input, objectIds: ['n1'], baseRevision: 'fixture-r1', operationId: expect.any(String), confirmed: true });
    expect(f.flow.state.registration?.operationId).toBe(sent.operationId);
    expect(f.flow.state.registration?.requestHash).toBe(await contentHash(ModelApprovalRequestSchema.parse(sent)));
  });
  it('revokes an approval that arrives after cancellation, with zero answer calls', async () => {
    const f = await setup(); let resolve!: (value: ApiResponse<unknown>) => void;
    f.approveResponse = new Promise((done) => { resolve = done; });
    await f.flow.preview(); const registering = f.flow.approve(true); await f.flow.cancel();
    resolve(success(f.approval)); await registering;
    expect(f.flow.state.approval).toBeNull();
    expect(f.call.mock.calls.map(([path]) => path)).toContain('/api/workspace/approvals/approved/revoke');
    expect(f.call.mock.calls.map(([path]) => path)).not.toContain('/api/retrieval/answer');
  });
  it('revokes an unused approval and makes send unavailable immediately', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true); await f.flow.cancel(); await f.flow.send();
    expect(f.flow.state.approval).toBeNull(); expect(f.flow.state.preview).toBeNull();
    expect(f.call.mock.calls.map(([path]) => path)).not.toContain('/api/retrieval/answer');
  });
  it('never sends after an external content invalidation or double approval click', async () => {
    const f = await setup(); await f.flow.preview();
    await Promise.all([f.flow.approve(true), f.flow.approve(true)]);
    expect(f.call.mock.calls.filter(([path]) => path.endsWith('/model'))).toHaveLength(1);
    f.reader.cancel(); await f.flow.send();
    expect(f.call.mock.calls.map(([path]) => path)).not.toContain('/api/retrieval/answer');
    await f.flow.cancel();
  });
  it('permanently invalidates an old query scope without erasing its unresolved original operation', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('lost response'); }); await f.flow.send();
    await f.flow.invalidate();
    expect(f.flow.state.invalidated).toBe(true); expect(f.flow.state.operation?.id).toBe(f.approval.id);
    f.call.mockResolvedValueOnce(success({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.preview.contentHash,
      baseRevision: f.preview.baseRevision, state: 'done' }));
    await f.flow.inspect(); expect(answerLeaveState(f.flow.state)).toBe('clean');
    const count = f.call.mock.calls.length; await f.flow.preview(); await f.flow.approve(true); await f.flow.send();
    expect(f.call).toHaveBeenCalledTimes(count); expect(f.onResult).not.toHaveBeenCalled();
  });
  it('cannot revive an invalidated preview when the editor has moved to a new query', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.invalidate();
    const count = f.call.mock.calls.length; await f.flow.preview(); await f.flow.approve(true); await f.flow.send();
    expect(f.call).toHaveBeenCalledTimes(count); expect(f.flow.state.preview).toBeNull(); expect(f.onResult).not.toHaveBeenCalled();
  });
  it('refuses a mismatched returned approval without treating an unrelated revocation as original-registration recovery', async () => {
    const f = await setup(); f.approveResponse = Promise.resolve(success({ ...f.approval, contentHash: 'changed' }));
    await f.flow.preview(); await f.flow.approve(true);
    expect(f.flow.state.approval).toBeNull(); expect(f.flow.state.phase).not.toBe('approved');
    expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.call.mock.calls.map(([path]) => path)).not.toContain('/api/workspace/approvals/approved/revoke');
  });
  it('retains a failed revocation for explicit retry rather than reporting it revoked', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('offline'); });
    await f.flow.cancel(); expect(f.flow.state.phase).toBe('revoke_failed');
    expect(f.flow.state.approval?.id).toBe('approved'); await f.flow.send();
    expect(f.call.mock.calls.map(([path]) => path)).not.toContain('/api/retrieval/answer');
    await f.flow.cancel(); expect(f.flow.state.approval).toBeNull();
  });
  it('blocks leaving for in-flight, approved and unknown operations, including after revoke', async () => {
    const f = await setup(); expect(answerLeaveState(f.flow.state)).toBe('clean');
    await f.flow.preview(); await f.flow.approve(true); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    f.call.mockImplementationOnce(async () => { throw new Error('network reply lost'); });
    await f.flow.send(); expect(f.flow.state.uncertain).toBe(true); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    await f.flow.cancel(); expect(f.flow.state.approval).toBeNull(); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    const count = f.call.mock.calls.length; await f.flow.preview(); expect(f.call).toHaveBeenCalledTimes(count);
  });
  it('keeps a pending revocation blocked across repeated input invalidation', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    let resolve!: (value: ApiResponse<unknown>) => void;
    f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const cancelling = f.flow.cancel(); await f.flow.cancel();
    expect(answerLeaveState(f.flow.state)).toBe('blocked');
    const count = f.call.mock.calls.length; await f.flow.preview(); expect(f.call).toHaveBeenCalledTimes(count);
    resolve(success({ revoked: true })); await cancelling;
    expect(answerLeaveState(f.flow.state)).toBe('clean');
  });
  it('does not treat a malformed success envelope as a verified model response', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockResolvedValueOnce(success({ value: 'UNVERIFIED_BODY' }));
    await f.flow.send(); expect(f.onResult).not.toHaveBeenCalled();
    expect(f.flow.state.uncertain).toBe(true); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.flow.state.error).not.toContain('UNVERIFIED_BODY'); await f.flow.cancel();
  });
  it('settles an explicitly cancelled attempted operation only from a matching platform not_sent receipt', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('answer response lost'); }); await f.flow.send();
    f.call.mockResolvedValueOnce(success({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer',
      contentHash: f.approval.contentHash, baseRevision: f.approval.baseRevision, state: 'not_sent' })).mockResolvedValueOnce(success({ revoked: true }));
    await f.flow.cancel();
    expect(f.call.mock.calls.at(-2)?.[0]).toBe('/api/workspace/model-operations/approved/close');
    expect(JSON.parse(f.call.mock.calls.at(-2)?.[1]?.body as string)).toEqual({ purpose: 'answer', contentHash: f.approval.contentHash,
      baseRevision: f.approval.baseRevision, confirmed: true });
    expect(f.flow.state.receipt?.state).toBe('not_sent'); expect(answerOperationState(f.flow.state)).toBe('not_sent');
    expect(f.flow.state.uncertain).toBe(false); expect(answerLeaveState(f.flow.state)).toBe('clean'); expect(f.onResult).not.toHaveBeenCalled();
  });
  it('does not accept a forged not_sent receipt with a different original binding', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('answer response lost'); }); await f.flow.send();
    f.call.mockResolvedValueOnce(success({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer',
      contentHash: 'different', baseRevision: f.approval.baseRevision, state: 'not_sent' }));
    await f.flow.cancel();
    expect(f.flow.state.receipt).toBeNull(); expect(f.flow.state.uncertain).toBe(true); expect(answerLeaveState(f.flow.state)).toBe('blocked');
  });
  it.each(['not_written', 'preserved'] as const)('does not interpret a %s error as an original-operation closure', async (dataState) => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    const error: ApiError = { code: 'FORBIDDEN', message: 'The request was refused', dataState, nextAction: 'review_model_operation', retryable: false };
    f.call.mockResolvedValueOnce({ ok: false, error, meta });
    await f.flow.send();
    expect(f.flow.state.uncertain).toBe(true); expect(f.onFailure).toHaveBeenCalledWith(error);
    await f.flow.cancel();
    f.call.mockResolvedValueOnce(success(null)); await f.flow.inspect();
    expect(answerLeaveState(f.flow.state)).toBe('blocked'); expect(f.flow.state.receipt).toBeNull();
    const count = f.call.mock.calls.length; await f.flow.preview(); await f.flow.send();
    expect(f.call).toHaveBeenCalledTimes(count); expect(f.onResult).not.toHaveBeenCalled();
  });
  it('keeps a returned direct result unknown when no original model terminal receipt exists', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    const data = { queryId: 'q1', snapshotRevision: 'fixture-r1', groups: { eligible: [node()], conditional: [], conflicts: [], excludedIds: [] },
      paths: [], answer: null, missingConditions: [], warnings: [], coverage: 'partial' };
    f.call.mockResolvedValueOnce(success(data)).mockResolvedValueOnce(success({ revoked: true })).mockResolvedValueOnce(success(null));
    await f.flow.send();
    expect(f.onResult).toHaveBeenCalledExactlyOnceWith(data); expect(f.flow.state.approval).toBeNull();
    expect(f.flow.state.uncertain).toBe(true); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.call.mock.calls.some(([path]) => path === '/api/retrieval/answer/operations/approved')).toBe(true);
    expect(f.call.mock.calls.filter(([path]) => path === '/api/retrieval/answer/operations/approved').every(([, init]) => init?.method === 'GET' && init?.body === undefined)).toBe(true);
    const count = f.call.mock.calls.length; await f.flow.preview(); await f.flow.approve(true); await f.flow.send();
    expect(f.call).toHaveBeenCalledTimes(count);
  });
  it('delivers one validated direct or cited result and does not double-send', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    const data = { queryId: 'q1', snapshotRevision: 'fixture-r1', groups: { eligible: [node()], conditional: [], conflicts: [], excludedIds: [] },
      paths: [], answer: null, missingConditions: [], warnings: [], coverage: 'partial' };
    f.call.mockResolvedValueOnce(success(data)); await Promise.all([f.flow.send(), f.flow.send()]);
    expect(f.call.mock.calls.filter(([path]) => path === '/api/retrieval/answer')).toHaveLength(1);
    expect(f.onResult).toHaveBeenCalledExactlyOnceWith(data); expect(answerLeaveState(f.flow.state)).toBe('clean');
    expect(f.flow.state.receipt).toMatchObject({ approvalId: f.approval.id, state: 'done' });
  });
  it('keeps a returned result blocked after terminal readback until its remaining approval is revoked', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    const data = { queryId: 'q1', snapshotRevision: 'fixture-r1', groups: { eligible: [node()], conditional: [], conflicts: [], excludedIds: [] },
      paths: [], answer: null, missingConditions: [], warnings: [], coverage: 'partial' };
    f.call.mockResolvedValueOnce(success(data)).mockImplementationOnce(async () => { throw new Error('revocation response lost'); });
    await f.flow.send();
    expect(f.onResult).toHaveBeenCalledExactlyOnceWith(data);
    expect(f.flow.state.approval?.id).toBe('approved'); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.call.mock.calls.some(([path]) => path === '/api/retrieval/answer/operations/approved')).toBe(true);
    expect(f.flow.state.receipt?.state).toBe('done');
    await f.flow.cancel(); expect(answerLeaveState(f.flow.state)).toBe('clean');
    expect(f.call.mock.calls.filter(([path]) => path === '/api/retrieval/answer')).toHaveLength(1);
  });
  it('does not deliver a previous answer after input invalidation while its cleanup revocation is pending', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    const data = { queryId: 'q1', snapshotRevision: 'fixture-r1', groups: { eligible: [node()], conditional: [], conflicts: [], excludedIds: [] },
      paths: [], answer: null, missingConditions: [], warnings: [], coverage: 'partial' };
    let resolve!: (value: ApiResponse<unknown>) => void; let started!: () => void;
    const revoking = new Promise<void>((done) => { started = done; });
    f.call.mockResolvedValueOnce(success(data)).mockImplementationOnce(() => { started(); return new Promise((done) => { resolve = done; }); });
    const sending = f.flow.send(); await revoking; await f.flow.cancel();
    expect(answerLeaveState(f.flow.state)).toBe('blocked');
    resolve(success({ revoked: true })); await sending;
    expect(f.onResult).not.toHaveBeenCalled(); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.flow.state.receipt).toBeNull(); await f.flow.inspect(); expect(answerLeaveState(f.flow.state)).toBe('clean');
  });
  it('does not clear an outstanding approval when the original receipt is terminal', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('lost response'); }); await f.flow.send();
    f.call.mockResolvedValueOnce(success({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.preview.contentHash,
      baseRevision: f.preview.baseRevision, state: 'done' }));
    await f.flow.inspect(); expect(f.flow.state.uncertain).toBe(false); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    await f.flow.cancel(); expect(answerLeaveState(f.flow.state)).toBe('clean');
  });
  it('discards a late receipt after cancellation and coalesces repeated inspection clicks', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('lost response'); }); await f.flow.send(); await f.flow.cancel();
    let resolve!: (value: ApiResponse<unknown>) => void;
    f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const inspecting = f.flow.inspect(); await f.flow.inspect(); await f.flow.cancel();
    resolve(success({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.preview.contentHash,
      baseRevision: f.preview.baseRevision, state: 'done' }));
    await inspecting; expect(f.flow.state.receipt).toBeNull(); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.call.mock.calls.filter(([path]) => path.includes('/operations/'))).toHaveLength(1);
  });
  it.each(['done', 'discarded'] as const)('resolves uncertainty only from the original %s receipt after revocation', async (state) => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('lost response'); }); await f.flow.send(); await f.flow.cancel();
    f.call.mockResolvedValueOnce(success({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: f.preview.contentHash,
      baseRevision: f.preview.baseRevision, state, modelId: 'fixture-model' }));
    const count = f.call.mock.calls.filter(([path]) => path === '/api/retrieval/answer').length;
    await f.flow.inspect(); expect(answerLeaveState(f.flow.state)).toBe('clean'); expect(f.flow.state.receipt?.state).toBe(state);
    expect(f.call.mock.calls.some(([path]) => path === '/api/retrieval/answer/operations/approved')).toBe(true);
    expect(f.call.mock.calls.filter(([path]) => path === '/api/retrieval/answer/operations/approved').every(([, init]) => init?.method === 'GET' && init?.body === undefined)).toBe(true);
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.call.mock.calls.filter(([path]) => path === '/api/retrieval/answer')).toHaveLength(count);
  });
  it.each(['sending', 'unknown', null] as const)('keeps %s operation readback unresolved without an automatic retry', async (state) => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('lost response'); }); await f.flow.send(); await f.flow.cancel();
    f.call.mockResolvedValueOnce(success(state === null ? null : { approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer',
      contentHash: f.preview.contentHash, baseRevision: f.preview.baseRevision, state }));
    await f.flow.inspect(); expect(answerLeaveState(f.flow.state)).toBe('blocked'); expect(f.flow.state.uncertain).toBe(true);
    expect(f.onResult).not.toHaveBeenCalled();
  });
  it('does not unlock from a receipt for another content hash or after a readback failure', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('lost response'); }); await f.flow.send(); await f.flow.cancel();
    f.call.mockResolvedValueOnce(success({ approvalId: f.approval.id, actorId: 'u1', workspaceId: 'w1', purpose: 'answer', contentHash: 'different', baseRevision: f.preview.baseRevision, state: 'done' }));
    await f.flow.inspect(); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    f.call.mockImplementationOnce(async () => { throw new Error('offline'); }); await f.flow.inspect();
    expect(answerLeaveState(f.flow.state)).toBe('blocked'); expect(f.flow.state.receipt).toBeNull();
  });
  it('recovers the exact lost approval registration for explicit revocation, never for implicit sending', async () => {
    const f = await setup(); await f.flow.preview();
    f.call.mockImplementationOnce(async () => { throw new Error('registration response lost'); });
    await f.flow.approve(true); const original = f.flow.state.registration!;
    expect(original.operationId).toBeTruthy(); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    f.call.mockResolvedValueOnce(success({ operationId: original.operationId, purpose: 'model_input', modelPurpose: 'answer', workspaceId: 'w1', actorId: 'u1',
      requestHash: original.requestHash, status: 'registered', approval: f.approval, absenceIsFinal: false }));
    await f.flow.inspectRegistration();
    expect(f.call.mock.lastCall?.[0]).toBe(`/api/workspace/approval-registrations/model_input/${original.operationId}?modelPurpose=answer`);
    expect(f.call.mock.lastCall?.[1]?.method).toBe('GET'); expect(f.call.mock.lastCall?.[1]?.body).toBeUndefined();
    expect(f.flow.state.approval).toEqual(f.approval); expect(f.flow.state.phase).not.toBe('approved');
    expect(answerLeaveState(f.flow.state)).toBe('blocked'); await f.flow.send();
    expect(f.call.mock.calls.some(([path]) => path === '/api/retrieval/answer')).toBe(false);
    await f.flow.cancel(); expect(answerLeaveState(f.flow.state)).toBe('clean');
    await f.flow.preview(); await f.flow.approve(true);
    expect(f.flow.state.registration?.operationId).not.toBe(original.operationId);
    expect(f.call.mock.calls.filter(([path]) => path === '/api/workspace/approvals/model')).toHaveLength(2);
  });
  it.each(['not_registered', 'unknown'] as const)('keeps %s registration unresolved without registering or sending again', async (status) => {
    const f = await setup(); await f.flow.preview(); f.call.mockImplementationOnce(async () => { throw new Error('lost'); }); await f.flow.approve(true);
    const original = f.flow.state.registration!;
    f.call.mockResolvedValueOnce(success({ operationId: original.operationId, purpose: 'model_input', modelPurpose: 'answer', workspaceId: 'w1', actorId: 'u1',
      requestHash: null, status, approval: null, absenceIsFinal: false }));
    await f.flow.inspectRegistration(); await f.flow.preview(); await f.flow.approve(true); await f.flow.send();
    expect(answerLeaveState(f.flow.state)).toBe('blocked'); expect(f.flow.state.registration).toEqual(original);
    expect(f.call.mock.calls.filter(([path]) => path === '/api/workspace/approvals/model')).toHaveLength(1);
    expect(f.call.mock.calls.some(([path]) => path === '/api/retrieval/answer')).toBe(false);
  });
  it.each(['revoked', 'expired'] as const)('closes an unsent registration only from exact %s metadata', async (status) => {
    const f = await setup(); await f.flow.preview(); f.call.mockImplementationOnce(async () => { throw new Error('lost'); }); await f.flow.approve(true);
    await f.flow.invalidate(); const original = f.flow.state.registration!;
    const approval = status === 'expired' ? { ...f.approval, approvedAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() } : f.approval;
    f.call.mockResolvedValueOnce(success({ operationId: original.operationId, purpose: 'model_input', modelPurpose: 'answer', workspaceId: 'w1', actorId: 'u1',
      requestHash: original.requestHash, status, approval, absenceIsFinal: false }));
    await f.flow.inspectRegistration(); expect(answerLeaveState(f.flow.state)).toBe('clean'); expect(f.flow.state.invalidated).toBe(true);
    expect(f.flow.state.approval).toBeNull(); expect(f.flow.state.registrationStatus).toBe(status);
    const count = f.call.mock.calls.length; await f.flow.preview(); await f.flow.approve(true); await f.flow.send();
    expect(f.call).toHaveBeenCalledTimes(count); expect(f.onResult).not.toHaveBeenCalled();
  });
  it('rejects mismatched registration identity, complete-request hash, approved scope and unexpected body fields', async () => {
    const f = await setup(); await f.flow.preview(); f.call.mockImplementationOnce(async () => { throw new Error('lost'); }); await f.flow.approve(true);
    const original = f.flow.state.registration!;
    const receipt = { operationId: original.operationId, purpose: 'model_input', modelPurpose: 'answer', workspaceId: 'w1', actorId: 'u1',
      requestHash: original.requestHash, status: 'registered', approval: f.approval, absenceIsFinal: false };
    for (const patch of [{ operationId: 'another-operation' }, { actorId: 'another-actor' }, { workspaceId: 'another-workspace' },
      { modelPurpose: 'review' }, { requestHash: 'another-request' }, { approval: { ...f.approval, contentHash: 'different' } },
      { approval: { ...f.approval, baseRevision: 'different' } }, { approval: { ...f.approval, objectIds: ['another-node'] } }, { body: 'PRIVATE_BODY' },
    ]) {
      f.call.mockResolvedValueOnce(success({ ...receipt, ...patch })); await f.flow.inspectRegistration();
      expect(answerLeaveState(f.flow.state)).toBe('blocked'); expect(f.flow.state.approval).toBeNull();
    }
    f.call.mockImplementationOnce(async () => { throw new Error('readback offline'); }); await f.flow.inspectRegistration();
    expect(answerLeaveState(f.flow.state)).toBe('blocked'); expect(f.onResult).not.toHaveBeenCalled();
  });
  it('discards late registration readback after invalidation and coalesces repeated inspections', async () => {
    const f = await setup(); await f.flow.preview(); f.call.mockImplementationOnce(async () => { throw new Error('lost'); }); await f.flow.approve(true);
    const original = f.flow.state.registration!; let release!: (value: ApiResponse<unknown>) => void;
    f.call.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.flow.inspectRegistration(); await f.flow.inspectRegistration(); await f.flow.invalidate();
    release(success({ operationId: original.operationId, purpose: 'model_input', modelPurpose: 'answer', workspaceId: 'w1', actorId: 'u1',
      requestHash: original.requestHash, status: 'registered', approval: f.approval, absenceIsFinal: false }));
    await pending; expect(f.flow.state.approval).toBeNull(); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.call.mock.calls.filter(([path]) => path.includes('/approval-registrations/'))).toHaveLength(1);
  });
  it('does not confuse an unrelated approval response with revocation of the original registration', async () => {
    const f = await setup(); await f.flow.preview(); f.call.mockResolvedValueOnce(success({ ...f.approval, contentHash: 'unrelated' }));
    await f.flow.approve(true); expect(f.flow.state.approval).toBeNull(); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.flow.state.registration?.operationId).toBeTruthy(); expect(f.call.mock.calls.some(([path]) => path.endsWith('/revoke'))).toBe(false);
  });
  it('does not let registration readback clear uncertainty about an already attempted model call', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('answer response lost'); }); await f.flow.send(); await f.flow.cancel();
    const count = f.call.mock.calls.length; await f.flow.inspectRegistration();
    expect(f.call).toHaveBeenCalledTimes(count); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    expect(f.flow.state.operation?.id).toBe(f.approval.id);
  });
  it('consumes 1.22 recovery by the original registration operationId without restoring approval or answer text', async () => {
    const f = await setup(); await f.flow.preview();
    f.call.mockImplementationOnce(async () => { throw new Error('approval response lost'); }); await f.flow.approve(true);
    const original = f.flow.state.registration!;
    const recovery = { kind: 'model', operationId: original.operationId, actorId: 'u1', workspaceId: 'w1', approvalId: f.approval.id,
      recordId: null, purpose: 'answer', requestHash: original.requestHash, contentHash: f.approval.contentHash, baseRevision: f.approval.baseRevision,
      objectIds: ['n1'], approvalExpiresAt: f.approval.expiresAt, stage: 'done', readOnly: true, absenceIsFinal: false };
    f.call.mockResolvedValueOnce(success(recovery)); await f.flow.inspectRecovery(original.operationId);
    expect(f.call.mock.lastCall?.[0]).toBe(`/api/workspace/operation-recovery/model/${original.operationId}?modelPurpose=answer`);
    expect(f.call.mock.lastCall?.[1]?.method).toBe('GET'); expect(f.call.mock.lastCall?.[1]?.body).toBeUndefined();
    expect(f.flow.state.recovery).toMatchObject({ operationId: original.operationId, approvalId: f.approval.id, stage: 'done' });
    expect(f.flow.state.approval).toBeNull(); expect(f.flow.state.receipt).toBeNull(); expect(f.flow.state.uncertain).toBe(true);
    expect(f.call.mock.calls.some(([path]) => path === '/api/retrieval/answer')).toBe(false);
  });

  it('does not read another operation after the page supplies a switched operationId', async () => {
    const f = await setup(); await f.flow.preview();
    f.call.mockImplementationOnce(async () => { throw new Error('approval response lost'); }); await f.flow.approve(true);
    const original = f.flow.state.registration!;
    const count = f.call.mock.calls.length;

    await f.flow.inspectRecovery(`${original.operationId}-other`);

    expect(f.call).toHaveBeenCalledTimes(count);
    expect(f.flow.state.recovery).toBeNull();
    expect(f.flow.state.uncertain).toBe(true);
    expect(answerLeaveState(f.flow.state)).toBe('blocked');
  });
  it('keeps an unresolved 1.22 recovery unknown and does not let metadata done stand in for a model receipt', async () => {
    const f = await setup(); await f.flow.preview(); await f.flow.approve(true);
    f.call.mockImplementationOnce(async () => { throw new Error('answer response lost'); }); await f.flow.send(); await f.flow.cancel();
    const original = f.flow.state.registration!;
    const unresolved = { kind: 'model', operationId: original.operationId, actorId: 'u1', workspaceId: 'w1', approvalId: null, recordId: null,
      purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null,
      stage: 'not_registered', readOnly: true, absenceIsFinal: false };
    f.call.mockResolvedValueOnce(success(null)).mockResolvedValueOnce(success(unresolved)); await f.flow.inspect();
    expect(f.flow.state.recovery?.stage).toBe('not_registered'); expect(f.flow.state.receipt).toBeNull();
    expect(f.flow.state.uncertain).toBe(true); expect(answerLeaveState(f.flow.state)).toBe('blocked');
  });
});
