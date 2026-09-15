import type { RequestContext, Result } from '../../contracts/api';
import type { Approval, ChangeSet } from '../../contracts/domain';
import { ApprovalSchema } from '../../contracts/domain';
import { hashChangeSet } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import { failure } from './model';

export async function checkCommitApproval(changes: ChangeSet, approval: Approval, ctx: RequestContext, now: number): Promise<Result<true>> {
  if (!ctx.scopes.includes(SCOPES.knowledgeWrite)) return failure('缺少知识提交权限。', 'FORBIDDEN', 'request_access');
  return checkApprovalBinding(changes, approval, ctx, now);
}

export async function checkApprovalBinding(changes: ChangeSet, approval: Approval, ctx: Pick<RequestContext, 'actorId' | 'workspaceId'>,
  now: number, allowInactive = false): Promise<Result<true>> {
  if (changes.contentHash !== await hashChangeSet(changes) || approval.contentHash !== changes.contentHash) return failure('提交内容与批准摘要不一致，请重新预览。', 'VALIDATION', 'refresh_preview', 'preserved');
  const ids = [...changes.nodes.map((node) => node.id), ...changes.relations.map((relation) => relation.id), ...changes.withdrawnIds];
  const expectedIds = new Set(ids);
  if (approval.purpose !== 'commit_knowledge' || approval.actorId !== ctx.actorId || approval.workspaceId !== ctx.workspaceId ||
    changes.workspaceId !== ctx.workspaceId || approval.baseRevision !== changes.baseRevision ||
    new Set(approval.objectIds).size !== expectedIds.size || approval.objectIds.length !== expectedIds.size ||
    approval.objectIds.some((id) => !expectedIds.has(id))) return failure('批准的用途、对象范围、身份或基准版本不匹配。', 'FORBIDDEN', 'approve_again', 'preserved');
  const approvedAt = Date.parse(approval.approvedAt); const expiresAt = Date.parse(approval.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > now || (!allowInactive && expiresAt <= now) || expiresAt <= approvedAt ||
    changes.nodes.some((node) => !node.confirmedAt || Date.parse(node.confirmedAt) > approvedAt)) return failure('批准已过期或确认时间无效，请重新确认当前预览。', 'FORBIDDEN', 'approve_again', 'preserved');
  return { ok: true, data: true };
}

export async function validateIssuedApproval(changes: ChangeSet, input: unknown,
  identity: Pick<RequestContext, 'actorId' | 'workspaceId'>, now: number): Promise<Result<Approval>> {
  const parsed = ApprovalSchema.safeParse(input);
  if (parsed.success && (await checkApprovalBinding(changes, parsed.data, identity, now)).ok) return { ok: true, data: parsed.data };
  return failure('批准回执与本次预览的内容、范围、身份或期限不匹配，登记状态待核验；未发出 Git 提交。', 'UNKNOWN_RESULT', 'check_approval', 'unknown');
}
