import { z } from 'zod';
import { CandidateSchema, Id, Timestamp } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { scanSegments } from './privacy';
import { failure } from './result';

export const ProposedSpanSchema = z.object({ segmentId: Id, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(24000) }).strict();
export const ProposedContentSchema = CandidateSchema.pick({ title: true, question: true, claim: true, kind: true, whyKeep: true, uncertainties: true }).extend({
  title: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(4000), claim: z.string().trim().min(1).max(8000),
  whyKeep: z.string().trim().min(1).max(2000), uncertainties: z.array(z.string().max(2000)).max(12), spans: z.array(ProposedSpanSchema).min(1).max(12),
}).strict();
export type ProposedContent = z.infer<typeof ProposedContentSchema>;
export interface DecodedCandidates { proposals: ProposedContent[]; modelId: string; generatedAt: string }

export function decodeCandidates(response: { value: unknown; modelId: string; generatedAt: string }): Result<DecodedCandidates> {
  const invalid = () => failure<DecodedCandidates>('UPSTREAM', '模型候选结构、数量或来源信息无效；现场已保留，候选未保存。', 'continue_manually', 'preserved');
  if (!Id.safeParse(response.modelId).success || !Timestamp.safeParse(response.generatedAt).success) return invalid();
  let value = response.value;
  if (typeof value === 'string') {
    if (value.length > 64000) return invalid();
    try { value = JSON.parse(value); } catch { return invalid(); }
  }
  const parsed = z.object({ candidates: z.array(ProposedContentSchema).max(3) }).strict().safeParse(value);
  if (!parsed.success) return invalid();
  if (parsed.data.candidates.length) {
    const scan = scanSegments(parsed.data.candidates.map((candidate, i) => ({ id: `candidate-check-${i}`, role: 'source', text: [candidate.title, candidate.question, candidate.claim, candidate.whyKeep, ...candidate.uncertainties, ...candidate.spans.map((s) => s.quote)].join('\n') })));
    if (!scan.ok || scan.data.status === 'blocked') return invalid();
  }
  return { ok: true, data: { proposals: parsed.data.candidates, modelId: response.modelId, generatedAt: response.generatedAt } };
}
