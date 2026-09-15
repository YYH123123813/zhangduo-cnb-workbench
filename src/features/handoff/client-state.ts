import type { Result } from '../../contracts/api';
import type { HandoffDraft } from '../../contracts/domain';
import { canonicalJson } from '../../contracts/hash';
import { failure, initialConditions, isAICandidate, refreshRelationConfirmations } from './model';
import type { Review, ReviewItem } from './model';
import type { SubmissionState } from './submission';
import { isSubmissionLocked } from './submission';
import { restoreDraft } from './draft';
import { progressFingerprint } from './progress';
export { refreshRelationConfirmations } from './model';

export function hasRelationInput(item: ReviewItem) {
  const input = item.relationInput;
  return Boolean(input.targetId || input.type || input.direction || input.rationale || input.evidenceIds.length);
}
export function hasItemEdits(item: ReviewItem) {
  if (item.savedFingerprint !== undefined) return progressFingerprint(item) !== item.savedFingerprint;
  return Boolean(!isAICandidate(item.subject) || item.statement || item.disposition || item.relations.length || item.boundaries.length ||
    hasRelationInput(item) ||
    canonicalJson(item.conditions) !== canonicalJson(initialConditions()) ||
    item.sources.some((source) => source.support !== 'unverified' || source.supportedClaim || source.limitation));
}
export function applyVerifiedDraftSave(review: Review, draft: HandoffDraft): Result<Review> {
  const restored = restoreDraft(review, draft);
  if (!restored.ok) return restored;
  const previous = review.items.find((item) => item.draftId === draft.id)!;
  // The draft port cannot persist unfinished relation inputs. Saving must not erase them locally.
  return { ok: true, data: { ...restored.data, items: restored.data.items.map((item) => item.draftId === draft.id
    ? { ...item, relationInput: structuredClone(previous.relationInput) } : item) } };
}
export function hasLocalEdits(review: Review | null) {
  return Boolean(review?.items.some(hasItemEdits));
}
export function canReplaceReview(review: Review | null, submission: SubmissionState, consent: boolean,
  unknownDrafts: Record<string, unknown> = {}): Result<true> {
  if (Object.keys(unknownDrafts).length) return failure('草稿写入尚未核验，请保留本地内容并先读回。', 'CONFLICT', 'read_back', 'unknown');
  if (isSubmissionLocked(submission)) return failure('当前提交或批准尚未处理完，请先核验或撤回。', 'CONFLICT', 'resolve_operation', 'preserved');
  if (hasLocalEdits(review) && !consent) return failure('读取将替换本页编辑，请先保存、导出，或明确确认放弃。', 'VALIDATION', 'confirm_replace', 'preserved');
  return { ok: true, data: true };
}
export function shouldWarnOnExit(review: Review | null, submission: SubmissionState,
  unknownDrafts: Record<string, unknown>, busy: boolean): boolean {
  return busy || isSubmissionLocked(submission) || Object.keys(unknownDrafts).length > 0 || hasLocalEdits(review);
}
export function requestReviewExit(review: Review | null, submission: SubmissionState,
  unknownDrafts: Record<string, unknown>, busy: boolean, confirmDiscard: () => boolean): Result<true> {
  if (busy) return failure('请求尚未结束，请保留本页并等待结果。', 'CONFLICT', 'wait_request', 'preserved');
  const checked = canReplaceReview(review, submission, false, unknownDrafts);
  if (checked.ok || checked.error.nextAction !== 'confirm_replace') return checked;
  return confirmDiscard() ? canReplaceReview(review, submission, true, unknownDrafts)
    : failure('已取消离开，审阅内容仍保留在本页。', 'VALIDATION', 'continue_editing', 'preserved');
}
export function reviseItem(previous: ReviewItem, next: ReviewItem): ReviewItem {
  const changed = previous.statement !== next.statement || previous.conditions !== next.conditions || previous.boundaries !== next.boundaries || previous.sources !== next.sources;
  return changed ? { ...next, relations: refreshRelationConfirmations(next.relations) } : next;
}
