import { apiRequest } from '../../app/api-client';
import type { RequestContext, Result } from '../../contracts/api';
import { Id } from '../../contracts/domain';
import { HandoffOperationReceiptSchema } from '../../contracts/handoff-operation';
import type { HandoffOperationReceipt, HandoffOperationSaveRequest, HandoffOperationState } from '../../contracts/handoff-operation';
import { contentHash, hashChangeSet } from '../../contracts/hash';
import { failure } from './model';
import { verifyOperationEnvelope } from './operation';
import type { OriginalOperationView } from './operation';
import { validateReceipt } from './receipt';

type Identity = Pick<RequestContext, 'actorId' | 'workspaceId'>;
const unknown = <T>() => failure<T>('原操作仍待核验；没有重发保存、批准或 Git 提交。', 'UNKNOWN_RESULT', 'read_original_operation', 'unknown');

async function verifySave(input: HandoffOperationSaveRequest, identity: Identity, state: HandoffOperationState,
  mode: RequestContext['mode'], request: typeof apiRequest): Promise<Result<HandoffOperationReceipt>> {
  const receipt = await request<HandoffOperationReceipt | null>(`/api/workspace/handoff-operation-receipts/${encodeURIComponent(input.changes.id)}`);
  if (!receipt.ok) return receipt;
  if (receipt.meta.mode !== mode) return unknown();
  const verified = await verifyOperationEnvelope(state, receipt.data, { ...identity, mode }, input.draft.conversationId, input.changes.id, Date.now());
  if (!verified.ok) return verified;
  if (verified.data.receipt.requestHash !== await contentHash(input)) return unknown();
  return { ok: true, data: verified.data.receipt };
}

export async function saveOperationSnapshot(input: HandoffOperationSaveRequest, identity: Identity,
  request: typeof apiRequest = apiRequest): Promise<Result<HandoffOperationReceipt>> {
  try {
    const saved = await request<HandoffOperationState>('/api/workspace/handoff-operations', { method: 'POST', body: JSON.stringify(input) });
    if (!saved.ok) return saved;
    const verified = await verifySave(input, identity, saved.data, saved.meta.mode, request);
    return verified.ok ? verified : { ok: false, error: { ...verified.error, dataState: 'unknown', nextAction: 'read_original_operation' } };
  } catch { return unknown(); }
}

export async function readSavedOperation(input: HandoffOperationSaveRequest, identity: Identity,
  request: typeof apiRequest = apiRequest): Promise<Result<HandoffOperationReceipt>> {
  try {
    const saved = await request<HandoffOperationState>(`/api/workspace/handoff-operations/${encodeURIComponent(input.changes.id)}`);
    if (!saved.ok) return saved;
    return await verifySave(input, identity, saved.data, saved.meta.mode, request);
  } catch { return unknown(); }
}

export interface OriginalLookupResult { view: OriginalOperationView; mode: RequestContext['mode'] }
export interface OriginalLookupBinding {
  draftId?: string; source?: string; operationHash?: string; actorId?: string; workspaceId?: string;
}
export async function lookupOriginalOperation(conversationId: string, operationId: string,
  request: typeof apiRequest = apiRequest, expected: OriginalLookupBinding = {}): Promise<Result<OriginalLookupResult>> {
  if (!Id.safeParse(conversationId).success || !Id.safeParse(operationId).success) return failure('需要原现场和提交操作 ID。');
  const mismatch = () => failure<OriginalLookupResult>('原预览与地址中的身份、来源、版本摘要或期限不一致，未展示正文。', 'CONFLICT', 'read_original_operation', 'preserved');
  if ((expected.draftId !== undefined && !Id.safeParse(expected.draftId).success) ||
    (expected.source !== undefined && !['candidate', 'manual'].includes(expected.source)) ||
    (expected.operationHash !== undefined && !/^[a-f0-9]{64}$/.test(expected.operationHash))) return mismatch();
  try {
    const read = await request<OriginalOperationView>(`/api/handoff/${encodeURIComponent(conversationId)}/operation?changeSetId=${encodeURIComponent(operationId)}`);
    if (!read.ok) return read;
    const { recovery, storage } = read.data;
    const proof = HandoffOperationReceiptSchema.safeParse(storage);
    if (!proof.success || read.meta.mode === 'unconfigured' || recovery.canSubmit !== false ||
      recovery.key.actorId !== proof.data.actorId || recovery.key.workspaceId !== proof.data.workspaceId ||
      recovery.key.changeSetId !== operationId || proof.data.operationId !== operationId || proof.data.conversationId !== conversationId ||
      recovery.key.conversationId !== conversationId || !recovery.preview || recovery.preview.changes.id !== operationId ||
      await hashChangeSet(recovery.preview.changes) !== proof.data.changeSetHash || recovery.key.contentHash !== proof.data.changeSetHash ||
      recovery.preview.changes.baseRevision !== proof.data.baseRevision || recovery.key.draftRevision !== proof.data.draftRevision ||
      recovery.key.draftContentHash !== proof.data.draftContentHash || recovery.preview.draft.id !== proof.data.draftId ||
      (recovery.receipt && recovery.receipt.changeSetId !== operationId)) return unknown();
    if (recovery.key.draftId !== proof.data.draftId || recovery.preview.draft.conversationId !== conversationId ||
      recovery.preview.draft.node.workspaceId !== proof.data.workspaceId || recovery.preview.changes.workspaceId !== proof.data.workspaceId ||
      (expected.draftId !== undefined && expected.draftId !== proof.data.draftId) ||
      (expected.source !== undefined && expected.source !== (recovery.preview.draft.candidateId === null ? 'manual' : 'candidate')) ||
      (expected.operationHash !== undefined && expected.operationHash !== proof.data.changeSetHash) ||
      Date.parse(proof.data.expiresAt) <= Date.now() || Date.parse(proof.data.storedAt) > Date.now() ||
      Date.parse(proof.data.expiresAt) <= Date.parse(proof.data.storedAt)) return mismatch();
    if ((expected.actorId !== undefined && expected.actorId !== proof.data.actorId) ||
      (expected.workspaceId !== undefined && expected.workspaceId !== proof.data.workspaceId)) {
      return failure('当前身份或工作区已变化，未展示原正文。', 'FORBIDDEN', 'request_access', 'preserved');
    }
    if ((recovery.commitState === 'saved' && !recovery.receipt) ||
      (recovery.receipt && (!validateReceipt(recovery.receipt, operationId, read.meta.mode).ok || recovery.commitState !== 'saved'))) return unknown();
    return { ok: true, data: { view: read.data, mode: read.meta.mode } };
  } catch { return unknown(); }
}
