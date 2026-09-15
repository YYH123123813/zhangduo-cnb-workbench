import type { RequestContext, Result } from '../../contracts/api';
import { DraftReceiptSchema, DraftStateSchema, ReviewProgressSchema } from '../../contracts/handoff';
import type { DraftReceipt, DraftSaveOptions, DraftState, ReviewProgress } from '../../contracts/handoff';
import { canonicalJson, contentHash } from '../../contracts/hash';
import { restoreDraft } from './draft';
import { failure, isAICandidate, refreshRelationConfirmations, sameSourceProvenance, sourceFor } from './model';
import type { Review, ReviewItem } from './model';
import { withManualSource } from './manual';

export interface PendingProgress { progress: ReviewProgress; options: DraftSaveOptions }
export interface ProgressSaveResult { state: DraftState; receipt: DraftReceipt }

export function progressFingerprint(item: ReviewItem): string {
  return canonicalJson({ id: item.draftId, nodeId: item.nodeId, baseRevision: item.baseRevision,
    title: item.subject.title, question: item.subject.question, kind: item.subject.kind,
    disposition: item.disposition, statement: item.statement, authorship: item.authorship, conditions: item.conditions,
    boundaries: item.boundaries, sources: item.sources, relations: item.relations, relationInput: item.relationInput });
}

export function toProgress(review: Review, item: ReviewItem, baseRevision: string): Result<ReviewProgress> {
  const parsed = ReviewProgressSchema.safeParse({ id: item.draftId, workspaceId: review.conversation.workspaceId,
    conversationId: review.conversation.id, nodeId: item.nodeId, baseRevision: item.baseRevision ?? baseRevision,
    title: item.subject.title, question: item.subject.question, kind: item.subject.kind,
    disposition: item.disposition, statement: item.statement, authorship: item.authorship,
    conditions: item.conditions, boundaries: item.boundaries, sources: item.sources, relations: item.relations, relationInput: item.relationInput });
  return parsed.success ? { ok: true, data: parsed.data } : failure('部分审阅字段超出保存范围或格式无效；本地内容仍保留。', 'VALIDATION', 'review_progress', 'preserved');
}

export function validateProgress(input: unknown, options: Pick<DraftSaveOptions, 'source' | 'expectedConversationHash'>,
  review: Review, ctx: Pick<RequestContext, 'actorId' | 'workspaceId'>): Result<ReviewProgress> {
  const parsed = ReviewProgressSchema.safeParse(input);
  if (!parsed.success) return failure('部分审阅格式无效。');
  const progress = parsed.data, source = options.source;
  const item = review.items.find((entry) => entry.draftId === progress.id);
  if (progress.workspaceId !== ctx.workspaceId || progress.conversationId !== review.conversation.id ||
    options.expectedConversationHash !== review.conversation.contentHash) return failure('部分审阅不属于当前现场或来源版本。', 'CONFLICT', 'reload_source', 'preserved');
  if (!item || canonicalJson(sourceFor(item)) !== canonicalJson(source) || item.nodeId !== progress.nodeId || item.subject.title !== progress.title ||
    item.subject.question !== progress.question || item.subject.kind !== progress.kind) return failure('部分审阅的候选、草稿或节点引用不一致。');
  if (new Set(progress.sources.map((entry) => entry.id)).size !== progress.sources.length || progress.sources.some((entry) =>
    !item.subject.sources.some((original) => sameSourceProvenance(original, entry)) ||
    (entry.support !== 'unverified' && (!progress.statement.trim() || !entry.excerpt.trim() || entry.supportedClaim !== progress.statement.trim())) ||
    (entry.support === 'partial' && !entry.limitation.trim()))) return failure('来源原句或判断不对应本次陈述，请重新核验。');
  const sameAI = isAICandidate(item.subject) && Boolean(progress.statement.trim()) && progress.statement.trim().replace(/\r\n/g, '\n') === item.subject.claim.trim().replace(/\r\n/g, '\n');
  if (!isAICandidate(item.subject) && progress.authorship !== 'human_written') return failure('手动审阅不能冒用 AI 作者身份。');
  if (sameAI !== (progress.authorship === 'ai_accepted')) return failure('作者身份与原候选表达不一致。');
  const sourceIds = new Set(progress.sources.map((entry) => entry.id));
  if (new Set(progress.conditions.map((entry) => entry.id)).size !== progress.conditions.length || progress.conditions.some((entry) =>
    entry.evidenceIds.some((id) => !sourceIds.has(id)) || (entry.confirmedBy && entry.confirmedBy !== ctx.actorId)) ||
    progress.relations.some((entry) => entry.workspaceId !== ctx.workspaceId || entry.proposedBy !== ctx.actorId || (entry.confirmedBy && entry.confirmedBy !== ctx.actorId))) {
    return failure('部分审阅的条件、关系或确认人不匹配。', 'FORBIDDEN', 'review_attribution');
  }
  return { ok: true, data: progress };
}

export async function restoreProgressState(review: Review, input: unknown): Promise<Result<Review>> {
  const parsed = DraftStateSchema.safeParse(input);
  if (!parsed.success) return failure('已存进度格式无效，本地编辑未改变。', 'UPSTREAM', 'read_draft_state', 'preserved');
  const state = parsed.data;
  if (state.state === 'available' && state.source?.kind === 'manual' && state.document) {
    const fields = state.document.kind === 'draft' ? state.document.value.node : state.document.value;
    const manual = await withManualSource(review, state.source, { id: state.id, title: fields.title, question: fields.question, kind: fields.kind });
    if (!manual.ok) return manual;
    review = manual.data;
  }
  const item = review.items.find((entry) => entry.draftId === state.id);
  if (!item) return failure('已存进度不属于本次审阅。', 'FORBIDDEN', 'select_draft', 'preserved');
  const draftVersion = { state: state.state, revision: state.revision, contentHash: state.contentHash };
  if (state.state !== 'available') {
    if (state.state === 'missing' && (state.revision !== 0 || state.contentHash !== null || state.source !== null || state.conversationHash !== null)) {
      return failure('草稿缺失状态不一致。', 'UPSTREAM', 'read_draft_state', 'preserved');
    }
    return { ok: true, data: { ...review, items: review.items.map((entry) => entry !== item ? entry : { ...entry, draftVersion }) } };
  }
  if (state.conversationHash !== review.conversation.contentHash || canonicalJson(state.source) !== canonicalJson(sourceFor(item)) ||
    await contentHash({ document: state.document, source: state.source }) !== state.contentHash) return failure('已存进度的来源或摘要不匹配。', 'CONFLICT', 'reload_source', 'preserved');
  if (state.document!.kind === 'draft') {
    const restored = restoreDraft(review, state.document!.value);
    if (!restored.ok) return restored;
    return { ok: true, data: { ...restored.data, items: restored.data.items.map((entry) => entry.draftId !== state.id ? entry :
      { ...entry, draftVersion, savedFingerprint: progressFingerprint(entry) }) } };
  }
  const value = state.document!.value;
  // Old actors' confirmations remain visible as pending judgments, never as this actor's confirmation.
  const progress = { ...value, conditions: value.conditions.map((condition) => {
    if (!condition.confirmedBy || condition.confirmedBy === review.actorId) return condition;
    const { confirmedBy: _actor, ...rest } = condition;
    return { ...rest, status: 'unknown' as const };
  }), relations: value.relations.map((relation) => relation.confirmedBy && relation.confirmedBy !== review.actorId
    ? refreshRelationConfirmations([relation])[0]! : relation) };
  const checked = validateProgress(progress, { source: state.source!, expectedConversationHash: state.conversationHash! }, review,
    { actorId: review.actorId, workspaceId: review.conversation.workspaceId });
  if (!checked.ok) return checked;
  const restored = itemFromProgress(item, progress);
  return { ok: true, data: { ...review, activeId: item.subject.id, items: review.items.map((entry) => entry !== item ? entry :
    { ...restored, draftVersion, savedFingerprint: progressFingerprint(itemFromProgress(item, value)) }) } };
}

function itemFromProgress(item: ReviewItem, progress: ReviewProgress): ReviewItem {
  return { ...item, subject: isAICandidate(item.subject) ? item.subject : { ...item.subject, title: progress.title, question: progress.question, kind: progress.kind },
    disposition: progress.disposition, statement: progress.statement, authorship: progress.authorship,
    conditions: structuredClone(progress.conditions), sources: structuredClone(progress.sources), boundaries: [...progress.boundaries],
    relations: structuredClone(progress.relations), baseRevision: progress.baseRevision, relationInput: structuredClone(progress.relationInput) };
}

export function acknowledgeProgress(review: Review, pending: PendingProgress, receipt: DraftReceipt): Review {
  return { ...review, items: review.items.map((item) => item.draftId !== pending.progress.id ? item : {
    ...item, baseRevision: item.baseRevision ?? pending.progress.baseRevision,
    draftVersion: { state: 'available', revision: receipt.revision, contentHash: receipt.contentHash },
    savedFingerprint: progressFingerprint(itemFromProgress(item, pending.progress)),
  }) };
}

const uncertain = <T>(): Result<T> => failure('读回不对应原保存操作，结果仍未知；本地内容未改变，请继续核验。', 'UNKNOWN_RESULT', 'read_back', 'unknown');
export async function verifyProgressState(pending: PendingProgress, input: unknown): Promise<Result<DraftState>> {
  const state = DraftStateSchema.safeParse(input), document = { kind: 'progress', value: pending.progress };
  if (!state.success || state.data.state !== 'available' || state.data.id !== pending.progress.id ||
    state.data.revision !== pending.options.expectedRevision + 1 || state.data.conversationHash !== pending.options.expectedConversationHash ||
    canonicalJson(state.data.source) !== canonicalJson(pending.options.source) || canonicalJson(state.data.document) !== canonicalJson(document) ||
    state.data.contentHash !== await contentHash({ document, source: pending.options.source })) return uncertain();
  return { ok: true, data: state.data };
}

export async function verifyProgressReceipt(pending: PendingProgress, input: unknown,
  identity: Pick<RequestContext, 'actorId' | 'workspaceId'>): Promise<Result<DraftReceipt>> {
  const parsed = DraftReceiptSchema.safeParse(input);
  if (!parsed.success) return uncertain();
  const receipt = parsed.data;
  if (receipt.operationId !== pending.options.operationId || receipt.draftId !== pending.progress.id || receipt.kind !== 'progress' ||
    receipt.actorId !== identity.actorId || receipt.workspaceId !== identity.workspaceId || receipt.previousRevision !== pending.options.expectedRevision ||
    receipt.conversationHash !== pending.options.expectedConversationHash || receipt.contentHash !== await contentHash({ document: { kind: 'progress', value: pending.progress }, source: pending.options.source })) return uncertain();
  return { ok: true, data: receipt };
}
