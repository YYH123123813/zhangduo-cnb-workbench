import { apiRequest } from '../../app/api-client';
import type { ApiError, ApiResponse } from '../../contracts/api';
import { ApprovalSchema, type Approval, type RetrievalRequest, type RetrievalResult } from '../../contracts/domain';
import { canonicalJson, contentHash, hashModelInput } from '../../contracts/hash';
import { ApprovalRegistrationStateSchema, type ApprovalRegistrationState } from '../../contracts/approval';
import { ModelApprovalRequestSchema, ModelOperationReceiptSchema, type ModelApprovalRequest, type ModelOperationReceipt } from '../../contracts/model';
import { OperationRecoveryQuerySchema, OperationRecoverySchema, type OperationRecovery } from '../../contracts/operation-recovery';
import { AnswerPreviewSchema, AnswerResultSchema, type AnswerPreview } from './api';
import type { latestRead } from './client-state';
import type { NavigationProps } from '../../contracts/navigation';
import type { RecoveryAnchor } from '../../contracts/recovery-anchor';
import { retainAnswerIdentity, validRecoveryLifetime } from './answer-recovery';

export type AnswerCall = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
export interface AnswerRegistration {
  operationId: string; requestHash: string; contentHash: string; baseRevision: string; objectIds: string[];
}
export interface AnswerRecoveryExpectation extends AnswerRegistration {
  actorId: string; workspaceId: string; approvalId?: string | null; approvalExpiresAt?: string | null;
}
export type AnswerRecoveryResult = { ok: true; data: OperationRecovery } | { ok: false; error: ApiError };

const recoveryError = (message: string): AnswerRecoveryResult => ({ ok: false, error: {
  code: 'UNKNOWN_RESULT', message, retryable: false, dataState: 'unknown', nextAction: 'read_original_operation',
} });

function matchesAnswerRecovery(value: OperationRecovery, expected: AnswerRecoveryExpectation): boolean {
  if (value.kind !== 'model' || value.operationId !== expected.operationId || value.actorId !== expected.actorId || value.workspaceId !== expected.workspaceId) return false;
  const unresolved = ['not_registered', 'unknown'].includes(value.stage);
  if (unresolved) return value.approvalId === null && value.recordId === null && value.purpose === null
    && value.requestHash === null && value.contentHash === null && value.baseRevision === null
    && value.objectIds.length === 0 && value.approvalExpiresAt === null;
  return value.purpose === 'answer' && value.recordId === null
    && value.requestHash === expected.requestHash && value.contentHash === expected.contentHash && value.baseRevision === expected.baseRevision
    && value.approvalId !== null
    && canonicalJson([...value.objectIds].sort()) === canonicalJson([...expected.objectIds].sort())
    && (expected.approvalId === undefined || value.approvalId === expected.approvalId)
    && (expected.approvalExpiresAt === undefined || value.approvalExpiresAt === expected.approvalExpiresAt);
}

/** Reads the shared 1.22 operation metadata only. It never restores private text or changes operation state. */
export async function readAnswerOperationRecovery(call: AnswerCall, expected: AnswerRecoveryExpectation, signal?: AbortSignal): Promise<AnswerRecoveryResult> {
  // The recovery endpoint is keyed by the original registration operation ID.
  // A caller that only has an approval ID must remain blocked rather than
  // probing the approval key and risking another operation being claimed.
  if (expected.approvalId && expected.operationId === expected.approvalId) return recoveryError('原回答恢复不能使用批准 ID 代替原登记 operationId。');
  const query = OperationRecoveryQuerySchema.safeParse({ kind: 'model', operationId: expected.operationId, modelPurpose: 'answer' });
  if (!query.success) return recoveryError('原回答操作 ID 无法按共享恢复契约核验。');
  const path = `/api/workspace/operation-recovery/model/${encodeURIComponent(expected.operationId)}?modelPurpose=answer`;
  const init: RequestInit = { method: 'GET', ...(signal ? { signal } : {}) };
  try {
    const response = await call(path, init);
    if (!response.ok) return { ok: false, error: response.error };
    const parsed = OperationRecoverySchema.safeParse(response.data);
    if (!parsed.success || !matchesAnswerRecovery(parsed.data, expected)) return recoveryError('原回答操作恢复元数据与身份、用途、摘要、版本或范围不一致。');
    return { ok: true, data: parsed.data };
  } catch {
    return recoveryError('原回答操作恢复读取中断；未恢复正文，也未推定操作未发送。');
  }
}

export type AnswerOperationState = 'preview' | 'approved' | 'sending' | 'unknown' | 'not_sent' | 'done' | 'discarded';
export const answerOperationLabels: Record<AnswerOperationState, string> = {
  preview: '范围待批准', approved: '已批准，待发送', sending: '发送处理中', unknown: '结果未知',
  not_sent: '平台已证明未发送', done: '操作已结束', discarded: '输出已丢弃',
};
export interface AnswerState {
  retention?: { status: 'saving' | 'saved' | 'unknown'; identity: RecoveryAnchor | null };
  phase: 'idle' | 'previewing' | 'preview' | 'approving' | 'approved' | 'sending' | 'checking' | 'cancelling' | 'revoke_failed' | 'done';
  preview: AnswerPreview | null; approval: Approval | null; notice: string; error: string; uncertain: boolean;
  operation: Approval | null; receipt: ModelOperationReceipt | null; invalidated: boolean;
  registration: AnswerRegistration | null; registrationStatus: ApprovalRegistrationState['status'] | null; recovery: OperationRecovery | null;
}
export const emptyAnswerState = (): AnswerState => ({ phase: 'idle', preview: null, approval: null, operation: null, receipt: null, registration: null, registrationStatus: null,
  recovery: null, notice: '', error: '', uncertain: false, invalidated: false });
export function answerOperationState(state: Pick<AnswerState, 'phase' | 'receipt' | 'operation' | 'uncertain'>): AnswerOperationState {
  if (state.phase === 'preview') return 'preview';
  if (state.phase === 'approved' || (state.phase === 'revoke_failed' && !state.operation)) return 'approved';
  if (state.phase === 'sending') return 'sending';
  if (state.operation && state.receipt?.state === 'not_sent' && !state.uncertain) return 'not_sent';
  if (state.operation && state.receipt?.state === 'done' && !state.uncertain) return 'done';
  if (state.operation && state.receipt?.state === 'discarded' && !state.uncertain) return 'discarded';
  return 'unknown';
}
export const answerLeaveState = (state: AnswerState): 'blocked' | 'clean' => state.approval || state.uncertain ||
  ['approving', 'approved', 'sending', 'checking', 'cancelling', 'revoke_failed'].includes(state.phase) ? 'blocked' : 'clean';
export function createAnswerFlow(options: { request: RetrievalRequest; actorId: string; reader: ReturnType<typeof latestRead>;
  onState: (state: AnswerState) => void; onResult: (result: RetrievalResult) => void; onFailure: (error: ApiError) => void; call?: AnswerCall;
  retainOperationRecovery?: NavigationProps['retainOperationRecovery'] }) {
  const request = structuredClone(options.request); const call = options.call ?? apiRequest;
  const reader = options.reader;
  let state = emptyAnswerState();
  let detached = false;
  let preparedApproval: ModelApprovalRequest | null = null; let preparedRegistration: AnswerRegistration | null = null;
  let lastSignal: AbortSignal | null = null; let registering = false; let revoking = false; let inspecting = false; let recovering = false; let closing = false; let modelAttempted = false;
  const publish = (patch: Partial<AnswerState>) => { if (!detached) { state = { ...state, ...patch }; options.onState(state); } };
  const active = () => !detached && lastSignal !== null && reader.active(lastSignal);
  const reject = (error: ApiError) => { publish({ phase: 'done', preview: null, error: error.message, uncertain: modelAttempted || error.dataState === 'unknown' || error.code === 'UNKNOWN_RESULT' }); options.onFailure(error); };
  const post = (path: string, body: unknown, signal?: AbortSignal) => call(path, { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const matchesScope = (approval: Approval, scope: Pick<AnswerRegistration, 'baseRevision' | 'contentHash' | 'objectIds'>) =>
    approval.actorId === options.actorId && approval.workspaceId === request.task.workspaceId && approval.purpose === 'model_input' &&
    approval.baseRevision === scope.baseRevision && approval.contentHash === scope.contentHash &&
    canonicalJson([...approval.objectIds].sort()) === canonicalJson([...scope.objectIds].sort()) && Date.parse(approval.expiresAt) > Date.parse(approval.approvedAt);
  const matchesOperation = (receipt: ModelOperationReceipt, operation: Approval) => receipt.approvalId === operation.id &&
    receipt.actorId === operation.actorId && receipt.workspaceId === operation.workspaceId && receipt.purpose === 'answer' &&
    receipt.contentHash === operation.contentHash && receipt.baseRevision === operation.baseRevision;
  async function closeUnsent(operation: Approval): Promise<ModelOperationReceipt | null> {
    if (closing) return null;
    closing = true;
    try {
      const response = await post(`/api/workspace/model-operations/${encodeURIComponent(operation.id)}/close`, {
        purpose: 'answer', contentHash: operation.contentHash, baseRevision: operation.baseRevision, confirmed: true,
      });
      if (!response.ok) return null;
      const parsed = ModelOperationReceiptSchema.safeParse(response.data);
      if (!parsed.success || !matchesOperation(parsed.data, operation) || parsed.data.state !== 'not_sent') return null;
      return parsed.data;
    } catch { return null; }
    finally { closing = false; }
  }
  const publishNotSent = (receipt: ModelOperationReceipt) => publish({ phase: 'done', preview: null, approval: null,
    receipt, uncertain: false, error: '', notice: '平台已核验原回答操作未发送；未恢复正文，也未自动重发。' });
  async function revoke(approval: Approval, receivedResult = false) {
    revoking = true;
    try {
      const response = await post(`/api/workspace/approvals/${encodeURIComponent(approval.id)}/revoke`, {});
      if (response.ok && typeof response.data === 'object' && response.data !== null && 'revoked' in response.data && response.data.revoked === true) {
        const uncertain = modelAttempted && state.uncertain;
        const notSent = state.receipt?.state === 'not_sent';
        publish({ phase: notSent || uncertain || receivedResult ? 'done' : 'idle', approval: null, preview: null, registrationStatus: 'revoked', error: '', uncertain: notSent ? false : uncertain, notice: notSent
          ? '批准已撤回；平台已证明原回答操作未发送。' : receivedResult
          ? '本次回答流程已返回，剩余批准已撤回；原模型操作终态仍待回执核验。' : modelAttempted
          ? '批准已撤回；模型请求可能已发送，已发送内容无法撤回，本次输出已丢弃。' : '批准已撤回，未请求模型回答。' });
        return;
      }
    } catch { /* The approval remains available for an explicit revocation retry. */ }
    finally { revoking = false; }
    publish({ phase: 'revoke_failed', approval, preview: null, error: '批准撤回尚未核验。未继续发送；请重试撤回。' });
  }
  async function cancel() {
    if (revoking) { reader.cancel(); return; }
    reader.cancel(); const approval = state.approval; const operation = state.operation;
    publish({ phase: registering || approval ? 'cancelling' : 'idle', preview: null, approval: null, error: '', notice: modelAttempted
      ? '模型请求可能已发送，已丢弃本次输出；未自动重试。' : registering ? '正在等待批准登记结果，以撤回本次范围；未请求模型回答。' : state.uncertain ? '批准登记结果仍未知，不能确认已撤回；未请求模型回答。' : '已取消，未请求模型回答。' });
    if (modelAttempted && operation && !state.receipt) {
      const receipt = await closeUnsent(operation);
      if (receipt) publishNotSent(receipt);
    }
    if (approval) await revoke(approval);
  }
  const flow = {
    get state() { return state; },
    async preview() {
      if (detached || state.invalidated || registering || revoking || inspecting || state.approval || state.uncertain || !['idle', 'done', 'preview'].includes(state.phase)) return;
      const signal = reader.start(); lastSignal = signal; modelAttempted = false;
      preparedApproval = null; preparedRegistration = null;
      publish({ phase: 'previewing', preview: null, operation: null, receipt: null, registration: null, registrationStatus: null, recovery: null, retention: undefined, error: '', notice: '' });
      try {
        const response = await post('/api/retrieval/answer/preview', { request }, signal);
        if (!reader.active(signal)) return;
        if (!response.ok) { reject(response.error); return; }
        const parsed = AnswerPreviewSchema.safeParse(response.data);
        const valid = parsed.success && await hashModelInput(parsed.data.input) === parsed.data.contentHash;
        if (!reader.active(signal)) return;
        if (!valid || !parsed.success) {
          publish({ phase: 'done', error: '模型预览未通过范围校验，未请求批准。' }); return;
        }
        const approvalInput = ModelApprovalRequestSchema.parse({ input: parsed.data.input, objectIds: parsed.data.objectIds,
          baseRevision: parsed.data.baseRevision, operationId: crypto.randomUUID(), confirmed: true });
        const requestHash = await contentHash(approvalInput);
        if (!reader.active(signal)) return;
        preparedApproval = approvalInput;
        preparedRegistration = { operationId: approvalInput.operationId!, requestHash, contentHash: parsed.data.contentHash,
          baseRevision: parsed.data.baseRevision, objectIds: [...parsed.data.objectIds] };
        publish({ phase: 'preview', preview: parsed.data });
      } catch { if (reader.active(signal)) publish({ phase: 'done', error: '预览读取失败，未请求批准或模型回答。' }); }
    },
    async approve(confirmed: boolean, retainConfirmed = false) {
      if (state.invalidated || !confirmed || state.phase !== 'preview' || !state.preview || !preparedApproval || !preparedRegistration || !active()) return;
      const preview = state.preview; const signal = reader.start(); lastSignal = signal; registering = true;
      publish({ phase: 'approving', registration: structuredClone(preparedRegistration), registrationStatus: null, error: '', notice: '', uncertain: true });
      try {
        if (retainConfirmed) {
          publish({ retention: { status: 'saving', identity: null }, notice: '正在保留原操作身份，尚未登记业务批准。' });
          const retained = await retainAnswerIdentity(options.retainOperationRecovery, { ...preparedRegistration,
            actorId: options.actorId, workspaceId: request.task.workspaceId });
          if (detached) return;
          if (!retained.ok) {
            publish({ phase: 'done', preview: null, uncertain: true, retention: { status: 'unknown', identity: null }, error: retained.error.message, notice: '' }); return;
          }
          publish({ retention: { status: 'saved', identity: retained.data } });
          if (!reader.active(signal)) { publish({ phase: 'done', preview: null, uncertain: true, notice: '原操作身份已保留；本次流程已停止，未继续批准。' }); return; }
        }
        // Do not abort registration: a late ID is needed to revoke cancelled consent.
        const response = await post('/api/workspace/approvals/model', preparedApproval);
        if (detached) return;
        registering = false;
        if (!response.ok) {
          if (reader.active(signal)) reject(response.error);
          else publish({ phase: 'idle', uncertain: response.error.dataState === 'unknown', notice: '已停止本次流程，未请求模型回答。' });
          return;
        }
        const parsed = ApprovalSchema.safeParse(response.data);
        if (!parsed.success) { publish({ phase: 'done', uncertain: true, error: '批准登记结果无法核验，未请求模型回答。' }); return; }
        const approval = parsed.data;
        if (!matchesScope(approval, preview)) {
          publish({ phase: 'done', preview: null, uncertain: true, error: '返回的批准与原范围不一致；需核验原登记，未请求模型回答。' }); return;
        }
        publish({ registrationStatus: 'registered' });
        if (!reader.active(signal)) { await revoke(approval); return; }
        if (Date.parse(approval.approvedAt) > Date.now() || Date.parse(approval.expiresAt) <= Date.now()) {
          await revoke(approval); publish({ error: '原批准期限不允许发送，未请求模型回答。' }); return;
        }
        publish({ phase: 'approved', approval, uncertain: false, notice: '范围已批准，尚未请求模型回答。' });
      } catch { publish({ phase: 'done', preview: null, uncertain: true, error: '批准登记结果未知，未请求模型回答；不要将其视为批准已撤回。' }); }
      finally { registering = false; }
    },
    async inspectRegistration() {
      if (registering || revoking || inspecting || modelAttempted || state.operation || !state.registration || !state.uncertain || !['idle', 'done'].includes(state.phase)) return;
      const registration = state.registration; const signal = reader.start(); lastSignal = signal; inspecting = true;
      publish({ phase: 'checking', preview: null, error: '', notice: '' });
      try {
        const response = await call(`/api/workspace/approval-registrations/model_input/${encodeURIComponent(registration.operationId)}?modelPurpose=answer`, { method: 'GET', signal });
        if (!reader.active(signal)) return;
        if (!response.ok) { publish({ phase: 'done', uncertain: true, error: response.error.message }); options.onFailure(response.error); return; }
        const parsed = ApprovalRegistrationStateSchema.safeParse(response.data);
        if (!parsed.success || parsed.data.operationId !== registration.operationId || parsed.data.actorId !== options.actorId ||
          parsed.data.workspaceId !== request.task.workspaceId || parsed.data.purpose !== 'model_input' || parsed.data.modelPurpose !== 'answer' ||
          (parsed.data.approval ? parsed.data.requestHash !== registration.requestHash || !matchesScope(parsed.data.approval, registration) : parsed.data.requestHash !== null)) {
          publish({ phase: 'done', uncertain: true, error: '原批准登记的身份、用途、请求摘要或范围无法核验。' }); return;
        }
        const receipt = parsed.data;
        if (!receipt.approval) {
          publish({ phase: 'done', registrationStatus: receipt.status, uncertain: true, notice: receipt.status === 'not_registered'
            ? '尚未查到原登记；晚到请求仍可能登记，不能当作已撤回或重新批准。' : '原批准登记仍未知，未重新登记或发送模型请求。' }); return;
        }
        const terminal = receipt.status === 'revoked' || receipt.status === 'expired';
        publish({ phase: 'done', registrationStatus: receipt.status, approval: terminal ? null : receipt.approval, uncertain: false, notice: terminal
          ? '原批准登记的撤回或过期状态已核验；未恢复回答或重新发送。'
          : '已找回原批准；本窗口未请求模型回答。请先撤回批准，再按当前范围重新预览。' });
      } catch { if (reader.active(signal)) publish({ phase: 'done', uncertain: true, error: '原批准登记读回失败，仍待核验；未重新登记或发送。' }); }
      finally { inspecting = false; }
    },
    async send(): Promise<void> {
      if (state.invalidated || state.phase !== 'approved' || !state.approval || !active()) return;
      if (state.retention && (state.retention.status !== 'saved' || !state.retention.identity || !validRecoveryLifetime(state.retention.identity))) {
        publish({ phase: 'done', preview: null, uncertain: true, error: '原操作恢复身份已过期或无法核验；未发送模型，原批准仍待处理。' }); return;
      }
      const approval = state.approval; const signal = reader.start(); lastSignal = signal; modelAttempted = true;
      publish({ phase: 'sending', operation: structuredClone(approval), receipt: null, error: '', uncertain: true, notice: '模型请求处理中，取消不能撤回已发送内容。' });
      try {
        const response = await post('/api/retrieval/answer', { request, approval }, signal);
        if (!reader.active(signal)) return;
        if (!response.ok) { reject(response.error); return; }
        const parsed = AnswerResultSchema.safeParse(response.data);
        if (!parsed.success) { publish({ phase: 'done', preview: null, uncertain: true, error: '回答响应未通过结构校验，调用结果待核验；未自动重试。' }); return; }
        // A direct-result fallback is not proof that this operation can no longer send.
        publish({ phase: 'cancelling', preview: null, uncertain: true, notice: '本次回答流程已返回，正在核验撤回剩余批准和原操作终态。' });
        await revoke(approval, true);
        if (reader.active(signal)) {
          options.onResult(parsed.data);
          if (reader.active(signal)) await flow.inspect();
        }
      } catch { if (reader.active(signal)) publish({ phase: 'done', preview: null, uncertain: true, error: '回答结果未知，请求可能已发送，未自动重试。' }); }
    },
    async inspectRecovery(operationId?: string) {
      if (registering || revoking || inspecting || recovering || !['idle', 'done', 'revoke_failed'].includes(state.phase)) return;
      const registration = state.registration;
      if (!registration || (operationId !== undefined && operationId !== registration.operationId)) {
        publish({ phase: 'done', uncertain: true, error: '没有可绑定的原回答登记；未执行恢复读取。' }); return;
      }
      const expected: AnswerRecoveryExpectation = { ...registration, actorId: options.actorId, workspaceId: request.task.workspaceId,
        ...(state.operation ? { approvalId: state.operation.id, approvalExpiresAt: state.operation.expiresAt } : {}) };
      const phase = state.phase === 'revoke_failed' ? 'revoke_failed' : 'done';
      const signal = reader.start(); lastSignal = signal; recovering = true;
      publish({ phase: 'checking', error: '', notice: '' });
      try {
        const result = await readAnswerOperationRecovery(call, expected, signal);
        if (!reader.active(signal)) return;
        if (!result.ok) { publish({ phase, uncertain: true, error: result.error.message }); options.onFailure(result.error); return; }
        publish({ phase, recovery: result.data, notice: result.data.stage === 'not_registered' || result.data.stage === 'unknown'
          ? '原回答操作恢复仍未知；元数据未证明未发送，未恢复正文或重新请求模型。'
          : '已读回原回答操作最小元数据；恢复只读，不恢复正文、不批准、不发送或重试。' });
      } finally { recovering = false; }
    },
    async inspect() {
      if (registering || revoking || inspecting || recovering || !state.operation || !state.uncertain || !['idle', 'done', 'revoke_failed'].includes(state.phase)) return;
      const operation = state.operation; const phase = state.phase === 'revoke_failed' ? 'revoke_failed' : 'done';
      const registration = state.registration;
      const signal = reader.start(); lastSignal = signal; inspecting = true;
      publish({ phase: 'checking', error: '', notice: '' });
      const recoverMetadata = async () => {
        if (!registration || !reader.active(signal)) return;
        const result = await readAnswerOperationRecovery(call, { ...registration, actorId: options.actorId, workspaceId: request.task.workspaceId,
          approvalId: operation.id, approvalExpiresAt: operation.expiresAt }, signal);
        if (reader.active(signal) && result.ok) publish({ recovery: result.data });
      };
      try {
        const response = await call(`/api/retrieval/answer/operations/${encodeURIComponent(operation.id)}`, { method: 'GET', signal });
        if (!reader.active(signal)) return;
        if (!response.ok) {
          await recoverMetadata(); publish({ phase, error: response.error.message, uncertain: true }); options.onFailure(response.error); return;
        }
        const parsed = ModelOperationReceiptSchema.nullable().safeParse(response.data);
        if (!parsed.success || (parsed.data && (parsed.data.approvalId !== operation.id || parsed.data.actorId !== operation.actorId ||
          parsed.data.workspaceId !== operation.workspaceId || parsed.data.purpose !== 'answer' || parsed.data.contentHash !== operation.contentHash ||
          parsed.data.baseRevision !== operation.baseRevision))) {
          await recoverMetadata(); publish({ phase, error: '回执与原操作身份、内容或版本不一致，结果仍待核验。', uncertain: true }); return;
        }
        const receipt = parsed.data; const terminal = receipt?.state === 'done' || receipt?.state === 'discarded' || receipt?.state === 'not_sent';
        publish({ phase, receipt, uncertain: !terminal, notice: terminal
          ? receipt.state === 'not_sent' ? '平台已证明原模型操作未发送；未恢复正文，也未自动重发。' : receipt.state === 'done' ? '原模型操作已结束；回执仅含元数据，不另取回答正文，也不证明引用校验通过。' : '原模型操作输出已丢弃；已发送内容无法撤回。'
          : receipt === null ? '未查到原操作回执，不能确认未发送或未计费。' : receipt.state === 'sending' ? '原模型操作仍在处理，尚未核验终态。' : '原模型操作结果仍未知，未自动重试。' });
        await recoverMetadata();
      } catch { if (reader.active(signal)) { await recoverMetadata(); publish({ phase, uncertain: true, error: '原操作读回失败，结果仍待核验；未重发模型请求。' }); } }
      finally { inspecting = false; }
    },
    cancel,
    detach() { detached = true; reader.cancel(); },
    async invalidate() { publish({ invalidated: true }); await cancel(); },
  };
  return flow;
}
