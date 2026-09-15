import { z } from 'zod';
import { Id, VersionRefSchema, type RetrievalResult } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure } from './api';

const DraftSchema = z.object({ claims: z.array(z.object({ nodeRef: VersionRefSchema,
  sourceId: Id, quote: z.string().min(1).max(1500).refine((text) => text.trim().length > 0),
  text: z.string().min(1).max(4000),
}).strict()).min(1).max(4) }).strict();

export function validateAnswer(value: unknown, result: RetrievalResult): Result<NonNullable<RetrievalResult['answer']>> {
  const invalid = () => failure('VALIDATION', '回答引用未通过节点、版本、来源或原文校验。', 'review_sources');
  const parsed = DraftSchema.safeParse(value);
  if (!parsed.success || result.groups.conflicts.length || result.missingConditions.length) return invalid();
  const seen = new Set<string>();
  for (const claim of parsed.data.claims) {
    const n = result.groups.eligible.find((n) => n.id === claim.nodeRef.objectId && n.workspaceId === claim.nodeRef.workspaceId && n.revision === claim.nodeRef.revision);
    const source = n?.sources.find((s) => s.id === claim.sourceId);
    if (!n || !source || n.confirmation !== 'confirmed' || n.lifecycle !== 'active' || n.evidenceStatus !== 'supported' ||
      result.groups.excludedIds.includes(n.id) || source.kind === 'ai_inference' || source.support !== 'supports' ||
      !source.excerpt.includes(claim.quote) || claim.text !== n.humanStatement || source.supportedClaim !== claim.text) return invalid();
    const key = JSON.stringify([claim.nodeRef, claim.sourceId, claim.quote]);
    if (seen.has(key)) return invalid();
    seen.add(key);
  }
  const conditions = [...new Set(parsed.data.claims.flatMap((claim) => result.groups.eligible.find((n) => n.id === claim.nodeRef.objectId)!.conditions.map((c) => c.text)))];
  const text = ['本次检索范围内的来源化整理：', ...parsed.data.claims.map((claim, i) => `${i + 1}. ${claim.text}`),
    ...(conditions.length ? [`适用条件：${conditions.join('；')}`] : []),
    '引用位置已核对；这不等于独立证明知识正确，也不代表已经掌握。',
    ...(result.coverage !== 'current' ? ['索引覆盖尚未完整核验，不能据此声称没有其他证据或冲突。'] : []),
  ].join('\n');
  return { ok: true, data: { text, citations: parsed.data.claims.map(({ nodeRef, sourceId, quote }) => ({ nodeRef, sourceId, quote })) } };
}
