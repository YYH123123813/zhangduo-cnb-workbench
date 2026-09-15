import { z } from 'zod';
import { EvidenceRecordSchema, type EvidenceRecord, type KnowledgeSnapshot } from '../../contracts/domain';
import { fail, parse } from './http';

export function checkedEvidence(value: unknown, workspaceId: string): EvidenceRecord[] {
  const records = parse(z.array(EvidenceRecordSchema), value);
  if (records.some((record) => record.workspaceId !== workspaceId || record.nodeRefs.some((ref) => ref.workspaceId !== workspaceId)
    || record.useContext && (record.useContext.task.workspaceId !== workspaceId
      || record.useContext.task.id !== record.taskId
      || record.useContext.task.conditionChecks?.some((check) => check.nodeRef.workspaceId !== workspaceId)
      || record.useContext.relations.some((edge) => [edge.workspaceId, edge.source.workspaceId, edge.target.workspaceId].some((id) => id !== workspaceId))))) fail('FORBIDDEN', '历史记录或原任务上下文工作区不匹配。');
  return records;
}
export function evidenceObjectIds(record: EvidenceRecord): string[] {
  const context = record.useContext;
  return [...new Set([record.id, ...record.nodeRefs.map((ref) => ref.objectId), ...record.relationRefs,
    ...(context ? [...(context.task.conditionChecks?.map((check) => check.nodeRef.objectId) ?? []),
      ...context.knowledge.map((node) => node.id), ...context.relations.flatMap((edge) => [edge.id, edge.source.objectId, edge.target.objectId]),
      ...context.paths.flatMap((path) => [path.seedId, ...path.nodeIds, ...path.relationIds])] : []), ...(record.outcome ? [record.outcome.useRecordId] : [])])];
}
export function restrictedEvidenceIds(records: EvidenceRecord[], excludedIds: string[]) {
  const restricted = new Set(records.filter((record) => [...evidenceObjectIds(record),
    ...(record.useContext?.knowledge.flatMap((node) => node.conditions.flatMap((condition) => condition.evidenceIds)) ?? []),
    ...(record.useContext?.relations.flatMap((edge) => edge.evidenceIds) ?? [])].some((id) => excludedIds.includes(id))).map((record) => record.id));
  for (const record of records) if (record.outcome && restricted.has(record.outcome.useRecordId)) restricted.add(record.id);
  return restricted;
}
export function unreadableExclusions(snapshot: KnowledgeSnapshot): string[] {
  // Shared snapshots retain logical withdrawals, but remove bodies covered by durable deletion barriers.
  return snapshot.excludedIds.filter((id) => !snapshot.nodes.some((node) => node.id === id && node.lifecycle === 'withdrawn')
    && !snapshot.relations.some((edge) => edge.id === id && edge.state === 'withdrawn'));
}
