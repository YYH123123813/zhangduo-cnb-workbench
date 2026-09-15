import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { Id, KnowledgeNodeSchema, type ChangeSet, type KnowledgeNode, type KnowledgeSnapshot, type Relation } from '../../contracts/domain';
import { cancelSchema, checkBase, fail, parse } from './http';

export interface ChangePreview {
  kind: 'node_revision' | 'relation_revision' | 'replacement' | 'restore';
  before: { nodes: KnowledgeNode[]; relations: Relation[] };
  changes: Omit<ChangeSet, 'contentHash'>;
  changedFields: string[];
  warnings: string[];
  restoration?: { nodeId: string; historicalRevision: string };
}
export const reasonSchema = z.string().trim().min(1).max(4000);
export const editFields = {
  title: z.string().trim().min(1).max(4000).optional(),
  question: z.string().trim().min(1).max(20000).optional(),
  humanStatement: z.string().trim().min(1).max(100000).optional(),
  conditions: KnowledgeNodeSchema.shape.conditions.optional(),
  boundaries: KnowledgeNodeSchema.shape.boundaries.optional(),
  sources: KnowledgeNodeSchema.shape.sources.optional(),
  evidenceStatus: KnowledgeNodeSchema.shape.evidenceStatus.optional(),
  lifecycle: KnowledgeNodeSchema.shape.lifecycle.optional(),
};
export const nodeEditSchema = z.object({
  action: z.literal('preview'), operationId: Id, baseRevision: Id, nodeRevision: Id,
  reason: reasonSchema, patch: z.object(editFields).strict().refine((value) => Object.keys(value).length > 0),
}).strict();
export const nodeRequestSchema = z.discriminatedUnion('action', [nodeEditSchema, cancelSchema]);
export type NodeEdit = z.infer<typeof nodeEditSchema>;

export function currentNode(snapshot: KnowledgeSnapshot, id: string): KnowledgeNode {
  const value = snapshot.nodes.find((item) => item.id === id);
  if (!value) fail('VALIDATION', '当前快照中没有该知识对象。', 'select_current_object');
  return value;
}
export function revisionPreview(snapshot: KnowledgeSnapshot, ctx: RequestContext, id: string, edit: NodeEdit): ChangePreview {
  checkBase(snapshot, edit.baseRevision);
  const original = currentNode(snapshot, id);
  if (original.revision !== edit.nodeRevision) fail('CONFLICT', '引用的知识版本已变化，草稿保留。', 'reload_and_preview', 'preserved');
  if (snapshot.excludedIds.includes(id) || original.lifecycle === 'withdrawn') fail('CONFLICT', '已撤回对象不能通过普通编辑重新启用。', 'preview_restore', 'preserved');
  const changedFields = Object.keys(edit.patch).filter((key) => JSON.stringify(original[key as keyof KnowledgeNode]) !== JSON.stringify(edit.patch[key as keyof NodeEdit['patch']]));
  if (!changedFields.length) fail('VALIDATION', '没有内容变化。');
  const expressionChanged = changedFields.some((field) => ['title', 'question', 'humanStatement', 'conditions', 'boundaries'].includes(field));
  const supportChanged = expressionChanged || changedFields.includes('sources');
  const updated = parse(KnowledgeNodeSchema, {
    ...original, ...edit.patch, authorship: expressionChanged ? 'human_edited' : original.authorship, confirmation: 'draft',
    evidenceStatus: edit.patch.evidenceStatus ?? (supportChanged ? 'unverified' : original.evidenceStatus),
    confirmedBy: undefined, confirmedAt: undefined, updatedAt: new Date().toISOString(),
  });
  return {
    kind: 'node_revision', before: { nodes: [structuredClone(original)], relations: [] },
    changes: { id: edit.operationId, workspaceId: ctx.workspaceId, baseRevision: edit.baseRevision, nodes: [updated], relations: [], withdrawnIds: updated.lifecycle === 'withdrawn' ? [id] : [], reason: edit.reason },
    changedFields, warnings: ['仅在本次预览中保留草稿，尚未提交Git。', '来源支持与人的确认分别记录；修改不自动证明新结论。'],
  };
}
