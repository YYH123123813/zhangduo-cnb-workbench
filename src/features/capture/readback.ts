import type { Result } from '../../contracts/api';
import { ConversationSchema, type Conversation } from '../../contracts/domain';
import { hashConversation, normalizeSourceText } from '../../contracts/hash';
import { failure } from './result';

export async function checkSavedReceipt(value: unknown, expected: { id: string; workspaceId?: string; contentHash?: string }, signal?: AbortSignal): Promise<Result<Conversation>> {
  const stopped = () => failure<Conversation>('FORBIDDEN', '已停止本次读回；没有新建现场。', 'read_back', 'preserved');
  if (signal?.aborted) return stopped();
  const parsed = ConversationSchema.safeParse(value);
  if (!parsed.success) return failure('UNKNOWN_RESULT', '现场读回结构不完整，请核对原ID。', 'read_back', 'unknown');
  const saved = parsed.data;
  if (saved.id !== expected.id || (expected.workspaceId !== undefined && saved.workspaceId !== expected.workspaceId) || (expected.contentHash !== undefined && saved.contentHash !== expected.contentHash) || saved.state !== 'saved' || !saved.sourceAlreadyPersisted || !saved.issueNumber || new Set(saved.segments.map((s) => s.id)).size !== saved.segments.length || saved.segments.some((s) => normalizeSourceText(s.text) !== s.text) || await hashConversation(saved) !== saved.contentHash) return failure('UNKNOWN_RESULT', '现场身份、保存位置或正文摘要尚未核验；未显示成功。', 'read_back', 'unknown');
  return signal?.aborted ? stopped() : { ok: true, data: saved };
}
