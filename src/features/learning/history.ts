import { EvidenceRecordSchema, type EvidenceRecord, type KnowledgeSnapshot, type RetrievalResult, type TaskContext, type KnowledgeNode } from '../../contracts/domain';
import { z } from 'zod';
import type { Result } from '../../contracts/api';
import { failure, success } from './errors';
import { previewUse } from './use';

export function validateEvidenceList(input: unknown, workspaceId: string): Result<EvidenceRecord[]> {
  const parsed = z.array(EvidenceRecordSchema).safeParse(input);
  if (!parsed.success) return failure('UPSTREAM', '证据存储返回了不合法的记录。', 'check_storage');
  if (parsed.data.some((record) => record.workspaceId !== workspaceId || record.nodeRefs.some((ref) => ref.workspaceId !== workspaceId))) return failure('FORBIDDEN', '证据存储返回了越界记录，未展示内容。', 'check_storage');
  if (new Set(parsed.data.map((record) => record.id)).size !== parsed.data.length) return failure('UPSTREAM', '证据存储包含重复记录 ID，无法确定历史归属。', 'check_storage');
  return success(parsed.data);
}

// A transient preview, not a second persisted evidence contract or knowledge store.
export interface UseRecordDraft {
  record: EvidenceRecord;
  taskSnapshot: TaskContext;
  snapshotRevision: string;
  knowledge: Pick<KnowledgeNode, 'id' | 'revision' | 'title' | 'humanStatement' | 'conditions' | 'boundaries' | 'evidenceStatus'>[];
  paths: RetrievalResult['paths'];
  retrievalContext?: Pick<RetrievalResult, 'queryId' | 'coverage' | 'missingConditions' | 'warnings'>;
  reason: string;
  persistence: 'not_saved';
  indexing: 'excluded';
}

export function buildUseDraft(input: unknown, snapshot: KnowledgeSnapshot, recordId: string, recordedAt: string): Result<UseRecordDraft> {
  const preview = previewUse(input, snapshot);
  if (!preview.ok) return preview;
  const value = preview.data;
  const record = EvidenceRecordSchema.safeParse({
    id: recordId, workspaceId: value.task.workspaceId, taskId: value.task.id, kind: 'use',
    nodeRefs: value.nodeRefs, relationRefs: value.relationRefs, decision: value.decision,
    answer: '', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped',
    result: 'unverified', recordedAt,
  });
  if (!record.success) return failure('VALIDATION', '记录 ID 或记录时间无效，未保存。');
  const contextIds = new Set([...value.nodeRefs.map((ref) => ref.objectId), ...snapshot.relations.filter((relation) => value.relationRefs.includes(relation.id)).flatMap((relation) => [relation.source.objectId, relation.target.objectId])]);
  return success(structuredClone({
    record: record.data, taskSnapshot: value.task, snapshotRevision: snapshot.revision,
    knowledge: snapshot.nodes.filter((node) => contextIds.has(node.id)).map(({ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus }) => ({ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus })),
    paths: value.relationRefs.flatMap((id) => snapshot.relations.filter((relation) => relation.id === id).map((relation) => ({ seedId: relation.source.objectId, relationIds: [relation.id], nodeIds: [relation.source.objectId, relation.target.objectId], reason: relation.rationale }))),
    reason: value.reason, persistence: 'not_saved' as const, indexing: 'excluded' as const,
  }));
}

export function describeHistory(record: EvidenceRecord, snapshot?: KnowledgeSnapshot) {
  const sameWorkspace = snapshot?.workspaceId === record.workspaceId;
  const unavailable = sameWorkspace && record.nodeRefs.some((ref) => snapshot.excludedIds.includes(ref.objectId) || !snapshot.nodes.some((node) => node.id === ref.objectId));
  const changed = sameWorkspace && (record.nodeRefs.some((ref) => snapshot.nodes.some((node) => node.id === ref.objectId && (node.revision !== ref.revision || node.lifecycle !== 'active' || node.confirmation !== 'confirmed'))) || record.relationRefs.some((id) => snapshot.excludedIds.includes(id) || !snapshot.relations.some((relation) => relation.id === id && relation.state === 'confirmed')));
  return {
    record: structuredClone(record),
    contextState: record.useContext ? 'recorded' as const : record.kind === 'outcome' ? 'linked_use' as const : 'not_recorded' as const,
    versionState: !sameWorkspace ? 'unknown' as const : unavailable ? 'unavailable' as const : changed ? 'changed' as const : record.relationRefs.length || !record.nodeRefs.length ? 'unknown' as const : 'current' as const,
  };
}
export type HistoricalEvidenceView = ReturnType<typeof describeHistory>;

export function evidenceKindLabel(kind: EvidenceRecord['kind']) {
  return { use: '任务应用', outcome: '实际结果', recall: '回忆作答', near_transfer: '近迁移作答' }[kind];
}
