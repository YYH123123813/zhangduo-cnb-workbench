import { EvidenceRecordSchema, GitRevisionSchema, type EvidenceRecord, type KnowledgeSnapshot } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import type { UseRecordDraft } from './history';
import { previewUse } from './use';
import { previewOutcome } from './outcome';
import { failure, success } from './errors';

export function buildUseEvidence(draft: UseRecordDraft, snapshot: KnowledgeSnapshot): Result<EvidenceRecord> {
  if (!GitRevisionSchema.safeParse(draft.snapshotRevision).success) return failure('VALIDATION', '保存需要完整固定的 Git 版本；当前预览不能作为持久记录。', 'reload_and_preview');
  const preview = previewUse({ task: draft.taskSnapshot, snapshotRevision: draft.snapshotRevision,
    nodeRefs: draft.record.nodeRefs, relationRefs: draft.record.relationRefs, decision: draft.record.decision, reason: draft.reason }, snapshot);
  if (!preview.ok) return preview;
  const value = preview.data;
  const retrieval = draft.retrievalContext;
  const record = EvidenceRecordSchema.safeParse({
    ...draft.record, answer: '', relationRefs: value.relationRefs,
    useContext: { task: value.task, snapshotRevision: draft.snapshotRevision, knowledge: draft.knowledge,
      relations: snapshot.relations.filter((edge) => value.relationRefs.includes(edge.id)),
      paths: draft.paths.length ? draft.paths : value.nodeRefs.map((ref) => ({ seedId: ref.objectId, nodeIds: [ref.objectId], relationIds: [], reason: '人的本次知识选择' })),
      reason: value.reason, retrievalContext: { queryId: retrieval?.queryId ?? null, coverage: retrieval?.coverage ?? 'unavailable',
        missingConditions: [...new Set([...value.missingConditions, ...(retrieval?.missingConditions ?? [])])],
        warnings: [...new Set([...value.warnings, ...(retrieval?.warnings ?? ['未关联原检索回执；仅记录人的本次使用情境。'])])],
        trust: 'client_preview_only' } },
  });
  return record.success ? success(record.data) : failure('VALIDATION', '原条件、路径或版本未满足结构化证据格式，未保存。', 'review_evidence');
}

export function buildOutcomeEvidence(input: unknown, original: EvidenceRecord, ctx: RequestContext, id: string, recordedAt: string): Result<EvidenceRecord> {
  const preview = previewOutcome(input, original, ctx);
  if (!preview.ok) return preview;
  if (!original.useContext) return failure('CONFLICT', '原使用记录未保存任务条件，不能用当前知识补造结果依据。', 'read_original_evidence', 'preserved');
  if (id === original.id || Date.parse(recordedAt) < Date.parse(original.recordedAt)) return failure('VALIDATION', '结果需要独立 ID，且时间不能早于原应用记录。');
  const { useRecordId, status, summary, failureReason, verification } = preview.data;
  const record = EvidenceRecordSchema.safeParse({ id, workspaceId: original.workspaceId, taskId: original.taskId, kind: 'outcome',
    nodeRefs: original.nodeRefs, relationRefs: original.relationRefs, answer: '', answerVisible: true, hintLevel: 0,
    selfConfidence: 'skipped', result: 'self_reported', recordedAt, outcome: { useRecordId, status, summary, failureReason, verification } });
  return record.success ? success(record.data) : failure('VALIDATION', '结果记录格式不正确，未保存。');
}
