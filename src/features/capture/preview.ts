import { z } from 'zod';
import { ConversationSchema, Id, type Conversation, type TaskContext } from '../../contracts/domain';
import { hashConversation, normalizeSourceText } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { TaskDraftSchema, frameTask } from './task';
import { selectSegments } from './scope';
import { prepareContent } from './redaction';
import { failure } from './result';
import type { ApprovalRequest } from './approval';

export const PreviewInputSchema = z.object({
  conversationId: Id, task: TaskDraftSchema,
  source: z.discriminatedUnion('origin', [z.object({ origin: z.literal('paste') }).strict(), z.object({ origin: z.literal('manual') }).strict(), z.object({ origin: z.literal('cnb_issue'), issueNumber: z.number().int().positive(), sourceRevision: Id }).strict()]),
  segments: ConversationSchema.shape.segments.min(1).max(200), personalInfoReviewed: z.boolean(), scopeConfirmed: z.literal(true),
}).strict();
export type PreviewInput = z.infer<typeof PreviewInputSchema>;
export interface CapturePreview { conversation: Conversation; task: TaskContext; approvalRequest: ApprovalRequest }

export async function previewCapture(input: PreviewInput, ctx: RequestContext, services: Services): Promise<Result<CapturePreview>> {
  if (!ctx.scopes.includes(SCOPES.conversationWrite)) return failure('FORBIDDEN', '缺少现场保存权限；未生成写入批准。');
  const task = frameTask(input.task, ctx, new Date().toISOString());
  if (!task.ok) return task;
  if (!task.data) return failure('VALIDATION', '问题为空，可以保留本地草稿；保存前请填写当前问题。');
  const chosen = selectSegments(input.segments, input.segments.map((s) => s.id));
  if (!chosen.ok) return chosen;
  const prepared = prepareContent(chosen.data.map((s) => ({ ...s, text: normalizeSourceText(s.text) })), [], input.personalInfoReviewed);
  if (!prepared.ok) return prepared;
  if (!prepared.data.some((s) => s.text.trim())) return failure('VALIDATION', '所选内容为空，请重新选择。');
  if (input.source.origin === 'cnb_issue') {
    if (!ctx.scopes.includes(SCOPES.conversationRead)) return failure('FORBIDDEN', '缺少Issue读取权限。');
    const current = await services.readIssue(ctx, input.source.issueNumber);
    if (!current.ok) return current;
    if (current.data.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', '来源不属于当前工作区。');
    if (current.data.issueNumber !== input.source.issueNumber || current.data.contentHash !== input.source.sourceRevision || prepared.data.some((s) => !current.data.segments.some((original) => original.id === s.id))) return failure('CONFLICT', '来源Issue已改变，请重新读取并核对范围。');
    task.data.sourceIssueNumber = input.source.issueNumber;
  }
  const conversation: Conversation = {
    id: input.conversationId, workspaceId: ctx.workspaceId, taskId: task.data.id, origin: input.source.origin,
    sourceAlreadyPersisted: input.source.origin === 'cnb_issue', segments: prepared.data,
    contentHash: 'pending', createdAt: new Date().toISOString(), state: 'preview',
  };
  conversation.contentHash = await hashConversation(conversation);
  return { ok: true, data: { conversation, task: task.data, approvalRequest: { purpose: 'save_conversation', objectIds: [conversation.id], contentHash: conversation.contentHash, baseRevision: 'new' } } };
}
