import { z } from 'zod';
import { Id, Timestamp, VersionRefSchema } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure, success } from './errors';

const QueueItemInput = z.object({ id: Id, nodeRef: VersionRefSchema, taskId: Id, title: z.string().trim().min(1).max(4000) }).strict();
export type QueueItem = z.infer<typeof QueueItemInput> & { dueAt: string; status: 'ready' | 'deferred' | 'skipped' };
export interface ReviewQueue { workspaceId: string; enabled: boolean; items: QueueItem[] }
const QueueAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enable') }).strict(), z.object({ type: z.literal('disable') }).strict(),
  z.object({ type: z.literal('add'), item: QueueItemInput }).strict(),
  z.object({ type: z.literal('defer'), id: Id, until: Timestamp }).strict(),
  z.object({ type: z.literal('skip'), id: Id }).strict(), z.object({ type: z.literal('remove'), id: Id }).strict(),
]);
export type ReviewQueueAction = z.infer<typeof QueueAction>;
export function createQueue(workspaceId: string): ReviewQueue { return { workspaceId, enabled: false, items: [] }; }

export function selectQueueItem(queue: ReviewQueue, id: string, now: string): Result<QueueItem> {
  if (!Timestamp.safeParse(now).success) return failure('VALIDATION', '回顾时间无效。');
  if (!queue.enabled) return failure('CONFLICT', '回顾已关闭，未启动作答。', 'enable_reviews');
  const item = queue.items.find((entry) => entry.id === id);
  if (!item || item.status === 'skipped') return failure('CONFLICT', '回顾项已移除或跳过，未启动作答。', 'choose_queue_item');
  if (item.nodeRef.workspaceId !== queue.workspaceId) return failure('FORBIDDEN', '回顾项不属于当前工作区。');
  if (item.status === 'deferred' && Date.parse(item.dueAt) > Date.parse(now)) return failure('CONFLICT', '回顾项已延后，尚未到期。', 'return_to_task');
  return success(structuredClone(item));
}

export function updateQueue(state: ReviewQueue, action: unknown, now: string): Result<ReviewQueue> {
  const parsed = QueueAction.safeParse(action);
  if (!parsed.success || !Timestamp.safeParse(now).success) return failure('VALIDATION', '回顾操作或时间无效。');
  const next = structuredClone(state);
  const event = parsed.data;
  if (event.type === 'enable' || event.type === 'disable') return success({ ...next, enabled: event.type === 'enable' });
  if (!next.enabled) return failure('VALIDATION', '回顾已关闭，未加入或更改队列。', 'enable_reviews');
  if (event.type === 'add') {
    if (event.item.nodeRef.workspaceId !== next.workspaceId) return failure('FORBIDDEN', '回顾节点不属于当前工作区。');
    if (next.items.length >= 5) return failure('VALIDATION', '本次队列最多保留五项。', 'remove_queue_item');
    if (next.items.some((item) => item.id === event.item.id || (item.taskId === event.item.taskId && item.nodeRef.objectId === event.item.nodeRef.objectId && item.nodeRef.revision === event.item.nodeRef.revision))) return failure('CONFLICT', '相同任务和节点版本已在队列中。', 'open_existing_item');
    next.items.push({ ...event.item, dueAt: now, status: 'ready' });
    return success(next);
  }
  const item = next.items.find((item) => item.id === event.id);
  if (!item) return failure('CONFLICT', '该回顾项已经移出队列。', 'refresh_queue');
  if (event.type === 'remove') next.items = next.items.filter((item) => item.id !== event.id);
  if (event.type === 'skip') item.status = 'skipped';
  if (event.type === 'defer') {
    if (Date.parse(event.until) <= Date.parse(now)) return failure('VALIDATION', '延后时间需要晚于当前时间。');
    item.dueAt = event.until; item.status = 'deferred';
  }
  return success(next);
}
