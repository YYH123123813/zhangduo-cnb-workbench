import { z } from 'zod';
import { ApprovalSchema, ConversationSchema, Id, type Conversation } from '../../contracts/domain';
import { SCOPES } from '../../contracts/scopes';
import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { checkConversation } from './conversation';
import { checkApprovalBinding } from './approval';
import { failure } from './result';

export const SaveInputSchema = z.object({ conversation: ConversationSchema, approval: ApprovalSchema, confirmed: z.literal(true) }).strict();

export async function readSavedConversation(services: Services, ctx: RequestContext, id: string): Promise<Result<Conversation>> {
  if (!ctx.scopes.includes(SCOPES.conversationRead)) return failure('FORBIDDEN', '缺少现场读取权限。');
  if (!Id.safeParse(id).success) return failure('VALIDATION', '现场ID无效。');
  const read = await services.readConversation(ctx, id);
  if (!read.ok) return read;
  if (read.data.id !== id) return failure('CONFLICT', '返回了不同现场；请核对操作ID。', 'read_back', 'unknown');
  const checked = await checkConversation(read.data, ctx, 'saved');
  if (!checked.ok) return checked;
  if (!checked.data.sourceAlreadyPersisted || !checked.data.issueNumber) return failure('UNKNOWN_RESULT', '尚无经核验的CNB保存位置。', 'read_back', 'unknown');
  return checked;
}

export async function saveCapture(services: Services, ctx: RequestContext, input: z.infer<typeof SaveInputSchema>): Promise<Result<Conversation>> {
  if (![SCOPES.conversationWrite, SCOPES.conversationRead].every((scope) => ctx.scopes.includes(scope))) return failure('FORBIDDEN', '保存现场需要写入与读回权限。');
  const conversation = await checkConversation(input.conversation, ctx, 'preview');
  if (!conversation.ok) return conversation;
  const valid = checkApprovalBinding(input.approval, { purpose: 'save_conversation', objectIds: [conversation.data.id], contentHash: conversation.data.contentHash, baseRevision: 'new' }, ctx);
  if (!valid.ok) return valid;
  const saved = await services.saveConversation(ctx, conversation.data, valid.data);
  if (!saved.ok) return saved;
  if (saved.data.id !== conversation.data.id || saved.data.contentHash !== conversation.data.contentHash || saved.data.workspaceId !== ctx.workspaceId || saved.data.state !== 'saved') return failure('UNKNOWN_RESULT', '保存回执不匹配，需要读回核验。', 'read_back', 'unknown');
  const verified = await readSavedConversation(services, ctx, conversation.data.id);
  if (!verified.ok) return { ok: false, error: { ...verified.error, dataState: 'unknown', nextAction: 'read_back' } };
  if (verified.data.contentHash !== conversation.data.contentHash) return failure('CONFLICT', '远端正文与批准内容不一致。', 'read_back', 'unknown');
  return verified;
}
