import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import { CONTRACT_VERSION, type Approval } from '../../contracts/domain';
import { conversation, ctx, withFixtureSession } from './fixtures.test-support';
import { composeModelInput, PROMPT_VERSION, type ModelPreview, type ModelScope } from './model-input';
import { hashConversation, hashModelInput } from '../../contracts/hash';
import { sendModelInput, type ModelSendEvent } from './model-send';
import { CaptureModelFlow } from './model-flow';
import { HashNavigation } from '../../app/routing';
import { contentHash } from '../../contracts/hash';
import { ModelApprovalRequestSchema } from '../../contracts/model';
import type { OperationRecovery } from '../../contracts/operation-recovery';

function ok<T>(data: T): ApiResponse<T> { return { ok: true, data, meta: { mode: 'fixture', contractVersion: CONTRACT_VERSION, requestId: 'fixture' } }; }
async function setup() {
  const value = structuredClone(conversation); value.contentHash = await hashConversation(value);
  const scope: ModelScope = { task: { id: conversation.taskId, workspaceId: ctx.workspaceId, question: '问题', constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() }, segmentIds: ['segment-1'], scopeConfirmed: true };
  const input = composeModelInput(scope.task, [value.segments[0]!]);
  const preview: ModelPreview = { input, promptVersion: PROMPT_VERSION, approvalRequest: { purpose: 'model_input', objectIds: scope.segmentIds, baseRevision: value.contentHash, contentHash: await hashModelInput(input) } };
  const approval: Approval = { ...preview.approvalRequest, id: 'fixture-model-approval', workspaceId: ctx.workspaceId, actorId: ctx.actorId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const delivery = { conversationId: value.id, conversationHash: value.contentHash, candidates: [], state: 'empty', batch: { conversationId: value.id, conversationHash: value.contentHash, candidates: [], state: 'available', revision: 1, retentionDays: 7, modelApprovalId: approval.id, expiresAt: new Date(Date.now() + 86400000).toISOString() }, handoffHref: `#handoff?conversationId=${value.id}` };
  const extraction = { operationId: approval.id, modelApprovalId: approval.id, actorId: approval.actorId, workspaceId: approval.workspaceId,
    conversationId: value.id, conversationHash: value.contentHash, inputHash: approval.contentHash, sourceIds: scope.segmentIds,
    stage: 'saved_empty', settingsRevision: 0, batchRevision: 1, candidateContentHash: await contentHash([]), updatedAt: new Date().toISOString(), retryAllowed: false };
  const registrationFor = async (operationId: string, status: 'registered' | 'revoked' | 'expired' | 'not_registered' | 'unknown' = 'registered') => {
    const body = ModelApprovalRequestSchema.parse({ input: preview.input, objectIds: preview.approvalRequest.objectIds, baseRevision: preview.approvalRequest.baseRevision, conversationId: value.id, operationId, confirmed: true });
    const requestHash = ['registered', 'revoked', 'expired'].includes(status) ? await contentHash(body) : null;
    return { operationId, purpose: 'model_input' as const, modelPurpose: 'extract' as const, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
      requestHash, status, approval: requestHash ? approval : null, absenceIsFinal: false };
  };
  const recoveryFor = async (operationId: string, stage: OperationRecovery['stage'] = 'done'): Promise<OperationRecovery> => ({
    kind: 'model', operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, approvalId: approval.id, recordId: null,
    purpose: 'extract', requestHash: (await registrationFor(operationId)).requestHash, contentHash: approval.contentHash, baseRevision: approval.baseRevision,
    objectIds: approval.objectIds, approvalExpiresAt: approval.expiresAt, stage, readOnly: true, absenceIsFinal: false,
  });
  const request = vi.fn(async (path: string, _init?: RequestInit): Promise<ApiResponse<unknown>> => path.endsWith('/model-approve') ? ok(approval)
    : path.endsWith('/revoke') ? ok({ revoked: true }) : path.includes('/operation-recovery/model/') ? ok(await recoveryFor(decodeURIComponent(path.split('/').pop()!.split('?')[0]!)))
      : path.includes('/approval-registrations/model_input/') ? ok(await registrationFor(decodeURIComponent(path.split('/').pop()!.split('?')[0]!)))
        : path.includes('/extraction-operations/') ? ok(extraction) : ok(delivery));
  const controller = new AbortController(); const onSent = vi.fn();
  const events: ModelSendEvent[] = [];
  const transport = withFixtureSession(request);
  return { value, scope, preview, approval, extraction, delivery, request, transport, controller, onSent, events, registrationFor, recoveryFor, run: () => sendModelInput(transport, value, scope, preview, controller.signal, onSent, (event) => events.push(event)) };
}
describe('C09 model approval cancellation and displayed-input binding', () => {
  it('submits displayed hashes and scope without client-supplied model text', async () => {
    const s = await setup(); expect((await s.run()).ok).toBe(true);
    expect(JSON.parse(s.request.mock.calls[0]![1]!.body as string)).toEqual({ ...s.scope, operationId: expect.any(String), expectedInputHash: s.preview.approvalRequest.contentHash, expectedConversationHash: s.preview.approvalRequest.baseRevision, retentionDays: 7, confirmed: true });
  });
  it('does not request approval or extraction after an earlier stop', async () => {
    const s = await setup(); s.controller.abort();
    expect((await s.run()).ok).toBe(false); expect(s.request).not.toHaveBeenCalled();
  });
  it('observes and revokes late approval after cancellation without sending model content', async () => {
    const s = await setup(); let release!: (value: ApiResponse<unknown>) => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    s.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; entered(); }));
    const pending = s.run(); await started; s.controller.abort(); release(ok(s.approval));
    expect((await pending).ok).toBe(false);
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/revoke'))).toBe(true);
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/extract'))).toBe(false);
    expect(s.onSent).not.toHaveBeenCalled();
  });
  it('rejects approvals that do not bind the displayed input, workspace, source or expiry', async () => {
    for (const change of [{ contentHash: 'new-unseen-input' }, { workspaceId: 'other' }, { objectIds: ['unselected'] }, { baseRevision: 'changed' }, { expiresAt: '2020-01-01T00:00:00Z' }]) {
      const s = await setup(); s.request.mockResolvedValueOnce(ok({ ...s.approval, ...change }));
      expect((await s.run()).ok).toBe(false); expect(s.onSent).not.toHaveBeenCalled();
      expect(s.request.mock.calls.some(([path]) => path.endsWith('/extract'))).toBe(false);
    }
  });
  it('classifies lost extraction responses as unknown without retrying', async () => {
    const s = await setup(); s.request.mockResolvedValueOnce(ok(s.approval)).mockRejectedValueOnce(new Error('lost'));
    expect(await s.run()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(s.onSent).toHaveBeenCalledOnce(); expect(s.request).toHaveBeenCalledTimes(2);
  });
  it('cancels an in-flight extraction and exposes unknown even if the server later returns success', async () => {
    const s = await setup(); s.request.mockResolvedValueOnce(ok(s.approval)).mockImplementationOnce(async () => { s.controller.abort(); return ok(s.delivery); });
    expect(await s.run()).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/revoke'))).toBe(true);
  });
  it('checks the delivered conversation and version before displaying a success', async () => {
    for (const change of [{ conversationId: 'other' }, { conversationHash: 'stale' }, { candidates: [{ state: 'accepted' }] }]) {
      const s = await setup(); s.request.mockResolvedValueOnce(ok(s.approval)).mockResolvedValueOnce(ok({ ...s.delivery, ...change }));
      expect(await s.run()).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    }
    const s = await setup(); expect(await s.run()).toMatchObject({ ok: true, data: s.delivery });
  });
  it('rejects a preview that displays different text before requesting any approval', async () => {
    const s = await setup(); s.preview.input.text = 'UNREVIEWED_TEXT';
    expect(await s.run()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.request).not.toHaveBeenCalled(); expect(s.onSent).not.toHaveBeenCalled();
  });
  it('retains unknown registration when the approval response is lost or malformed', async () => {
    for (const malformed of [true, false]) {
      const s = await setup();
      if (malformed) s.request.mockResolvedValueOnce(ok({})); else s.request.mockRejectedValueOnce(new Error('lost approval'));
      expect(await s.run()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
      expect(s.events).toContainEqual({ kind: 'registration', state: 'pending' });
      expect(s.events.at(-1)).toEqual({ kind: 'registration', state: 'unknown' });
      expect(s.onSent).not.toHaveBeenCalled();
    }
  });
  it('exposes the original approval and failed late revocation for recovery', async () => {
    const s = await setup();
    s.request.mockImplementationOnce(async () => { s.controller.abort(); return ok(s.approval); }).mockResolvedValueOnce(ok({ revoked: false }));
    expect(await s.run()).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    expect(s.events).toContainEqual({ kind: 'registration', state: 'active', approval: s.approval });
    expect(s.events.at(-1)).toEqual({ kind: 'revocation', state: 'unknown' });
    expect(s.onSent).not.toHaveBeenCalled();
  });
});

describe('C12 model state and shared navigation', () => {
  it('blocks same-page navigation and unload after unknown registration without repeating approval', async () => {
    const s = await setup(); const flow = new CaptureModelFlow(s.transport, s.value);
    const host = { write: vi.fn(), confirmDiscard: vi.fn(() => true) }, blocked = vi.fn();
    const navigation = new HashNavigation('#capture', host);
    const unregister = navigation.registerLeaveGuard({ owner: 'capture', getState: flow.getLeaveState, onBlocked: blocked });
    s.request.mockRejectedValueOnce(new Error('lost approval')); await flow.send(s.scope, s.preview);
    expect(navigation.navigate('#capture?conversationId=other')).toBe(false);
    expect(navigation.shouldWarnBeforeUnload()).toBe(true); expect(blocked).toHaveBeenCalledOnce(); expect(host.confirmDiscard).not.toHaveBeenCalled();
    await flow.cancel(); await flow.send(s.scope, s.preview);
    expect(s.request).toHaveBeenCalledOnce(); expect(flow.getLeaveState()).toBe('blocked');
    unregister(); expect(navigation.shouldWarnBeforeUnload()).toBe(false);
  });
  it('retains original approval after failed revocation and unlocks only after explicit retry', async () => {
    const s = await setup(); const flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockImplementationOnce(async () => { void flow.cancel(); return ok(s.approval); }).mockResolvedValueOnce(ok({ revoked: false }));
    await flow.send(s.scope, s.preview);
    expect(flow.getSnapshot()).toMatchObject({ approval: s.approval, registration: 'unknown', sent: false });
    expect(flow.getLeaveState()).toBe('blocked'); await flow.cancel();
    expect(flow.getLeaveState()).toBe('clean'); expect(s.request.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
  });
  it('recovers an empty original batch by readback, then allows handoff without another send', async () => {
    const s = await setup(); const flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockResolvedValueOnce(ok(s.approval)).mockRejectedValueOnce(new Error('lost extract'));
    await flow.send(s.scope, s.preview); expect(flow.getLeaveState()).toBe('blocked');
    s.request.mockResolvedValueOnce(ok(await s.recoveryFor(flow.getSnapshot().registrationIdentity!.operationId))).mockResolvedValueOnce(ok({ ...s.extraction })).mockResolvedValueOnce(ok(s.delivery));
    await flow.readBack();
    expect(flow.getSnapshot()).toMatchObject({ phase: 'complete', delivery: { state: 'empty' } }); expect(flow.getLeaveState()).toBe('clean');
    await flow.send(s.scope, s.preview);
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/extract'))).toHaveLength(1);
  });
  it('restores by an explicitly supplied original ID without issuing a replacement approval', async () => {
    const s = await setup(); const flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockResolvedValueOnce(ok(await s.recoveryFor(s.approval.id))).mockResolvedValueOnce(ok({ ...s.extraction })).mockResolvedValueOnce(ok(s.delivery));
    await flow.restore(s.approval.id);
    expect(flow.getSnapshot()).toMatchObject({ phase: 'complete', recoveryId: s.approval.id, delivery: { state: 'empty' } });
    expect(flow.getSnapshot().approval).not.toHaveProperty('approvedAt');
    expect(s.request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    await flow.send(s.scope, s.preview); expect(s.request).toHaveBeenCalledTimes(3);
  });
  it('recovers a lost model registration using the shared full hash, then waits for explicit revocation', async () => {
    const s = await setup(); const flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockRejectedValueOnce(new Error('lost model approval')); await flow.send(s.scope, s.preview);
    const identity = flow.getSnapshot().registrationIdentity!;
    const request = ModelApprovalRequestSchema.parse({ input: s.preview.input, objectIds: s.preview.approvalRequest.objectIds, baseRevision: s.value.contentHash, conversationId: s.value.id, operationId: identity.operationId, confirmed: true });
    expect(identity.requestHash).toBe(await contentHash(request));
    s.request.mockResolvedValueOnce(ok(await s.recoveryFor(identity.operationId))).mockResolvedValueOnce(ok(await s.registrationFor(identity.operationId)));
    await flow.readApprovalRegistration(); await flow.send({ ...s.scope, task: { ...s.scope.task, question: 'Changed task' } }, s.preview);
    expect(flow.getSnapshot()).toMatchObject({ registration: 'active', approval: s.approval, sent: false });
    expect(flow.getLeaveState()).toBe('blocked');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/extract') || path.endsWith('/revoke'))).toBe(false);
    await flow.cancel(); expect(flow.getLeaveState()).toBe('clean');
  });
  it('explicitly continues the recovered model approval once without registering a replacement', async () => {
    const s = await setup(), flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockRejectedValueOnce(Error('Lost original approval')); await flow.send(s.scope, s.preview);
    const identity = flow.getSnapshot().registrationIdentity!;
    const registration = { operationId: identity.operationId, purpose: 'model_input', modelPurpose: 'extract', actorId: ctx.actorId, workspaceId: ctx.workspaceId, requestHash: identity.requestHash, status: 'registered', approval: s.approval, absenceIsFinal: false };
    const normal = s.request.getMockImplementation()!;
    s.request.mockImplementation((path, init) => path.includes('/approval-registrations/') ? Promise.resolve(ok(registration)) : normal(path, init));
    await flow.readApprovalRegistration();
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/extract'))).toBe(false);
    await Promise.all([flow.continueOriginal(s.scope, s.preview), flow.continueOriginal(s.scope, s.preview)]);
    expect(flow.getSnapshot()).toMatchObject({ phase: 'complete', registration: 'consumed', approval: s.approval, registrationIdentity: identity, sent: true });
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/extract'))).toHaveLength(1);
    expect(JSON.parse(String(s.request.mock.calls.find(([path]) => path.endsWith('/extract'))![1]!.body))).toMatchObject({ approval: s.approval, task: s.scope.task });
    await flow.continueOriginal(s.scope, s.preview);
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/extract'))).toHaveLength(1);
  });
  it.each(['changed_task', 'changed_valid_preview', 'expired', 'unknown_registration', 'lost_extraction'])('does not turn %s into permission for another model request', async (fault) => {
    const s = await setup(), flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockRejectedValueOnce(Error('Lost original approval')); await flow.send(s.scope, s.preview);
    const identity = flow.getSnapshot().registrationIdentity!;
    const registration = { operationId: identity.operationId, purpose: 'model_input', modelPurpose: 'extract', actorId: ctx.actorId, workspaceId: ctx.workspaceId, requestHash: identity.requestHash, status: 'registered', approval: s.approval, absenceIsFinal: false };
    s.request.mockResolvedValueOnce(ok(await s.recoveryFor(identity.operationId))).mockResolvedValueOnce(ok(registration)); await flow.readApprovalRegistration();
    const scope = fault.startsWith('changed') ? { ...s.scope, task: { ...s.scope.task, question: 'New input is not the original task' } } : s.scope;
    const preview = structuredClone(s.preview);
    if (fault === 'changed_valid_preview') { preview.input = composeModelInput(scope.task, [s.value.segments[0]!]); preview.approvalRequest.contentHash = await hashModelInput(preview.input); }
    s.request.mockResolvedValueOnce(ok(fault === 'expired' ? { ...await s.recoveryFor(identity.operationId), stage: 'expired' }
      : fault === 'unknown_registration' ? { ...await s.recoveryFor(identity.operationId), stage: 'not_registered', approvalId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null }
        : await s.recoveryFor(identity.operationId))).mockResolvedValueOnce(ok(fault === 'expired' ? { ...registration, status: 'expired' }
          : fault === 'unknown_registration' ? { ...registration, status: 'not_registered', approval: null, requestHash: null } : registration));
    if (fault === 'lost_extraction') s.request.mockRejectedValueOnce(Error('Lost extraction response'));
    await flow.continueOriginal(scope, preview); await flow.continueOriginal(scope, preview);
    expect(flow.getSnapshot()).toMatchObject({ phase: 'unknown', sent: fault === 'lost_extraction', delivery: null });
    expect(flow.getLeaveState()).toBe('blocked');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/extract'))).toHaveLength(fault === 'lost_extraction' ? 1 : 0);
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
  });
  it('does not let a late registration overwrite a recovered state or automatically revoke it', async () => {
    const s = await setup(), flow = new CaptureModelFlow(s.transport, s.value);
    let release!: (response: ApiResponse<unknown>) => void;
    s.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = flow.send(s.scope, s.preview);
    await vi.waitFor(() => expect(flow.getSnapshot().registration).toBe('pending'));
    const identity = flow.getSnapshot().registrationIdentity!;
    const registration = { operationId: identity.operationId, purpose: 'model_input', modelPurpose: 'extract', actorId: ctx.actorId, workspaceId: ctx.workspaceId, absenceIsFinal: false };
    s.request.mockResolvedValueOnce(ok({ ...await s.recoveryFor(identity.operationId), stage: 'not_registered', approvalId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null }))
      .mockResolvedValueOnce(ok({ ...registration, requestHash: null, status: 'not_registered', approval: null }));
    await flow.readApprovalRegistration(); await flow.send(s.scope, s.preview);
    expect(flow.getLeaveState()).toBe('blocked');
    s.request.mockResolvedValueOnce(ok(await s.recoveryFor(identity.operationId))).mockResolvedValueOnce(ok({ ...registration, requestHash: identity.requestHash, status: 'registered', approval: s.approval }));
    await flow.readApprovalRegistration(); const recovered = flow.getSnapshot();
    release(ok(s.approval)); await pending;
    expect(flow.getSnapshot()).toBe(recovered);
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/extract') || path.endsWith('/revoke'))).toBe(false);
    await flow.cancel(); expect(flow.getLeaveState()).toBe('clean');
  });
  it('does not release an unknown extraction just because the original registration was revoked', async () => {
    const s = await setup(), flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockResolvedValueOnce(ok(s.approval)).mockRejectedValueOnce(Error('Synthetic lost extraction'));
    await flow.send(s.scope, s.preview);
    const identity = flow.getSnapshot().registrationIdentity!;
    s.request.mockResolvedValueOnce(ok({ ...await s.recoveryFor(identity.operationId), stage: 'revoked' })).mockResolvedValueOnce(ok({ operationId: identity.operationId, purpose: 'model_input', modelPurpose: 'extract', actorId: ctx.actorId, workspaceId: ctx.workspaceId, requestHash: identity.requestHash, status: 'revoked', approval: s.approval, absenceIsFinal: false }));
    await flow.readApprovalRegistration(); await flow.send(s.scope, s.preview);
    expect(flow.getSnapshot()).toMatchObject({ registration: 'revoked', sent: true, phase: 'unknown', delivery: null });
    expect(flow.getLeaveState()).toBe('blocked');
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/extract'))).toHaveLength(1);
  });
  it('fails closed after discovery is unknown and only an explicit read-only retry can unlock sending', async () => {
    const s = await setup();
    const flow = new CaptureModelFlow(s.transport, s.value);
    s.request.mockRejectedValueOnce(new Error('Synthetic discovery failure'));

    await flow.discover();

    expect(flow.getSnapshot()).toMatchObject({ phase: 'unknown', discovery: 'unknown', stage: 'unknown' });
    expect(flow.getLeaveState()).toBe('blocked');
    await flow.send(s.scope, s.preview);
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/model-approve'))).toBe(false);

    s.request.mockResolvedValueOnce(ok({ conversationId: s.value.id, conversationHash: s.value.contentHash, operations: [], absenceIsFinal: false, retryAllowed: false }));
    await flow.discover();
    expect(flow.getSnapshot()).toMatchObject({ phase: 'idle', discovery: 'ready', discovered: [] });
  });

  it('prioritizes an explicit recovery operation over same-content discovery results', async () => {
    const s = await setup();
    const flow = new CaptureModelFlow(s.transport, s.value);
    const discovery = { conversationId: s.value.id, conversationHash: s.value.contentHash, operations: [s.extraction], absenceIsFinal: false, retryAllowed: false };
    s.request.mockResolvedValueOnce(ok(discovery));

    await flow.discover();
    expect(flow.getSnapshot().discovered).toHaveLength(1);
    await flow.restore(s.approval.id);
    expect(s.request.mock.calls.filter(([path]) => path.includes('/operation-recovery/model/'))).toHaveLength(1);
    expect(s.request.mock.calls.some(([path]) => path.endsWith('/model-approve'))).toBe(false);
  });
});
