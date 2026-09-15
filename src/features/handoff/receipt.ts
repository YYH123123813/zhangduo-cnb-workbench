import { z } from 'zod';
import { Id } from '../../contracts/domain';
import type { CommitReceipt } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { failure } from './model';
import { safeUrl } from './links';

const ReceiptSchema = z.object({ changeSetId: Id, revision: Id, commitUrl: z.string().url(), indexing: z.enum(['pending', 'current', 'failed']) }).strict();
export function validateReceipt(input: unknown, operationId: string, mode: RequestContext['mode']): Result<CommitReceipt> {
  const parsed = ReceiptSchema.safeParse(input);
  if (!parsed.success || parsed.data.changeSetId !== operationId || !safeUrl(parsed.data.commitUrl) || mode === 'unconfigured' ||
    (mode === 'live' && (!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(parsed.data.revision) || !parsed.data.commitUrl.startsWith('https://')))) {
    return failure('没有取得可核对的提交回执，结果未知。请保留草稿与操作 ID。', 'UNKNOWN_RESULT', 'read_back', 'unknown');
  }
  return { ok: true, data: parsed.data };
}
