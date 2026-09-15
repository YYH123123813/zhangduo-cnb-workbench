import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { Id, RelationSchema, type KnowledgeNode, type KnowledgeSnapshot, type Relation } from '../../contracts/domain';
import { cancelSchema, checkBase, fail, parse } from './http';
import { activeRelation } from './impact';
import { reasonSchema, type ChangePreview } from './revisions';
import { rejectReplacementCycles } from './replacement';

const relationEditSchema = z.object({
  action: z.literal('preview'), operationId: Id, baseRevision: Id, reason: reasonSchema,
  patch: z.object({ targetId: Id.optional(), reverse: z.boolean().optional(), type: RelationSchema.shape.type.optional(), rationale: reasonSchema.optional(), evidenceIds: z.array(Id).min(1).max(200).optional(), state: z.enum(['proposed', 'withdrawn', 'rejected']).optional() }).strict().refine((p) => Object.keys(p).length > 0),
}).strict();
export const relationRequestSchema = z.discriminatedUnion('action', [relationEditSchema, cancelSchema]);
export function validateRelationEvidence(nodes: KnowledgeNode[], edge: Relation) {
  if (edge.source.objectId === edge.target.objectId) fail('VALIDATION', '关系不能指向自身。');
  const sourceIds = new Set([edge.source, edge.target].flatMap((ref) => nodes.find((node) => node.id === ref.objectId)?.sources.filter((source) => source.support === 'supports').map((source) => source.id) ?? []));
  if (!edge.evidenceIds.length || new Set(edge.evidenceIds).size !== edge.evidenceIds.length || edge.evidenceIds.some((id) => !sourceIds.has(id))) fail('VALIDATION', '关系依据必须引用当前端点已保存且标记支持的来源，不能使用未知或失效引用。', 'review_relation_evidence');
}
export function relationPreview(snapshot: KnowledgeSnapshot, ctx: RequestContext, id: string, input: z.infer<typeof relationEditSchema>): ChangePreview {
  checkBase(snapshot, input.baseRevision);
  const original = snapshot.relations.find((r) => r.id === id);
  if (!original) fail('VALIDATION', '当前快照中没有该关系。');
  const { reverse, targetId, ...patch } = input.patch;
  if (patch.state !== 'withdrawn' && patch.state !== 'rejected' && !activeRelation(snapshot, original)) fail('CONFLICT', '关系或端点已变化，先复核当前版本。', 'review_endpoints', 'preserved');
  const withdrawing = patch.state === 'withdrawn' || patch.state === 'rejected';
  if (withdrawing && (reverse || (targetId && targetId !== original.target.objectId) || (patch.type && patch.type !== original.type))) fail('VALIDATION', '撤回与修改端点或类型应分别预览，未改变原关系。');
  const endpoint = (ref: typeof original.source) => {
    if (!withdrawing) return ref;
    const current = snapshot.nodes.find((node) => node.id === ref.objectId);
    if (!current) fail('CONFLICT', '撤回关系的当前端点不可读，请核验对象阻断状态。', 'review_endpoints', 'preserved');
    return { ...ref, revision: current.revision };
  };
  const source = endpoint(reverse ? original.target : original.source);
  let target = endpoint(reverse ? original.source : original.target);
  if (targetId && targetId !== target.objectId) {
    const selected = snapshot.nodes.find((node) => node.id === targetId);
    if (!selected || selected.workspaceId !== ctx.workspaceId || selected.confirmation !== 'confirmed' || selected.lifecycle !== 'active' || snapshot.excludedIds.includes(selected.id)) fail('CONFLICT', '目标不可用，未确认悬空、受限或未正式化的关系。', 'review_endpoints', 'preserved');
    if (!patch.rationale || !patch.evidenceIds) fail('VALIDATION', '目标变化后需重新填写关系依据并明确选择证据。', 'review_relation_evidence');
    target = { workspaceId: ctx.workspaceId, objectId: selected.id, revision: selected.revision };
  }
  const updated = parse(RelationSchema, {
    ...original, ...patch,
    source, target,
    state: patch.state === 'rejected' ? 'withdrawn' : patch.state ?? 'proposed', confirmedBy: undefined, confirmedAt: undefined, updatedAt: new Date().toISOString(),
  });
  if (!withdrawing) validateRelationEvidence(snapshot.nodes, updated);
  rejectReplacementCycles([...snapshot.relations.filter((r) => r.id !== id && r.state === 'confirmed'), updated], snapshot.excludedIds);
  return {
    kind: 'relation_revision', before: { nodes: [], relations: [structuredClone(original)] },
    changes: { id: input.operationId, workspaceId: ctx.workspaceId, baseRevision: input.baseRevision, reason: input.reason, nodes: [], relations: [updated], withdrawnIds: updated.state === 'withdrawn' ? [id] : [] },
    changedFields: Object.keys(input.patch), warnings: [...(patch.state === 'rejected' ? ['正式关系的拒绝将以撤回保存，不写入候选拒绝状态。'] : []), ...(withdrawing ? ['撤回按当前端点版本登记，不重新确认旧关系的依据。'] : []), '旧关系保留在历史版本中。', 'Git保存与索引更新分别核验。'],
  };
}
