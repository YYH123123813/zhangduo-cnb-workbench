import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { Id, type ChangeSet, type KnowledgeNode, type KnowledgeSnapshot } from '../../contracts/domain';
import { canonicalJson } from '../../contracts/hash';
import type { Services } from '../../contracts/ports';
import { cancelSchema, checkBase, fail, readSnapshot } from './http';
import { currentNode, reasonSchema, type ChangePreview } from './revisions';

export const restoreInputSchema = z.object({ action: z.literal('preview'), operationId: Id, nodeId: Id, baseRevision: Id, historicalRevision: Id, reason: reasonSchema }).strict();
export const restoreRequestSchema = z.discriminatedUnion('action', [restoreInputSchema, cancelSchema]);
export const restorationSchema = z.object({ nodeId: Id, historicalRevision: Id }).strict();
export type Restoration = z.infer<typeof restorationSchema>;
function content(node: KnowledgeNode) {
  const { revision: _revision, confirmation: _confirmation, confirmedBy: _actor, confirmedAt: _time, updatedAt: _updated, ...value } = node;
  return value;
}
export async function validateRestoration(services: Services, ctx: RequestContext, head: KnowledgeSnapshot, changes: Omit<ChangeSet, 'contentHash'>, restoration?: Restoration) {
  if (!restoration) return [];
  if (changes.nodes.length !== 1 || changes.nodes[0]?.id !== restoration.nodeId || changes.relations.length || changes.withdrawnIds.length) fail('VALIDATION', '恢复必须单独提交选定的历史知识对象。');
  const historical = await readSnapshot(services, ctx, restoration.historicalRevision);
  const old = currentNode(historical, restoration.nodeId);
  currentNode(head, restoration.nodeId);
  if (old.confirmation !== 'confirmed' || old.lifecycle !== 'active' || historical.excludedIds.includes(old.id)
    || canonicalJson(content(old)) !== canonicalJson(content(changes.nodes[0]!))) fail('CONFLICT', '恢复内容与可信历史不一致，未重新启用对象。', 'preview_restore_again', 'preserved');
  return [old.id];
}
// Historical content must come from Services.snapshot(ctx, revision), not the client.
export function restorePreview(head: KnowledgeSnapshot, historical: KnowledgeSnapshot, ctx: RequestContext, input: z.infer<typeof restoreInputSchema>): ChangePreview {
  checkBase(head, input.baseRevision);
  if (head.workspaceId !== ctx.workspaceId || historical.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '历史版本工作区不匹配。');
  if (historical.revision !== input.historicalRevision) fail('CONFLICT', '历史版本未核验。', 'read_historical_revision', 'preserved');
  const current = currentNode(head, input.nodeId);
  const old = currentNode(historical, input.nodeId);
  if (old.workspaceId !== ctx.workspaceId || current.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '知识工作区不匹配。');
  if (old.confirmation !== 'confirmed' || old.lifecycle !== 'active' || historical.excludedIds.includes(old.id)) fail('CONFLICT', '只能恢复为历史中明确有效且未被排除的知识。', 'select_active_historical_revision', 'preserved');
  const { confirmedBy: _actor, confirmedAt: _time, ...content } = old;
  return { kind: 'restore', before: { nodes: [structuredClone(current)], relations: [] },
    changes: { id: input.operationId, workspaceId: ctx.workspaceId, baseRevision: head.revision, reason: input.reason,
      nodes: [{ ...content, revision: current.revision, confirmation: 'draft', updatedAt: new Date().toISOString() }], relations: [], withdrawnIds: [] },
    restoration: { nodeId: old.id, historicalRevision: historical.revision },
    changedFields: ['historicalContent'], warnings: [`恢复来源版本：${historical.revision}`, '恢复将新增Git提交，不删除历史；原关系需独立复核，索引需更新。', '恢复不能解除持久应用删除屏障，也不代表物理数据已恢复。', ...(head.excludedIds.includes(current.id) ? ['本次仅恢复可读知识的逻辑撤回状态，不清除持久删除屏障。'] : [])] };
}
