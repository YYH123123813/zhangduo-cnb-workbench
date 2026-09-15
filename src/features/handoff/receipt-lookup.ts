import { apiRequest } from '../../app/api-client';
import type { RequestContext, Result } from '../../contracts/api';
import { Id } from '../../contracts/domain';
import type { CommitReceipt } from '../../contracts/domain';
import { failure } from './model';
import { validateReceipt } from './receipt';

export interface ReceiptLookupResult { receipt: CommitReceipt; mode: RequestContext['mode'] }
export async function lookupReceipt(conversationId: string, operationId: string, read = apiRequest): Promise<Result<ReceiptLookupResult>> {
  if (!Id.safeParse(conversationId).success || !Id.safeParse(operationId).success) return failure('请填写有效的现场 ID 与操作 ID。', 'VALIDATION', 'enter_operation', 'preserved');
  try {
    const response = await read<CommitReceipt>(`/api/handoff/${encodeURIComponent(conversationId)}/receipt?changeSetId=${encodeURIComponent(operationId)}`);
    if (!response.ok) return response;
    const verified = validateReceipt(response.data, operationId, response.meta.mode);
    return verified.ok ? { ok: true, data: { receipt: verified.data, mode: response.meta.mode } } : verified;
  } catch {
    return { ok: false, error: { code: 'UNKNOWN_RESULT', message: '未能读回原操作结果，不能据此判断是否写入。', retryable: true, dataState: 'unknown', nextAction: 'read_back' } };
  }
}
