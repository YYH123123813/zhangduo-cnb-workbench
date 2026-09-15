import { z } from 'zod';
import { Id, TaskContextSchema, VersionRefSchema, type KnowledgeSnapshot } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure, success } from './errors';

export const UseSelectionSchema = z.object({
  task: TaskContextSchema,
  snapshotRevision: Id,
  nodeRefs: z.array(VersionRefSchema).min(1).max(20),
  relationRefs: z.array(Id).max(40),
  decision: z.enum(['adopt', 'reject', 'verify_later']),
  reason: z.string().trim().max(4000),
}).strict();
export type UseSelection = z.infer<typeof UseSelectionSchema>;
export interface UsePreview extends UseSelection {
  missingConditions: string[];
  warnings: string[];
  persistence: 'not_saved';
}

export function previewUse(input: unknown, snapshot: KnowledgeSnapshot): Result<UsePreview> {
  const parsed = UseSelectionSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '请选择应用决定，并检查任务、节点版本和理由。');
  const selection = parsed.data;
  if (selection.task.workspaceId !== snapshot.workspaceId || selection.nodeRefs.some((ref) => ref.workspaceId !== snapshot.workspaceId)) {
    return failure('FORBIDDEN', '任务和知识必须属于当前工作区。', 'return_to_workspace');
  }
  if (selection.snapshotRevision !== snapshot.revision) return failure('CONFLICT', '知识快照已变化，当前决定尚未保存。', 'reload_and_preview');
  if (new Set(selection.nodeRefs.map((ref) => ref.objectId)).size !== selection.nodeRefs.length || new Set(selection.relationRefs).size !== selection.relationRefs.length) {
    return failure('VALIDATION', '节点或关系重复，请重新选择。');
  }
  const nodes = selection.nodeRefs.map((ref) => snapshot.nodes.find((node) => node.id === ref.objectId));
  const selectedIds = new Set(selection.nodeRefs.map((ref) => ref.objectId));
  const adjacent = snapshot.relations.filter((relation) => relation.state === 'confirmed' && !snapshot.excludedIds.includes(relation.id)
    && (selectedIds.has(relation.source.objectId) || selectedIds.has(relation.target.objectId)));
  const relationRefs = [...new Set([...selection.relationRefs, ...adjacent.map((relation) => relation.id)])];
  if (relationRefs.length > 40) return failure('VALIDATION', '关联关系超出本次预览范围，请缩小所选节点范围。');
  const contextNodes = new Map(nodes.flatMap((node) => node ? [[node.id, node] as const] : []));
  const relationWarnings: string[] = [];
  for (const [index, node] of nodes.entries()) {
    if (!node || snapshot.excludedIds.includes(node.id) || node.workspaceId !== snapshot.workspaceId || node.revision !== selection.nodeRefs[index]?.revision) {
      return failure('CONFLICT', '所选知识已变化或不可读取，保留决定并重新检索。', 'reload_and_preview');
    }
    if (selection.decision === 'adopt' && (node.confirmation !== 'confirmed' || node.lifecycle === 'withdrawn' || node.lifecycle === 'superseded')) {
      return failure('VALIDATION', '未确认、已撤回或被替代的知识不能作为当前采用结论。');
    }
  }
  for (const id of relationRefs) {
    const relation = snapshot.relations.find((item) => item.id === id);
    if (!relation || relation.workspaceId !== snapshot.workspaceId || relation.state !== 'confirmed' || snapshot.excludedIds.includes(id)) {
      return failure('CONFLICT', '关系已变化或未确认，请重新检查路径。', 'reload_and_preview');
    }
    if (relation.type === 'contradicts') relationWarnings.push('路径包含已确认的冲突关系，需要人工复核');
    if (relation.type === 'supersedes') relationWarnings.push('路径包含已确认的替代关系，需要人工复核');
    for (const ref of [relation.source, relation.target]) {
      const endpoint = snapshot.nodes.find((node) => node.id === ref.objectId);
      if (ref.workspaceId !== snapshot.workspaceId || !endpoint || endpoint.revision !== ref.revision || snapshot.excludedIds.includes(ref.objectId) || endpoint.confirmation !== 'confirmed' || endpoint.lifecycle === 'withdrawn' || endpoint.lifecycle === 'superseded') {
        return failure('CONFLICT', '关系引用的节点版本已失效。', 'reload_and_preview');
      }
      contextNodes.set(endpoint.id, endpoint);
    }
  }
  const conditions = [...contextNodes.values()].flatMap((node) => node.conditions.map((condition) => ({ condition,
    check: selection.task.conditionChecks?.find((check) => check.nodeRef.workspaceId === node.workspaceId && check.nodeRef.objectId === node.id
      && check.nodeRef.revision === node.revision && check.conditionId === condition.id),
  })));
  const missingConditions = [...new Set(conditions.filter(({ condition, check }) => condition.status !== 'confirmed' || check?.status !== 'satisfied').map(({ condition }) => condition.text))];
  const warnings = [...relationWarnings, ...conditions.filter(({ check }) => check?.status === 'not_satisfied').map(({ condition }) => `本次任务前提不满足：${condition.text}`),
    ...[...contextNodes.values()].flatMap((node) => [
    ...node.boundaries,
    ...(node.evidenceStatus !== 'supported' ? ['来源支持尚不充分'] : []),
    ...(node.lifecycle === 'needs_review' ? ['知识需要重新核对'] : []),
  ])];
  if (selection.decision === 'adopt' && (missingConditions.length || warnings.length) && !selection.reason) {
    return failure('VALIDATION', '仍有条件或边界需要核对，请填写本次采用的理由。');
  }
  return success({ ...structuredClone(selection), relationRefs, missingConditions, warnings: [...new Set(warnings)], persistence: 'not_saved' });
}
