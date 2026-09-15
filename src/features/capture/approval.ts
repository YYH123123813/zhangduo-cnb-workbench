import { ApprovalSchema, type Approval } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { failure } from './result';

export type ApprovalRequest = Pick<Approval, 'purpose' | 'objectIds' | 'contentHash' | 'baseRevision'>;

// These binding checks do not replace the platform's issued/revoked approval registry.
export function checkApprovalBinding(input: unknown, expected: ApprovalRequest, ctx: RequestContext, now = Date.now()): Result<Approval> {
  const parsed = ApprovalSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '批准信息不完整；请重新确认。', 'approve_again');
  const approval = parsed.data;
  if (approval.actorId !== ctx.actorId || approval.workspaceId !== ctx.workspaceId || approval.purpose !== expected.purpose) return failure('FORBIDDEN', '批准的操作者、工作区或用途不匹配。', 'approve_again');
  if (approval.objectIds.length !== expected.objectIds.length || new Set(approval.objectIds).size !== approval.objectIds.length || approval.objectIds.some((id) => !expected.objectIds.includes(id))) return failure('FORBIDDEN', '批准范围与当前对象不匹配。', 'approve_again');
  if (approval.contentHash !== expected.contentHash || approval.baseRevision !== expected.baseRevision) return failure('CONFLICT', '内容或基准版本已改变，请重新预览并确认。', 'preview_again');
  if (!Number.isFinite(now) || Date.parse(approval.approvedAt) > now || Date.parse(approval.expiresAt) <= now || Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) return failure('FORBIDDEN', '批准已过期或时间无效，请重新确认。', 'approve_again');
  return { ok: true, data: approval };
}
