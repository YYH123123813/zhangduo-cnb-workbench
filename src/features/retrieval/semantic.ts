import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { Id } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import type { SemanticQueryResult } from '../../contracts/retrieval';
import { failure } from './api';
import { SemanticHitsSchema } from './recall';

const StatusSchema = z.object({ hits: SemanticHitsSchema, snapshotRevision: Id, indexRevision: Id.nullable(),
  coverage: z.enum(['current', 'stale', 'partial', 'unavailable']) }).strict();
type Recall = Omit<SemanticQueryResult, 'snapshotRevision'> & { snapshotRevision: string | null };

export async function readSemantic(ctx: RequestContext, query: string, services: Services): Promise<Result<Recall>> {
  try {
    if (services.semanticQueryWithStatus) {
      const response = await services.semanticQueryWithStatus(ctx, query);
      if (!response.ok) return response;
      const parsed = StatusSchema.safeParse(response.data);
      if (parsed.success) return { ok: true, data: parsed.data };
    } else {
      const response = await services.semanticQuery(ctx, query);
      if (!response.ok) return response;
      const parsed = SemanticHitsSchema.safeParse(response.data);
      if (parsed.success) return { ok: true, data: { hits: parsed.data, snapshotRevision: null, indexRevision: null, coverage: 'partial' } };
    }
  } catch { /* Invalid or unavailable semantic data never substitutes for Git originals. */ }
  return failure('UPSTREAM', '语义召回或覆盖状态未通过校验。', 'retry_read', true);
}

export function semanticView(response: Result<Recall>, snapshotRevision: string): Result<Pick<SemanticQueryResult, 'hits' | 'coverage'> & { warning: string }> {
  if (!response.ok) return { ok: true, data: { hits: [], coverage: 'unavailable', warning: '语义召回不可用，当前仅显示 Git 文本结果。' } };
  const recall = response.data;
  if (recall.snapshotRevision !== null && recall.snapshotRevision !== snapshotRevision) {
    return failure('CONFLICT', '语义召回所依据的知识快照已变化。', 'refresh_snapshot');
  }
  let coverage = recall.coverage;
  if (coverage === 'current') coverage = recall.indexRevision === null ? 'partial' : recall.indexRevision === snapshotRevision ? 'current' : 'stale';
  const warnings = {
    current: '平台报告索引覆盖当前快照；正文已从 Git 读取，相似命中不等于来源支持。',
    partial: '语义索引覆盖尚未完整核验，正文已从 Git 快照读取。',
    stale: '语义索引版本过期，正文已从当前 Git 快照读取；可能仍有未召回知识。',
    unavailable: '语义召回不可用，当前仅显示 Git 文本结果。',
  };
  return { ok: true, data: { hits: coverage === 'unavailable' ? [] : recall.hits, coverage, warning: warnings[coverage] } };
}
