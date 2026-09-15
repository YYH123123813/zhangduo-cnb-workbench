import type { RequestContext, Result } from '../../contracts/api';
import { canonicalJson, contentHash } from '../../contracts/hash';
import { Id, TaskContextSchema, type TaskContext } from '../../contracts/domain';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import { TaskReceiptSchema, TaskSaveRequestSchema, TaskStateSchema, type TaskReceipt, type TaskSaveRequest, type TaskState } from '../../contracts/task-record';
import { readTaskOperationRecovery } from './operation-recovery';
import { failure, success } from './errors';

export type ReviewTaskTransport = (path: string, init?: RequestInit) => Promise<Result<unknown>>;
export interface ReviewTaskResult { state: TaskState; receipt: TaskReceipt | null; recovery: OperationRecovery | null; }
export interface ReviewTaskConsent { confirmed: boolean; onPending: (request: TaskSaveRequest) => void; beforeSave?: (request: TaskSaveRequest) => Promise<Result<true>>; }

const unknownTask = <T>(message: string): Result<T> => failure('UNKNOWN_RESULT', message, 'read_task_receipt', 'unknown');

function taskRequest(task: TaskContext, operationId: string, state: TaskState) {
  return TaskSaveRequestSchema.parse({ operationId, task, expectedRevision: state.revision, expectedContentHash: state.contentHash,
    retentionDays: 30, confirmed: true });
}

function validateState(input: unknown, identity: Pick<RequestContext, 'actorId' | 'workspaceId'>, taskId: string): Result<TaskState> {
  const parsed = TaskStateSchema.safeParse(input);
  if (!parsed.success || parsed.data.id !== taskId || parsed.data.workspaceId !== identity.workspaceId || parsed.data.actorId !== identity.actorId || parsed.data.absenceIsFinal !== false) {
    return failure('UNKNOWN_RESULT', '原任务状态无法绑定当前身份、工作区或任务 ID，未启动作答。', 'read_task_receipt', 'unknown');
  }
  return success(parsed.data);
}

async function readState(transport: ReviewTaskTransport, identity: Pick<RequestContext, 'actorId' | 'workspaceId'>, taskId: string): Promise<Result<TaskState>> {
  const result = await transport(`/api/workspace/tasks/${encodeURIComponent(taskId)}`);
  if (!result.ok) return result;
  const checked = validateState(result.data, identity, taskId);
  if (checked.ok && checked.data.task && await contentHash(checked.data.task) !== checked.data.contentHash) return unknownTask('原任务正文与内容摘要不符，未展示任务。');
  return checked;
}

export async function readReviewTaskState(transport: ReviewTaskTransport, identity: Pick<RequestContext, 'actorId' | 'workspaceId'>,
  taskId: string, original?: TaskContext): Promise<Result<TaskState>> {
  if (!Id.safeParse(taskId).success) return failure('VALIDATION', '请指定原任务 ID。');
  try {
    const state = await readState(transport, identity, taskId);
    if (state.ok && state.data.task && original && canonicalJson(state.data.task) !== canonicalJson(original)) {
      return failure('CONFLICT', '已保存任务与原检索任务不同，未以当前任务替换原题。', 'return_to_original_task', 'preserved');
    }
    return state;
  } catch { return unknownTask('原任务读取中断；没有保存或启动作答。'); }
}

async function readReceipt(transport: ReviewTaskTransport, identity: Pick<RequestContext, 'actorId' | 'workspaceId'>, operationId: string): Promise<Result<TaskReceipt | null>> {
  const result = await transport(`/api/workspace/task-receipts/${encodeURIComponent(operationId)}`);
  if (!result.ok) return result;
  if (result.data === null) return success(null);
  const parsed = TaskReceiptSchema.safeParse(result.data);
  if (!parsed.success || parsed.data.operationId !== operationId || parsed.data.actorId !== identity.actorId || parsed.data.workspaceId !== identity.workspaceId) {
    return unknownTask('原任务保存回执无法绑定当前身份或原操作，未启动作答。');
  }
  return success(parsed.data);
}

async function readSavedTask(
  transport: ReviewTaskTransport,
  identity: Pick<RequestContext, 'actorId' | 'workspaceId'>,
  task: TaskContext,
  request: ReturnType<typeof taskRequest>,
): Promise<Result<ReviewTaskResult>> {
  const receiptResult = await readReceipt(transport, identity, request.operationId);
  if (!receiptResult.ok) return receiptResult;
  if (!receiptResult.data) return unknownTask('原任务保存回执尚未确认；空回执不证明任务未保存，也不会重发保存。');
  const receipt = receiptResult.data;
  const [requestHash, expectedTaskHash] = await Promise.all([contentHash(request), contentHash(task)]);
  if (receipt.taskId !== task.id || receipt.requestHash !== requestHash || receipt.contentHash !== expectedTaskHash
    || receipt.previousRevision !== request.expectedRevision || receipt.revision !== request.expectedRevision + 1) {
    return unknownTask('原任务保存回执的请求摘要、内容摘要或版本不匹配，未启动作答。');
  }
  const stateResult = await readState(transport, identity, task.id);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.data;
  if (state.state !== 'available' || !state.task || state.revision !== receipt.revision || state.contentHash !== receipt.contentHash
    || canonicalJson(state.task) !== canonicalJson(task)) return failure('CONFLICT', '原任务保存后版本或内容已变化，未将当前任务重绑定到旧保存操作。', 'read_task_receipt', 'preserved');
  return success({ state, receipt, recovery: null });
}

/** Read-only recovery for a task save whose POST result was unknown. */
export async function readReviewTaskOperation(
  transport: ReviewTaskTransport,
  identity: Pick<RequestContext, 'actorId' | 'workspaceId'>,
  input: unknown,
): Promise<Result<ReviewTaskResult>> {
  try {
    const parsed = TaskSaveRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.task.workspaceId !== identity.workspaceId) {
      return failure('VALIDATION', '原任务或保存操作不完整，不能核验原操作。', 'read_task_receipt');
    }
    const request = parsed.data, { task, operationId } = request;
    const recovery = await readTaskOperationRecovery(transport, identity, operationId);
    if (!recovery.ok) return recovery;
    if (recovery.data.stage !== 'saved' || recovery.data.recordId !== task.id || recovery.data.requestHash !== await contentHash(request)
      || recovery.data.contentHash !== await contentHash(task)) {
      return unknownTask('原任务保存仍未知；共享恢复元数据没有形成可核验的成功回执。');
    }
    const saved = await readSavedTask(transport, identity, task, request);
    return saved.ok ? success({ ...saved.data, recovery: recovery.data }) : saved;
  } catch {
    return unknownTask('原任务保存恢复中断；未发送任何写入。');
  }
}

/**
 * S07 requires the exact original task to be durable before an attempt starts.
 * A successful POST is never trusted until its receipt and task state are read
 * back with the original operation ID and complete request/content hashes.
 */
export async function ensureReviewTask(
  transport: ReviewTaskTransport,
  identity: Pick<RequestContext, 'actorId' | 'workspaceId'>,
  input: unknown,
  operationId: string,
  consent: ReviewTaskConsent,
): Promise<Result<ReviewTaskResult>> {
  try {
    if (consent?.confirmed !== true) return failure('FORBIDDEN', '请先明确确认原任务私有保存 30 天。', 'confirm_task_retention');
    const parsed = TaskContextSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', '受信回顾必须先保存完整原任务，未启动作答。', 'save_original_task');
    const task = parsed.data;
    if (task.workspaceId !== identity.workspaceId || !Id.safeParse(operationId).success) return failure('FORBIDDEN', '原任务或保存操作不属于当前工作区。', 'save_original_task');
    const current = await readState(transport, identity, task.id);
    if (!current.ok) return current;
    if (current.data.state === 'available') {
      if (!current.data.task || current.data.contentHash !== await contentHash(task) || canonicalJson(current.data.task) !== canonicalJson(task)) {
        return failure('CONFLICT', '当前已保存任务与本次原任务不一致，未覆盖或重绑定。', 'read_task_receipt', 'preserved');
      }
      return success({ state: current.data, receipt: null, recovery: null });
    }
    const request = taskRequest(task, operationId, current.data);
    const retained = await consent.beforeSave?.(structuredClone(request));
    if (retained && !retained.ok) return retained;
    consent.onPending(structuredClone(request));
    let response: Result<unknown>;
    try { response = await transport('/api/workspace/tasks', { method: 'POST', body: JSON.stringify(request) }); }
    catch { response = unknownTask('原任务保存响应中断；未重发保存请求。'); }
    if (!response.ok && response.error.dataState === 'not_written' && !['UNKNOWN_RESULT', 'CONFLICT'].includes(response.error.code)) return response;
    return await readSavedTask(transport, identity, task, request);
  } catch {
    return unknownTask('原任务保存或读回中断；未重发保存请求，需按原操作继续核验。');
  }
}
