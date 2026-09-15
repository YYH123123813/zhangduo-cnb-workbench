import type { RequestContext, Result } from '../../contracts/api';
import { KnowledgeApprovalStateSchema } from '../../contracts/approval';
import { checkApprovalBinding } from './commit';
import { failure } from './model';
import { newSubmission } from './submission';
import type { SubmissionState } from './submission';

export async function recoverApprovalState(state: SubmissionState, input: unknown,
  identity: Pick<RequestContext, 'actorId' | 'workspaceId'>, now: number): Promise<Result<SubmissionState>> {
  if (!state.preview || state.pending || state.unknown || state.receipt) return failure('提交状态须独立核验，不能用批准状态替代 Git 回执。', 'CONFLICT', 'read_back', 'unknown');
  const parsed = KnowledgeApprovalStateSchema.safeParse(input), changes = state.preview.changes;
  if (!parsed.success || parsed.data.changeSetId !== changes.id || parsed.data.actorId !== identity.actorId || parsed.data.workspaceId !== identity.workspaceId) {
    return failure('读回不属于原批准操作，当前预览仍保留。', 'UNKNOWN_RESULT', 'check_approval', 'unknown');
  }
  const original = parsed.data;
  if (original.status === 'not_registered' || original.status === 'unknown' || !original.approval) {
    return failure('尚不能确定原批准登记的最终结果；未发出 Git 提交，也未重发登记。', 'UNKNOWN_RESULT', 'check_approval', 'unknown');
  }
  const binding = await checkApprovalBinding(changes, original.approval, identity, now, original.status !== 'registered');
  if (!binding.ok || (original.status === 'expired' && Date.parse(original.approval.expiresAt) > now)) {
    return failure('原批准的摘要、范围、版本或期限不匹配，当前预览仍保留。', 'UNKNOWN_RESULT', 'check_approval', 'unknown');
  }
  if (original.status !== 'registered') return { ok: true, data: newSubmission() };
  return { ok: true, data: { ...state, approvalUnknown: false, approval: original.approval } };
}
