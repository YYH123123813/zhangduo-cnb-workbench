import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import { CONTRACT_VERSION, type Approval, type Conversation } from '../../contracts/domain';
import { hashConversation } from '../../contracts/hash';
import { conversation, ctx, withFixtureSession } from './fixtures.test-support';
import { ConversationApprovalRequestSchema } from '../../contracts/approval';
import { contentHash } from '../../contracts/hash';
import type { CapturePreview, PreviewInput } from './preview';
import { CaptureSaveFlow } from './save-flow';
import { failure } from './result';
import type { OperationRecovery } from '../../contracts/operation-recovery';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function ok<T>(data: T): ApiResponse<T> { return { ok: true, data, meta: { requestId: 'fixture', mode: 'fixture', contractVersion: CONTRACT_VERSION } }; }
async function setup() {
  const value: Conversation = { ...conversation, origin: 'paste', sourceAlreadyPersisted: false, state: 'preview', issueNumber: undefined, issueUrl: undefined };
  value.contentHash = await hashConversation(value);
  const input: PreviewInput = { conversationId: value.id, task: { id: value.taskId, question: '当前问题', constraints: [], intent: 'archive' }, source: { origin: 'paste' }, segments: value.segments, personalInfoReviewed: true, scopeConfirmed: true };
  const preview: CapturePreview = { conversation: value, task: { id: value.taskId, workspaceId: value.workspaceId, question: '当前问题', constraints: [], mode: 'independent', updatedAt: new Date().toISOString() }, approvalRequest: { purpose: 'save_conversation', objectIds: [value.id], contentHash: value.contentHash, baseRevision: 'new' } };
  const approval: Approval = { ...preview.approvalRequest, id: 'fixture-approval', actorId: ctx.actorId, workspaceId: ctx.workspaceId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
  const saved: Conversation = { ...value, state: 'saved', sourceAlreadyPersisted: true, issueNumber: 18 };
  const registrationFor = async (operationId: string, status: 'registered' | 'revoked' | 'expired' | 'not_registered' | 'unknown' = 'registered') => {
    const body = ConversationApprovalRequestSchema.parse(JSON.parse(JSON.stringify({ conversation: value, baseRevision: 'new', operationId, confirmed: true })));
    const requestHash = ['registered', 'revoked', 'expired'].includes(status) ? await contentHash(body) : null;
    return { operationId, purpose: 'save_conversation' as const, actorId: ctx.actorId, workspaceId: ctx.workspaceId, requestHash, status,
      approval: requestHash ? approval : null, absenceIsFinal: false };
  };
  const recoveryFor = async (operationId: string, stage: OperationRecovery['stage'] = 'done'): Promise<OperationRecovery> => ({
    kind: 'capture', operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, approvalId: approval.id, recordId: null,
    purpose: 'save_conversation', requestHash: (await registrationFor(operationId)).requestHash, contentHash: approval.contentHash,
    baseRevision: approval.baseRevision, objectIds: approval.objectIds, approvalExpiresAt: approval.expiresAt, stage, readOnly: true, absenceIsFinal: false,
  });
  const request = vi.fn(async (path: string, _init?: RequestInit): Promise<ApiResponse<unknown>> => {
    if (path === '/api/capture/preview') return ok(preview);
    if (path === '/api/capture/approve') return ok(approval);
    if (path.endsWith('/revoke')) return ok({ revoked: true });
    if (path.includes('/operation-recovery/capture/')) return ok(await recoveryFor(decodeURIComponent(path.split('/').pop()!)));
    if (path.includes('/approval-registrations/save_conversation/')) return ok(await registrationFor(decodeURIComponent(path.split('/').pop()!)));
    return ok(saved);
  });
  const flow = new CaptureSaveFlow(withFixtureSession(request));
  return { flow, request, input, preview, approval, saved, recoveryFor, registrationFor };
}
describe('C08 browser save lifecycle with fixture transport', () => {
  it('cancels a preview immediately and ignores its late response while a new preview succeeds', async () => {
    const s = await setup(); const gate = deferred<ApiResponse<unknown>>();
    s.request.mockImplementationOnce(() => gate.promise);
    const pending = s.flow.prepare(s.input);
    await s.flow.cancel();
    expect(s.flow.getSnapshot().phase).toBe('failed');
    await s.flow.prepare(s.input);
    const latest = s.flow.getSnapshot();
    gate.resolve(ok({ ...s.preview, conversation: { ...s.preview.conversation, id: 'stale' } })); await pending;
    expect(s.flow.getSnapshot()).toBe(latest);
    expect(latest.phase).toBe('ready');
  });
  it('ignores rapid duplicate confirms and exposes only a checked saved receipt', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    await Promise.all([s.flow.save(), s.flow.save()]);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/save')).toHaveLength(1);
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'saved', saved: s.saved, sent: true });
    await s.flow.cancel();
    expect(s.flow.getSnapshot().phase).toBe('saved');
  });
  it('revokes a late approval after cancellation or disposal, without sending a write', async () => {
    for (const dispose of [false, true]) {
      const s = await setup(); await s.flow.prepare(s.input);
      const gate = deferred<ApiResponse<unknown>>(); s.request.mockImplementationOnce(() => gate.promise);
      const pending = s.flow.save();
      await vi.waitFor(() => expect(s.request.mock.calls.some(([path]) => path === '/api/capture/approve')).toBe(true));
      if (dispose) s.flow.dispose(); else await s.flow.cancel();
      gate.resolve(ok(s.approval)); await pending;
      expect(s.request.mock.calls.some(([path]) => path === '/api/capture/save')).toBe(false);
      expect(s.request.mock.calls.some(([path]) => path.endsWith(`/${s.approval.id}/revoke`))).toBe(true);
      expect(s.flow.getSnapshot().saved).toBeNull();
    }
  });
  it('locks unknown writes against resubmission and recovers by the original ID', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    const normal = s.request.getMockImplementation()!;
    s.request.mockImplementation((path, init) => path === '/api/capture/save' ? Promise.reject(new Error('transport lost')) : normal(path, init));
    await s.flow.save(); await s.flow.save();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'unknown', sent: true, saved: null });
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/save')).toHaveLength(1);
    await s.flow.readBack();
    expect(s.request.mock.calls.at(-1)?.[0]).toBe(`/api/capture/${s.input.conversationId}`);
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'saved', saved: s.saved });
  });
  it('does not accept a wrong ID, workspace or unhashed body even in a success envelope', async () => {
    for (const change of [{ id: 'other' }, { workspaceId: 'other' }, { segments: [{ id: 'x', role: 'source', text: 'changed' }] }, { issueNumber: undefined }]) {
      const s = await setup(); await s.flow.prepare(s.input);
      s.request.mockResolvedValueOnce(ok(s.approval)).mockResolvedValueOnce(ok({ ...s.saved, ...change }));
      await s.flow.save();
      expect(s.flow.getSnapshot()).toMatchObject({ phase: 'unknown', saved: null });
    }
  });
  it('cancellation during a write retains unknown state when revocation is not confirmed', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    const gate = deferred<ApiResponse<unknown>>();
    s.request.mockResolvedValueOnce(ok(s.approval)).mockImplementationOnce(() => gate.promise).mockResolvedValueOnce(ok({ revoked: false }));
    const pending = s.flow.save();
    await vi.waitFor(() => expect(s.flow.getSnapshot().phase).toBe('saving'));
    await s.flow.cancel(); gate.resolve(ok(s.saved)); await pending;
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'unknown', saved: null });
    expect(s.flow.getSnapshot().message).not.toContain('批准已撤回');
  });
  it('does not let a read-back response repopulate a disposed page', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockResolvedValueOnce(ok(s.approval)).mockRejectedValueOnce(new Error('lost'));
    await s.flow.save();
    const gate = deferred<ApiResponse<unknown>>(); s.request.mockImplementationOnce(() => gate.promise);
    const pending = s.flow.readBack(); s.flow.dispose();
    const afterDispose = s.flow.getSnapshot();
    gate.resolve(ok(s.saved)); await pending;
    expect(s.flow.getSnapshot()).toBe(afterDispose); expect(afterDispose.saved).toBeNull();
  });
  it('allows a new explicit approval only when the service guarantees not_written', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockResolvedValueOnce(ok(s.approval)).mockResolvedValueOnce({ ...failure('FORBIDDEN', '已拒绝'), meta: ok(null).meta });
    await s.flow.save();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'failed', sent: false });
    await s.flow.save();
    expect(s.flow.getSnapshot().phase).toBe('saved');
  });
  it('never writes with an approval that differs from the displayed capture', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockResolvedValueOnce(ok({ ...s.approval, contentHash: 'unseen-content' }));
    await s.flow.save();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'failed', sent: false, saved: null });
    expect(s.request.mock.calls.some(([path]) => path === '/api/capture/save')).toBe(false);
  });
  it('survives a React strict-effect cleanup without replacing idle with cancelled', async () => {
    const s = await setup(); s.flow.dispose(); s.flow.activate();
    expect(s.flow.getSnapshot().phase).toBe('idle');
    await s.flow.prepare(s.input); expect(s.flow.getSnapshot().phase).toBe('ready');
  });
  it('blocks new approvals and leaving when registration has no trustworthy response', async () => {
    for (const response of ['lost', 'malformed', 'unknown']) {
      const s = await setup(); await s.flow.prepare(s.input);
      if (response === 'lost') s.request.mockRejectedValueOnce(new Error('lost'));
      else s.request.mockResolvedValueOnce(response === 'malformed' ? ok({}) : { ...failure('UNKNOWN_RESULT', '未知', 'read_back', 'unknown'), meta: ok(null).meta });
      await s.flow.save(); await s.flow.cancel(); await s.flow.prepare(s.input); await s.flow.save();
      expect(s.flow.getSnapshot()).toMatchObject({ phase: 'unknown', approvalState: 'unknown', sent: false });
      expect(s.flow.getLeaveState()).toBe('blocked');
      expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
    }
  });
  it('keeps a cancelled registration blocked until its late approval is revoked', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    const issued = deferred<ApiResponse<unknown>>(), revoked = deferred<ApiResponse<unknown>>();
    s.request.mockImplementationOnce(() => issued.promise).mockImplementationOnce(() => revoked.promise);
    const pending = s.flow.save();
    await vi.waitFor(() => expect(s.request.mock.calls.some(([path]) => path === '/api/capture/approve')).toBe(true));
    await s.flow.cancel();
    expect(s.flow.getLeaveState()).toBe('blocked'); await s.flow.save();
    issued.resolve(ok(s.approval));
    await vi.waitFor(() => expect(s.flow.getSnapshot().approvalState).toBe('revoking'));
    expect(s.flow.getLeaveState()).toBe('blocked');
    revoked.resolve(ok({ revoked: true })); await pending;
    expect(s.flow.getLeaveState()).toBe('dirty');
    expect(s.request.mock.calls.some(([path]) => path === '/api/capture/save')).toBe(false);
  });
  it('retains the original approval after failed revocation and retries only revocation', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockResolvedValueOnce(ok(s.approval)).mockResolvedValueOnce({ ...failure('FORBIDDEN', '未写入'), meta: ok(null).meta }).mockResolvedValueOnce(ok({ revoked: false }));
    await s.flow.save(); await s.flow.save();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'unknown', approvalId: s.approval.id, approvalState: 'unknown', sent: false });
    expect(s.flow.getLeaveState()).toBe('blocked');
    await s.flow.cancel();
    expect(s.flow.getLeaveState()).toBe('dirty');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/revoke'))).toHaveLength(2);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
  });
  it('does not race readback against a still-pending revocation response', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockResolvedValueOnce(ok(s.approval)).mockRejectedValueOnce(new Error('lost write'));
    await s.flow.save();
    const revoked = deferred<ApiResponse<unknown>>(); s.request.mockImplementationOnce(() => revoked.promise);
    const cancelled = s.flow.cancel(); await s.flow.readBack();
    expect(s.request.mock.calls.some(([path]) => path === `/api/capture/${s.input.conversationId}`)).toBe(false);
    revoked.resolve(ok({ revoked: true })); await cancelled; await s.flow.readBack();
    expect(s.flow.getSnapshot().phase).toBe('saved'); expect(s.flow.getLeaveState()).toBe('clean');
  });
  it('recovers lost registration by the full original request without automatically writing or revoking', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockRejectedValueOnce(new Error('lost approval')); await s.flow.save();
    const original = s.flow.getSnapshot().registrationIdentity!;
    const body = ConversationApprovalRequestSchema.parse(JSON.parse(String(s.request.mock.calls.find(([path]) => path === '/api/capture/approve')![1]!.body)));
    expect(original).toMatchObject({ operationId: body.operationId, actorId: ctx.actorId, requestHash: await contentHash(body) });
    await s.flow.readApprovalRegistration(); await s.flow.save();
    expect(s.flow.getSnapshot()).toMatchObject({ approvalId: s.approval.id, approvalState: 'active', phase: 'unknown', sent: false });
    expect(s.flow.getLeaveState()).toBe('blocked');
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
    expect(s.request.mock.calls.some(([path]) => path === '/api/capture/save' || path.endsWith('/revoke'))).toBe(false);
    await s.flow.cancel(); expect(s.flow.getLeaveState()).toBe('dirty');
  });
  it('continues a recovered original save only after an explicit action and never registers or writes twice', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockRejectedValueOnce(Error('Lost registration response')); await s.flow.save();
    const identity = s.flow.getSnapshot().registrationIdentity!;
    const normal = s.request.getMockImplementation()!;
    const registration = { operationId: identity.operationId, purpose: identity.purpose, actorId: identity.actorId, workspaceId: identity.workspaceId, requestHash: identity.requestHash, status: 'registered', approval: s.approval, absenceIsFinal: false };
    s.request.mockImplementation((path, init) => path.includes('/approval-registrations/') ? Promise.resolve(ok(registration)) : normal(path, init));
    await s.flow.readApprovalRegistration();
    expect(s.request.mock.calls.some(([path]) => path === '/api/capture/save')).toBe(false);
    await Promise.all([s.flow.continueOriginal(), s.flow.continueOriginal()]);
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'saved', approvalId: s.approval.id, registrationIdentity: identity });
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/save')).toHaveLength(1);
    expect(JSON.parse(String(s.request.mock.calls.find(([path]) => path === '/api/capture/save')![1]!.body))).toEqual(JSON.parse(JSON.stringify({ approval: s.approval, conversation: s.preview.conversation, confirmed: true })));
    await s.flow.continueOriginal();
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/save')).toHaveLength(1);
  });
  it.each(['changed_preview', 'expired', 'unknown_registration'])('refuses original-save continuation after %s', async (fault) => {
    const s = await setup(); await s.flow.prepare(s.input);
    s.request.mockRejectedValueOnce(Error('Lost registration response')); await s.flow.save();
    const identity = s.flow.getSnapshot().registrationIdentity!;
    const registration = { operationId: identity.operationId, purpose: identity.purpose, actorId: identity.actorId, workspaceId: identity.workspaceId, requestHash: identity.requestHash, status: 'registered', approval: s.approval, absenceIsFinal: false };
    const normal = s.request.getMockImplementation()!;
    s.request.mockImplementation((path, init) => path.includes('/operation-recovery/capture/') ? Promise.resolve(ok({ ...s.recoveryFor(identity.operationId), stage: fault === 'expired' ? 'expired' : fault === 'unknown_registration' ? 'not_registered' : 'done', ...(fault === 'unknown_registration' ? { approvalId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null } : {}) })) : path.includes('/approval-registrations/') ? Promise.resolve(ok(fault === 'expired' ? { ...registration, status: 'expired' } : fault === 'unknown_registration' ? { ...registration, status: 'not_registered', approval: null, requestHash: null } : registration)) : normal(path, init));
    await s.flow.readApprovalRegistration();
    if (fault === 'changed_preview') s.flow.getSnapshot().preview!.conversation.segments[0]!.text = 'Changed after original consent';
    await s.flow.continueOriginal();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'unknown', sent: false });
    expect(s.flow.getLeaveState()).toBe('blocked');
    expect(s.request.mock.calls.some(([path]) => path === '/api/capture/save' || path.endsWith('/revoke'))).toBe(false);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
  });
  it('keeps non-final absence locked, then ignores an old registration response after explicit recovery and revocation', async () => {
    const s = await setup(); await s.flow.prepare(s.input);
    const gate = deferred<ApiResponse<unknown>>(); s.request.mockImplementationOnce(() => gate.promise);
    const pending = s.flow.save();
    await vi.waitFor(() => expect(s.flow.getSnapshot().registrationIdentity).not.toBeNull());
    const original = s.flow.getSnapshot().registrationIdentity!;
    const registration = { operationId: original.operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'save_conversation', absenceIsFinal: false };
    s.request.mockResolvedValueOnce(ok({ ...await s.recoveryFor(original.operationId), stage: 'not_registered', approvalId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null }))
      .mockResolvedValueOnce(ok({ ...registration, status: 'not_registered', approval: null, requestHash: null }));
    await s.flow.readApprovalRegistration(); await s.flow.save();
    expect(s.flow.getLeaveState()).toBe('blocked');
    s.request.mockResolvedValueOnce(ok(await s.recoveryFor(original.operationId))).mockResolvedValueOnce(ok({ ...registration, status: 'registered', approval: s.approval, requestHash: original.requestHash }));
    await s.flow.readApprovalRegistration(); await s.flow.cancel(); await s.flow.prepare(s.input);
    const latest = s.flow.getSnapshot(); gate.resolve(ok(s.approval)); await pending;
    expect(s.flow.getSnapshot()).toBe(latest);
    expect(s.request.mock.calls.some(([path]) => path === '/api/capture/save')).toBe(false);
  });
  it('refuses a server preview that silently changes selected content even with a valid new hash', async () => {
    const s = await setup();
    const changed = { ...s.preview.conversation, segments: [...s.input.segments, { id: 'unselected', role: 'source' as const, text: 'UNSELECTED_PRIVATE_FIXTURE' }] };
    changed.contentHash = await hashConversation(changed);
    s.request.mockResolvedValueOnce(ok({ ...s.preview, conversation: changed, approvalRequest: { ...s.preview.approvalRequest, contentHash: changed.contentHash } }));
    await s.flow.prepare(s.input); await s.flow.save();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'failed', preview: null, sent: false });
    expect(s.request.mock.calls.some(([path]) => path === '/api/capture/approve')).toBe(false);
  });
  it('refuses preview changes to role, source origin, task, target Issue, or approval purpose', async () => {
    for (const field of ['role', 'origin', 'task', 'workspace', 'target', 'purpose', 'shape']) {
      const s = await setup(); const changed = structuredClone(s.preview);
      if (field === 'role') changed.conversation.segments[0]!.role = 'assistant';
      if (field === 'origin') changed.conversation.origin = 'manual';
      if (field === 'task') changed.task.question = 'UNSEEN_TASK';
      if (field === 'workspace') changed.task.workspaceId = 'foreign';
      if (field === 'target') changed.conversation.issueNumber = 100;
      if (field === 'purpose') changed.approvalRequest.purpose = 'model_input';
      if (field === 'shape') changed.conversation.segments = [];
      changed.conversation.contentHash = await hashConversation(changed.conversation);
      changed.approvalRequest.contentHash = changed.conversation.contentHash;
      s.request.mockResolvedValueOnce(ok(changed));
      await s.flow.prepare(s.input);
      expect(s.flow.getSnapshot(), field).toMatchObject({ phase: 'failed', preview: null });
    }
  });
});
