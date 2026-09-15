import type { RequestContext } from '../../contracts/api';
import type { Approval } from '../../contracts/domain';
import { fail } from './http';

export function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every((id) => right.includes(id));
}
export function checkConsent(ctx: RequestContext, approval: Approval, expected: { purpose: Approval['purpose']; contentHash: string; baseRevision: string; objectIds: string[] }) {
  if (approval.actorId !== ctx.actorId || approval.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '批准不属于当前操作者或工作区。', 'request_new_approval');
  if (approval.purpose !== expected.purpose || approval.contentHash !== expected.contentHash || approval.baseRevision !== expected.baseRevision || !sameIds(approval.objectIds, expected.objectIds)) {
    fail('CONFLICT', '批准范围、内容或版本已变化，必须重新确认。', 'preview_and_approve_again', 'preserved');
  }
  if (Date.parse(approval.approvedAt) > Date.now() || Date.parse(approval.expiresAt) <= Date.now() || Date.parse(approval.approvedAt) >= Date.parse(approval.expiresAt)) fail('FORBIDDEN', '批准已过期或时间无效。', 'request_new_approval');
  // Canonical hashing, revocation and durable idempotency remain authoritative in Services.
}
