import { z } from 'zod';
import { Id, TaskContextSchema, type TaskContext } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { failure } from './result';
import { contentHash } from '../../contracts/hash';
import { TaskStateSchema, type TaskState } from '../../contracts/task-record';

export const TaskDraftSchema = z.object({
  id: Id, question: z.string().max(4000),
  constraints: z.array(z.object({ id: Id, text: z.string().max(1000) }).strict()).max(5),
  intent: z.enum(['archive', 'propose']),
}).strict();
export type TaskDraft = z.infer<typeof TaskDraftSchema>;
export interface StoredTaskContext { task: TaskContext; revision: number }

export function initialTaskDraft(id: string = crypto.randomUUID()): TaskDraft {
  return { id, question: '', constraints: [], intent: 'archive' };
}

export function taskDraftFromContext(input: TaskContext): Result<TaskDraft> {
  const parsed = TaskContextSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '原任务结构未核验。');
  const draft = TaskDraftSchema.safeParse({ id: input.id, question: input.question, constraints: input.constraints.map(({ id, text }) => ({ id, text })), intent: input.mode === 'assisted' ? 'propose' : 'archive' });
  return draft.success ? { ok: true, data: draft.data } : failure('VALIDATION', '原任务超过当前捕获表单范围，未截断或替换原任务。');
}

export function taskForStorage(input: TaskDraft, workspaceId: string, original?: TaskContext, updatedAt = new Date().toISOString()): Result<TaskContext> {
  const draft = TaskDraftSchema.safeParse(input);
  if (!draft.success || !draft.data.question.trim()) return failure('VALIDATION', '请核对当前问题和约束范围。');
  if (original && (original.id !== input.id || original.workspaceId !== workspaceId)) return failure('FORBIDDEN', '不能把新任务绑定到旧任务上下文。');
  const parsed = TaskContextSchema.safeParse({ ...(original ?? {}), id: input.id, workspaceId, question: input.question,
    constraints: input.constraints.filter((item) => item.text.trim()).map((item) => {
      const previous = original?.constraints.find((prior) => prior.id === item.id && prior.text === item.text);
      return previous ? { ...previous } : { ...item };
    }), mode: input.intent === 'propose' ? 'assisted' : 'independent', updatedAt });
  return parsed.success ? { ok: true, data: parsed.data } : failure('VALIDATION', '完整原任务内容未核验；未保存。');
}

export async function taskForStorageAtState(input: TaskDraft, state: TaskState, original?: StoredTaskContext): Promise<Result<TaskContext>> {
  const parsed = TaskStateSchema.safeParse(state);
  if (!parsed.success) return failure('VALIDATION', '原任务保存状态未核验。');
  const remote = parsed.data;
  const conflict = () => failure<TaskContext>('CONFLICT', '原任务版本已变化、过期或尚未明确恢复；当前编辑已保留，请读取并确认使用原任务后再保存。', 'preview_again', 'preserved');
  if (remote.id !== input.id || remote.state === 'expired' || (remote.state === 'missing' && original)) return conflict();
  if (remote.state === 'available') {
    if (!original || original.revision !== remote.revision) return conflict();
    try { if (await contentHash(TaskContextSchema.parse(original.task)) !== remote.contentHash) return conflict(); }
    catch { return conflict(); }
  }
  return taskForStorage(input, remote.workspaceId, original?.task);
}

export function frameTask(input: unknown, ctx: RequestContext, now: string): Result<TaskContext | null> {
  if (ctx.mode === 'unconfigured') return failure('NOT_CONFIGURED', '尚未连接工作区；草稿未写入。', 'configure_workspace');
  const parsed = TaskDraftSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '问题最多4000字，约束最多5项；不能指定身份或工作区。');
  const draft = parsed.data;
  if (!draft.question.trim()) return { ok: true, data: null };
  const task = TaskContextSchema.safeParse({
    id: draft.id, workspaceId: ctx.workspaceId, question: draft.question.trim(),
    constraints: draft.constraints.filter((item) => item.text.trim()),
    mode: draft.intent === 'propose' ? 'assisted' : 'independent', updatedAt: now,
  });
  return task.success ? { ok: true, data: task.data } : failure('VALIDATION', '任务时间或标识无效。');
}
