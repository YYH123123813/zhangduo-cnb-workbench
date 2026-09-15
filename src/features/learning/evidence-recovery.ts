import type { RequestContext, Result } from '../../contracts/api';
import { ApprovalRegistrationStateSchema, type ApprovalRegistrationState } from '../../contracts/approval';
import { EvidenceRecordSchema, Id, type Approval, type EvidenceRecord } from '../../contracts/domain';
import { EvidenceReceiptSchema, type EvidenceReceipt } from '../../contracts/evidence';
import { checkEvidenceReceipt, checkEvidenceRegistration, evidenceExpectation } from './evidence-binding';
import type { EvidenceTransport } from './evidence-save-flow';
import { failure, success } from './errors';
import { readEvidenceOperationRecovery } from './operation-recovery';

export interface EvidenceOperationView {
  operationId: string; status: 'saved' | 'saved_receipt_only' | 'unresolved';
  approval: Approval | null; approvalStatus: ApprovalRegistrationState['status']; receipt: EvidenceReceipt | null; record: EvidenceRecord | null; message: string;
  operationRecovery?: import('../../contracts/operation-recovery').OperationRecovery;
}
const mismatch = () => failure<EvidenceOperationView>('UNKNOWN_RESULT', '响应未匹配原身份、操作或完整摘要，未展示正文。', 'read_original_evidence_operation', 'unknown');

// Recovery is read-only. An approval hash is not an immutable copy of its unsaved payload.
export async function readEvidenceOperation(transport: EvidenceTransport, identity: Pick<RequestContext, 'actorId' | 'workspaceId'>, operationId: string,
  options: { binding?: { contentHash: string; baseRevision: string }; readBody?: boolean } = {}): Promise<Result<EvidenceOperationView>> {
  if (!Id.safeParse(operationId).success) return failure('VALIDATION', '原操作 ID 无效。');
  try {
    const registered = await transport(`/api/workspace/approval-registrations/save_evidence/${encodeURIComponent(operationId)}`);
    if (!registered.ok) return registered;
    const parsed = ApprovalRegistrationStateSchema.safeParse(registered.data);
    if (!parsed.success) return mismatch();
    const registration = parsed.data, approval = registration.approval;
    if (registration.operationId !== operationId || registration.purpose !== 'save_evidence' || registration.modelPurpose !== undefined
      || registration.actorId !== identity.actorId || registration.workspaceId !== identity.workspaceId) return mismatch();
    // W12 supplies a second, metadata-only recovery address. It is advisory for
    // this flow: the approval, receipt, and body still need their own bindings.
    const sharedRecovery = await readEvidenceOperationRecovery(transport, identity, operationId);
    const operationRecovery = sharedRecovery.ok ? sharedRecovery.data : undefined;
    const pending: EvidenceOperationView = { operationId, status: 'unresolved', approval, approvalStatus: registration.status,
      receipt: null, record: null, message: '原保存回执尚未确认；未登记或空回执不证明操作未执行。', operationRecovery };
    if (!approval) return success(pending);
    if (!registration.requestHash || approval.actorId !== identity.actorId || approval.workspaceId !== identity.workspaceId
      || approval.purpose !== 'save_evidence' || approval.objectIds.length !== 1) return mismatch();
    if (options.binding && (approval.contentHash !== options.binding.contentHash || approval.baseRevision !== options.binding.baseRevision)) return mismatch();
    const saved = await transport(`/api/workspace/evidence-receipts/${encodeURIComponent(operationId)}`);
    if (!saved.ok) return saved;
    if (saved.data === null) return success({ ...pending, message: '批准登记已读取，保存回执仍未确认。缺少原预览载荷时不能继续保存，也不能据空回执断言未写入。' });
    const receipt = EvidenceReceiptSchema.safeParse(saved.data);
    if (!receipt.success || receipt.data.operationId !== operationId || receipt.data.approvalId !== approval.id
      || receipt.data.actorId !== identity.actorId || receipt.data.workspaceId !== identity.workspaceId || receipt.data.recordId !== approval.objectIds[0]
      || receipt.data.baseRevision !== approval.baseRevision || receipt.data.contentHash !== approval.contentHash) return mismatch();
    if (options.readBody === false) return success({ ...pending, status: 'saved_receipt_only', receipt: receipt.data,
      message: '原保存专用回执已核验；尚未请求记录正文，未恢复批准载荷。' });
    const body = await transport(`/api/workspace/evidence/${encodeURIComponent(receipt.data.recordId)}`);
    if (!body.ok) {
      if (body.error.code === 'FORBIDDEN') return success({ ...pending, status: 'saved_receipt_only', receipt: receipt.data,
        message: '原保存回执已匹配，但当前访问/删除屏障拒绝正文；没有恢复正文，也不把屏障误报为物理删除完成。' });
      return body;
    }
    if (body.data === null) return success({ ...pending, status: 'saved_receipt_only', receipt: receipt.data,
      message: '原保存回执已匹配，但原正文当前不可读；没有恢复正文，也不推定删除已完成。' });
    const record = EvidenceRecordSchema.safeParse(body.data); if (!record.success) return mismatch();
    const expected = await evidenceExpectation({ operationId, record: record.data, baseRevision: receipt.data.baseRevision, retention: 'until_deleted', confirmed: true }, identity.actorId);
    if (!checkEvidenceRegistration(registration, expected).ok || !checkEvidenceReceipt(receipt.data, expected, approval).ok) return mismatch();
    return success({ ...pending, status: 'saved', record: record.data, receipt: receipt.data,
      message: '原登记、完整请求摘要、保存回执和记录已只读核验；没有重新登记或追加。' });
  } catch { return failure('UNKNOWN_RESULT', '原操作读取中断；未发送任何写入。', 'read_original_evidence_operation', 'unknown'); }
}
