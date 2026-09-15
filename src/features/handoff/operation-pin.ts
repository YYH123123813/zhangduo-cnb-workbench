import type { Result } from '../../contracts/api';
import type { HandoffOperationPin } from '../../contracts/navigation';
import { HandoffOperationReceiptSchema, HandoffOperationSaveRequestSchema } from '../../contracts/handoff-operation';
import type { HandoffOperationReceipt, HandoffOperationSaveRequest } from '../../contracts/handoff-operation';
import { canonicalJson, contentHash, hashChangeSet } from '../../contracts/hash';
import { failure, sourceFor } from './model';
import type { Review, ReviewItem } from './model';
import type { HandoffPreview } from './preview';

const SHA256 = /^[a-f0-9]{64}$/;

export interface BuildHandoffOperationPinInput {
  review: Review;
  item: ReviewItem;
  preview: HandoffPreview;
  request: HandoffOperationSaveRequest | null;
  receipt: HandoffOperationReceipt | null;
}

function rejected(message: string, nextAction = 'review_original_preview'): Result<HandoffOperationPin> {
  return failure(message, 'CONFLICT', nextAction, 'preserved');
}

/**
 * Bind the address to the already verified original-save operation.
 * This function only validates and constructs the navigation payload; it never
 * writes a URL or changes handoff state.
 */
export async function buildHandoffOperationPin(input: BuildHandoffOperationPinInput): Promise<Result<HandoffOperationPin>> {
  const { review, item, preview, request, receipt } = input;
  if (!request || !receipt) return rejected('原预览尚未取得可核验的保存回执，未固定操作地址。', 'read_original_operation');

  const parsedRequest = HandoffOperationSaveRequestSchema.safeParse(request);
  const parsedReceipt = HandoffOperationReceiptSchema.safeParse(receipt);
  if (!parsedRequest.success || !parsedReceipt.success) return rejected('原预览保存回执字段不完整，未固定操作地址。');

  const saved = parsedReceipt.data;
  const now = Date.now();
  if (Date.parse(saved.expiresAt) <= now || Date.parse(saved.storedAt) > now || Date.parse(saved.expiresAt) <= Date.parse(saved.storedAt)) {
    return rejected('原预览保存期限已失效，未固定操作地址。', 'read_original_operation');
  }
  const currentSource = sourceFor(item);
  const source = currentSource.kind === 'candidate' ? 'candidate' : 'manual';
  const expectedHash = saved.changeSetHash;
  if (!SHA256.test(expectedHash)) return rejected('原操作摘要不是有效的 64 位小写 SHA-256，未固定操作地址。', 'read_original_operation');

  const sameSource = canonicalJson(parsedRequest.data.source) === canonicalJson(currentSource);
  const sameDraft = canonicalJson(parsedRequest.data.draft) === canonicalJson(preview.draft);
  const sameChanges = canonicalJson(parsedRequest.data.changes) === canonicalJson(preview.changes);
  const draftVersion = item.draftVersion;
  if (!sameSource || !sameDraft || !sameChanges || !draftVersion ||
    parsedRequest.data.source.kind !== source || parsedRequest.data.draft.id !== preview.draft.id ||
    parsedRequest.data.draft.conversationId !== review.conversation.id || parsedRequest.data.changes.id !== preview.changes.id ||
    parsedRequest.data.draftRevision !== draftVersion.revision || parsedRequest.data.draftContentHash !== draftVersion.contentHash ||
    parsedRequest.data.expectedConversationHash !== review.conversation.contentHash ||
    item.draftId !== preview.draft.id) {
    return rejected('当前现场、草稿、来源或原预览已变化，未固定旧操作地址。', 'refresh_preview');
  }

  if (saved.operationId !== preview.changes.id || saved.draftId !== preview.draft.id ||
    saved.conversationId !== review.conversation.id || saved.actorId !== review.actorId ||
    saved.workspaceId !== review.conversation.workspaceId || saved.baseRevision !== preview.changes.baseRevision ||
    saved.draftRevision !== parsedRequest.data.draftRevision || saved.draftContentHash !== parsedRequest.data.draftContentHash ||
    saved.conversationHash !== review.conversation.contentHash || saved.requestHash !== await contentHash(parsedRequest.data) ||
    preview.changes.contentHash !== expectedHash || await hashChangeSet(preview.changes) !== expectedHash) {
    return rejected('原保存回执与当前预览的身份、版本或内容摘要不一致，未固定操作地址。', 'read_original_operation');
  }

  return { ok: true, data: {
    conversationId: review.conversation.id,
    draftId: preview.draft.id,
    changeSetId: preview.changes.id,
    source,
    operationHash: expectedHash,
  } };
}
