import type { Result } from '../../contracts/api';
import { canonicalJson } from '../../contracts/hash';
import type { RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import { ReviewOperationReceiptSchema, type ReviewOperationReceipt } from '../../contracts/review-session';
import { TaskReceiptSchema, type TaskReceipt, type TaskState } from '../../contracts/task-record';
import type { EvidenceReceipt } from '../../contracts/evidence';
import { readLearningRecoveryAnchor } from './recovery-anchor';
import type { LearningRecoveryIdentity, LearningRecoveryTransport } from './operation-recovery';
import { readReviewTaskState } from './review-task';
import { readEvidenceOperation, type EvidenceOperationView } from './evidence-recovery';
import { AttemptResponseSchema } from './attempt-response';
import type { AttemptResponse } from './review-api';
import { failure, success } from './errors';

export interface RetainedLearningOperation {
  anchor: RecoveryAnchorRead; message: string;
  receipt?: TaskReceipt | EvidenceReceipt | ReviewOperationReceipt;
  task?: TaskState; evidence?: EvidenceOperationView; review?: AttemptResponse;
}
const unknown = <T>(): Result<T> => failure('UNKNOWN_RESULT', '原操作仍未知或专用回执与保留的摘要不一致；没有读取正文或重复发送。', 'read_original_operation', 'unknown');
function reviewReceiptMatches(receipt: ReviewOperationReceipt, anchor: RecoveryAnchorRead) {
  const { identity, original } = anchor;
  return receipt.operationId === identity.operation.operationId && receipt.actorId === identity.actorId && receipt.workspaceId === identity.workspaceId
    && receipt.requestHash === identity.binding.requestHash && receipt.attemptId === original?.recordId && receipt.kind === original.purpose
    && (receipt.kind === 'start' ? receipt.attemptId === receipt.operationId && receipt.expectedVersion === 0 && receipt.resultingVersion === 0
      : receipt.resultingVersion === receipt.expectedVersion + 1)
    && (['feedback', 'appeal'].includes(receipt.kind) ? receipt.feedbackVersion !== null : receipt.feedbackVersion === null);
}

/** Default recovery fetches metadata and dedicated receipts only, never private text. */
export async function recoverRetainedLearningOperation(transport: LearningRecoveryTransport, identity: LearningRecoveryIdentity, supplied: unknown, readBody = false): Promise<Result<RetainedLearningOperation>> {
  const fresh = await readLearningRecoveryAnchor(transport, identity, supplied);
  if (!fresh.ok) return fresh;
  const anchor = fresh.data;
  if (anchor.binding !== 'matched' || !anchor.original) return unknown();
  const { operation, binding } = anchor.identity;
  const view: RetainedLearningOperation = { anchor, message: '仅核验原操作最小元数据，不代表业务提交成功。' };
  const expired = () => Date.parse(anchor.identity.expiresAt) <= Date.now();
  const expiration = () => failure<never>('FORBIDDEN', '恢复身份保留已到期，未继续读取或交付正文。', 'read_original_operation');
  const read = async (path: string): Promise<Result<unknown>> => {
    if (expired()) return expiration();
    const response = await transport(path);
    return expired() ? expiration() : response;
  };
  try {
    if (expired()) return expiration();
    if (operation.kind === 'model') return success({ ...view, message: '模型审核仅恢复原操作阶段；未恢复模型输入、输出、批准载荷或学习证明。' });
    if (operation.kind === 'task') {
      const response = await read(`/api/workspace/task-receipts/${encodeURIComponent(operation.operationId)}`);
      if (!response.ok) return response;
      const receipt = TaskReceiptSchema.safeParse(response.data);
      if (!receipt.success || receipt.data.operationId !== operation.operationId || receipt.data.requestHash !== binding.requestHash
        || receipt.data.actorId !== identity.actorId || receipt.data.workspaceId !== identity.workspaceId
        || receipt.data.taskId !== anchor.original.recordId || receipt.data.contentHash !== anchor.original.contentHash) return unknown();
      view.receipt = receipt.data; view.message = '原任务保存专用回执已核验；尚未读取任务正文。';
      if (readBody) {
        const task = await readReviewTaskState(read, identity, receipt.data.taskId);
        if (!task.ok) return task;
        if (task.data.state !== 'available' || task.data.revision !== receipt.data.revision || task.data.contentHash !== receipt.data.contentHash) {
          return success({ ...view, message: '原任务保存回执成立，但任务已变化或到期；未用当前任务重建原内容或批准。' });
        }
        view.task = task.data; view.message = '已读取与原保存回执版本和摘要一致的任务；尚未启动作答。';
      }
    } else if (operation.kind === 'evidence') {
      if (!binding.contentHash || !binding.baseRevision) return unknown();
      const evidence = await readEvidenceOperation(read, identity, operation.operationId, {
        binding: { contentHash: binding.contentHash, baseRevision: binding.baseRevision }, readBody,
      });
      if (!evidence.ok) return evidence;
      if (!evidence.data.receipt) return unknown();
      view.evidence = evidence.data; view.receipt = evidence.data.receipt; view.message = evidence.data.message;
    } else if (operation.kind === 'review') {
      const path = `/api/learning/attempts/${encodeURIComponent(operation.operationId)}`;
      const response = await read(`${path}?projection=receipt&requestHash=${binding.requestHash}`);
      if (!response.ok) return response;
      const receipt = ReviewOperationReceiptSchema.safeParse(response.data);
      if (!receipt.success || !reviewReceiptMatches(receipt.data, anchor)) return unknown();
      view.receipt = receipt.data; view.message = '原作答事件专用回执已核验；尚未请求题目、反馈或答案。';
      if (readBody) {
        const response = await read(`${path}?requestHash=${binding.requestHash}`);
        if (!response.ok) return response;
        const state = AttemptResponseSchema.safeParse(response.data);
        if (!state.success || canonicalJson(state.data.receipt) !== canonicalJson(receipt.data)
          || state.data.view.id !== receipt.data.attemptId || state.data.view.version < receipt.data.resultingVersion
          || state.data.view.question.nodeRef.workspaceId !== identity.workspaceId) return unknown();
        view.review = state.data; view.message = '已按原事件回执读取当前允许的会话投影；后续版本不改变原事件归属。未自动继续作答。';
      }
    } else return unknown();
    return expired() ? expiration() : success(view);
  } catch { return unknown(); }
}
