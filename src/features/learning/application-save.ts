import type { RequestContext, Result } from '../../contracts/api';
import { EvidenceRecordSchema, type EvidenceRecord } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { canonicalJson, hashEvidence } from '../../contracts/hash';
import { ApplicationExecuteSchema, type ApplicationSaved } from './application-api';
import { checkEvidenceApproval, checkEvidenceReceipt, checkEvidenceRegistration, evidenceExpectation } from './evidence-binding';
import { failure, success } from './errors';
import { previewUse } from './use';
import { validateTaskContext } from '../../contracts/task';
import { buildOutcomeEvidence } from './application-record';

export async function executeApplicationSave(input: unknown, kind: 'use' | 'outcome', services: Services, ctx: RequestContext): Promise<Result<ApplicationSaved>> {
  if (!['knowledge:read', 'evidence:write', 'evidence:read'].every((scope) => ctx.scopes.includes(scope))) return failure('FORBIDDEN', '保存及独立核验需要当前知识读取与证据读写权限。', 'request_access');
  const parsed = ApplicationExecuteSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '请使用原预览、长期保存同意和已登记的批准执行保存。');
  const { request, approval } = parsed.data, record = request.record;
  if (record.workspaceId !== ctx.workspaceId || record.nodeRefs.some((ref) => ref.workspaceId !== ctx.workspaceId)) return failure('FORBIDDEN', '记录不属于当前工作区。');
  if (record.kind !== kind) return failure('VALIDATION', '应用和实际结果必须通过各自入口保存，不能上传作答证明。');
  if (!services.readApprovalRegistration || !services.readEvidenceReceipt || !services.readEvidence) return failure('NOT_IMPLEMENTED', '原批准或保存回执端口尚未提供，未执行保存。', 'connect_evidence_ports');
  const expected = await evidenceExpectation(request, ctx.actorId);
  const supplied = checkEvidenceApproval(approval, expected); if (!supplied.ok) return failure('FORBIDDEN', '批准与原记录摘要、身份或版本不匹配。');
  const read = await services.readApprovalRegistration(ctx, { operationId: request.operationId, purpose: 'save_evidence' });
  if (!read.ok) return read;
  const registration = checkEvidenceRegistration(read.data, expected); if (!registration.ok) return registration;
  if (registration.data.status === 'revoked' || registration.data.status === 'expired') return failure('FORBIDDEN', '原保存批准已撤回或过期，未再次写入。', 'review_evidence');
  if (registration.data.status !== 'registered' || !registration.data.approval) return failure('UNKNOWN_RESULT', '原批准登记尚未确认，未继续发送保存。', 'read_approval_registration', 'unknown');
  if (canonicalJson(registration.data.approval) !== canonicalJson(approval)) return failure('FORBIDDEN', '不能使用另一次登记的批准执行本操作。');
  if (kind === 'use') {
    if (!record.useContext) return failure('VALIDATION', '缺少原使用情境，未保存。');
    const snapshot = await services.snapshot(ctx); if (!snapshot.ok) return snapshot;
    const task = validateTaskContext(record.useContext.task, snapshot.data, ctx.actorId); if (!task.ok) return task;
    const preview = previewUse({ task: record.useContext.task, snapshotRevision: request.baseRevision, nodeRefs: record.nodeRefs,
      relationRefs: record.relationRefs, decision: record.decision, reason: record.useContext.reason }, snapshot.data);
    if (!preview.ok) return preview;
    if (preview.data.relationRefs.some((id) => !record.relationRefs.includes(id))
      || preview.data.missingConditions.some((text) => !record.useContext!.retrievalContext.missingConditions.includes(text))
      || preview.data.warnings.some((text) => !record.useContext!.retrievalContext.warnings.includes(text))) return failure('VALIDATION', '预览遗漏正式前提或覆盖警告，请重新核对后批准。', 'reload_and_preview');
  } else {
    if (!record.outcome) return failure('VALIDATION', '缺少独立结果记录。');
    const original = await readApplicationEvidence(services, ctx, record.outcome.useRecordId); if (!original.ok) return original;
    const reconstructed = buildOutcomeEvidence({ useRecordId: record.outcome.useRecordId, status: record.outcome.status,
      summary: record.outcome.summary, failureReason: record.outcome.failureReason }, original.data, ctx, record.id, record.recordedAt);
    if (!reconstructed.ok) return reconstructed;
    if (await hashEvidence(reconstructed.data) !== expected.recordHash || request.baseRevision !== original.data.useContext?.snapshotRevision)
      return failure('CONFLICT', '结果必须保留原使用记录的任务、版本及引用，未更改原记录。', 'read_original_evidence');
  }
  const written = await services.appendEvidence(ctx, record, approval); if (!written.ok) return written;
  const saved = EvidenceRecordSchema.safeParse(written.data);
  if (!saved.success || await hashEvidence(saved.data) !== expected.recordHash) return failure('UNKNOWN_RESULT', '保存响应未匹配原记录，需要读回原操作。', 'read_evidence_receipt', 'unknown');
  const readBack = await services.readEvidence(ctx, request.record.id);
  if (!readBack.ok) return failure('UNKNOWN_RESULT', '保存回执已返回，但原记录读回失败；请按原操作继续核验。', 'read_evidence_receipt', 'unknown');
  const readRecord = EvidenceRecordSchema.safeParse(readBack.data);
  if (!readRecord.success || readRecord.data.id !== request.record.id || await hashEvidence(readRecord.data) !== expected.recordHash) {
    return failure('UNKNOWN_RESULT', '保存回执已返回，但原记录摘要未匹配；未将本次操作标记为成功。', 'read_evidence_receipt', 'unknown');
  }
  const receipt = await services.readEvidenceReceipt(ctx, request.operationId); if (!receipt.ok) return failure('UNKNOWN_RESULT', '写入后的原回执未能确认，请只读核验。', 'read_evidence_receipt', 'unknown');
  const checked = checkEvidenceReceipt(receipt.data, expected, approval); if (!checked.ok) return checked;
  return success({ receipt: checked.data, persistence: 'saved', indexing: 'excluded' });
}

export async function readApplicationSelection(services: Services, ctx: RequestContext, selection: { taskId?: string; useId?: string; evidenceId?: string }): Promise<Result<EvidenceRecord[]>> {
  const selectedId = selection.evidenceId ?? selection.useId;
  if (!selectedId) return failure('VALIDATION', '请选择原应用或结果记录。');
  const selected = await readApplicationEvidence(services, ctx, selectedId); if (!selected.ok) return selected;
  const useId = selection.useId ?? selected.data.outcome?.useRecordId;
  const original = useId && useId !== selectedId ? await readApplicationEvidence(services, ctx, useId) : selected;
  if (!original.ok) return original;
  if ((useId && original.data.kind !== 'use') || (selection.taskId && selected.data.taskId !== selection.taskId)
    || original.data.taskId !== selected.data.taskId || (selected.data.outcome && selected.data.outcome.useRecordId !== original.data.id)
    || (selected.data.kind === 'use' && useId && selected.data.id !== useId))
    return failure('CONFLICT', '入口的原应用、结果和任务并非同一记录链，未显示正文。', 'review_original_ids');
  if (selected.data.outcome && (canonicalJson(selected.data.nodeRefs) !== canonicalJson(original.data.nodeRefs)
    || canonicalJson(selected.data.relationRefs) !== canonicalJson(original.data.relationRefs)))
    return failure('CONFLICT', '结果引用与原应用不同，未显示正文。', 'review_original_ids');
  return success(original.data.id === selected.data.id ? [selected.data] : [original.data, selected.data]);
}

export async function readApplicationEvidence(services: Services, ctx: RequestContext, id: string): Promise<Result<EvidenceRecord>> {
  if (!services.readEvidence) return failure('NOT_IMPLEMENTED', '原记录读取端口尚未提供。', 'connect_evidence_ports');
  if (!ctx.scopes.includes('evidence:read') || !ctx.scopes.includes('knowledge:read')) return failure('FORBIDDEN', '读取原记录需要当前证据与知识读取权限。');
  const result = await services.readEvidence(ctx, id); if (!result.ok) return result;
  if (result.data === null) return failure('CONFLICT', '未找到可读的原记录；这不证明原保存未执行。', 'read_evidence_receipt', 'preserved');
  const parsed = EvidenceRecordSchema.safeParse(result.data);
  if (!parsed.success || parsed.data.id !== id) return failure('UPSTREAM', '返回记录未匹配原记录 ID。', 'read_original_evidence');
  if (parsed.data.workspaceId !== ctx.workspaceId || parsed.data.nodeRefs.some((ref) => ref.workspaceId !== ctx.workspaceId)) return failure('FORBIDDEN', '记录不属于当前工作区。');
  return success(parsed.data);
}
