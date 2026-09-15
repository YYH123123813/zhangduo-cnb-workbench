import { z } from 'zod';
import type { ApiResponse, Result } from '../../contracts/api';
import { ApprovalSchema, CandidateSchema, Id, type Approval, type Conversation } from '../../contracts/domain';
import type { ModelPreview, ModelScope } from './model-input';
import type { DeliveryReceipt } from './delivery';
import { checkStoredCandidates } from './spans';
import { handoffHref } from './links';
import { failure } from './result';
import { checkModelPreview } from './model-preview-receipt';
import { CandidateStateSchema } from '../../contracts/candidates';
import { canonicalJson } from '../../contracts/hash';
import { checkCandidateBatch } from './candidate-batch';
import { ModelApprovalRequestSchema } from '../../contracts/model';
import { checkRegistrationContinuation, prepareRegistration, type RegistrationContinuation, type RegistrationIdentity } from './approval-registration';

type Transport = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
export type ModelSendEvent = { kind: 'identity'; identity: RegistrationIdentity } | { kind: 'registration'; state: 'pending' | 'none' | 'unknown' } | { kind: 'registration'; state: 'active'; approval: Approval } | { kind: 'revocation'; state: 'pending' | 'revoked' | 'unknown' };
const DeliverySchema = z.object({ conversationId: Id, conversationHash: Id, candidates: z.array(CandidateSchema).max(3), state: z.enum(['saved', 'empty', 'existing', 'missing', 'expired', 'unverified']), batch: CandidateStateSchema.optional() });

export async function checkDeliveryReceipt(value: unknown, conversation: Conversation, approvalId?: string): Promise<Result<DeliveryReceipt>> {
  const delivery = DeliverySchema.safeParse(value);
  const invalid = () => failure<DeliveryReceipt>('UNKNOWN_RESULT', '候选回执与当前现场或原提取操作不一致；请先核验候选。', 'read_candidates', 'unknown');
  if (!delivery.success || delivery.data.conversationId !== conversation.id || delivery.data.conversationHash !== conversation.contentHash) return invalid();
  if (delivery.data.batch) {
    const batch = await checkCandidateBatch(delivery.data.batch, conversation); if (!batch.ok) return invalid();
    const expected = batch.data.state === 'available' ? batch.data.candidates.length ? 'existing' : 'empty' : batch.data.state;
    if ((delivery.data.state !== expected && !(delivery.data.state === 'saved' && expected === 'existing')) || canonicalJson(delivery.data.candidates) !== canonicalJson(batch.data.candidates) || (approvalId && (batch.data.state !== 'available' || batch.data.modelApprovalId !== approvalId))) return invalid();
  } else if (approvalId || !['existing', 'unverified'].includes(delivery.data.state) || (delivery.data.state === 'unverified') !== (delivery.data.candidates.length === 0)) return invalid();
  const candidates = await checkStoredCandidates(conversation, delivery.data.candidates);
  if (!candidates.ok) return failure('UNKNOWN_RESULT', '候选引用尚未核验；请重新读取候选。', 'read_candidates', 'unknown');
  return { ok: true, data: { ...delivery.data, candidates: candidates.data, handoffHref: handoffHref(conversation.id) } };
}

export async function sendModelInput(request: Transport, conversation: Conversation, scope: ModelScope, preview: ModelPreview, signal: AbortSignal, onSent: () => void, onState: (event: ModelSendEvent) => void = () => {}, ownsAttempt: () => boolean = () => true, continuation?: RegistrationContinuation): Promise<Result<DeliveryReceipt>> {
  let approval: Approval | null = null; let sent = false; let registrationStarted = false; let registrationUnknown = false; let revoked = false; let revocation: Promise<boolean> | null = null;
  const unknownApproval = () => failure<DeliveryReceipt>('UNKNOWN_RESULT', '原模型批准登记或撤回未确认；未发送新的模型请求，请先核验原批准。', 'read_approval_state', 'unknown');
  const stopped = () => registrationUnknown || (approval && !revoked && !sent) ? unknownApproval() : failure<DeliveryReceipt>(sent ? 'UNKNOWN_RESULT' : 'FORBIDDEN', sent ? '提取结果未知；已发出的请求不保证撤回，请先核验。' : '已停止后续发送；尚未调用模型。', sent ? 'read_candidates' : 'continue_manually', sent ? 'unknown' : 'preserved');
  const revoke = () => {
    if (!approval || !ownsAttempt()) return Promise.resolve(false);
    const id = approval.id;
    if (!revocation) {
      onState({ kind: 'revocation', state: 'pending' });
      revocation = Promise.resolve().then(() => request(`/api/capture/approvals/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' })).then((r) => r.ok && typeof r.data === 'object' && r.data !== null && 'revoked' in r.data && r.data.revoked === true).catch(() => false).then((value) => {
        revoked = value; onState({ kind: 'revocation', state: value ? 'revoked' : 'unknown' }); return value;
      });
    }
    return revocation;
  };
  const stop = () => { void revoke(); };
  if (signal.aborted) return stopped();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const checkedPreview = await checkModelPreview(preview, conversation, scope);
    if (signal.aborted) return stopped();
    if (!checkedPreview.ok) return checkedPreview;
    const operationId = continuation?.identity.operationId ?? crypto.randomUUID();
    const original = ModelApprovalRequestSchema.parse({ input: preview.input, objectIds: preview.approvalRequest.objectIds, baseRevision: preview.approvalRequest.baseRevision, conversationId: conversation.id, operationId, confirmed: true });
    if (continuation) {
      const recovered = await checkRegistrationContinuation(request, original, continuation, signal);
      if (signal.aborted || !ownsAttempt()) return stopped();
      if (!recovered.ok) { onState({ kind: 'registration', state: 'unknown' }); return recovered; }
      approval = recovered.data;
      onState({ kind: 'registration', state: 'active', approval });
    } else {
      const prepared = await prepareRegistration(request, original, conversation.workspaceId, signal);
      if (signal.aborted || !ownsAttempt()) return stopped();
      if (!prepared.ok) return prepared;
      onState({ kind: 'identity', identity: prepared.data });
      // Keep the approval response observable so cancellation can revoke a late approval.
      registrationStarted = true; onState({ kind: 'registration', state: 'pending' });
      const issued = await request(`/api/capture/${encodeURIComponent(conversation.id)}/model-approve`, { method: 'POST', body: JSON.stringify({ ...scope, operationId, expectedInputHash: preview.approvalRequest.contentHash, expectedConversationHash: preview.approvalRequest.baseRevision, retentionDays: 7, confirmed: true }) });
      if (!ownsAttempt()) return stopped();
      const parsed = issued.ok ? ApprovalSchema.safeParse(issued.data) : null;
      if (parsed?.success && (parsed.data.actorId !== prepared.data.actorId || parsed.data.workspaceId !== prepared.data.workspaceId)) {
        registrationUnknown = true; onState({ kind: 'registration', state: 'unknown' }); return unknownApproval();
      }
      if (parsed?.success) { approval = parsed.data; onState({ kind: 'registration', state: 'active', approval }); }
      else {
        registrationUnknown = issued.ok || issued.error.dataState !== 'not_written';
        onState({ kind: 'registration', state: registrationUnknown ? 'unknown' : 'none' });
        if (!issued.ok && !registrationUnknown) return issued;
        return unknownApproval();
      }
    }
    if (signal.aborted) { await revoke(); return stopped(); }
    const expected = preview.approvalRequest;
    if (!approval || approval.workspaceId !== conversation.workspaceId || approval.purpose !== 'model_input' || approval.contentHash !== expected.contentHash || approval.baseRevision !== expected.baseRevision || approval.objectIds.length !== expected.objectIds.length || new Set(approval.objectIds).size !== approval.objectIds.length || approval.objectIds.some((id) => !expected.objectIds.includes(id)) || Date.parse(approval.approvedAt) > Date.now() || Date.parse(approval.expiresAt) <= Date.now()) {
      await revoke(); return revoked ? failure('CONFLICT', '批准与已展示模型输入不一致或已过期；已撤回，未发送模型，请重新预览。', 'preview_again', 'preserved') : unknownApproval();
    }
    sent = true; onSent();
    if (signal.aborted) return stopped();
    const result = await request(`/api/capture/${encodeURIComponent(conversation.id)}/extract`, { method: 'POST', body: JSON.stringify({ ...scope, approval, retentionDays: 7, confirmed: true }), signal });
    if (signal.aborted) return stopped();
    if (!result.ok) return result;
    const delivery = await checkDeliveryReceipt(result.data, conversation, approval.id);
    return signal.aborted ? stopped() : delivery;
  } catch {
    if (registrationStarted && !approval) { registrationUnknown = true; onState({ kind: 'registration', state: 'unknown' }); return unknownApproval(); }
    return sent ? failure('UNKNOWN_RESULT', '提取结果未知；请先核验候选，不要直接重发。', 'read_candidates', 'unknown') : failure('UPSTREAM', '模型预览未完成；尚未申请批准或发送模型。', 'preview_again', 'preserved');
  }
  finally { signal.removeEventListener('abort', stop); if (signal.aborted) await revoke(); }
}
