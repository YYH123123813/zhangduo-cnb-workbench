import { apiRequest } from '../../app/api-client';
import type { ApiResponse } from '../../contracts/api';
import type { DraftState } from '../../contracts/handoff';
import { restoreProgressState } from './progress';
import { isManualDraftId } from './manual';
import { failure, selectCandidate } from './model';
import type { Review } from './model';

export interface ReviewTarget { conversationId: string; candidateId?: string; draftId?: string; changeSetId?: string; source?: string }

// Resolve the whole target before the caller replaces any existing local edits.
export async function loadReviewTarget(target: ReviewTarget, read = apiRequest): Promise<ApiResponse<Review>> {
  const manual = target.source === 'manual' || Boolean(target.draftId && isManualDraftId(target.draftId));
  const result = await read<Review>(`/api/handoff/${encodeURIComponent(target.conversationId)}${manual ? '?source=manual' : ''}`);
  if (!result.ok) return result;
  if (result.data.conversation.id !== target.conversationId) {
    return { ...failure<Review>('返回的现场不匹配，本地编辑仍保留。', 'UPSTREAM', 'reload_source', 'preserved'), meta: result.meta };
  }
  const selected = target.candidateId ? selectCandidate(result.data, target.candidateId) : result;
  // An operation recovery URL may carry the original draft ID for identity, but
  // must never hydrate the current mutable draft into the old operation.
  if (!selected.ok || !target.draftId || target.changeSetId) return { ...selected, meta: result.meta };
  const saved = await read<DraftState>(`/api/handoff/${encodeURIComponent(target.conversationId)}/draft-state?draftId=${encodeURIComponent(target.draftId)}`);
  if (!saved.ok) return saved;
  if (saved.meta.mode !== result.meta.mode || saved.data.id !== target.draftId ||
    saved.data.state !== 'available' ||
    (target.candidateId && (saved.data.source?.kind !== 'candidate' || saved.data.source.candidateId !== target.candidateId))) {
    return { ...failure<Review>('草稿与指定候选或工作区模式不匹配，本地编辑仍保留。', 'CONFLICT', 'select_draft', 'preserved'), meta: result.meta };
  }
  return { ...await restoreProgressState(selected.data, saved.data), meta: result.meta };
}
