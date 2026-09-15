import type { ApiResponse, Result } from '../../contracts/api';
import { ApprovalRegistrationStateSchema, ConversationApprovalRequestSchema, type ApprovalRegistrationQuery, type ApprovalRegistrationState, type ConversationApprovalRequest } from '../../contracts/approval';
import { ApprovalSchema, type Approval } from '../../contracts/domain';
import { ModelApprovalRequestSchema, type ModelApprovalRequest } from '../../contracts/model';
import { canonicalJson, contentHash, hashModelInput } from '../../contracts/hash';
import { WorkspaceSessionSchema } from '../../contracts/session';
import type { ApprovalRequest } from './approval';
import { readCaptureOperationRecovery, readModelOperationRecovery } from './operation-recovery';
import { failure } from './result';

type Transport = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
export type RegistrationIdentity = ApprovalRegistrationQuery & { actorId: string; workspaceId: string; requestHash: string; expected: ApprovalRequest };
export interface RegistrationContinuation { identity: RegistrationIdentity; approvalId: string }

export async function prepareRegistration(request: Transport, original: ConversationApprovalRequest | ModelApprovalRequest, workspaceId: string, signal?: AbortSignal): Promise<Result<RegistrationIdentity>> {
  try {
    // Hash the shared schema's exact wire payload, including operationId and confirmation.
    const wire: unknown = JSON.parse(JSON.stringify(original));
    const body = 'conversation' in original ? ConversationApprovalRequestSchema.parse(wire) : ModelApprovalRequestSchema.parse(wire);
    if (!body.operationId) return failure('VALIDATION', '本次批准缺少稳定登记ID。');
    const response = await request('/api/workspace/session', { signal });
    if (!response.ok) return { ok: false, error: { ...response.error, dataState: 'not_written' } };
    const session = WorkspaceSessionSchema.safeParse(response.data);
    const saving = 'conversation' in body;
    if (!session.success || session.data.workspace.id !== workspaceId || session.data.workspace.mode === 'unconfigured' || !session.data.scopes.includes(saving ? 'conversation:write' : 'model:extract'))
      return failure('FORBIDDEN', '原工作区身份或批准权限尚未核验；未申请批准。', 'check_permissions');
    const expected: ApprovalRequest = saving
      ? { purpose: 'save_conversation', objectIds: [body.conversation.id], contentHash: body.conversation.contentHash, baseRevision: body.baseRevision }
      : { purpose: 'model_input', objectIds: body.objectIds, contentHash: await hashModelInput(body.input), baseRevision: body.baseRevision };
    return { ok: true, data: { operationId: body.operationId, purpose: expected.purpose as 'save_conversation' | 'model_input', ...(!saving ? { modelPurpose: body.input.purpose } : {}),
      actorId: session.data.actorId, workspaceId, requestHash: await contentHash(body), expected } };
  } catch { return failure('UPSTREAM', '原工作区身份或批准请求尚未核验；未申请批准。', 'retry_read'); }
}

export function matchesRegistrationApproval(approval: Approval, original: RegistrationIdentity): boolean {
  const expected = original.expected;
  return approval.actorId === original.actorId && approval.workspaceId === original.workspaceId && approval.purpose === expected.purpose
    && approval.contentHash === expected.contentHash && approval.baseRevision === expected.baseRevision
    && canonicalJson(approval.objectIds) === canonicalJson(expected.objectIds)
    && Date.parse(approval.expiresAt) > Date.parse(approval.approvedAt) && Date.parse(approval.approvedAt) <= Date.now();
}

async function readDetailedRegistration(request: Transport, original: RegistrationIdentity, signal?: AbortSignal): Promise<Result<ApprovalRegistrationState>> {
  const unknown = () => failure<ApprovalRegistrationState>('UNKNOWN_RESULT', '原批准登记未核验；不会重新申请、写入或发送模型。', 'read_approval_state', 'unknown');
  try {
    const suffix = original.modelPurpose ? `?modelPurpose=${original.modelPurpose}` : '';
    const result = await request(`/api/workspace/approval-registrations/${original.purpose}/${encodeURIComponent(original.operationId)}${suffix}`, { signal });
    if (!result.ok) return { ok: false, error: { ...result.error, dataState: 'unknown' } };
    const parsed = ApprovalRegistrationStateSchema.safeParse(result.data);
    if (!parsed.success) return unknown();
    const value = parsed.data;
    if (value.operationId !== original.operationId || value.purpose !== original.purpose || value.modelPurpose !== original.modelPurpose
      || value.actorId !== original.actorId || value.workspaceId !== original.workspaceId) return unknown();
    if (value.approval && (value.requestHash !== original.requestHash || !ApprovalSchema.safeParse(value.approval).success || !matchesRegistrationApproval(value.approval, original))) return unknown();
    if (value.status === 'registered' && Date.parse(value.approval!.expiresAt) <= Date.now()) return unknown();
    return { ok: true, data: value };
  } catch { return unknown(); }
}

function matchesRecoveryRegistration(recovery: Awaited<ReturnType<typeof readCaptureOperationRecovery>>, registration: ApprovalRegistrationState): boolean {
  if (!recovery.ok) return false;
  const value = recovery.data;
  if (value.approvalId !== (registration.approval?.id ?? null) || value.requestHash !== registration.requestHash) return false;
  if (value.stage === 'not_registered') return registration.status === 'not_registered';
  if (value.stage === 'unknown') return registration.status === 'unknown';
  if (value.stage === 'revoked') return registration.status === 'revoked';
  if (value.stage === 'expired') return registration.status === 'expired';
  return ['approved', 'sending', 'saved', 'executed', 'done'].includes(value.stage) && registration.status === 'registered';
}

export async function readRegistration(request: Transport, original: RegistrationIdentity, signal?: AbortSignal): Promise<Result<ApprovalRegistrationState>> {
  const recovery = original.purpose === 'model_input'
    ? await readModelOperationRecovery(request, {
      operationId: original.operationId, actorId: original.actorId, workspaceId: original.workspaceId, purpose: 'extract',
      requestHash: original.requestHash, contentHash: original.expected.contentHash, baseRevision: original.expected.baseRevision,
      objectIds: original.expected.objectIds,
    }, signal)
    : await readCaptureOperationRecovery(request, {
      operationId: original.operationId, actorId: original.actorId, workspaceId: original.workspaceId,
      purpose: 'save_conversation', requestHash: original.requestHash, contentHash: original.expected.contentHash,
      baseRevision: original.expected.baseRevision, objectIds: original.expected.objectIds,
    }, signal);
  if (!recovery.ok) return recovery;

  const registration = await readDetailedRegistration(request, original, signal);
  if (!registration.ok) return registration;
  if (!matchesRecoveryRegistration(recovery, registration.data)) return failure('UNKNOWN_RESULT', '统一恢复元数据与批准登记详情不一致；不会继续现场写入。', 'read_approval_state', 'unknown');
  return registration;
}

export async function checkRegistrationContinuation(request: Transport, body: ConversationApprovalRequest | ModelApprovalRequest, continuation: RegistrationContinuation, signal: AbortSignal): Promise<Result<Approval>> {
  const unknown = () => failure<Approval>('UNKNOWN_RESULT', '原会话、请求范围或有效批准未核验；未继续执行，请核验或撤回原批准。', 'read_approval_state', 'unknown');
  const current = await prepareRegistration(request, body, continuation.identity.workspaceId, signal);
  if (signal.aborted || !current.ok || canonicalJson(current.data) !== canonicalJson(continuation.identity)) return unknown();
  const result = await readRegistration(request, continuation.identity, signal);
  if (signal.aborted || !result.ok || result.data.status !== 'registered' || result.data.approval?.id !== continuation.approvalId) return unknown();
  return { ok: true, data: result.data.approval };
}
