import { ConversationSchema, Id, type Conversation } from '../../contracts/domain';
import { z } from 'zod';
import type { Result } from '../../contracts/api';
import { failure } from './result';

export function selectSegments(segments: Conversation['segments'], selectedIds: string[]): Result<Conversation['segments']> {
  if (!ConversationSchema.shape.segments.max(200).safeParse(segments).success || !z.array(Id).min(1).max(200).safeParse(selectedIds).success) return failure('VALIDATION', '至少选择一个片段，最多200个。');
  const ids = new Set(selectedIds);
  if (new Set(segments.map((s) => s.id)).size !== segments.length || ids.size !== selectedIds.length || selectedIds.some((id) => !segments.some((s) => s.id === id))) return failure('VALIDATION', '片段标识重复或已失效，请重新选择。');
  return { ok: true, data: segments.filter((s) => ids.has(s.id)).map((s) => ({ ...s })) };
}
