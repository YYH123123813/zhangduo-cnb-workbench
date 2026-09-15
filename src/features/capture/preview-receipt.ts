import { z } from 'zod';
import { ApprovalSchema, ConversationSchema, TaskContextSchema } from '../../contracts/domain';
import { canonicalJson, hashConversation, normalizeSourceText } from '../../contracts/hash';
import type { Result } from '../../contracts/api';
import type { CapturePreview, PreviewInput } from './preview';
import { prepareContent } from './redaction';
import { failure } from './result';

const PreviewReceiptSchema = z.object({
  conversation: ConversationSchema,
  task: TaskContextSchema,
  approvalRequest: ApprovalSchema.pick({ purpose: true, objectIds: true, contentHash: true, baseRevision: true }),
}).strict();

export async function checkCapturePreview(value: unknown, input: PreviewInput): Promise<Result<CapturePreview>> {
  const invalid = () => failure<CapturePreview>('CONFLICT', '保存预览与选中内容、任务或用途不一致；未登记批准，请重新预览。', 'preview_again');
  const parsed = PreviewReceiptSchema.safeParse(value);
  if (!parsed.success) return invalid();
  const { conversation, task, approvalRequest } = parsed.data;
  const segments = prepareContent(input.segments.map((s) => ({ ...s, text: normalizeSourceText(s.text) })), [], input.personalInfoReviewed);
  if (!segments.ok) return invalid();
  if (conversation.id !== input.conversationId || conversation.taskId !== input.task.id || conversation.origin !== input.source.origin || conversation.state !== 'preview' || conversation.sourceAlreadyPersisted !== (input.source.origin === 'cnb_issue') || conversation.issueNumber !== undefined || conversation.issueUrl !== undefined || canonicalJson(conversation.segments) !== canonicalJson(segments.data)) return invalid();
  if (task.id !== input.task.id || task.workspaceId !== conversation.workspaceId || task.question !== input.task.question.trim() || task.mode !== (input.task.intent === 'propose' ? 'assisted' : 'independent') || canonicalJson(task.constraints) !== canonicalJson(input.task.constraints.filter((item) => item.text.trim())) || task.sourceIssueNumber !== (input.source.origin === 'cnb_issue' ? input.source.issueNumber : undefined)) return invalid();
  if (approvalRequest.purpose !== 'save_conversation' || approvalRequest.baseRevision !== 'new' || approvalRequest.objectIds.length !== 1 || approvalRequest.objectIds[0] !== conversation.id || approvalRequest.contentHash !== conversation.contentHash || await hashConversation(conversation) !== conversation.contentHash) return invalid();
  return { ok: true, data: parsed.data };
}
