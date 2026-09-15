import type { ApiError, RequestContext, Result } from '../../contracts/api';
import { unavailable } from '../../contracts/api';
import { KnowledgeApprovalStateSchema } from '../../contracts/approval';
import type { KnowledgeApprovalState } from '../../contracts/approval';
import type { CommitReceipt } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { SCOPES } from '../../contracts/scopes';
import { checkApprovalBinding } from './commit';
import { validateReceipt } from './receipt';
import type { OriginalPreviewKey } from './original-preview';
import type { HandoffPreview } from './preview';

export interface OriginalRecoveryState {
  key: OriginalPreviewKey;
  phase: 'reading' | 'read_only' | 'committed' | 'unavailable' | 'cancelled';
  preview: HandoffPreview | null;
  approval: KnowledgeApprovalState | null;
  receipt: CommitReceipt | null;
  commitState: 'unknown' | 'saved' | 'rejected';
  canSubmit: false;
  error: ApiError | null;
}
export function beginOriginalRecovery(key: OriginalPreviewKey): OriginalRecoveryState {
  return { key: structuredClone(key), phase: 'reading', preview: null, approval: null, receipt: null,
    commitState: 'unknown', canSubmit: false, error: null };
}
const uncertain = (nextAction = 'read_original_operation'): ApiError => ({ code: 'UNKNOWN_RESULT', message: 'The original operation is still unverified; no mutation has been retried.',
  retryable: false, dataState: 'unknown', nextAction });
function restricted(state: OriginalRecoveryState, error: ApiError): OriginalRecoveryState {
  return { ...beginOriginalRecovery(state.key), phase: 'unavailable', error };
}
function accessError(state: OriginalRecoveryState, ctx: RequestContext): ApiError | null {
  const scopes = [SCOPES.draftRead, SCOPES.conversationRead, SCOPES.knowledgeRead,
    ...(state.preview?.draft.candidateId ? [SCOPES.candidateRead] : [])];
  return state.key.actorId !== ctx.actorId || state.key.workspaceId !== ctx.workspaceId || ctx.mode === 'unconfigured' ||
    scopes.some((scope) => !ctx.scopes.includes(scope)) ? { code: 'FORBIDDEN', message: 'Original content access has changed.',
      retryable: false, dataState: 'preserved', nextAction: 'request_access' } : null;
}

// Accept only the result of verifyOriginalPreview; this state never grants permission to submit.
export function acceptOriginalPreview(state: OriginalRecoveryState, result: Result<HandoffPreview>): OriginalRecoveryState {
  if (state.phase === 'cancelled') return state;
  if (!result.ok) return restricted(state, result.error);
  const { changes, draft } = result.data;
  if (changes.id !== state.key.changeSetId || changes.contentHash !== state.key.contentHash || changes.baseRevision !== state.key.baseRevision ||
    changes.workspaceId !== state.key.workspaceId || draft.id !== state.key.draftId || draft.conversationId !== state.key.conversationId) {
    return restricted(state, uncertain('read_original_preview'));
  }
  return { ...beginOriginalRecovery(state.key), phase: 'read_only', preview: structuredClone(result.data) };
}
export function cancelOriginalRecovery(state: OriginalRecoveryState): OriginalRecoveryState {
  return { ...beginOriginalRecovery(state.key), phase: 'cancelled' };
}

export async function reconcileOriginalFacts(state: OriginalRecoveryState, approvalRead: Result<KnowledgeApprovalState>,
  commitRead: Result<CommitReceipt | null>, ctx: RequestContext, now: number): Promise<OriginalRecoveryState> {
  if (state.phase === 'cancelled' || state.phase === 'unavailable' || !state.preview) return state;
  const denied = accessError(state, ctx);
  if (denied) return restricted(state, denied);
  for (const result of [approvalRead, commitRead]) {
    if (!result.ok && ['FORBIDDEN', 'UNAUTHORIZED'].includes(result.error.code)) return restricted(state, result.error);
  }
  const next: OriginalRecoveryState = { ...state, phase: 'read_only', approval: null, receipt: null, commitState: 'unknown', error: null };
  if (!approvalRead.ok) next.error = { ...approvalRead.error, dataState: 'unknown' };
  else {
    const parsed = KnowledgeApprovalStateSchema.safeParse(approvalRead.data);
    if (!parsed.success || parsed.data.changeSetId !== state.key.changeSetId || parsed.data.actorId !== state.key.actorId ||
      parsed.data.workspaceId !== state.key.workspaceId) return { ...next, error: uncertain('check_approval') };
    const approval = parsed.data;
    if (approval.approval) {
      const checked = await checkApprovalBinding(state.preview.changes, approval.approval, ctx, now, approval.status !== 'registered');
      if (!checked.ok || (approval.status === 'expired' && Date.parse(approval.approval.expiresAt) > now)) return { ...next, error: uncertain('check_approval') };
    }
    next.approval = approval;
  }
  // Approval availability cannot erase a separately verified, immutable Git result.
  const prior = state.commitState === 'saved' && state.receipt ? validateReceipt(state.receipt, state.key.changeSetId, ctx.mode) : null;
  if (prior?.ok && (!commitRead.ok || !commitRead.data)) {
    return { ...next, phase: 'committed', commitState: 'saved', receipt: prior.data,
      error: next.error ?? (commitRead.ok ? uncertain('read_back') : { ...commitRead.error, dataState: 'unknown' }) };
  }
  if (!commitRead.ok) {
    const error = commitRead.error;
    if (error.code === 'CONFLICT' && error.dataState === 'preserved' && error.nextAction === 'preview_again') {
      return { ...next, commitState: 'rejected', error };
    }
    return { ...next, error: { ...error, dataState: 'unknown' } };
  }
  if (!commitRead.data) return { ...next, error: next.error ?? uncertain('read_back') };
  const receipt = validateReceipt(commitRead.data, state.key.changeSetId, ctx.mode);
  if (!receipt.ok) return { ...next, error: receipt.error };
  return { ...next, phase: 'committed', commitState: 'saved', receipt: receipt.data };
}

export async function readOriginalFacts(state: OriginalRecoveryState,
  services: Pick<Services, 'readKnowledgeApproval' | 'readCommit'>, ctx: RequestContext, now: number): Promise<OriginalRecoveryState> {
  if (state.phase === 'cancelled' || state.phase === 'unavailable' || !state.preview) return state;
  const denied = accessError(state, ctx);
  if (denied) return restricted(state, denied);
  async function read<T>(action: (() => Promise<Result<T>>) | undefined): Promise<Result<T>> {
    if (!action) return unavailable('Original operation read port is not configured.');
    try { return await action(); } catch { return { ok: false, error: uncertain() }; }
  }
  const [approval, commit] = await Promise.all([
    read(services.readKnowledgeApproval ? () => services.readKnowledgeApproval!(ctx, state.key.changeSetId) : undefined),
    read(services.readCommit ? () => services.readCommit!(ctx, state.key.changeSetId) : undefined),
  ]);
  return reconcileOriginalFacts(state, approval, commit, ctx, now);
}
