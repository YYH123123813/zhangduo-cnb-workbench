import { apiRequest } from '../../app/api-client';
import { canonicalJson, contentHash } from '../../contracts/hash';
import { WorkspaceSessionSchema, type WorkspaceSession } from '../../contracts/session';
import { RecoveryAnchorReadSchema, type RecoveryAnchor, type RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import { readAnswerOperationRecovery, type AnswerCall } from './answer-client';
import { validRecoveryLifetime } from './answer-recovery';

export interface RestoredAnswerState {
  status: 'checking' | 'matched' | 'unknown' | 'mismatch' | 'missing' | 'expired' | 'unauthorized';
  message: string; identity: RecoveryAnchor | null; metadata: OperationRecovery | null;
}
export const restoredAnswerState = (status: RestoredAnswerState['status'], message: string,
  identity: RecoveryAnchor | null = null, metadata: OperationRecovery | null = null): RestoredAnswerState => ({ status, message, identity, metadata });
const mismatch = () => restoredAnswerState('mismatch', '原操作身份、用途、摘要或版本不匹配，未恢复正文。');
const unknown = () => restoredAnswerState('unknown', '原操作仍待核验，未恢复正文，也不能确认未发送。');
const expired = () => restoredAnswerState('expired', '原操作身份或批准已过期，不能据此判断业务操作未发送。');
const unauthorized = () => restoredAnswerState('unauthorized', '请重新核验原工作区身份与回答读取权限。');

async function assess(value: RecoveryAnchorRead, session: WorkspaceSession): Promise<RestoredAnswerState> {
  const parsed = RecoveryAnchorReadSchema.safeParse(value); if (!parsed.success) return mismatch();
  const { identity, original, binding } = parsed.data;
  if (session.actorId !== identity.actorId || session.workspace.id !== identity.workspaceId || session.workspace.visibility !== 'private'
    || !session.scopes.includes('workspace:read') || !session.scopes.includes('model:answer')) return unauthorized();
  if (identity.feature !== 'retrieval' || identity.operation.kind !== 'model' || identity.operation.modelPurpose !== 'answer'
    || !/^[a-f0-9]{64}$/.test(identity.binding.contentHash ?? '') || !identity.binding.baseRevision
    || identity.id !== await contentHash([identity.feature, identity.operation])) return mismatch();
  if (Date.parse(identity.expiresAt) <= Date.now()) return expired();
  if (!validRecoveryLifetime(identity)) return mismatch();
  if (binding === 'mismatch') return mismatch();
  if (!original) return { ...unknown(), identity };
  if (original.kind !== 'model' || original.operationId !== identity.operation.operationId || original.actorId !== identity.actorId
    || original.workspaceId !== identity.workspaceId || original.recordId !== null
    || !['not_registered', 'approved', 'sending', 'unknown', 'done', 'discarded', 'not_sent', 'expired', 'revoked', 'failed'].includes(original.stage)) return mismatch();
  if (['unknown', 'not_registered'].includes(original.stage)) {
    return original.purpose !== null && original.purpose !== 'answer' ? mismatch() : { ...unknown(), identity };
  }
  if (original.purpose !== 'answer' || original.approvalId === null || original.approvalId === original.operationId
    || !/^[a-f0-9]{64}$/.test(original.requestHash ?? '') || original.approvalExpiresAt === null
    || original.contentHash !== identity.binding.contentHash || original.baseRevision !== identity.binding.baseRevision
    || (identity.binding.requestHash !== undefined && original.requestHash !== identity.binding.requestHash)
    || !original.objectIds.length || new Set(original.objectIds).size !== original.objectIds.length) return mismatch();
  if (original.stage === 'expired' || Date.parse(original.approvalExpiresAt) <= Date.now()) return { ...expired(), identity, metadata: original };
  if (binding === 'unknown' || original.stage === 'revoked' || original.stage === 'failed') return { ...unknown(), identity, metadata: original };
  return restoredAnswerState('matched', '原操作元数据已匹配。业务终态仍须原权威回执核验；未恢复回答正文。', identity, original);
}

/** A new page has no query or model input. This controller can only read metadata. */
export function createRestoredAnswerFlow(options: { call?: AnswerCall; onState: (state: RestoredAnswerState) => void }) {
  const call = options.call ?? apiRequest;
  let state = restoredAnswerState('checking', '正在核对原工作区身份');
  let supplied: RecoveryAnchorRead | null = null;
  let controller: AbortController | null = null, disposed = false;
  const publish = (next: RestoredAnswerState) => { if (!disposed) { state = next; options.onState(next); } };
  async function read(refresh: boolean) {
    if (disposed) return;
    controller?.abort(); const current = new AbortController(); controller = current;
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(8000)]);
    const active = () => !disposed && controller === current && !current.signal.aborted;
    const target = supplied;
    publish(restoredAnswerState('checking', '正在核对原工作区身份'));
    if (!target) { publish(restoredAnswerState('missing', '没有可核验的原操作身份，可能已到期或不可读取；未推定未发送。')); return; }
    try {
      const sessionResponse = await call('/api/workspace/session', { method: 'GET', signal });
      if (!active()) return;
      if (!sessionResponse.ok) { publish(['UNAUTHORIZED', 'FORBIDDEN'].includes(sessionResponse.error.code) ? unauthorized() : unknown()); return; }
      const session = WorkspaceSessionSchema.safeParse(sessionResponse.data);
      if (!session.success || sessionResponse.meta.mode !== session.data.workspace.mode) { publish(unauthorized()); return; }
      let checked = await assess(target, session.data);
      if (!active()) return;
      if (['mismatch', 'unauthorized', 'expired'].includes(checked.status)) { publish(checked); return; }
      if (refresh) {
        const response = await call(`/api/workspace/recovery-identities/${encodeURIComponent(target.identity.id)}`, { method: 'GET', signal });
        if (!active()) return;
        if (!response.ok) { publish(['UNAUTHORIZED', 'FORBIDDEN'].includes(response.error.code) ? unauthorized() : unknown()); return; }
        if (response.data === null) { publish(restoredAnswerState('missing', '原操作身份已不可读取，未推定未发送。')); return; }
        const parsed = RecoveryAnchorReadSchema.safeParse(response.data);
        if (!parsed.success || response.meta.mode !== session.data.workspace.mode || canonicalJson(parsed.data.identity) !== canonicalJson(target.identity)) { publish(mismatch()); return; }
        checked = await assess(parsed.data, session.data);
        if (!active()) return;
      }
      if (checked.status !== 'matched' || !checked.metadata || !checked.identity) { publish(checked); return; }
      // The original scope comes from the authenticated shared recovery projection, never a new query.
      const original = checked.metadata;
      const result = await readAnswerOperationRecovery(call, { operationId: original.operationId, actorId: session.data.actorId, workspaceId: session.data.workspace.id,
        requestHash: original.requestHash!, contentHash: original.contentHash!, baseRevision: original.baseRevision!, objectIds: original.objectIds,
        approvalId: original.approvalId, approvalExpiresAt: original.approvalExpiresAt }, signal);
      if (!active()) return;
      if (Date.parse(checked.identity.expiresAt) <= Date.now()) { publish(expired()); return; }
      if (!result.ok) { publish(['UNAUTHORIZED', 'FORBIDDEN'].includes(result.error.code) ? unauthorized() : unknown()); return; }
      const final = await assess({ identity: checked.identity, original: result.data, binding: 'matched', readOnly: true, retryAllowed: false }, session.data);
      if (active()) publish(final);
    } catch { if (active()) publish(unknown()); }
  }
  return {
    get state() { return state; },
    leaveState: () => 'blocked' as const,
    restore(value: RecoveryAnchorRead | null) { supplied = structuredClone(value); return read(false); },
    inspect: () => read(true),
    expire() { if (state.identity && Date.parse(state.identity.expiresAt) <= Date.now()) { controller?.abort(); publish(expired()); } },
    dispose() { disposed = true; controller?.abort(); },
  };
}
