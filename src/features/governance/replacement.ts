import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { Id, type KnowledgeSnapshot, type Relation } from '../../contracts/domain';
import { cancelSchema, checkBase, fail } from './http';
import { currentNode, reasonSchema, type ChangePreview } from './revisions';

export function rejectReplacementCycles(relations: Relation[], excludedIds: string[] = []) {
  const adjacency = new Map<string, string[]>();
  for (const edge of relations) if (edge.type === 'supersedes' && edge.state !== 'withdrawn' && edge.state !== 'rejected' && !excludedIds.includes(edge.id)) {
    const neighbors = adjacency.get(edge.source.objectId) ?? [];
    neighbors.push(edge.target.objectId); adjacency.set(edge.source.objectId, neighbors);
  }
  const finished = new Set<string>();
  const visiting = new Set<string>();
  for (const root of adjacency.keys()) {
    const stack = [{ id: root, leaving: false }];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.leaving) { visiting.delete(item.id); finished.add(item.id); continue; }
      if (visiting.has(item.id)) fail('VALIDATION', '替代关系形成循环，未写入。', 'review_replacement_direction');
      if (finished.has(item.id)) continue;
      visiting.add(item.id); stack.push({ id: item.id, leaving: true });
      for (const id of adjacency.get(item.id) ?? []) stack.push({ id, leaving: false });
    }
  }
}
const replaceInputSchema = z.object({ action: z.literal('preview'), operationId: Id, baseRevision: Id, oldNodeId: Id, replacementNodeId: Id, relationId: Id, reason: reasonSchema, evidenceIds: z.array(Id).min(1).max(200) }).strict();
export const replaceRequestSchema = z.discriminatedUnion('action', [replaceInputSchema, cancelSchema]);
export function replacementPreview(snapshot: KnowledgeSnapshot, ctx: RequestContext, input: z.infer<typeof replaceInputSchema>): ChangePreview {
  checkBase(snapshot, input.baseRevision);
  if (input.oldNodeId === input.replacementNodeId) fail('VALIDATION', '知识不能替代自身。');
  const old = currentNode(snapshot, input.oldNodeId);
  const replacement = currentNode(snapshot, input.replacementNodeId);
  if ([old, replacement].some((n) => n.confirmation !== 'confirmed' || n.lifecycle === 'withdrawn' || snapshot.excludedIds.includes(n.id)) || replacement.lifecycle !== 'active') fail('CONFLICT', '选定知识不可用于替代，请复核。', 'select_active_knowledge', 'preserved');
  if ([...snapshot.nodes, ...snapshot.relations].some((item) => item.id === input.relationId)) fail('VALIDATION', '新替代关系ID已存在。');
  const updatedAt = new Date().toISOString();
  const edge: Relation = {
    id: input.relationId, workspaceId: ctx.workspaceId,
    source: { workspaceId: ctx.workspaceId, objectId: replacement.id, revision: replacement.revision },
    target: { workspaceId: ctx.workspaceId, objectId: old.id, revision: old.revision },
    type: 'supersedes', rationale: input.reason, evidenceIds: input.evidenceIds, state: 'proposed', proposedBy: ctx.actorId, updatedAt,
  };
  rejectReplacementCycles([...snapshot.relations.filter((r) => r.state === 'confirmed'), edge], snapshot.excludedIds);
  return {
    kind: 'replacement', before: { nodes: [structuredClone(old), structuredClone(replacement)], relations: [] },
    changes: { id: input.operationId, workspaceId: ctx.workspaceId, baseRevision: input.baseRevision, reason: input.reason,
      nodes: [{ ...old, lifecycle: 'superseded', confirmation: 'draft', confirmedBy: undefined, confirmedAt: undefined, updatedAt }], relations: [edge], withdrawnIds: [] },
    changedFields: ['lifecycle', 'supersedes'], warnings: ['替代是人的选择，不代表系统裁定冲突一方正确。', '旧陈述、来源、适用条件及原版本保留。'],
  };
}
