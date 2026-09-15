import type { Result } from '../../contracts/api';
import { EvidenceRecordSchema, type Approval } from '../../contracts/domain';
import type { EvidenceApprovalRequest, EvidenceReceipt } from '../../contracts/evidence';
import { hashEvidence } from '../../contracts/hash';
import { ApplicationSavedSchema, EvidenceStoragePreviewSchema, type EvidenceStoragePreview } from './application-api';
import { checkEvidenceApproval, checkEvidenceReceipt, checkEvidenceRegistration, evidenceExpectation, type EvidenceExpectation } from './evidence-binding';

export type EvidenceTransport = (path: string, init?: RequestInit) => Promise<Result<unknown>>;
type Phase = 'preview' | 'approving' | 'approval_unknown' | 'approved' | 'saving' | 'save_unknown' | 'revoking' | 'revoke_unknown' | 'saved' | 'saved_receipt_only' | 'cancelled';
interface SaveState { phase: Phase; busy: boolean; approval: Approval | null; receipt: EvidenceReceipt | null; cancelRequested: boolean; message: string }

function freezePreview<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezePreview); Object.freeze(value); }
  return value;
}

// Only this page's explicitly selected preview lives here. The shared Services owns durable operations.
export class EvidenceSaveFlow {
  readonly preview: EvidenceStoragePreview;
  private value: SaveState = { phase: 'preview', busy: false, approval: null, receipt: null, cancelRequested: false, message: '' };
  private listeners = new Set<() => void>();
  private expected: EvidenceExpectation | null = null;
  private sequence = 0;
  private saveUnresolved = false;
  constructor(preview: EvidenceStoragePreview, private readonly transport: EvidenceTransport) {
    this.preview = freezePreview(EvidenceStoragePreviewSchema.parse(structuredClone(preview)));
  }
  get state() { return this.value; }
  get blocked() { return this.value.busy || !['preview', 'saved', 'saved_receipt_only', 'cancelled'].includes(this.value.phase); }
  readonly getSnapshot = () => this.value;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private change(change: Partial<SaveState>) { this.value = { ...this.value, ...change }; this.listeners.forEach((listener) => listener()); }
  private request(): EvidenceApprovalRequest {
    return { operationId: this.preview.operationId, record: structuredClone(this.preview.record), baseRevision: this.preview.baseRevision, retention: 'until_deleted', confirmed: true };
  }
  private async expectation() { return this.expected ??= await evidenceExpectation(this.request(), this.preview.actorId); }
  private post(path: string, body: unknown) { return this.transport(path, { method: 'POST', body: JSON.stringify(body) }); }
  private originalRegistration() { return this.transport(`/api/workspace/approval-registrations/save_evidence/${encodeURIComponent(this.preview.operationId)}`); }
  private fail(message: string, phase: Phase) { this.change({ phase, message }); }

  async approve(consent: boolean) {
    if (this.value.busy || this.value.phase !== 'preview') return;
    if (!consent) { this.change({ message: '请先确认具体内容及长期私有保存范围。' }); return; }
    const ticket = ++this.sequence; this.change({ phase: 'approving', busy: true, message: '' });
    try {
      const expected = await this.expectation(); if (ticket !== this.sequence) return;
      const result = await this.post('/api/workspace/approvals/evidence', expected.request); if (ticket !== this.sequence) return;
      if (!result.ok) {
        this.fail(result.error.message, result.error.dataState === 'not_written' && !['UNKNOWN_RESULT', 'CONFLICT'].includes(result.error.code) ? 'preview' : 'approval_unknown'); return;
      }
      const approval = checkEvidenceApproval(result.data, expected);
      if (!approval.ok) { this.fail(approval.error.message, 'approval_unknown'); return; }
      this.change({ approval: approval.data });
      await this.readRegistration(expected, ticket);
    } catch { if (ticket === this.sequence) this.fail('批准登记结果未知；请核验原操作，不重复登记。', 'approval_unknown'); }
    finally { if (ticket === this.sequence) this.change({ busy: false }); }
  }

  private async readRegistration(expected: EvidenceExpectation, ticket: number) {
    const result = await this.originalRegistration(); if (ticket !== this.sequence) return;
    const fallback = this.value.cancelRequested && this.value.approval ? 'revoke_unknown' : 'approval_unknown';
    if (!result.ok) { this.fail(result.error.message, fallback); return; }
    const checked = checkEvidenceRegistration(result.data, expected);
    if (!checked.ok) { this.fail(checked.error.message, fallback); return; }
    const value = checked.data;
    if (this.value.approval && value.approval && this.value.approval.id !== value.approval.id) { this.fail('登记返回了另一批准，原操作仍未核验。', fallback); return; }
    if (value.status === 'registered' && value.approval) {
      this.change({ phase: 'approved', approval: value.approval, message: this.value.cancelRequested ? '原批准仍有效；请明确撤回。未自动保存。' : '批准已登记，记录尚未保存。' });
    } else if (value.status === 'revoked' || value.status === 'expired') {
      this.change({ phase: 'cancelled', approval: value.approval, message: value.status === 'revoked' ? '原批准已撤回，本流程没有待核验的写入。' : '原批准已到期，本流程没有待核验的写入。' });
    } else this.fail('尚未找到可确认的原批准；未登记不代表没有晚到请求。', 'approval_unknown');
  }

  async save() {
    if (this.value.busy || this.value.phase !== 'approved' || !this.value.approval || this.value.cancelRequested) return;
    const ticket = ++this.sequence; this.change({ phase: 'saving', busy: true, message: '' }); this.saveUnresolved = true;
    try {
      const expected = await this.expectation(); if (ticket !== this.sequence) return;
      const path = this.preview.record.kind === 'use' ? '/api/learning/use' : '/api/learning/outcomes';
      const result = await this.post(path, { action: 'execute', request: expected.request, approval: this.value.approval });
      if (ticket !== this.sequence) return;
      if (!result.ok) {
        if (result.error.dataState === 'not_written' && result.error.code !== 'UNKNOWN_RESULT') {
          this.saveUnresolved = false; this.change({ phase: 'approved', cancelRequested: true, message: `${result.error.message} 请撤回原批准后重新预览。` });
        } else this.fail(result.error.message, 'save_unknown');
        return;
      }
      const parsed = ApplicationSavedSchema.safeParse(result.data);
      const receipt = checkEvidenceReceipt(parsed.success ? parsed.data.receipt : null, expected, this.value.approval!);
      if (!receipt.ok) { this.fail(receipt.error.message, 'save_unknown'); return; }
      this.saveUnresolved = false; this.change({ phase: 'saved', busy: false, receipt: receipt.data, message: '原保存操作已核验；私有记录不进入语义索引。' });
    } catch { if (ticket === this.sequence) this.fail('保存结果未知；保留原操作 ID，仅核验原回执。', 'save_unknown'); }
    finally { if (ticket === this.sequence) this.change({ busy: false }); }
  }

  async verify() {
    if (this.value.busy || ['preview', 'saved', 'saved_receipt_only', 'cancelled'].includes(this.value.phase)) return;
    const ticket = ++this.sequence; this.change({ busy: true, message: '' });
    try {
      const expected = await this.expectation(); if (ticket !== this.sequence) return;
      if (this.saveUnresolved) {
        const result = await this.transport(`/api/workspace/evidence-receipts/${encodeURIComponent(this.preview.operationId)}`);
        if (ticket !== this.sequence) return;
        if (!result.ok || !this.value.approval) { this.fail(!result.ok ? result.error.message : '原保存批准未核验。', 'save_unknown'); return; }
        const receipt = checkEvidenceReceipt(result.data, expected, this.value.approval);
        if (!receipt.ok) { this.fail('原保存回执尚未匹配；空回执或相同内容的其他记录不能证明本操作结果。', 'save_unknown'); return; }
        const body = await this.transport(`/api/workspace/evidence/${encodeURIComponent(receipt.data.recordId)}`);
        if (ticket !== this.sequence) return;
        if (!body.ok) {
          if (body.error.code === 'FORBIDDEN') {
            this.saveUnresolved = false;
            this.change({ phase: 'saved_receipt_only', busy: false, receipt: receipt.data, message: '原保存回执已匹配，但当前访问或删除屏障拒绝正文；未恢复正文，也不把屏障误报为物理删除完成。' });
          } else this.fail(body.error.message, 'save_unknown');
          return;
        }
        if (body.data === null) {
          this.saveUnresolved = false;
          this.change({ phase: 'saved_receipt_only', busy: false, receipt: receipt.data, message: '原保存回执已匹配，但原记录正文当前不可读；未据此推定物理删除已完成。' });
          return;
        }
        const record = EvidenceRecordSchema.safeParse(body.data);
        if (!record.success || record.data.id !== this.preview.record.id || await hashEvidence(record.data) !== expected.recordHash) {
          this.fail('原保存记录未匹配完整摘要；本次操作仍需继续核验。', 'save_unknown'); return;
        }
        this.saveUnresolved = false; this.change({ phase: 'saved', busy: false, receipt: receipt.data, message: '已只读核验原保存登记、回执和原记录；未重复写入。' });
      } else await this.readRegistration(expected, ticket);
    } catch { if (ticket === this.sequence) this.fail('核验未完成，保留原操作身份。', this.saveUnresolved ? 'save_unknown' : 'approval_unknown'); }
    finally { if (ticket === this.sequence) this.change({ busy: false }); }
  }

  async cancel() {
    if (this.value.busy || ['saved', 'cancelled'].includes(this.value.phase)) return;
    if (this.value.phase === 'preview') { this.change({ phase: 'cancelled', cancelRequested: true, message: '已取消，未登记批准或保存记录。' }); return; }
    this.change({ cancelRequested: true });
    if (this.saveUnresolved) { this.change({ message: '保存已发出，不能把取消当作未写入；请先核验原保存回执。' }); return; }
    if (!this.value.approval) { this.change({ message: '批准结果未知，请先核验原登记，再撤回原批准。' }); return; }
    const ticket = ++this.sequence; this.change({ phase: 'revoking', busy: true });
    try {
      const result = await this.post(`/api/workspace/approvals/${encodeURIComponent(this.value.approval.id)}/revoke`, {});
      if (ticket !== this.sequence) return;
      if (!result.ok) { this.fail(result.error.message, 'revoke_unknown'); return; }
      await this.readRegistration(await this.expectation(), ticket);
    } catch { if (ticket === this.sequence) this.fail('撤回结果未知；原批准仍需核验。', 'revoke_unknown'); }
    finally { if (ticket === this.sequence) this.change({ busy: false }); }
  }

  interrupt() {
    if (!this.value.busy) return;
    this.sequence++;
    this.change({ busy: false, phase: this.saveUnresolved ? 'save_unknown' : this.value.phase === 'revoking' ? 'revoke_unknown' : 'approval_unknown', message: '本地请求已中断，远端结果仍需按原操作核验。' });
  }
}
