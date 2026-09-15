import { CandidateSchema, ConversationSchema } from '../../contracts/domain';
import type { Candidate, Conversation, KnowledgeNode, Relation, SourceRecord } from '../../contracts/domain';
import type { ApiError, Result } from '../../contracts/api';
import type { DraftState } from '../../contracts/handoff';
import type { DraftSaveOptions } from '../../contracts/handoff';
import type { ManualReviewSource } from './manual';

export type ReviewSubject = Candidate | ManualReviewSource;
export const isAICandidate = (subject: ReviewSubject): subject is Candidate => !('origin' in subject);
export const sourceFor = (item: ReviewItem): DraftSaveOptions['source'] => isAICandidate(item.subject)
  ? { kind: 'candidate', candidateId: item.subject.id } : { kind: 'manual', spans: item.subject.spans };
export const candidateIdFor = (item: ReviewItem): string | null => isAICandidate(item.subject) ? item.subject.id : null;

export type Disposition = 'handoff' | 'archive' | 'reject' | 'later' | null;
export interface RelationInput { targetId: string; type: Relation['type'] | ''; direction: 'outgoing' | 'incoming' | ''; rationale: string; evidenceIds: string[] }
export interface ReviewItem {
  subject: ReviewSubject; disposition: Disposition;
  statement: string; authorship: KnowledgeNode['authorship'];
  conditions: KnowledgeNode['conditions']; boundaries: string[];
  sources: SourceRecord[];
  nodeId: string; draftId: string; relations: Relation[];
  baseRevision: string | null;
  relationInput: RelationInput;
  draftVersion?: Pick<DraftState, 'state' | 'revision' | 'contentHash'>;
  savedFingerprint?: string;
}
export interface Review { conversation: Conversation; items: ReviewItem[]; activeId: string | null; actorId: string }

export function initialConditions(): KnowledgeNode['conditions'] {
  return [{ id: 'key-condition', text: '适用前提尚未核验', status: 'unknown', evidenceIds: [] }];
}

export function sameSourceProvenance(original: SourceRecord, source: SourceRecord) {
  return (['id', 'kind', 'title', 'url', 'excerpt', 'accessedAt'] as const).every((key) => original[key] === source[key]);
}

export function failure<T>(message: string, code: ApiError['code'] = 'VALIDATION',
  nextAction = 'edit_fields', dataState: ApiError['dataState'] = 'not_written'): Result<T> {
  return { ok: false, error: { code, message, retryable: false, dataState, nextAction } };
}

export function createReview(conversation: Conversation, candidates: Candidate[]): Result<Review> {
  if (!ConversationSchema.safeParse(conversation).success || candidates.length > 3 ||
    new Set(conversation.segments.map((segment) => segment.id)).size !== conversation.segments.length ||
    candidates.some((item) => !CandidateSchema.safeParse(item).success || item.conversationId !== conversation.id) ||
    new Set(candidates.map((item) => item.id)).size !== candidates.length) {
    return failure('候选必须属于同一现场，ID 不重复，且最多三条。');
  }
  for (const candidate of candidates) {
    if (new Set(candidate.sources.map((source) => source.id)).size !== candidate.sources.length ||
      new Set(candidate.spans.map((span) => span.id)).size !== candidate.spans.length) return failure('来源记录或片段 ID 重复。');
    const checked = sourceSpans(conversation, candidate);
    if (!checked.ok) return checked;
  }
  return { ok: true, data: { conversation: structuredClone(conversation),
    actorId: '', items: candidates.map((item) => ({ subject: structuredClone(item), disposition: null, statement: '', authorship: 'human_written', nodeId: crypto.randomUUID(), draftId: crypto.randomUUID(), relations: [], baseRevision: null,
      relationInput: { targetId: '', type: '', direction: '', rationale: '', evidenceIds: [] },
      conditions: initialConditions(), boundaries: [],
      sources: item.sources.map((source) => ({ ...source, support: 'unverified', supportedClaim: '', limitation: '' })) })),
    activeId: candidates[0]?.id ?? null } };
}

export function setKeyCondition(item: ReviewItem, text: string, status: KnowledgeNode['conditions'][number]['status']): Result<ReviewItem> {
  if (!['confirmed', 'unknown', 'rejected'].includes(status) || (status !== 'unknown' && !text.trim())) {
    return failure('请填写本次判断的具体条件，或保留为未核验。');
  }
  return { ok: true, data: { ...item, relations: refreshRelationConfirmations(item.relations), conditions: [{ id: item.conditions[0]?.id ?? 'key-condition',
    text: text.trim() || '适用前提尚未核验', status, evidenceIds: [] }, ...item.conditions.slice(1)] } };
}

export function writeStatement(item: ReviewItem, statement: string): ReviewItem {
  const sameAsAI = isAICandidate(item.subject) && statement.trim().replace(/\r\n/g, '\n') === item.subject.claim.trim().replace(/\r\n/g, '\n');
  return { ...item, statement, relations: statement === item.statement ? item.relations : refreshRelationConfirmations(item.relations),
    sources: statement === item.statement ? item.sources : item.sources.map((source) => ({ ...source, support: 'unverified', supportedClaim: '' })), authorship: !isAICandidate(item.subject) ? 'human_written' : sameAsAI ? 'ai_accepted' :
    item.authorship === 'human_written' ? 'human_written' : 'human_edited' };
}

export function acceptAI(item: ReviewItem): ReviewItem {
  if (!isAICandidate(item.subject)) return item;
  return { ...writeStatement(item, item.subject.claim), authorship: 'ai_accepted' };
}

export function assessSource(item: ReviewItem, sourceId: string, support: SourceRecord['support'], limitation: string): Result<ReviewItem> {
  const source = item.sources.find((entry) => entry.id === sourceId);
  if (!source || !['supports', 'partial', 'does_not_support', 'unverified'].includes(support)) return failure('来源或核验状态无效。');
  if (support !== 'unverified' && (!item.statement.trim() || !source.excerpt.trim())) return failure('核验需要当前陈述与来源原句，仅有 URL 不够。');
  if (support === 'partial' && !limitation.trim()) return failure('部分支持需要说明不支持的范围。');
  return { ok: true, data: { ...item, relations: refreshRelationConfirmations(item.relations), sources: item.sources.map((entry) => entry.id === sourceId
    ? { ...entry, support, limitation, supportedClaim: support === 'unverified' ? '' : item.statement.trim() } : entry) } };
}

export function refreshRelationConfirmations(relations: Relation[]): Relation[] {
  return relations.map((relation) => {
    if (relation.state !== 'confirmed') return relation;
    const { confirmedBy: _actor, confirmedAt: _time, ...rest } = relation;
    return { ...rest, state: 'proposed' };
  });
}

export function evidenceStatus(sources: SourceRecord[]): KnowledgeNode['evidenceStatus'] {
  if (sources.some((source) => source.support === 'does_not_support')) return 'disputed';
  const evidenced = sources.filter((source) => source.kind !== 'ai_inference' && source.excerpt.trim() && source.supportedClaim.trim());
  if (evidenced.length === sources.length && evidenced.length && evidenced.every((source) => source.support === 'supports')) return 'supported';
  if (evidenced.some((source) => source.support === 'supports' || source.support === 'partial')) return 'partial';
  return 'unverified';
}

export function selectCandidate(review: Review, id: string): Result<Review> {
  if (!review.items.some((item) => item.subject.id === id)) return failure('候选不存在。');
  return { ok: true, data: { ...review, activeId: id } };
}

export function sourceSpans(conversation: Conversation, candidate: Pick<Candidate, 'spans'>): Result<Candidate['spans']> {
  for (const span of candidate.spans) {
    const segment = conversation.segments.find((item) => item.id === span.segmentId);
    if (span.conversationId !== conversation.id || !segment || span.end > segment.text.length ||
      span.start < 0 || span.end <= span.start || segment.text.slice(span.start, span.end) !== span.quote) {
      return failure('来源片段已变化或引用不匹配，请重新读取现场。', 'VALIDATION', 'reload_source');
    }
  }
  return { ok: true, data: candidate.spans };
}

export function decide(review: Review, id: string, disposition: Disposition): Result<Review> {
  if (![null, 'handoff', 'archive', 'reject', 'later'].includes(disposition) ||
    !review.items.some((item) => item.subject.id === id)) return failure('候选或处理方式无效。');
  return { ok: true, data: { ...review, items: review.items.map((item) => item.subject.id === id
    ? { ...item, disposition } : item) } };
}
