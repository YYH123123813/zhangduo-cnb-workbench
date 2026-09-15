import type { ApiError, ApiResponse } from '../../contracts/api';
import { ApprovalSchema, type Approval } from '../../contracts/domain';
export type RequestApi = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
export type ChangeStage = 'idle' | 'ready' | 'approving' | 'approval_unknown' | 'reading_approval' | 'approved' | 'sending' | 'verifying' | 'unknown' | 'revoking' | 'revoke_unknown' | 'failed' | 'succeeded';
export interface ApprovalState<P, R> { stage: ChangeStage; prepared: P | null; approval: Approval | null; result: R | null; error: ApiError | null }
const empty = <P, R>(): ApprovalState<P, R> => ({ stage: 'idle', prepared: null, approval: null, result: null, error: null });
const uncertain: ApiError = { code: 'UNKNOWN_RESULT', message: '结果尚未核验。原操作ID和内容已保留，不重复发送执行请求。', retryable: false, dataState: 'unknown', nextAction: 'read_original_operation' };
const registrationUnknown: ApiError = { ...uncertain, message: '批准登记结果未知，尚未发送执行。原预览保留；当前平台尚不能按原操作找回批准，不能重新登记或确认取消。', nextAction: 'read_approval_registration' };
const invalid: ApiError = { code: 'VALIDATION', message: '批准与当前变更不匹配或已过期，未发送提交。', retryable: false, dataState: 'preserved', nextAction: 'preview_and_approve_again' };
export const post = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
interface Registration { actorId: string; workspaceId: string; status: 'registered' | 'revoked' | 'expired' | 'not_registered' | 'unknown'; approval: Approval | null }
export interface ApprovalProtocol<P, R> {
  binding: (prepared: P) => Pick<Approval, 'workspaceId' | 'purpose' | 'contentHash' | 'baseRevision' | 'objectIds'>;
  available: (prepared: P) => boolean;
  approve: (prepared: P) => [string, RequestInit];
  recoverApproval?: (request: RequestApi, prepared: P) => Promise<ApiResponse<Registration | null>>;
  verifyAfterUnknown?: (prepared: P) => boolean;
  execute: (prepared: P, approval: Approval) => [string, RequestInit];
  verify: (request: RequestApi, prepared: P, approval: Approval, response: ApiResponse<unknown> | null) => Promise<ApiResponse<R | null>>;
}

// An uncertain write keeps its original payload until a read-only verification settles it.
export class ApprovalFlow<P, R> {
  private value = empty<P, R>();
  private listeners = new Set<() => void>();
  private actorId = '';
  private revision = '';
  private executionResponse: ApiResponse<unknown> | null = null;
  constructor(private readonly request: RequestApi, private readonly protocol: ApprovalProtocol<P, R>) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get locked() { return ['approving', 'approval_unknown', 'reading_approval', 'sending', 'verifying', 'unknown', 'revoking', 'revoke_unknown'].includes(this.value.stage); }
  private registrationError() { return this.protocol.recoverApproval ? { ...registrationUnknown, message: '批准登记结果未知，尚未发送执行。原预览和操作ID保留，请只读核验原批准。' } : registrationUnknown; }
  private update(patch: Partial<ApprovalState<P, R>>) { this.value = { ...this.value, ...patch }; this.listeners.forEach((listener) => listener()); }
  prepare(prepared: P, actorId: string): boolean {
    if (this.locked || this.value.approval || this.value.stage === 'succeeded') return false;
    this.actorId = actorId; this.revision = this.protocol.binding(prepared).baseRevision;
    this.executionResponse = null;
    this.update({ ...empty<P, R>(), stage: 'ready', prepared: structuredClone(prepared) }); return true;
  }
  private matches(approval: Approval, prepared: P, active = true) {
    const expected = this.protocol.binding(prepared);
    return approval.actorId === this.actorId && approval.workspaceId === expected.workspaceId && approval.purpose === expected.purpose
      && approval.contentHash === expected.contentHash && approval.baseRevision === expected.baseRevision
      && approval.objectIds.length === expected.objectIds.length && new Set(approval.objectIds).size === approval.objectIds.length
      && expected.objectIds.every((id) => approval.objectIds.includes(id)) && Date.parse(approval.approvedAt) <= Date.now()
      && (!active || Date.parse(approval.expiresAt) > Date.now()) && Date.parse(approval.approvedAt) < Date.parse(approval.expiresAt);
  }
  async approve() {
    const prepared = this.value.prepared;
    if (this.value.stage !== 'ready' || !prepared || !this.protocol.available(prepared) || this.protocol.binding(prepared).baseRevision !== this.revision) return;
    this.update({ stage: 'approving', error: null });
    try {
      const response = await this.request(...this.protocol.approve(prepared));
      if (!response.ok) {
        const unknown = response.error.code === 'UNKNOWN_RESULT' || ['unknown', 'partial'].includes(response.error.dataState);
        this.update({ stage: unknown ? 'approval_unknown' : 'ready', error: unknown ? this.registrationError() : response.error }); return;
      }
      const approval = ApprovalSchema.safeParse(response.data);
      if (!approval.success || !this.matches(approval.data, prepared)) { this.update({ stage: 'approval_unknown', error: this.registrationError() }); return; }
      this.update({ stage: 'approved', approval: approval.data });
      if (this.revision !== this.protocol.binding(prepared).baseRevision) await this.revoke();
    } catch { this.update({ stage: 'approval_unknown', error: this.registrationError() }); }
  }
  async recoverApproval() {
    const prepared = this.value.prepared;
    if (this.value.stage !== 'approval_unknown' || !prepared || !this.protocol.recoverApproval) return;
    this.update({ stage: 'reading_approval', error: null });
    try {
      const response = await this.protocol.recoverApproval(this.request, prepared);
      if (!response.ok) { this.update({ stage: 'approval_unknown', error: { ...response.error, dataState: 'unknown', retryable: false } }); return; }
      const state = response.data;
      if (!state || state.actorId !== this.actorId || state.workspaceId !== this.protocol.binding(prepared).workspaceId
        || !state.approval || !this.matches(state.approval, prepared, false)) { this.update({ stage: 'approval_unknown', error: this.registrationError() }); return; }
      if (state.status === 'revoked' || (state.status === 'expired' && Date.parse(state.approval.expiresAt) <= Date.now())) {
        this.update(empty<P, R>()); return;
      }
      if (state.status !== 'registered' || !this.matches(state.approval, prepared)) { this.update({ stage: 'approval_unknown', error: this.registrationError() }); return; }
      this.update({ stage: 'approved', approval: state.approval, error: null });
      if (this.revision !== this.protocol.binding(prepared).baseRevision) await this.revoke();
    } catch { this.update({ stage: 'approval_unknown', error: this.registrationError() }); }
  }
  async commit() {
    const { prepared, approval } = this.value;
    if (this.value.stage !== 'approved' || !prepared || !approval) return;
    if (!this.matches(approval, prepared) || this.revision !== this.protocol.binding(prepared).baseRevision) { this.update({ error: invalid }); await this.revoke(); return; }
    this.update({ stage: 'sending', error: null });
    try {
      const response = await this.request(...this.protocol.execute(prepared, approval));
      if (!response.ok) {
        this.update({ stage: response.error.code === 'UNKNOWN_RESULT' || ['unknown', 'partial'].includes(response.error.dataState) ? 'unknown' : 'failed', error: response.error }); return;
      }
      this.executionResponse = response;
      this.update({ stage: 'unknown' });
      await this.verify();
    } catch {
      this.update({ stage: 'unknown', error: uncertain });
      if (this.protocol.verifyAfterUnknown?.(prepared)) await this.verify();
    }
  }
  async verify() {
    const prepared = this.value.prepared;
    if (this.value.stage !== 'unknown' || !prepared) return;
    this.update({ stage: 'verifying', error: null });
    try {
      const response = await this.protocol.verify(this.request, prepared, this.value.approval!, this.executionResponse);
      if (!response.ok) {
        this.update({ stage: 'unknown', error: response.error }); return;
      }
      const result = response.data;
      if (!result) {
        this.update({ stage: 'unknown', error: uncertain }); return;
      }
      this.update({ stage: 'succeeded', result, error: null });
    } catch { this.update({ stage: 'unknown', error: uncertain }); }
  }
  observeRevision(revision: string) {
    this.revision = revision;
    if (this.value.prepared && this.protocol.binding(this.value.prepared).baseRevision !== revision && !['succeeded', 'unknown', 'sending', 'verifying'].includes(this.value.stage)) this.invalidate();
  }
  invalidate(): boolean {
    if (this.locked || this.value.stage === 'succeeded') return false;
    if (this.value.approval) { void this.revoke(); return true; }
    this.update(empty<P, R>()); return true;
  }
  async revoke() {
    const approval = this.value.approval;
    if (!approval || !['approved', 'failed', 'revoke_unknown'].includes(this.value.stage)) return;
    this.update({ stage: 'revoking', error: null });
    try {
      const response = await this.request(`/api/workspace/approvals/${encodeURIComponent(approval.id)}/revoke`, post({}));
      if (response.ok && (response.data as { revoked?: boolean } | null)?.revoked === true) this.update(empty<P, R>());
      else this.update({ stage: 'revoke_unknown', error: response.ok ? uncertain : response.error });
    } catch { this.update({ stage: 'revoke_unknown', error: uncertain }); }
  }
  finish(): boolean {
    if (this.value.stage !== 'succeeded') return false;
    this.executionResponse = null; this.update(empty<P, R>()); return true;
  }
}
