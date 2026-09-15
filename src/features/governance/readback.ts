import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { ChangeSetSchema, Id, type ChangeSet, type CommitReceipt } from '../../contracts/domain';
import { canonicalJson, hashChangeSet } from '../../contracts/hash';
import type { Services } from '../../contracts/ports';
import { cancelSchema, fail, readSnapshot, unwrap } from './http';

export const readChangesRequestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('verify'), changes: ChangeSetSchema }).strict(), cancelSchema]);
export const receiptSchema = z.object({ changeSetId: Id, revision: Id, commitUrl: z.string(), indexing: z.enum(['pending', 'current', 'failed']) }).strict();
export async function checkChangeIdentity(ctx: RequestContext, changes: ChangeSet) {
  if (changes.workspaceId !== ctx.workspaceId || [...changes.nodes, ...changes.relations].some((item) => item.workspaceId !== ctx.workspaceId)) fail('FORBIDDEN', '变更不属于当前工作区。');
  if (await hashChangeSet(changes) !== changes.contentHash) fail('CONFLICT', '变更与原摘要不一致，请保留原操作内容。', 'review_original_operation', 'preserved');
}

export async function verifyReceipt(services: Services, ctx: RequestContext, changes: ChangeSet, value: CommitReceipt) {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.changeSetId !== changes.id || parsed.data.revision === changes.baseRevision) fail('UNKNOWN_RESULT', '回执无法对应本次新提交。', 'read_commit', 'unknown');
  const receipt = parsed.data;
  let snapshot;
  try { snapshot = await readSnapshot(services, ctx, receipt.revision); }
  catch { fail('UNKNOWN_RESULT', '提交版本尚未读回，不能确认本次变更已保存。', 'read_commit', 'unknown'); }
  const same = (actual: unknown, expected: unknown) => actual !== undefined && canonicalJson(actual) === canonicalJson(expected);
  const changedIds = new Set(changes.nodes.map((node) => node.id));
  const nodesMatch = changes.nodes.every((node) => same(snapshot.nodes.find((item) => item.id === node.id), { ...node, revision: receipt.revision })
    && (node.lifecycle !== 'active' || !snapshot.excludedIds.includes(node.id)));
  const relationsMatch = changes.relations.every((edge) => same(snapshot.relations.find((item) => item.id === edge.id), { ...edge,
    source: { ...edge.source, revision: changedIds.has(edge.source.objectId) ? receipt.revision : edge.source.revision },
    target: { ...edge.target, revision: changedIds.has(edge.target.objectId) ? receipt.revision : edge.target.revision },
  }) && (edge.state !== 'confirmed' || !snapshot.excludedIds.includes(edge.id)));
  if (!nodesMatch || !relationsMatch || changes.withdrawnIds.some((id) => !snapshot.excludedIds.includes(id))) fail('UNKNOWN_RESULT', '固定提交中的对象、关系或排除状态与变更不符。', 'read_commit', 'unknown');
  return { state: 'verified' as const, receipt, snapshot, snapshotVerified: true as const, retrievalVerified: false as const, historyRewritten: false as const };
}

export async function readCommittedChanges(services: Services, ctx: RequestContext, changes: ChangeSet) {
  await checkChangeIdentity(ctx, changes);
  if (!services.readCommit) fail('NOT_CONFIGURED', '共享提交读回端口尚未配置。', 'configure_commit_reader');
  const receipt = unwrap(await services.readCommit(ctx, changes.id));
  if (!receipt) return { state: 'not_recorded' as const, changeSetId: changes.id, snapshotVerified: false as const,
    warning: '暂未查到已登记操作，不证明请求未写入；保留原操作ID继续只读核验。' };
  return verifyReceipt(services, ctx, changes, receipt);
}
