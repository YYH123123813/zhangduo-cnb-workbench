import type { RequestContext, Result } from '../../contracts/api';
import { HandoffOperationReceiptSchema, HandoffOperationSaveRequestSchema, HandoffOperationStateSchema } from '../../contracts/handoff-operation';
import type { HandoffOperationReceipt, HandoffOperationSaveRequest, HandoffOperationSnapshot } from '../../contracts/handoff-operation';
import { canonicalJson, contentHash } from '../../contracts/hash';
import { hasItemEdits } from './client-state';
import { toDraft } from './draft';
import { failure, sourceFor } from './model';
import type { Review, ReviewItem } from './model';
import type { OriginalPreviewKey } from './original-preview';
import type { OriginalRecoveryState } from './original-recovery';
import type { HandoffPreview } from './preview';

export function makeOperationRequest(preview: HandoffPreview, review: Review, item: ReviewItem,
  confirmed: boolean): Result<HandoffOperationSaveRequest> {
  if (!confirmed) return failure('尚未同意私有保存本次完整预览。', 'VALIDATION', 'confirm_original_save', 'not_written');
  if (hasItemEdits(item) || item.draftVersion?.state !== 'available' || !item.draftVersion.contentHash) {
    return failure('本条审阅仍有未保存内容，请先核验原草稿版本。', 'CONFLICT', 'save_progress', 'preserved');
  }
  const draft = toDraft(review, item, preview.changes.baseRevision, preview.draft.node.updatedAt);
  if (!draft.ok || canonicalJson(draft.data) !== canonicalJson(preview.draft)) {
    return failure('本次预览与已保存审阅不一致，未保存快照。', 'CONFLICT', 'refresh_preview', 'preserved');
  }
  const request = HandoffOperationSaveRequestSchema.safeParse({ draft: preview.draft, changes: preview.changes, source: sourceFor(item),
    draftRevision: item.draftVersion.revision, draftContentHash: item.draftVersion.contentHash,
    expectedConversationHash: review.conversation.contentHash, expectedOperationRevision: 0, retentionDays: 30, confirmed: true });
  return request.success ? { ok: true, data: request.data }
    : failure('原预览保存字段不完整，未执行保存。', 'VALIDATION', 'review_original_preview', 'not_written');
}

export interface VerifiedOperation {
  key: OriginalPreviewKey;
  snapshot: HandoffOperationSnapshot;
  receipt: HandoffOperationReceipt;
}
export interface OriginalOperationView { recovery: OriginalRecoveryState; storage: HandoffOperationReceipt }

export async function verifyOperationEnvelope(input: unknown, proof: unknown,
  identity: Pick<RequestContext, 'actorId' | 'workspaceId' | 'mode'>, conversationId: string, operationId: string,
  now: number): Promise<Result<VerifiedOperation>> {
  const state = HandoffOperationStateSchema.safeParse(input), receipt = HandoffOperationReceiptSchema.safeParse(proof);
  const uncertain = () => failure<VerifiedOperation>('尚未取得对应原操作的完整预览与保存回执；不能推断未保存、未批准或未提交。', 'UNKNOWN_RESULT', 'read_original_operation', 'unknown');
  if (!state.success || !receipt.success || !Number.isFinite(now)) return uncertain();
  const record = state.data, saved = receipt.data;
  if (identity.mode === 'unconfigured' || record.actorId !== identity.actorId || record.workspaceId !== identity.workspaceId ||
    saved.actorId !== identity.actorId || saved.workspaceId !== identity.workspaceId) {
    return failure('原操作不属于当前身份或工作区。', 'FORBIDDEN', 'request_access', 'preserved');
  }
  if (record.state === 'expired' || (record.expiresAt && Date.parse(record.expiresAt) <= now)) {
    return failure('原预览正文已到期，不能用最新草稿补造；仍可只读核验原提交回执。', 'CONFLICT', 'read_back', 'preserved');
  }
  if (record.state !== 'available' || !record.snapshot || record.operationId !== operationId || saved.operationId !== operationId ||
    saved.conversationId !== conversationId || record.revision !== saved.revision || record.contentHash !== saved.contentHash ||
    record.requestHash !== saved.requestHash || record.expiresAt !== saved.expiresAt || Date.parse(saved.storedAt) > now ||
    Date.parse(saved.expiresAt) <= Date.parse(saved.storedAt)) return uncertain();
  const { snapshot } = record, { draft, changes, source, savedDraft } = snapshot;
  if (draft.id !== saved.draftId || draft.conversationId !== conversationId || changes.id !== operationId ||
    changes.workspaceId !== identity.workspaceId || changes.contentHash !== saved.changeSetHash || changes.baseRevision !== saved.baseRevision ||
    savedDraft.id !== saved.draftId || savedDraft.revision !== saved.draftRevision || savedDraft.contentHash !== saved.draftContentHash ||
    savedDraft.conversationHash !== saved.conversationHash || savedDraft.state !== 'available' || !savedDraft.expiresAt ||
    Date.parse(saved.expiresAt) > Date.parse(savedDraft.expiresAt) || await contentHash(snapshot) !== saved.contentHash) return uncertain();
  const request = HandoffOperationSaveRequestSchema.safeParse({ draft, changes, source, draftRevision: saved.draftRevision,
    draftContentHash: saved.draftContentHash, expectedConversationHash: saved.conversationHash,
    expectedOperationRevision: 0, retentionDays: 30, confirmed: true });
  if (!request.success || await contentHash(request.data) !== saved.requestHash) return uncertain();
  return { ok: true, data: { key: { actorId: saved.actorId, workspaceId: saved.workspaceId, conversationId,
    changeSetId: operationId, contentHash: saved.changeSetHash, baseRevision: saved.baseRevision,
    draftId: saved.draftId, draftRevision: saved.draftRevision, draftContentHash: saved.draftContentHash }, snapshot, receipt: saved } };
}
