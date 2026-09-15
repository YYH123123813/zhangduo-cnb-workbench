import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import { ConversationApprovalRequestSchema, type ApprovalRegistrationState } from '../../contracts/approval';
import { ModelApprovalRequestSchema } from '../../contracts/model';
import { CONTRACT_VERSION, type Approval } from '../../contracts/domain';
import { contentHash, hashConversation } from '../../contracts/hash';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import { conversation, ctx, sessionFixture } from './fixtures.test-support';
import { checkRegistrationContinuation, prepareRegistration, readRegistration } from './approval-registration';

function ok<T>(data: T): ApiResponse<T> { return { ok: true, data, meta: { mode: 'fixture', requestId: 'fixture', contractVersion: CONTRACT_VERSION } }; }
async function setup(model = false) {
  const source = { ...conversation, contentHash: await hashConversation(conversation) };
  const body = model ? ModelApprovalRequestSchema.parse({ operationId: 'extract-registration', input: { purpose: 'extract', text: 'Selected input', sourceIds: ['segment-1'] }, objectIds: ['segment-1'], baseRevision: source.contentHash, conversationId: source.id, confirmed: true })
    : ConversationApprovalRequestSchema.parse({ operationId: 'save-registration', conversation: source, baseRevision: 'new', confirmed: true });
  const request = vi.fn(async (_path: string, _init?: RequestInit): Promise<ApiResponse<unknown>> => ok({ actorId: ctx.actorId, workspace: { id: ctx.workspaceId, slug: 'fixture/capture', mode: 'fixture', visibility: 'private' }, scopes: ctx.scopes }));
  const prepared = await prepareRegistration(request, body, ctx.workspaceId);
  if (!prepared.ok) throw Error('Expected original registration identity');
  const identity = prepared.data;
  const approval: Approval = { ...identity.expected, actorId: ctx.actorId, workspaceId: ctx.workspaceId, id: 'original-approval', approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const registration: ApprovalRegistrationState = { operationId: body.operationId!, purpose: identity.purpose, ...(model ? { modelPurpose: 'extract' as const } : {}), actorId: ctx.actorId, workspaceId: ctx.workspaceId, requestHash: identity.requestHash, status: 'registered', approval, absenceIsFinal: false };
  const recovery: OperationRecovery = { kind: model ? 'model' : 'capture', operationId: body.operationId!, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
    approvalId: approval.id, recordId: null, purpose: model ? 'extract' : 'save_conversation', requestHash: identity.requestHash,
    contentHash: approval.contentHash, baseRevision: approval.baseRevision, objectIds: approval.objectIds, approvalExpiresAt: approval.expiresAt,
    stage: model ? 'done' : 'done', readOnly: true, absenceIsFinal: false };
  request.mockClear(); request.mockImplementation(async (path) => path.includes('/operation-recovery/') ? ok(recovery) : ok(registration));
  return { body, request, identity, registration, approval, recovery };
}

describe('C07 exact original approval registration metadata', () => {
  it.each([false, true])('hashes the complete shared-schema request and reads only its original purpose/ID (model=%s)', async (model) => {
    const s = await setup(model);
    expect(s.identity.requestHash).toBe(await contentHash(s.body));
    expect(s.identity.requestHash).not.toBe(s.approval.contentHash);
    expect(await readRegistration(s.request, s.identity)).toEqual({ ok: true, data: s.registration });
    expect(s.request.mock.calls[0]![0]).toBe(`${model ? '/api/workspace/operation-recovery/model/' : '/api/workspace/operation-recovery/capture/'}${s.body.operationId}${model ? '?modelPurpose=extract' : ''}`);
    expect(s.request.mock.calls[1]![0]).toBe(`/api/workspace/approval-registrations/${s.identity.purpose}/${s.body.operationId}${model ? '?modelPurpose=extract' : ''}`);
    expect(s.request.mock.calls.every(([, init]) => !init?.body && (!init?.method || init.method === 'GET'))).toBe(true);
  });
  it('rejects changed operation, purpose, model purpose, actor, workspace, full request and approval scope', async () => {
    const s = await setup(true);
    const changes = [{ operationId: 'another' }, { purpose: 'save_conversation' }, { modelPurpose: 'answer' }, { actorId: 'another' }, { workspaceId: 'another' }, { requestHash: s.approval.contentHash },
      ...[{ actorId: 'another' }, { workspaceId: 'another' }, { purpose: 'save_conversation' }, { objectIds: ['unselected'] }, { contentHash: 'another' }, { baseRevision: 'another' }].map((change) => ({ approval: { ...s.approval, ...change } }))];
    for (const change of changes) {
      s.request.mockResolvedValueOnce(ok({ ...s.registration, ...change }));
      expect(await readRegistration(s.request, s.identity), JSON.stringify(change)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    }
  });
  it('does not turn not_registered or unknown into final absence and never writes during readback', async () => {
    const s = await setup();
    for (const status of ['not_registered', 'unknown']) {
      s.request.mockResolvedValueOnce(ok({ ...s.recovery, stage: status === 'not_registered' ? 'not_registered' : 'unknown', approvalId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null }))
        .mockResolvedValueOnce(ok({ ...s.registration, status, approval: null, requestHash: null }));
      expect(await readRegistration(s.request, s.identity)).toMatchObject({ ok: true, data: { status, absenceIsFinal: false } });
    }
    s.request.mockResolvedValueOnce(ok({ ...s.recovery, status: 'not_registered', approvalId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null, absenceIsFinal: true }));
    expect(await readRegistration(s.request, s.identity)).toMatchObject({ ok: false });
    expect(s.request.mock.calls.every(([, init]) => !init?.body)).toBe(true);
  });
  it('recognizes original revoked/expired metadata without requiring a still-usable approval', async () => {
    const s = await setup();
    for (const status of ['revoked', 'expired']) {
      s.request.mockResolvedValueOnce(ok({ ...s.recovery, stage: status, approvalExpiresAt: '2020-01-02T00:00:00.000Z' }))
        .mockResolvedValueOnce(ok({ ...s.registration, status, approval: { ...s.approval, approvedAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-02T00:00:00Z' } }));
      expect(await readRegistration(s.request, s.identity)).toMatchObject({ ok: true, data: { status, approval: { id: s.approval.id } } });
    }
  });
  it('rejects stale registered status for an already expired approval', async () => {
    const s = await setup();
    s.request.mockResolvedValueOnce(ok(s.recovery)).mockResolvedValueOnce(ok({ ...s.registration, approval: { ...s.approval, approvedAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-02T00:00:00Z' } }));
    expect(await readRegistration(s.request, s.identity)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
  });
  it.each(['actor', 'scope', 'approval', 'cancel'])('rechecks original continuation against %s changes without any write', async (fault) => {
    const s = await setup(true), controller = new AbortController();
    s.request.mockImplementation(async (path) => {
      if (path.endsWith('/session')) return ok(fault === 'actor' ? { ...sessionFixture, actorId: 'another-actor' } : fault === 'scope' ? { ...sessionFixture, scopes: ['workspace:read'] } : sessionFixture);
      if (fault === 'cancel') controller.abort();
      if (path.includes('/operation-recovery/')) return ok(s.recovery);
      return ok(fault === 'approval' ? { ...s.registration, approval: { ...s.approval, id: 'another-approval' } } : s.registration);
    });
    expect(await checkRegistrationContinuation(s.request, s.body, { identity: s.identity, approvalId: s.approval.id }, controller.signal)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    expect(s.request.mock.calls.every(([, init]) => !init?.body)).toBe(true);
  });
  it('refuses registration before a valid original session identity is obtained', async () => {
    const s = await setup();
    for (const response of [{}, { actorId: 'other', workspace: { id: 'other', slug: 'fixture/other', visibility: 'private', mode: 'fixture' }, scopes: ctx.scopes }]) {
      s.request.mockResolvedValueOnce(ok(response));
      expect(await prepareRegistration(s.request, s.body, ctx.workspaceId)).toMatchObject({ ok: false, error: { dataState: 'not_written' } });
    }
    expect(s.request.mock.calls.every(([, init]) => !init?.body)).toBe(true);
  });
});
