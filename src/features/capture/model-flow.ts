import type { ApiResponse } from '../../contracts/api';
import { Id, type Conversation } from '../../contracts/domain';
import type { LeaveGuard } from '../../contracts/navigation';
import type { ModelOperationReceipt } from '../../contracts/model';
import type { ExtractionOperation, ExtractionStage } from '../../contracts/extraction';
import type { DeliveryReceipt } from './delivery';
import type { ModelPreview, ModelScope } from './model-input';
import { sendModelInput, type ModelSendEvent } from './model-send';
import { discoverModelOperations, identityFromExtraction, readDiscoveredModelRecovery, readModelRecovery, type ModelOperationIdentity } from './model-recovery';
import { readRegistration, type RegistrationContinuation, type RegistrationIdentity } from './approval-registration';

type Transport = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
const rejectionMessages: Record<NonNullable<ExtractionOperation['rejectionReason']>, string> = {
  invalid_reference: '模型输出引用校验被拒绝', invalid_output: '模型输出结构校验被拒绝',
  source_changed: '原来源、设置或批准在模型运行期间失效', approval_invalid: '原模型批准失效',
};
export interface ModelFlowState {
  phase: 'idle' | 'sending' | 'checking' | 'unknown' | 'failed' | 'complete' | 'rejected_without_save' | 'discarded' | 'expired';
  stage: ExtractionStage | null;
  discovery: 'idle' | 'checking' | 'ready' | 'unknown';
  discovered: ExtractionOperation[];
  registration: 'none' | 'pending' | 'active' | 'revoking' | 'revoked' | 'expired' | 'unknown' | 'consumed';
  registrationIdentity: RegistrationIdentity | null;
  approval: ModelOperationIdentity | null; recoveryId: string | null; sent: boolean; delivery: DeliveryReceipt | null; operation: ModelOperationReceipt | null; extraction: ExtractionOperation | null; message: string;
}
export class CaptureModelFlow {
  private state: ModelFlowState = { phase: 'idle', stage: null, discovery: 'idle', discovered: [], registration: 'none', registrationIdentity: null, approval: null, recoveryId: null, sent: false, delivery: null, operation: null, extraction: null, message: '' };
  private listeners = new Set<() => void>();
  private current: AbortController | null = null;
  private alive = true;
  private revocation: Promise<void> | null = null;
  private attempt = 0;
  private recoveryMode: 'unified' | 'discovered' = 'unified';
  constructor(private request: Transport, private conversation: Conversation) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getLeaveState: LeaveGuard['getState'] = () => ['complete', 'rejected_without_save', 'discarded', 'expired'].includes(this.state.phase) ? 'clean'
    : this.current || this.state.sent || this.state.discovery === 'unknown' || this.state.discovered.length > 0 || ['pending', 'active', 'revoking', 'unknown'].includes(this.state.registration) ? 'blocked' : 'clean';
  activate() { this.alive = true; }
  dispose() { void this.cancel(); this.alive = false; }
  private update(change: Partial<ModelFlowState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...change }; this.listeners.forEach((listener) => listener());
  }
  private observe = (event: ModelSendEvent) => {
    if (event.kind === 'identity') this.update({ registrationIdentity: event.identity });
    else if (event.kind === 'registration') this.update({ registration: event.state, ...(event.state === 'active' ? { approval: event.approval, recoveryId: this.state.registrationIdentity?.operationId ?? this.state.recoveryId } : {}) });
    else this.update({ registration: event.state === 'pending' ? 'revoking' : event.state });
  };
  async send(scope: ModelScope, preview: ModelPreview) { await this.performSend(scope, preview); }
  async continueOriginal(scope: ModelScope, preview: ModelPreview) {
    if (this.state.registration !== 'active' || !this.state.registrationIdentity || !this.state.approval) return;
    await this.performSend(scope, preview, { identity: this.state.registrationIdentity, approvalId: this.state.approval.id });
  }
  private async performSend(scope: ModelScope, preview: ModelPreview, continuation?: RegistrationContinuation) {
    if (!this.alive || this.current || this.revocation || this.state.sent || this.state.discovered.length > 0 || (!continuation && this.getLeaveState() === 'blocked')) return;
    const controller = new AbortController(); this.current = controller;
    const attempt = ++this.attempt;
    this.update({ phase: 'sending', stage: null, extraction: null, ...(!continuation ? { registration: 'none' as const, registrationIdentity: null, approval: null } : {}), delivery: null, message: continuation ? '正在重新核验原批准与原输入；尚未继续发送。' : '正在登记本次模型批准。' });
    try {
      const result = await sendModelInput(this.request, this.conversation, scope, preview, controller.signal,
        () => { if (attempt === this.attempt) this.update({ sent: true, message: '正在生成并核验待审候选。' }); },
        (event) => { if (attempt === this.attempt) this.observe(event); }, () => attempt === this.attempt, continuation);
      if (!this.alive || this.current !== controller) return;
      this.current = null;
      if (result.ok) this.update({ phase: 'complete', stage: result.data.state === 'empty' ? 'saved_empty' : 'saved_nonempty', registration: 'consumed', delivery: result.data, message: result.data.state === 'empty' ? '本次提取已完成，无候选；空批次已保存。' : '原操作候选已保存并读回，等待人工审核。' });
      else this.update({ phase: this.getLeaveState() === 'blocked' || result.error.dataState === 'unknown' ? 'unknown' : 'failed', stage: result.error.dataState === 'unknown' ? 'unknown' : this.state.stage, message: result.error.message });
    } finally { if (this.current === controller) { this.current = null; this.update({}); } }
  }
  async cancel() {
    if (!this.alive || ['complete', 'rejected_without_save', 'discarded', 'expired'].includes(this.state.phase)) return;
    if (this.current) {
      this.current.abort();
      this.update({ phase: 'unknown', message: '已停止等待和后续发送；原批准或模型操作仍需核验。' });
      return;
    }
    const approval = this.state.approval;
    if (!approval || ['revoked', 'expired', 'consumed'].includes(this.state.registration)) return;
    if (this.revocation) return this.revocation;
    this.update({ registration: 'revoking', phase: 'unknown', message: '正在撤回原批准；不重新申请或发送。' });
    this.revocation = (async () => {
      let revoked = false;
      try {
        const result = await this.request(`/api/capture/approvals/${encodeURIComponent(approval.id)}/revoke`, { method: 'POST', body: '{}' });
        revoked = result.ok && typeof result.data === 'object' && result.data !== null && 'revoked' in result.data && result.data.revoked === true;
      } catch { /* Keep the original approval available for retry. */ }
      this.update({ registration: revoked ? 'revoked' : 'unknown', phase: revoked && !this.state.sent ? 'failed' : 'unknown', message: revoked ? this.state.sent ? '原批准已撤回；已发出的模型操作仍需核验。' : '原批准已撤回；未发送模型。' : '撤回未确认；请重试撤回原批准。' });
      this.revocation = null;
    })();
    return this.revocation;
  }
  async readApprovalRegistration() {
    const original = this.state.registrationIdentity;
    if (!this.alive || !original || this.revocation || ['checking', 'complete', 'discarded', 'expired'].includes(this.state.phase) || (this.current && this.state.sent)) return;
    // Transfer ownership to GET before stopping the old observer, including its late revocation.
    ++this.attempt; this.current?.abort();
    const controller = new AbortController(); this.current = controller;
    this.update({ phase: 'checking', message: '正在核验原模型批准登记；不发送模型或保存候选。' });
    try {
      const result = await readRegistration(this.request, original, controller.signal);
      if (!this.alive || this.current !== controller || controller.signal.aborted) return;
      if (!result.ok) { this.update({ phase: 'unknown', registration: 'unknown', message: result.error.message }); return; }
      const value = result.data;
      if (!value.approval) { this.update({ phase: 'unknown', registration: 'unknown', message: '尚未找到原登记，不能排除在途登记；不会重新批准或付费发送。' }); return; }
      const inactive = value.status === 'revoked' || value.status === 'expired';
      this.update({ approval: value.approval, registration: value.status === 'registered' ? 'active' : value.status as 'revoked' | 'expired',
        phase: inactive && !this.state.sent ? 'failed' : 'unknown',
        message: value.status === 'registered' ? '已找到原模型批准；未继续发送。可明确继续原输入或撤回原批准。'
          : this.state.sent ? '原批准已失效；模型与候选写入是否完成仍需核验原操作。' : '原批准已撤回或过期；本页未发送模型。' });
    } finally { if (this.current === controller) { this.current = null; this.update({}); } }
  }
  async discover() {
    if (!this.alive || this.current || this.revocation || this.state.sent || this.state.discovery === 'checking' || this.state.discovered.length > 0) return;
    const controller = new AbortController(); this.current = controller; ++this.attempt;
    this.update({ phase: 'checking', discovery: 'checking', message: '正在按当前会话只读发现原提取操作；不会发送模型或保存候选。' });
    try {
      const result = await discoverModelOperations(this.request, this.conversation, controller.signal);
      if (!this.alive || this.current !== controller || controller.signal.aborted) return;
      if (!result.ok) { this.update({ phase: 'unknown', discovery: 'unknown', stage: 'unknown', message: result.error.message }); return; }
      if (result.data.operations.length > 0) {
        this.update({ phase: 'unknown', stage: 'unknown', discovery: 'ready', discovered: result.data.operations, message: '发现原提取操作；必须选择原操作只读核验，不能重新批准或发送模型。' });
      } else {
        this.update({ phase: 'idle', stage: null, discovery: 'ready', message: '当前未读到原提取操作；absenceIsFinal=false，不能据此证明没有发送或计费。' });
      }
    } finally { if (this.current === controller) { this.current = null; this.update({}); } }
  }
  async restoreDiscovered(extraction: ExtractionOperation) {
    if (!this.alive || this.current || this.state.sent || !this.state.discovered.some((item) => item.operationId === extraction.operationId)) return;
    this.recoveryMode = 'discovered';
    this.update({ recoveryId: null, registrationIdentity: null, approval: identityFromExtraction(extraction), sent: true, registration: 'unknown', phase: 'checking', stage: extraction.stage, message: '正在只读核验发现的原提取操作；不会重新发送或保存候选。' });
    await this.readBack();
  }
  async readBack() {
    const approval = this.state.approval ?? this.state.recoveryId;
    if (!this.alive || this.current || this.revocation || !this.state.sent || !approval) return;
    const originalOperationId = this.state.registrationIdentity?.operationId ?? this.state.recoveryId;
    if (this.recoveryMode === 'unified' && !originalOperationId) {
      this.update({ phase: 'unknown', message: '原模型登记操作ID缺失；不能以批准ID代替，也不会重新批准或发送。' });
      return;
    }
    const controller = new AbortController(); this.current = controller;
    this.update({ phase: 'checking', delivery: null, operation: null, extraction: null, message: '正在读取原模型操作和候选批次。' });
    try {
      const result = this.recoveryMode === 'discovered'
        ? await readDiscoveredModelRecovery(this.request, this.conversation, approval, controller.signal)
        : await readModelRecovery(this.request, this.conversation,
          typeof approval === 'string' ? approval : { ...approval, operationId: originalOperationId ?? undefined, requestHash: this.state.registrationIdentity?.requestHash }, controller.signal);
      if (!this.alive || this.current !== controller) return;
      if (!result.ok) { this.update({ phase: 'unknown', message: result.error.message }); return; }
      const { state, stage, operation, extraction, delivery } = result.data;
      this.update({ phase: state, stage, operation, extraction, approval: this.state.approval ?? (extraction ? identityFromExtraction(extraction) : operation ? { id: operation.approvalId, actorId: operation.actorId, workspaceId: operation.workspaceId, contentHash: operation.contentHash, baseRevision: operation.baseRevision } : null), delivery: state === 'complete' ? delivery : null,
        registration: state === 'unknown' ? this.state.registration : 'consumed',
        message: state === 'complete' ? delivery.state === 'empty' ? '原提取已完成，无候选；空批次已核验。' : '原模型操作与候选批次已核验。'
          : state === 'rejected_without_save' ? `${extraction?.rejectionReason ? rejectionMessages[extraction.rejectionReason] : '平台已拒绝本次模型结果'}，且候选批次确认未写入；可人工继续，不重新发送原操作。`
          : state === 'discarded' ? '原模型结果已丢弃，未交付候选；可手动继续，不重新发送。'
          : state === 'expired' ? '原候选批次已过期；现场仍保留，不重新提取覆盖原批次。'
          : extraction?.stage === 'model_done' ? '模型已完成，但候选是否保存尚未由权威终态确认；不会重新发送。'
          : extraction?.stage === 'candidate_saving' ? '候选仍处于保存中；保存结果未知，不会重新发送。'
          : operation === null ? '未读到原模型操作；这不能证明没有发送或计费，请继续核验。'
          : '原模型操作或候选保存尚未完成核验；不会重新发送。' });
    } catch {
      if (this.alive && this.current === controller) this.update({ phase: 'unknown', message: '原模型操作或候选只读核验中断；结果仍未知，可再次只读核验，不会重新发送。' });
    } finally { if (this.current === controller) { this.current = null; this.update({}); } }
  }
  async restore(operationId: string) {
    if (!this.alive || this.current || this.state.sent || (this.state.discovered.length === 0 && this.getLeaveState() === 'blocked')) return;
    if (!Id.safeParse(operationId).success) { this.update({ message: '原模型操作ID无效。' }); return; }
    this.recoveryMode = 'unified';
    this.update({ recoveryId: operationId, sent: true, registration: 'unknown' });
    await this.readBack();
  }
}
