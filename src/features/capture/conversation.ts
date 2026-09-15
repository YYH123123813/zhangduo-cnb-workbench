import { ConversationSchema, type Conversation } from '../../contracts/domain';
import { hashConversation, normalizeSourceText } from '../../contracts/hash';
import type { RequestContext, Result } from '../../contracts/api';
import { scanSegments } from './privacy';
import { failure } from './result';

export async function checkConversation(input: unknown, ctx: RequestContext, state: 'preview' | 'saved'): Promise<Result<Conversation>> {
  const parsed = ConversationSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '现场结构无效，请重新预览。');
  const conversation = parsed.data;
  if (conversation.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', '现场不属于当前工作区。');
  if (state === 'preview' && !conversation.segments.some((s) => s.text.trim())) return failure('VALIDATION', '现场内容为空，请重新选择。');
  if (conversation.state !== state) return failure('CONFLICT', state === 'saved' ? '尚未核验现场已保存。' : '只能确认新的现场预览。', state === 'saved' ? 'read_back' : 'preview_again', state === 'saved' ? 'unknown' : 'not_written');
  if (new Set(conversation.segments.map((s) => s.id)).size !== conversation.segments.length || conversation.segments.some((s) => normalizeSourceText(s.text) !== s.text)) return failure('VALIDATION', '片段标识或文本规范化不一致。');
  const scan = scanSegments(conversation.segments);
  if (!scan.ok) return scan;
  if (state === 'preview' && scan.data.status === 'blocked') return failure('VALIDATION', '仍有疑似密钥；未保存、未发送。');
  if (await hashConversation(conversation) !== conversation.contentHash) return failure('CONFLICT', '正文与预览摘要不一致，请重新预览。', 'preview_again');
  return { ok: true, data: conversation };
}
