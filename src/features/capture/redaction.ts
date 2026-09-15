import { z } from 'zod';
import { ConversationSchema, Id, type Conversation } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { scanSegments, type Finding } from './privacy';
import { failure } from './result';
import { matchesQuote } from './spans';

type TextRange = { start: number; end: number };
export interface ManualMask { id: string; segmentId: string; text: string }
const ManualMasksSchema = z.array(z.object({ id: Id, segmentId: Id, text: z.string().min(1).max(10000).refine((text) => !!text.trim()) }).strict()).max(50);
export function manualMaskRanges(segments: Conversation['segments'], masks: readonly ManualMask[]): Result<(TextRange & { segmentId: string; maskId: string })[]> {
  const source = ConversationSchema.shape.segments.min(1).max(200).safeParse(segments);
  const parsed = ManualMasksSchema.safeParse(masks);
  if (!source.success || !parsed.success || source.data.reduce((n, s) => n + s.text.length, 0) > 100000 || new Set(source.data.map((s) => s.id)).size !== source.data.length) return failure('VALIDATION', '手动遮盖范围无效；最多50项，每项10000字符。');
  if (new Set(parsed.data.map((m) => m.id)).size !== parsed.data.length || new Set(parsed.data.map((m) => JSON.stringify([m.segmentId, m.text]))).size !== parsed.data.length) return failure('VALIDATION', '该手动遮盖已存在，请核对当前范围。');
  const ranges: (TextRange & { segmentId: string; maskId: string })[] = [];
  for (const entry of parsed.data) {
    const segment = source.data.find((s) => s.id === entry.segmentId);
    if (!segment || !segment.text.includes(entry.text)) return failure('VALIDATION', '手动遮盖未匹配当前片段；请重新核对原文。');
    let start = segment.text.indexOf(entry.text);
    while (start !== -1) {
      const end = start + entry.text.length;
      if (!matchesQuote(segment.text, { start, end, quote: entry.text })) return failure('VALIDATION', '遮盖不能拆开一个完整字符，请重新选择。');
      if (ranges.length >= 5000) return failure('VALIDATION', '匹配范围过多，请使用更完整的文字缩小范围。');
      ranges.push({ start, end, segmentId: segment.id, maskId: entry.id });
      start = segment.text.indexOf(entry.text, start + 1);
    }
  }
  return { ok: true, data: ranges };
}

function mergeRanges(findings: readonly TextRange[]) {
  const ranges: { start: number; end: number }[] = [];
  for (const finding of [...findings].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = ranges[ranges.length - 1];
    if (last && finding.start <= last.end) last.end = Math.max(last.end, finding.end);
    else ranges.push({ start: finding.start, end: finding.end });
  }
  return ranges;
}
function mask(text: string, findings: readonly TextRange[]) {
  const ranges = mergeRanges(findings);
  let output = ''; let cursor = 0;
  for (const range of ranges) { output += text.slice(cursor, range.start) + '[已遮盖]'; cursor = range.end; }
  return output + text.slice(cursor);
}

export function prepareContent(segments: Conversation['segments'], maskedIds: string[], personalInfoReviewed: boolean, manualMasks: readonly ManualMask[] = []): Result<Conversation['segments']> {
  const scan = scanSegments(segments);
  if (!scan.ok) return scan;
  const ids = new Set(maskedIds);
  if (ids.size !== maskedIds.length || maskedIds.some((id) => !scan.data.findings.some((f) => f.id === id))) return failure('VALIDATION', '遮盖范围已失效，请重新核对。');
  const manual = manualMaskRanges(segments, manualMasks);
  if (!manual.ok) return manual;
  const ranges = new Map(segments.map((s) => [s.id, mergeRanges(manual.data.filter((range) => range.segmentId === s.id))]));
  const covered = (finding: Finding) => ids.has(finding.id) || ranges.get(finding.segmentId)?.some((range) => range.start <= finding.start && range.end >= finding.end);
  if (scan.data.findings.some((f) => f.blocking && !covered(f))) return failure('VALIDATION', '疑似密钥必须遮盖或移出范围；未保存、未发送。');
  if (!personalInfoReviewed && scan.data.findings.some((f) => !f.blocking && !covered(f))) return failure('VALIDATION', '保留疑似个人信息前，请明确核对。');
  return { ok: true, data: segments.map((segment) => ({ ...segment, text: mask(segment.text, [...scan.data.findings.filter((f) => f.segmentId === segment.id && ids.has(f.id)), ...ranges.get(segment.id)!]) })) };
}

export function safeDisplayText(text: string): string {
  const scan = scanSegments([{ id: 'display', role: 'source', text }]);
  return scan.ok ? mask(text, scan.data.findings.filter((f) => f.blocking)) : '[检测未完成，原文未展开]';
}
