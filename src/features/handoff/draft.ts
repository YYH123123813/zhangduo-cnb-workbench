import type { RequestContext, Result } from '../../contracts/api';
import type { Candidate, HandoffDraft, KnowledgeNode, KnowledgeSnapshot } from '../../contracts/domain';
import { canonicalJson } from '../../contracts/hash';
import { DraftInputSchema } from './contracts';
import { candidateIdFor, evidenceStatus, failure, isAICandidate, refreshRelationConfirmations, sameSourceProvenance } from './model';
import type { Review, ReviewItem } from './model';
import { validateRelations } from './relations';

export function toDraft(review: Review, item: ReviewItem, baseRevision: string, now: string): Result<HandoffDraft> {
  if (item.disposition !== 'handoff' || !item.statement.trim()) return failure('请先选择交接并填写核心陈述。');
  const evidence = evidenceStatus(item.sources);
  const revision = item.baseRevision ?? baseRevision;
  const candidateId = candidateIdFor(item);
  const draft: HandoffDraft = { id: item.draftId, conversationId: review.conversation.id, candidateId,
    baseRevision: revision, relations: item.relations,
    node: { id: item.nodeId, workspaceId: review.conversation.workspaceId, schemaVersion: 1, revision,
      title: item.subject.title, question: item.subject.question, humanStatement: item.statement.trim(), authorship: item.authorship,
      candidateIds: candidateId ? [candidateId] : [], conversationId: review.conversation.id, kind: item.subject.kind,
      conditions: item.conditions.map(({ confirmedBy: _actor, ...condition }) => ({ ...condition, text: condition.text.trim() || '适用前提尚未核验',
        ...(condition.status === 'confirmed' ? { confirmedBy: review.actorId } : {}) })),
      boundaries: item.boundaries.map((text) => text.trim()).filter(Boolean), sources: item.sources,
      confirmation: 'draft', evidenceStatus: evidence, lifecycle: evidence === 'disputed' || item.conditions.some((condition) => condition.status === 'rejected') ? 'needs_review' : 'active', updatedAt: now },
  };
  const parsed = DraftInputSchema.safeParse(draft);
  return parsed.success ? { ok: true, data: parsed.data } : failure('草稿字段不完整或格式不正确。');
}

function validateSourceReview(node: KnowledgeNode, candidate: Pick<Candidate, 'sources'>): Result<true> {
  if (new Set(node.sources.map((source) => source.id)).size !== node.sources.length) return failure('来源 ID 重复。');
  for (const source of node.sources) {
    const original = candidate.sources.find((entry) => entry.id === source.id);
    if (!original || !sameSourceProvenance(original, source)) return failure('来源原句或来源身份不可改写，请重新读取候选。');
    if (source.support !== 'unverified' && (!source.excerpt.trim() || source.supportedClaim !== node.humanStatement.trim())) return failure('来源判断不对应当前陈述，需重新核验。');
    if (source.support === 'partial' && !source.limitation.trim()) return failure('部分支持缺少范围限制。');
  }
  if (node.evidenceStatus !== evidenceStatus(node.sources)) return failure('来源支持状态与核验记录不一致。');
  return { ok: true, data: true };
}
export function validateDraft(input: unknown, review: Review, snapshot: KnowledgeSnapshot, ctx: RequestContext): Result<HandoffDraft> {
  const parsed = DraftInputSchema.safeParse(input);
  if (!parsed.success) return failure('草稿结构无效。');
  const draft = parsed.data;
  if (draft.baseRevision !== snapshot.revision) return failure('知识版本已变化，草稿未覆盖。请重新核对当前版本。', 'CONFLICT', 'refresh_preview', 'preserved');
  const item = review.items.find((entry) => entry.draftId === draft.id);
  if (draft.node.workspaceId !== ctx.workspaceId || draft.conversationId !== review.conversation.id || draft.node.conversationId !== review.conversation.id) return failure('草稿不属于当前现场或工作区。', 'FORBIDDEN', 'select_workspace');
  if (!item || draft.id !== item.draftId || draft.node.id !== item.nodeId || draft.node.revision !== draft.baseRevision ||
    draft.candidateId !== candidateIdFor(item) || canonicalJson(draft.node.candidateIds) !== canonicalJson(draft.candidateId ? [draft.candidateId] : [])) return failure('草稿、来源与节点引用不一致。');
  const node = draft.node;
  if (!node.humanStatement.trim() || node.humanStatement.length > 20000 || !node.title.trim() || !node.question.trim() ||
    node.confirmation !== 'draft' || node.confirmedBy || node.confirmedAt || !['active', 'needs_review'].includes(node.lifecycle)) return failure('草稿尚不能作为正式确认；请检查陈述和状态。');
  const sources = validateSourceReview(node, item.subject);
  if (!sources.ok) return sources;
  const sameAI = isAICandidate(item.subject) && node.humanStatement.trim().replace(/\r\n/g, '\n') === item.subject.claim.trim().replace(/\r\n/g, '\n');
  if (!isAICandidate(item.subject) && node.authorship !== 'human_written') return failure('手动来源不能冒用 AI 候选作者身份。');
  if (sameAI) node.authorship = 'ai_accepted';
  else if (node.authorship === 'ai_accepted') return failure('修改过的 AI 文本必须标记为人工编辑。');
  const sourceIds = new Set(node.sources.map((source) => source.id));
  if (!node.conditions.length || new Set(node.conditions.map((condition) => condition.id)).size !== node.conditions.length || node.conditions.some((condition) =>
    !condition.text.trim() || condition.evidenceIds.some((id) => !sourceIds.has(id)) ||
    (condition.status === 'confirmed' && condition.confirmedBy !== ctx.actorId))) return failure('条件确认或依据无效。');
  if (draft.relations.some((relation) => relation.state === 'confirmed' && relation.confirmedBy !== ctx.actorId)) return failure('关系确认人不匹配。', 'FORBIDDEN', 'confirm_relations');
  const relations = validateRelations(draft.relations, node, snapshot, true);
  if (!relations.ok) return relations;
  node.lifecycle = node.evidenceStatus === 'disputed' || node.conditions.some((condition) => condition.status === 'rejected') ? 'needs_review' : 'active';
  return { ok: true, data: draft };
}

export function restoreDraft(review: Review, input: unknown): Result<Review> {
  const parsed = DraftInputSchema.safeParse(input);
  if (!parsed.success) return failure('已存草稿格式无效；当前编辑仍保留。');
  const draft = parsed.data;
  const item = review.items.find((entry) => entry.draftId === draft.id);
  if (!item || item.draftId !== draft.id || item.nodeId !== draft.node.id || draft.conversationId !== review.conversation.id ||
    draft.node.workspaceId !== review.conversation.workspaceId || draft.node.conversationId !== review.conversation.id) return failure('无法将另一现场或候选的草稿覆盖到本条。', 'FORBIDDEN', 'select_draft', 'preserved');
  const node = draft.node;
  if (node.revision !== draft.baseRevision || draft.candidateId !== candidateIdFor(item) || canonicalJson(node.candidateIds) !== canonicalJson(draft.candidateId ? [draft.candidateId] : []) ||
    node.confirmation !== 'draft' || node.confirmedBy || node.confirmedAt || !node.humanStatement.trim() ||
    !['active', 'needs_review'].includes(node.lifecycle) || draft.relations.some((relation) => relation.workspaceId !== node.workspaceId)) {
    return failure('已存草稿的候选、版本或确认状态不一致，本地编辑仍保留。', 'VALIDATION', 'select_draft', 'preserved');
  }
  const sources = validateSourceReview(node, item.subject);
  if (!sources.ok) return sources;
  const sameAI = isAICandidate(item.subject) && node.humanStatement.trim().replace(/\r\n/g, '\n') === item.subject.claim.trim().replace(/\r\n/g, '\n');
  if (!isAICandidate(item.subject) && node.authorship !== 'human_written') return failure('手动来源的作者身份不匹配。');
  if (!sameAI && node.authorship === 'ai_accepted') return failure('已存表达已不同于 AI 原文，作者身份需核对。', 'VALIDATION', 'select_draft', 'preserved');
  const conditions = node.conditions.map((condition) => {
    if (condition.status !== 'confirmed' || condition.confirmedBy === review.actorId) return condition;
    const { confirmedBy: _actor, ...rest } = condition;
    return { ...rest, status: 'unknown' as const };
  });
  const relations = draft.relations.map((relation) => relation.state === 'confirmed' && relation.confirmedBy !== review.actorId
    ? refreshRelationConfirmations([relation])[0]! : relation);
  return { ok: true, data: { ...review, activeId: item.subject.id, items: review.items.map((entry) => entry !== item ? entry : {
    ...entry, disposition: 'handoff', statement: node.humanStatement, authorship: sameAI ? 'ai_accepted' : node.authorship,
    sources: node.sources, conditions, boundaries: node.boundaries,
    relations, baseRevision: draft.baseRevision,
    relationInput: { targetId: '', type: '', direction: '', rationale: '', evidenceIds: [] },
  }) } };
}

export function verifyDraftReadback(expected: HandoffDraft, input: unknown): Result<HandoffDraft> {
  const parsed = DraftInputSchema.safeParse(input);
  if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(expected)) {
    return failure('读回草稿与本次发送内容不一致，写入结果仍未知。本地编辑未被替换，请继续核验。', 'UNKNOWN_RESULT', 'read_back', 'unknown');
  }
  return { ok: true, data: parsed.data };
}
