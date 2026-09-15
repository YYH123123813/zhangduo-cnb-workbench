import type { ApiResponse, Result } from '../../contracts/api';
import { canonicalJson } from '../../contracts/hash';
import { OperationRecoveryQuerySchema, OperationRecoverySchema, type OperationRecovery } from '../../contracts/operation-recovery';
import { failure } from './result';

export type RecoveryTransport = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;

interface RecoveryIdentity {
  operationId: string;
  actorId?: string;
  workspaceId: string;
  purpose: 'save_conversation' | 'extract';
  requestHash?: string;
  contentHash?: string;
  baseRevision?: string;
  objectIds?: string[];
  approvalId?: string | null;
}

export type CaptureRecoveryIdentity = Omit<RecoveryIdentity, 'purpose' | 'actorId' | 'requestHash' | 'contentHash' | 'baseRevision' | 'objectIds'> & {
  purpose: 'save_conversation'; actorId: string; requestHash: string; contentHash: string; baseRevision: string; objectIds: string[];
};
export type ModelRecoveryIdentity = Omit<RecoveryIdentity, 'purpose'> & { purpose: 'extract' };

const unknownRecovery = <T>(message: string): Result<T> => failure('UNKNOWN_RESULT', message, 'read_original_operation', 'unknown');

function expectedPurpose(identity: RecoveryIdentity) {
  return identity.purpose === 'extract' ? 'extract' : 'save_conversation';
}

function isUnresolved(value: OperationRecovery) {
  return value.stage === 'not_registered' || value.stage === 'unknown';
}

function sameIds(left: string[], right: string[]) {
  return canonicalJson(left) === canonicalJson(right);
}

function matchesRecovery(value: OperationRecovery, identity: RecoveryIdentity): boolean {
  if (value.operationId !== identity.operationId || (identity.actorId !== undefined && value.actorId !== identity.actorId) || value.workspaceId !== identity.workspaceId
    || value.readOnly !== true || value.absenceIsFinal !== false) return false;

  if (isUnresolved(value)) {
    return value.approvalId === null && value.recordId === null && value.purpose === null && value.requestHash === null
      && value.contentHash === null && value.baseRevision === null && value.objectIds.length === 0 && value.approvalExpiresAt === null;
  }

  return value.approvalId !== null && (identity.approvalId === undefined || value.approvalId === identity.approvalId)
    && value.recordId === null && value.purpose === expectedPurpose(identity)
    && (identity.requestHash === undefined || value.requestHash === identity.requestHash)
    && (identity.contentHash === undefined || value.contentHash === identity.contentHash)
    && (identity.baseRevision === undefined || value.baseRevision === identity.baseRevision)
    && (identity.objectIds === undefined || sameIds(value.objectIds, identity.objectIds));
}

async function readRecovery(call: RecoveryTransport, identity: RecoveryIdentity, kind: 'capture' | 'model', signal?: AbortSignal): Promise<Result<OperationRecovery>> {
  const query = kind === 'capture'
    ? OperationRecoveryQuerySchema.safeParse({ kind, operationId: identity.operationId })
    : OperationRecoveryQuerySchema.safeParse({ kind, operationId: identity.operationId, modelPurpose: 'extract' });
  if (!query.success) return unknownRecovery('原操作 ID 无法按共享恢复契约核验；未读取正文或重新执行。');

  const path = kind === 'capture'
    ? `/api/workspace/operation-recovery/capture/${encodeURIComponent(identity.operationId)}`
    : `/api/workspace/operation-recovery/model/${encodeURIComponent(identity.operationId)}?modelPurpose=extract`;
  const init: RequestInit = { method: 'GET', ...(signal ? { signal } : {}) };
  try {
    const response = await call(path, init);
    if (!response.ok) return response;
    const parsed = OperationRecoverySchema.safeParse(response.data);
    if (!parsed.success || parsed.data.kind !== kind || !matchesRecovery(parsed.data, identity))
      return unknownRecovery('共享原操作恢复元数据与身份、用途、摘要、版本或范围不一致；未重新批准、发送或保存。');
    return { ok: true, data: parsed.data };
  } catch {
    return unknownRecovery('共享原操作恢复读取中断；未读取正文，也未推定操作未执行。');
  }
}

export function readCaptureOperationRecovery(call: RecoveryTransport, identity: CaptureRecoveryIdentity, signal?: AbortSignal): Promise<Result<OperationRecovery>> {
  return readRecovery(call, identity, 'capture', signal);
}

export function readModelOperationRecovery(call: RecoveryTransport, identity: ModelRecoveryIdentity, signal?: AbortSignal): Promise<Result<OperationRecovery>> {
  return readRecovery(call, identity, 'model', signal);
}
