import { CandidateSchema, SourceSpanSchema, type Candidate, type Conversation } from '../../contracts/domain';
import { contentHash, hashConversation, hashSegment } from '../../contracts/hash';
import type { Result } from '../../contracts/api';
import type { DecodedCandidates } from './candidates';
import { failure } from './result';

function boundary(text: string, offset: number) {
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!));
}
export function matchesQuote(text: string, span: { start: number; end: number; quote: string }) {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= text.length && boundary(text, span.start) && boundary(text, span.end) && text.slice(span.start, span.end) === span.quote;
}

export async function buildCandidates(conversation: Conversation, allowedIds: string[], decoded: DecodedCandidates, promptVersion: string, signal?: AbortSignal): Promise<Result<Candidate[]>> {
  const invalid = () => failure<Candidate[]>('UPSTREAM', '候选引用不存在、超出授权范围或与原文不符；没有保存候选。', 'continue_manually', 'preserved');
  if (signal?.aborted) return failure('FORBIDDEN', '已停止后续候选处理；现场仍保留。', 'continue_manually', 'preserved');
  if (await hashConversation(conversation) !== conversation.contentHash) return failure('CONFLICT', '来源正文已经改变，旧候选不能继续使用。', 'preview_again', 'preserved');
  if (decoded.proposals.length > 3) return invalid();
  const candidates: Candidate[] = [];
  for (const proposal of decoded.proposals) {
    const spans: Candidate['spans'] = [];
    for (const proposed of proposal.spans) {
      const segment = conversation.segments.find((s) => s.id === proposed.segmentId);
      if (!segment || !allowedIds.includes(segment.id) || !matchesQuote(segment.text, proposed)) return invalid();
      const sourceHash = await hashSegment(conversation.id, segment);
      const span = { ...proposed, conversationId: conversation.id, contentHash: sourceHash, id: `span-${await contentHash({ conversationId: conversation.id, segmentId: segment.id, start: proposed.start, end: proposed.end, contentHash: sourceHash })}` };
      if (!SourceSpanSchema.safeParse(span).success) return invalid();
      if (!spans.some((s) => s.id === span.id)) spans.push(span);
    }
    const id = `candidate-${await contentHash({ conversationId: conversation.id, conversationHash: conversation.contentHash, proposal, modelId: decoded.modelId, promptVersion })}`;
    const candidate = CandidateSchema.safeParse({
      ...proposal, id, conversationId: conversation.id, spans,
      sources: spans.map((span) => ({ id: span.id, kind: 'conversation', title: '选中对话片段', excerpt: span.quote, accessedAt: new Date().toISOString(), support: 'unverified', supportedClaim: proposal.claim, limitation: '只核验原话出现；不代表主张已获独立来源支持。' })),
      modelId: decoded.modelId, promptVersion, generatedAt: decoded.generatedAt, state: 'proposed',
    });
    if (!candidate.success) return invalid();
    if (!candidates.some((c) => c.id === id)) candidates.push(candidate.data);
  }
  if (signal?.aborted) return failure('FORBIDDEN', '已停止后续候选处理；现场仍保留。', 'continue_manually', 'preserved');
  return { ok: true, data: candidates };
}

export async function checkStoredCandidates(conversation: Conversation, input: unknown): Promise<Result<Candidate[]>> {
  const parsed = CandidateSchema.array().max(3).safeParse(input);
  if (!parsed.success || new Set(parsed.data.map((c) => c.id)).size !== parsed.data.length) return failure('UPSTREAM', '已存候选结构不完整；请保留现场并手动交接。', 'continue_manually', 'preserved');
  for (const candidate of parsed.data) {
    if (candidate.conversationId !== conversation.id) return failure('FORBIDDEN', '候选不属于当前现场。', 'check_conversation', 'preserved');
    for (const span of candidate.spans) {
      const segment = conversation.segments.find((s) => s.id === span.segmentId);
      if (!segment || span.conversationId !== conversation.id || !matchesQuote(segment.text, span) || span.contentHash !== await hashSegment(conversation.id, segment)) return failure('CONFLICT', '候选引用已过期或不能核对；请重新检查来源。', 'review_source', 'preserved');
    }
  }
  return { ok: true, data: parsed.data };
}
