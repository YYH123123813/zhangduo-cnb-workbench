import type { Result } from '../../contracts/api';
import type { NavigationProps } from '../../contracts/navigation';
import { canonicalJson, contentHash } from '../../contracts/hash';
import { RecoveryAnchorInputSchema, RecoveryAnchorSchema, type RecoveryAnchor } from '../../contracts/recovery-anchor';

export const recoveryRetentionMs = 86_400_000;
export function validRecoveryLifetime(identity: RecoveryAnchor, now = Date.now()): boolean {
  const created = Date.parse(identity.createdAt), expiry = Date.parse(identity.expiresAt);
  return created <= now && expiry > now && expiry > created && expiry - created <= recoveryRetentionMs && expiry <= now + recoveryRetentionMs;
}

export async function retainAnswerIdentity(retain: NavigationProps['retainOperationRecovery'], scope: {
  operationId: string; contentHash: string; baseRevision: string; actorId: string; workspaceId: string;
}): Promise<Result<RecoveryAnchor>> {
  const unknown = (): Result<RecoveryAnchor> => ({ ok: false, error: { code: 'UNKNOWN_RESULT', retryable: false, dataState: 'unknown',
    message: '原操作身份保留尚未核验；未登记业务批准。请从共享原操作列表只读核验，不要重复保存。', nextAction: 'list_original_recovery_identities' } });
  if (!retain) return unknown();
  const input = RecoveryAnchorInputSchema.safeParse({ feature: 'retrieval', operation: { kind: 'model', operationId: scope.operationId, modelPurpose: 'answer' },
    binding: { contentHash: scope.contentHash, baseRevision: scope.baseRevision }, expiresAt: new Date(Date.now() + recoveryRetentionMs).toISOString(), confirmed: true });
  if (!input.success) return unknown();
  try {
    const response = await retain(input.data);
    if (!response.ok) return unknown();
    const parsed = RecoveryAnchorSchema.safeParse(response.data);
    if (!parsed.success) return unknown();
    const identity = parsed.data;
    if (identity.id !== await contentHash([input.data.feature, input.data.operation]) || identity.feature !== 'retrieval'
      || identity.actorId !== scope.actorId || identity.workspaceId !== scope.workspaceId
      || canonicalJson(identity.operation) !== canonicalJson(input.data.operation) || canonicalJson(identity.binding) !== canonicalJson(input.data.binding)
      || identity.expiresAt !== input.data.expiresAt || !validRecoveryLifetime(identity)) return unknown();
    return { ok: true, data: identity };
  } catch { return unknown(); }
}
