import type { RequestContext, Result } from '../../contracts/api';
import { canonicalJson, contentHash, hashEvidence } from '../../contracts/hash';
import type { NavigationProps } from '../../contracts/navigation';
import { RecoveryAnchorInputSchema, RecoveryAnchorReadSchema, RecoveryAnchorSchema, type RecoveryAnchor, type RecoveryAnchorInput, type RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import { TaskSaveRequestSchema, type TaskSaveRequest } from '../../contracts/task-record';
import type { EvidenceStoragePreview } from './application-api';
import { TrustedReviewRequestSchema, type ReviewRequest } from './review-api';
import { failure, success } from './errors';
import type { LearningRecoveryIdentity, LearningRecoveryTransport } from './operation-recovery';

type Retain = NavigationProps['retainOperationRecovery'];
const unknown = <T>(): Result<T> => failure('UNKNOWN_RESULT', '原恢复身份或摘要尚未核验；没有继续批准、发送或重试。', 'read_original_operation', 'unknown');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function validAnchor(anchor: RecoveryAnchor, identity: LearningRecoveryIdentity, now: number) {
  return anchor.feature === 'learning' && anchor.actorId === identity.actorId && anchor.workspaceId === identity.workspaceId
    && Date.parse(anchor.expiresAt) > now && Date.parse(anchor.createdAt) <= now
    && Date.parse(anchor.expiresAt) - Date.parse(anchor.createdAt) <= 86_400_000
    && RecoveryAnchorInputSchema.safeParse({ feature: anchor.feature, operation: anchor.operation, binding: anchor.binding, expiresAt: anchor.expiresAt, confirmed: true }).success;
}

export async function retainLearningRecovery(retain: Retain, identity: LearningRecoveryIdentity, input: unknown, now = Date.now()): Promise<Result<RecoveryAnchor>> {
  const startedAt = Date.now();
  const parsed = RecoveryAnchorInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.feature !== 'learning' || Date.parse(parsed.data.expiresAt) <= now || Date.parse(parsed.data.expiresAt) > now + 86_400_000) {
    return failure('VALIDATION', '请另行确认原操作最小身份的保留期限，最长 24 小时。', 'confirm_recovery_retention');
  }
  if (!retain) return failure('NOT_IMPLEMENTED', '当前页面未连接恢复身份保留端口，未继续本次操作。');
  try {
    const result = await retain(parsed.data);
    if (!result.ok) return result;
    const saved = RecoveryAnchorSchema.safeParse(result.data);
    if (!saved.success || !validAnchor(saved.data, identity, now + Math.max(0, Date.now() - startedAt))
      || saved.data.expiresAt !== parsed.data.expiresAt || !same(saved.data.operation, parsed.data.operation) || !same(saved.data.binding, parsed.data.binding)) return unknown();
    return success(saved.data);
  } catch { return unknown(); }
}

function checkedRead(input: unknown, identity: LearningRecoveryIdentity, now: number): Result<RecoveryAnchorRead> {
  const parsed = RecoveryAnchorReadSchema.safeParse(input);
  if (!parsed.success || !validAnchor(parsed.data.identity, identity, now)) return unknown();
  const { identity: anchor, original, binding } = parsed.data;
  if (binding === 'matched' && !original) return unknown();
  if (original) {
    if (original.actorId !== anchor.actorId || original.workspaceId !== anchor.workspaceId || original.operationId !== anchor.operation.operationId
      || original.kind !== anchor.operation.kind || (anchor.operation.kind === 'model' && original.purpose !== null && original.purpose !== 'review')) return unknown();
    for (const [key, expected] of Object.entries(anchor.binding)) {
      const actual = original[key as keyof RecoveryAnchor['binding']];
      if (actual != null && actual !== expected || binding === 'matched' && actual !== expected) return unknown();
    }
    if (binding === 'matched' && ['not_registered', 'unknown'].includes(original.stage)) return unknown();
  }
  return success(parsed.data);
}

/** Refreshes only the consented identity. Metadata is never a business receipt. */
export async function readLearningRecoveryAnchor(transport: LearningRecoveryTransport, identity: Pick<RequestContext, 'actorId' | 'workspaceId'>, supplied: unknown, now = Date.now()): Promise<Result<RecoveryAnchorRead>> {
  const startedAt = Date.now();
  const checked = checkedRead(supplied, identity, now);
  if (!checked.ok) return checked;
  try {
    const result = await transport(`/api/workspace/recovery-identities/${checked.data.identity.id}`);
    if (!result.ok) return result;
    if (result.data === null) return failure('FORBIDDEN', '原恢复身份已到期或当前无权读取，未恢复正文。', 'connect_original_workspace');
    const fresh = checkedRead(result.data, identity, now + Math.max(0, Date.now() - startedAt));
    return fresh.ok && !same(fresh.data.identity, checked.data.identity) ? unknown() : fresh;
  } catch { return unknown(); }
}

export async function taskRecoveryInput(request: TaskSaveRequest, expiresAt: string): Promise<RecoveryAnchorInput> {
  const original = TaskSaveRequestSchema.parse(request);
  return { feature: 'learning', operation: { kind: 'task', operationId: original.operationId }, binding: { requestHash: await contentHash(original) }, expiresAt, confirmed: true };
}
export async function reviewRecoveryInput(request: ReviewRequest, expiresAt: string): Promise<RecoveryAnchorInput> {
  const { action: _action, ...original } = TrustedReviewRequestSchema.parse(request);
  return { feature: 'learning', operation: { kind: 'review', operationId: original.operationId }, binding: { requestHash: await contentHash(original) }, expiresAt, confirmed: true };
}
export async function evidenceRecoveryInput(preview: EvidenceStoragePreview, expiresAt: string): Promise<RecoveryAnchorInput> {
  return { feature: 'learning', operation: { kind: 'evidence', operationId: preview.operationId },
    binding: { contentHash: await hashEvidence(preview.record), baseRevision: preview.baseRevision }, expiresAt, confirmed: true };
}
export function modelReviewRecoveryInput(operationId: string, original: { contentHash: string; baseRevision: string }, expiresAt: string): RecoveryAnchorInput {
  return RecoveryAnchorInputSchema.parse({ feature: 'learning', operation: { kind: 'model', operationId, modelPurpose: 'review' },
    binding: { contentHash: original.contentHash, baseRevision: original.baseRevision }, expiresAt, confirmed: true });
}
