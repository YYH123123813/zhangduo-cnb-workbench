import { ConversationSchema } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure } from './result';

export interface Finding { id: string; segmentId: string; start: number; end: number; kind: 'key' | 'credential' | 'private_key' | 'email' | 'phone'; blocking: boolean }
export interface Scan { status: 'clear' | 'review' | 'blocked'; findings: Finding[] }
const patterns: { kind: Finding['kind']; blocking: boolean; pattern: RegExp }[] = [
  { kind: 'private_key', blocking: true, pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g },
  { kind: 'key', blocking: true, pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AKID[A-Za-z0-9]{20,})\b/g },
  { kind: 'credential', blocking: true, pattern: /\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi },
  { kind: 'credential', blocking: true, pattern: /\b(?:password|passwd|api[_-]?key|secret[_-]?key|access[_-]?token|cnb[_-]?token|token)\s*["']?\s*[:=]\s*["']?[^\s"'`]{4,}/gi },
  { kind: 'email', blocking: false, pattern: /\b[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'phone', blocking: false, pattern: /\b(?:1[3-9]\d{9}|(?:\+?1[- .]?)?\d{3}[- .]\d{3}[- .]\d{4})\b/g },
];

export function scanSegments(input: unknown): Result<Scan> {
  const parsed = ConversationSchema.shape.segments.min(1).max(200).safeParse(input);
  if (!parsed.success || parsed.data.reduce((n, s) => n + s.text.length, 0) > 100000) return failure('VALIDATION', '未能完成敏感检测，请缩小或修正范围；暂不能确认。');
  const findings: Finding[] = [];
  for (const segment of parsed.data) {
    for (const rule of patterns) {
      for (const match of segment.text.matchAll(new RegExp(rule.pattern))) {
        const start = match.index;
        const end = start + match[0].length;
        findings.push({ id: `${segment.id}:${start}:${end}:${rule.kind}`, segmentId: segment.id, start, end, kind: rule.kind, blocking: rule.blocking });
      }
    }
  }
  return { ok: true, data: { status: findings.some((f) => f.blocking) ? 'blocked' : findings.length ? 'review' : 'clear', findings } };
}
