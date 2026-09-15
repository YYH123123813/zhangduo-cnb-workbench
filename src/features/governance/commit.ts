import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { ApprovalSchema, ChangeSetSchema, type ChangeSet, type KnowledgeSnapshot } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { cancelSchema, checkBase, fail, parse, readSnapshot, unwrap } from './http';
import { checkConsent } from './consent';
import { rejectReplacementCycles } from './replacement';
import { hashChangeSet } from '../../contracts/hash';
import { checkChangeIdentity, verifyReceipt } from './readback';
import { restorationSchema, validateRestoration, type Restoration } from './restore';
import { validateRelationEvidence } from './relations';

export const commitRequestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('commit'), changes: ChangeSetSchema, approval: ApprovalSchema, restoration: restorationSchema.optional() }).strict(), cancelSchema]);
export const prepareRequestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('prepare'), changes: ChangeSetSchema.omit({ contentHash: true }), restoration: restorationSchema.optional() }).strict(), cancelSchema]);
export async function prepareChanges(ctx: RequestContext, snapshot: KnowledgeSnapshot, changes: Omit<ChangeSet, 'contentHash'>, approvalPortAvailable = false, restoredIds: string[] = [], restoration?: Restoration) {
  const confirmedAt = new Date().toISOString();
  const normalized = { ...changes,
    nodes: changes.nodes.map((node) => ({ ...node, confirmation: 'confirmed' as const, confirmedBy: ctx.actorId, confirmedAt })),
    relations: changes.relations.map((edge) => edge.state === 'proposed' ? { ...edge, state: 'confirmed' as const, confirmedBy: ctx.actorId, confirmedAt } : edge),
  };
  const prepared = parse(ChangeSetSchema, { ...normalized, contentHash: 'pending-hash' });
  validateChanges(snapshot, prepared, restoredIds);
  prepared.contentHash = await hashChangeSet(prepared);
  return { changes: prepared, objectIds: [...new Set([...prepared.nodes, ...prepared.relations].map((item) => item.id).concat(prepared.withdrawnIds))], purpose: 'commit_knowledge' as const,
    ...(restoration ? { restoration } : {}), approvalStatus: approvalPortAvailable ? 'required' as const : 'unavailable' as const, executionEnabled: false,
    warning: approvalPortAvailable ? '需登记本次变更的明确批准；端口存在不等于工作区已授权或配置。' : '尚无可信批准登记接口，未授权、未写入。' };
}
export function validateChanges(snapshot: KnowledgeSnapshot, changes: ChangeSet, restoredIds: string[] = []) {
  checkBase(snapshot, changes.baseRevision);
  if (changes.workspaceId !== snapshot.workspaceId || changes.nodes.some((n) => n.workspaceId !== snapshot.workspaceId) || changes.relations.some((r) => r.workspaceId !== snapshot.workspaceId)) fail('FORBIDDEN', '修改跨越工作区，未提交。');
  const ids = [...changes.nodes, ...changes.relations].map((item) => item.id);
  if (!changes.reason.trim() || changes.reason.length > 4000) fail('VALIDATION', '必须提供非空且长度有效的修改理由。');
  if (!ids.length || new Set(ids).size !== ids.length || new Set(changes.withdrawnIds).size !== changes.withdrawnIds.length) fail('VALIDATION', '变更为空或包含重复对象。');
  for (const node of changes.nodes) {
    const old = snapshot.nodes.find((n) => n.id === node.id);
    if (!old) fail('VALIDATION', '新增知识必须通过替代预览或入库流程。');
    if (old.revision !== node.revision) fail('CONFLICT', '节点版本已变化。', 'reload_and_preview', 'preserved');
    if (old.conversationId !== node.conversationId || old.schemaVersion !== node.schemaVersion || JSON.stringify(old.candidateIds) !== JSON.stringify(node.candidateIds)) fail('VALIDATION', '不能改写原始来源标识。');
    if ((snapshot.excludedIds.includes(node.id) || old.lifecycle === 'withdrawn') && node.lifecycle !== 'withdrawn' && !restoredIds.includes(node.id)) fail('CONFLICT', '恢复排除对象需要可信历史恢复流程。', 'preview_restore', 'preserved');
    if (node.confirmation !== 'confirmed' || node.confirmedBy === undefined) fail('VALIDATION', '正式修订需要人的明确确认。');
  }
  for (const edge of changes.relations) {
    if (!snapshot.relations.some((r) => r.id === edge.id) && !(edge.type === 'supersedes' && changes.nodes.some((n) => n.id === edge.target.objectId && n.lifecycle === 'superseded'))) fail('VALIDATION', '新关系需要替代预览或入库流程。');
    if (edge.state === 'proposed') fail('VALIDATION', '提议关系不能直接作为正式修订提交。');
    if (edge.state === 'confirmed') validateRelationEvidence([...changes.nodes, ...snapshot.nodes.filter((node) => !changes.nodes.some((changed) => changed.id === node.id))], edge);
    if (edge.state === 'confirmed') for (const ref of [edge.source, edge.target]) {
      const target = [...changes.nodes, ...snapshot.nodes].find((n) => n.id === ref.objectId);
      const allowedLifecycle = target?.lifecycle === 'active' || (edge.type === 'supersedes' && ref === edge.target && target?.lifecycle === 'superseded');
      if (!target || target.confirmation !== 'confirmed' || target.revision !== ref.revision || !allowedLifecycle || snapshot.excludedIds.includes(target.id)) fail('CONFLICT', '关系端点不再可用或版本变化。', 'review_endpoints', 'preserved');
    }
  }
  rejectReplacementCycles([...snapshot.relations.filter((r) => r.state === 'confirmed' && !changes.relations.some((changed) => changed.id === r.id)), ...changes.relations], snapshot.excludedIds);
  const expectedWithdrawals = [...changes.nodes.filter((n) => n.lifecycle === 'withdrawn'), ...changes.relations.filter((r) => r.state === 'withdrawn')].map((item) => item.id);
  if (expectedWithdrawals.length !== changes.withdrawnIds.length || expectedWithdrawals.some((id) => !changes.withdrawnIds.includes(id))) fail('VALIDATION', '撤回对象与检索排除范围不一致。');
}
export async function commitChanges(services: Services, ctx: RequestContext, input: Extract<z.infer<typeof commitRequestSchema>, { action: 'commit' }>) {
  await checkChangeIdentity(ctx, input.changes);
  const objectIds = [...new Set([...input.changes.nodes, ...input.changes.relations].map((item) => item.id).concat(input.changes.withdrawnIds))];
  checkConsent(ctx, input.approval, { purpose: 'commit_knowledge', contentHash: input.changes.contentHash, baseRevision: input.changes.baseRevision, objectIds });
  if (input.changes.nodes.some((n) => n.confirmedBy !== ctx.actorId) || input.changes.relations.some((r) => r.state === 'confirmed' && r.confirmedBy !== ctx.actorId)) fail('FORBIDDEN', '不能代替他人确认知识或关系。');
  const previous = services.readCommit ? unwrap(await services.readCommit(ctx, input.changes.id)) : null;
  if (!previous) {
    const snapshot = await readSnapshot(services, ctx);
    checkBase(snapshot, input.changes.baseRevision);
    const restoredIds = await validateRestoration(services, ctx, snapshot, input.changes, input.restoration);
    validateChanges(snapshot, input.changes, restoredIds);
  }
  let result;
  try { result = await services.commit(ctx, input.changes, input.approval); }
  catch { fail('UNKNOWN_RESULT', '提交请求中断，保留同一操作ID并只读核验。', 'read_commit', 'unknown'); }
  const receipt = unwrap(result);
  if (receipt.changeSetId !== input.changes.id || !receipt.revision || !['pending', 'current', 'failed'].includes(receipt.indexing)) fail('UNKNOWN_RESULT', '提交回执无法核验，不能自动重试。', 'read_back_before_retry', 'unknown');
  // Services revalidates the stored operation hash and revocation even on a replay.
  if (previous) return verifyReceipt(services, ctx, input.changes, receipt);
  return { receipt, snapshotVerified: false, retrievalVerified: false, historyRewritten: false };
}
