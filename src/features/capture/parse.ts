import type { Conversation } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure } from './result';
import { normalizeSourceText } from '../../contracts/hash';

export type SourceDraft = Pick<Conversation, 'id' | 'origin' | 'segments' | 'sourceAlreadyPersisted' | 'createdAt' | 'issueNumber' | 'issueUrl'> & { sourceRevision?: string };
export interface ParsedText { rawText: string; segments: Conversation['segments']; warnings: string[] }

export function parseText(rawText: string, sourceId: string): Result<ParsedText> {
  if (!rawText.trim()) return failure('VALIDATION', '尚无文本；可以继续保留空草稿。');
  if (rawText.length > 100000 || !sourceId || sourceId.length > 100) return failure('VALIDATION', '文本最多100000字符，请缩小本次范围。');
  const normalized = normalizeSourceText(rawText);
  const segments: Conversation['segments'] = [];
  const warnings: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  // Retain marker lines and newlines so concatenating segments reproduces the normalized input.
  for (const line of normalized.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const insideFence = !!fence;
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[0]!, length: delimiter.length };
      else if (delimiter[0] === fence.marker && delimiter.length >= fence.length && line.trim() === delimiter) fence = undefined;
    }
    const marker = !insideFence && !delimiter ? /^(?:#{1,6}\s+)?(?:\*\*)?(user|human|用户|人|assistant|ai|助手|source|来源)(?:\*\*)?(?:\s*[:：]|\s*$)/i.exec(line) : null;
    const label = marker?.[1]?.toLowerCase();
    const role = label && /^(user|human|用户|人)$/.test(label) ? 'user' : label && /^(assistant|ai|助手)$/.test(label) ? 'assistant' : 'source';
    if (marker || !segments.length) segments.push({ id: `${sourceId}/s${segments.length + 1}`, role, text: line });
    else segments[segments.length - 1]!.text += line;
  }
  if (segments.length > 200) return failure('VALIDATION', '本次超过200个片段，请拆分导入；未截断原文。');
  if (segments.some((segment) => segment.role === 'source')) warnings.push('部分角色不明确，已保留为来源，可逐段修正。');
  if (rawText.includes('\uFFFD') || rawText.includes('\0')) warnings.push('文本包含疑似乱码，请核对原文后再确认。');
  return { ok: true, data: { rawText, segments, warnings } };
}
