import type { ApiResponse } from '../../contracts/api';
import { ApprovalSchema, type Approval, type Conversation } from '../../contracts/domain';
import type { CapturePreview, PreviewInput } from './preview';
import { checkSavedReceipt } from './readback';
import { checkCapturePreview } from './preview-receipt';
import type { LeaveGuard } from '../../contracts/navigation';
import { ConversationApprovalRequestSchema } from '../../contracts/approval';
import { checkRegistrationContinuation, prepareRegistration, readRegistration, type RegistrationIdentity, type RegistrationContinuation } from './approval-registration';

type Phase = 'idle' | 'previewing' | 'ready' | 'approving' | 'saving' | 'checking' | 'saved' | 'unknown' | 'failed';
type Transport = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
export interface SaveState { phase: Phase; preview: CapturePreview | null; saved: Conversation | null; message: string; mode: string; sent: boolean; approvalId: string | null; approvalState: 'none' | 'pending' | 'active' | 'revoking' | 'revoked' | 'expired' | 'unknown' | 'consumed'; registrationIdentity: RegistrationIdentity | null }
const busyPhases: Phase[] = ['previewing', 'approving', 'saving', 'checking'];

export class CaptureSaveFlow {
  private state: SaveState = { phase: 'idle', preview: null, saved: null, message: '', mode: '', sent: false, approvalId: null, approvalState: 'none', registrationIdentity: null };
  private listeners = new Set<() => void>();
  private current: AbortController | null = null;
  private approval: Approval | null = null;
  private revocation: Promise<boolean> | null = null;
  private alive = true;
  private saveAttempt = 0;
  constructor(private request: Transport) {}
  getSnapshot = () => this.state;
  getLeaveState: LeaveGuard['getState'] = () => this.state.phase === 'saved' ? 'clean' : this.state.sent || ['pending', 'active', 'revoking', 'unknown'].includes(this.state.approvalState) ? 'blocked' : this.state.preview ? 'dirty' : 'clean';
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate() { this.alive = true; }
  dispose() { if (this.current || this.approval) void this.cancel(); this.alive = false; }
  private update(change: Partial<SaveState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private isCurrent(controller: AbortController) { return this.alive && this.current === controller && !controller.signal.aborted; }
  private start(phase: Phase, message: string) {
    const controller = new AbortController(); this.current = controller; this.update({ phase, message }); return controller;
  }
  private revoke(approval: Approval): Promise<boolean> {
    if (this.revocation) return this.revocation;
    this.approval = approval;
    this.update({ approvalId: approval.id, approvalState: 'revoking' });
    this.revocation = (async () => {
      let revoked = false;
      try {
        const result = await this.request(`/api/capture/approvals/${encodeURIComponent(approval.id)}/revoke`, { method: 'POST', body: '{}' });
        revoked = result.ok && typeof result.data === 'object' && result.data !== null && 'revoked' in result.data && result.data.revoked === true;
      } catch { /* Retain the same approval for an explicit revocation retry. */ }
      if (this.approval === approval) {
        if (revoked) this.approval = null;
        this.update({ approvalState: revoked ? 'revoked' : 'unknown' });
      }
      this.revocation = null;
      return revoked;
    })();
    return this.revocation;
  }
  private async verify(value: unknown, expected: Conversation) {
    const result = await checkSavedReceipt(value, expected);
    return result.ok ? result.data : null;
  }
  async prepare(input: PreviewInput) {
    if (!this.alive || this.state.sent || this.getLeaveState() === 'blocked' || busyPhases.includes(this.state.phase)) return;
    const controller = this.start('previewing', '正在核对摘要；尚未保存。');
    this.update({ preview: null });
    try {
      const result = await this.request('/api/capture/preview', { method: 'POST', body: JSON.stringify(input), signal: controller.signal });
      if (!this.isCurrent(controller)) return;
      if (!result.ok) { this.update({ phase: 'failed', message: result.error.message }); return; }
      const preview = await checkCapturePreview(result.data, input);
      if (!this.isCurrent(controller)) return;
      if (!preview.ok) { this.update({ phase: 'failed', message: preview.error.message }); return; }
      this.update({ phase: 'ready', preview: preview.data, mode: result.meta.mode, message: '保存预览已生成；尚未批准、写入或发送模型。' });
    } catch { if (this.isCurrent(controller)) this.update({ phase: 'failed', message: '预览失败；内容仍在当前页面，未保存。' }); }
    finally { if (this.current === controller) this.current = null; }
  }
  async save() { await this.performSave(); }
  async continueOriginal() {
    if (this.state.approvalState !== 'active' || !this.state.registrationIdentity || !this.approval) return;
    await this.performSave({ identity: this.state.registrationIdentity, approvalId: this.approval.id });
  }
  private async performSave(continuation?: RegistrationContinuation) {
    const preview = this.state.preview;
    if (!this.alive || this.state.sent || (!continuation && this.getLeaveState() === 'blocked') || !preview || this.current || this.revocation || busyPhases.includes(this.state.phase)) return;
    const controller = this.start('approving', continuation ? '正在重新核验原批准；尚未继续写入。' : '正在登记本次保存批准。');
    const attempt = ++this.saveAttempt;
    if (!continuation) this.update({ approvalState: 'none', approvalId: null, registrationIdentity: null });
    try {
      const body = ConversationApprovalRequestSchema.parse(JSON.parse(JSON.stringify({ conversation: preview.conversation, baseRevision: 'new', operationId: continuation?.identity.operationId ?? crypto.randomUUID(), confirmed: true })));
      let approved: Approval;
      if (continuation) {
        const recovered = await checkRegistrationContinuation(this.request, body, continuation, controller.signal);
        if (!this.isCurrent(controller)) return;
        if (!recovered.ok) { this.update({ phase: 'unknown', approvalState: 'unknown', message: recovered.error.message }); return; }
        approved = recovered.data;
      } else {
        const prepared = await prepareRegistration(this.request, body, preview.conversation.workspaceId, controller.signal);
        if (!this.isCurrent(controller)) return;
        if (!prepared.ok) { this.update({ phase: 'failed', message: prepared.error.message }); return; }
        this.update({ registrationIdentity: prepared.data, approvalState: 'pending' });
        // Do not abort approval transport: a late issued approval must still be revoked.
        const issued = await this.request('/api/capture/approve', { method: 'POST', body: JSON.stringify(body) });
        if (attempt !== this.saveAttempt) return;
        const parsed = issued.ok ? ApprovalSchema.safeParse(issued.data) : null;
        if (!parsed?.success) {
          const absent = !issued.ok && issued.error.dataState === 'not_written';
          this.update({ phase: absent ? 'failed' : 'unknown', approvalState: absent ? 'none' : 'unknown', message: absent ? issued.error.message : '批准登记结果未知；未发送现场写入，不能重新申请或离开。需核验原批准登记。' });
          return;
        }
        if (parsed.data.actorId !== prepared.data.actorId || parsed.data.workspaceId !== prepared.data.workspaceId) {
          this.update({ phase: 'unknown', approvalState: 'unknown', message: '批准返回身份与原会话不一致；请按原登记核验。' }); return;
        }
        this.approval = parsed.data; this.update({ approvalId: parsed.data.id, approvalState: 'active' });
        if (!this.isCurrent(controller)) {
          const revoked = await this.revoke(parsed.data);
          if (attempt === this.saveAttempt) this.update({ phase: revoked ? 'failed' : 'unknown', message: revoked ? '后到批准已撤回；没有发送现场写入请求。' : '后到批准撤回未确认；请重试撤回原批准。' });
          return;
        }
        approved = parsed.data;
      }
      if (approved.purpose !== 'save_conversation' || approved.workspaceId !== preview.conversation.workspaceId || approved.contentHash !== preview.conversation.contentHash || approved.baseRevision !== 'new' || approved.objectIds.length !== 1 || approved.objectIds[0] !== preview.conversation.id || Date.parse(approved.approvedAt) > Date.now() || Date.parse(approved.expiresAt) <= Date.now()) {
        const revoked = await this.revoke(approved);
        if (this.isCurrent(controller)) this.update({ phase: revoked ? 'failed' : 'unknown', message: revoked ? '批准与已展示现场不一致或已过期，已撤回；未发送写入请求。' : '批准不匹配且撤回未确认；请重试撤回原批准。' });
        return;
      }
      this.approval = approved;
      this.update({ phase: 'saving', sent: true, message: '正在保存并读回核验；当前范围已锁定。' });
      const result = await this.request('/api/capture/save', { method: 'POST', body: JSON.stringify({ conversation: preview.conversation, approval: approved, confirmed: true }) });
      if (!this.isCurrent(controller)) return;
      if (!result.ok) {
        const notWritten = result.error.dataState === 'not_written';
        this.update({ phase: 'unknown', sent: !notWritten, message: result.error.message });
        if (notWritten) {
          const revoked = await this.revoke(approved);
          if (this.isCurrent(controller)) this.update({ phase: revoked ? 'failed' : 'unknown', message: revoked ? `${result.error.message} 原批准已撤回。` : '现场未写入，但批准撤回未确认；请重试撤回原批准。' });
        }
        return;
      }
      const saved = await this.verify(result.data, preview.conversation);
      if (!this.isCurrent(controller)) return;
      if (saved) this.approval = null;
      this.update(saved ? { phase: 'saved', saved, approvalState: 'consumed', message: '现场已保存并读回核验；尚未发送模型。' } : { phase: 'unknown', message: '保存回执与本次预览不匹配；请按原ID核验。' });
    } catch {
      if (attempt !== this.saveAttempt) return;
      if (this.state.approvalState === 'pending') this.update({ phase: 'unknown', approvalState: 'unknown', message: '批准登记结果未知；未发送现场写入，不能重新申请或离开。需核验原批准登记。' });
      else if (this.isCurrent(controller)) this.update({ phase: 'unknown', message: '保存结果未知；请按本次ID读回核验。' });
    }
    finally { if (this.current === controller) this.current = null; }
  }
  async readApprovalRegistration() {
    const original = this.state.registrationIdentity;
    if (!this.alive || !original || this.revocation || ['saving', 'checking', 'saved'].includes(this.state.phase)) return;
    // Supersede the old response observer before GET; late registration cannot resume a write.
    ++this.saveAttempt; this.current?.abort();
    const controller = this.start('checking', '正在核验原保存批准登记；不执行现场写入。');
    try {
      const result = await readRegistration(this.request, original, controller.signal);
      if (!this.isCurrent(controller)) return;
      if (!result.ok) { this.update({ phase: 'unknown', approvalState: 'unknown', message: result.error.message }); return; }
      const value = result.data;
      if (!value.approval) { this.update({ phase: 'unknown', approvalState: 'unknown', message: '尚未找到原登记，不能排除在途登记；不会重新申请批准。' }); return; }
      this.approval = value.status === 'registered' ? value.approval : null;
      const inactive = value.status === 'revoked' || value.status === 'expired';
      this.update({ approvalId: value.approval.id, approvalState: value.status === 'registered' ? 'active' : value.status as 'revoked' | 'expired',
        phase: inactive && !this.state.sent ? 'failed' : 'unknown',
        message: value.status === 'registered' ? '已找到原保存批准；未继续写入。可明确继续原请求或撤回原批准。'
          : this.state.sent ? '原批准已失效；已发出的现场写入仍需按原ID核验。' : '原批准已撤回或过期；本页未发送现场写入。' });
    } finally { if (this.current === controller) this.current = null; }
  }
  async cancel() {
    if (!this.alive || this.state.phase === 'saved') return;
    this.current?.abort(); this.current = null;
    this.update({ phase: this.getLeaveState() === 'blocked' ? 'unknown' : 'failed', message: this.state.sent ? '已停止后续处理；写入请求已发出，请按原ID核验。' : this.getLeaveState() === 'blocked' ? '已停止后续保存；原批准登记或撤回尚待核验，不能重新申请。' : '已停止后续保存；没有发送现场写入请求。' });
    const approval = this.approval;
    if (approval) {
      const revoked = await this.revoke(approval);
      this.update({ phase: revoked && !this.state.sent ? 'failed' : 'unknown', message: revoked ? this.state.sent ? '批准已撤回；已发出的写入仍需核验。' : '批准已撤回；未写入现场。' : '未能核验批准撤回；保留原批准ID，请重试撤回。' });
    }
  }
  async readBack() {
    const preview = this.state.preview;
    if (!this.alive || this.revocation || !this.state.sent || !preview || busyPhases.includes(this.state.phase) || this.state.phase === 'saved') return;
    const controller = this.start('checking', '正在按原ID核验现场。');
    try {
      const result = await this.request(`/api/capture/${encodeURIComponent(preview.conversation.id)}`, { signal: controller.signal });
      if (!this.isCurrent(controller)) return;
      if (!result.ok) { this.update({ phase: 'unknown', message: result.error.message }); return; }
      const saved = await this.verify(result.data, preview.conversation);
      if (!this.isCurrent(controller)) return;
      if (saved) this.approval = null;
      this.update(saved ? { phase: 'saved', saved, approvalState: 'consumed', message: '已按原ID核验现场保存结果。' } : { phase: 'unknown', message: '读回内容与本次预览不同，请核对现场版本。' });
    } catch { if (this.isCurrent(controller)) this.update({ phase: 'unknown', message: '读回未成功；没有重新创建现场。' }); }
    finally { if (this.current === controller) this.current = null; }
  }
}
