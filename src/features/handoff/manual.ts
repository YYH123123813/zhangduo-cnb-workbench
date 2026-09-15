import type { Candidate, SourceRecord } from '../../contracts/domain';
import { HandoffSourceSchema } from '../../contracts/handoff';
import type { DraftSaveOptions } from '../../contracts/handoff';
import type { Result } from '../../contracts/api';
import { hashSegment } from '../../contracts/hash';
import { failure, initialConditions, sourceSpans } from './model';
import type { Review, ReviewItem } from './model';

export interface ManualReviewSource {
  origin: 'manual'; id: string; title: string; question: string; kind: Candidate['kind'];
  spans: Candidate['spans']; sources: SourceRecord[];
}
export const isManualDraftId = (id: string) => /^handoff-manual-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export async function withManualSource(review: Review, input: DraftSaveOptions['source'],
  fields: { id: string; title: string; question: string; kind: Candidate['kind'] }): Promise<Result<Review>> {
  const parsed = HandoffSourceSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== 'manual' || !parsed.data.spans.length || !isManualDraftId(fields.id) || !review.conversation.sourceAlreadyPersisted || review.conversation.state !== 'saved') {
    return failure('手动审阅需要独立 ID、至少一条原句和已保存的授权现场。', 'VALIDATION', 'select_source', 'preserved');
  }
  const spans = parsed.data.spans;
  const checked = sourceSpans(review.conversation, { spans });
  if (!checked.ok || new Set(spans.map((span) => span.id)).size !== spans.length) return failure('手动来源范围不匹配。', 'VALIDATION', 'select_source', 'preserved');
  for (const span of spans) {
    const segment = review.conversation.segments.find((entry) => entry.id === span.segmentId)!;
    const boundary = (offset: number) => !(offset > 0 && offset < segment.text.length && /[\uD800-\uDBFF]/.test(segment.text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(segment.text[offset]!));
    if (!boundary(span.start) || !boundary(span.end) || span.contentHash !== await hashSegment(review.conversation.id, segment)) return failure('手动来源版本或字符边界不匹配。', 'CONFLICT', 'reload_source', 'preserved');
  }
  const sources: SourceRecord[] = spans.map((span) => ({ id: span.id, kind: 'conversation', title: `现场片段 ${span.segmentId}`,
    ...(review.conversation.issueUrl ? { url: review.conversation.issueUrl } : {}), excerpt: span.quote, accessedAt: review.conversation.createdAt,
    support: 'unverified', supportedClaim: '', limitation: '' }));
  const subject: ManualReviewSource = { origin: 'manual', id: fields.id, title: fields.title, question: fields.question, kind: fields.kind, spans, sources };
  const item: ReviewItem = { subject, disposition: null, statement: '', authorship: 'human_written', conditions: initialConditions(), boundaries: [], sources,
    nodeId: `knowledge-${fields.id}`, draftId: fields.id, relations: [], baseRevision: null,
    relationInput: { targetId: '', type: '', direction: '', rationale: '', evidenceIds: [] } };
  return { ok: true, data: { ...review, activeId: item.subject.id, items: review.items.some((entry) => entry.draftId === item.draftId)
    ? review.items.map((entry) => entry.draftId === item.draftId ? item : entry) : [...review.items, item] } };
}
