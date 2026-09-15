import type { ApiResponse, Result } from '../../contracts/api';
import type { Approval, Conversation } from '../../contracts/domain';
import { ExtractionDiscoverySchema, ExtractionOperationSchema, type ExtractionDiscovery, type ExtractionOperation, type ExtractionStage } from '../../contracts/extraction';
import { ModelOperationReceiptSchema, type ModelOperationReceipt } from '../../contracts/model';
import { contentHash } from '../../contracts/hash';
import { WorkspaceSessionSchema } from '../../contracts/session';
import type { DeliveryReceipt } from './delivery';
import { checkDeliveryReceipt } from './model-send';
import { readModelOperationRecovery } from './operation-recovery';
import { failure } from './result';

export type ModelRecoveryState = 'complete' | 'rejected_without_save' | 'discarded' | 'expired' | 'unknown';
export interface ModelRecovery {
  state: ModelRecoveryState;
  stage: ExtractionStage;
  operation: ModelOperationReceipt | null;
  extraction: ExtractionOperation | null;
  delivery: DeliveryReceipt;
}
export type ModelOperationIdentity = Pick<Approval, 'id' | 'actorId' | 'workspaceId' | 'contentHash' | 'baseRevision'> & { objectIds?: string[]; operationId?: string };
type Transport = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
export type ModelRecoveryTarget = ModelOperationIdentity & { operationId?: string; requestHash?: string } | string;

export function identityFromExtraction(extraction: ExtractionOperation): ModelOperationIdentity {
  return { id: extraction.operationId, actorId: extraction.actorId, workspaceId: extraction.workspaceId,
    contentHash: extraction.inputHash, baseRevision: extraction.conversationHash, objectIds: extraction.sourceIds };
}

function operationProjection(extraction: ExtractionOperation): ModelOperationReceipt {
  const state: ModelOperationReceipt['state'] = extraction.stage === 'model_sending' || extraction.stage === 'candidate_saving'
    ? 'sending' : extraction.stage === 'unknown' ? 'unknown' : 'done';
  return ModelOperationReceiptSchema.parse({ approvalId: extraction.operationId, actorId: extraction.actorId, workspaceId: extraction.workspaceId,
    purpose: 'extract', contentHash: extraction.inputHash, baseRevision: extraction.conversationHash, state });
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validateExtraction(extraction: ExtractionOperation, conversation: Conversation, approval: ModelOperationIdentity | string): Result<ExtractionOperation> {
  const id = typeof approval === 'string' ? approval : approval.id;
  const sourceIds = new Set(conversation.segments.map((segment) => segment.id));
  const expectedIds = typeof approval === 'string' ? undefined : approval.objectIds;
  if (extraction.operationId !== id || extraction.modelApprovalId !== id || extraction.conversationId !== conversation.id
    || extraction.workspaceId !== conversation.workspaceId || extraction.conversationHash !== conversation.contentHash
    || extraction.sourceIds.some((sourceId) => !sourceIds.has(sourceId)) || new Set(extraction.sourceIds).size !== extraction.sourceIds.length
    || (expectedIds && !sameIds(extraction.sourceIds, expectedIds))) {
    return failure('UNKNOWN_RESULT', '提取终态不属于原现场、原批准、原来源或原操作；没有再次发送模型。', 'read_extraction_state', 'unknown');
  }
  if (typeof approval !== 'string' && (approval.workspaceId !== conversation.workspaceId || approval.baseRevision !== conversation.contentHash || approval.contentHash !== extraction.inputHash)) {
    return failure('UNKNOWN_RESULT', '提取终态与原批准摘要或基准版本不一致；没有再次发送模型。', 'read_extraction_state', 'unknown');
  }
  if (typeof approval !== 'string' && extraction.actorId !== approval.actorId) {
    return failure('UNKNOWN_RESULT', '提取终态与原批准身份不一致；没有再次发送模型。', 'read_extraction_state', 'unknown');
  }
  return { ok: true, data: extraction };
}

async function resolveState(extraction: ExtractionOperation | null, delivery: DeliveryReceipt, approvalId: string): Promise<ModelRecoveryState> {
  if (!extraction) return 'unknown';
  const batch = delivery.batch;
  if (extraction.stage === 'rejected_without_save') return batch?.state === 'missing' ? 'rejected_without_save' : 'unknown';
  if (extraction.stage === 'saved_empty' || extraction.stage === 'saved_nonempty') {
    if (!batch || batch.modelApprovalId !== approvalId || extraction.batchRevision === undefined || batch.revision !== extraction.batchRevision) return 'unknown';
    if (batch.state === 'expired') return 'expired';
    if (batch.state !== 'available') return 'unknown';
    if (!extraction.candidateContentHash || await contentHash(batch.candidates) !== extraction.candidateContentHash) return 'unknown';
    const expected = extraction.stage === 'saved_empty' ? 0 : 1;
    return (batch.candidates.length > 0 ? 1 : 0) === expected ? 'complete' : 'unknown';
  }
  return 'unknown';
}

function validateDiscovery(value: unknown, conversation: Conversation): Result<ExtractionDiscovery> {
  const parsed = ExtractionDiscoverySchema.safeParse(value);
  if (!parsed.success || parsed.data.conversationId !== conversation.id || parsed.data.conversationHash !== conversation.contentHash
    || parsed.data.operations.some((operation) => !validateExtraction(operation, conversation, operation.operationId).ok)
    || new Set(parsed.success ? parsed.data.operations.map((operation) => operation.operationId) : []).size !== (parsed.success ? parsed.data.operations.length : 0)) {
    return failure('UNKNOWN_RESULT', '按会话发现的提取操作无法按原身份、来源和版本核验；不会重新发送模型。', 'read_extraction_state', 'unknown');
  }
  return { ok: true, data: parsed.data };
}

export async function discoverModelOperations(request: Transport, conversation: Conversation, signal?: AbortSignal): Promise<Result<ExtractionDiscovery>> {
  try {
    const result = await request(`/api/workspace/conversations/${encodeURIComponent(conversation.id)}/extractions`, { signal });
    if (signal?.aborted) return failure('UNKNOWN_RESULT', '提取操作发现被中止；不能证明没有在途请求。', 'read_extraction_state', 'unknown');
    if (!result.ok) return result;
    return validateDiscovery(result.data, conversation);
  } catch {
    return failure('UNKNOWN_RESULT', '提取操作发现结果未知；没有再次发送模型。', 'read_extraction_state', 'unknown');
  }
}

async function readLegacyModelRecovery(request: Transport, conversation: Conversation, approval: ModelOperationIdentity | string, signal?: AbortSignal): Promise<Result<ModelRecovery>> {
  const unresolved = () => failure<ModelRecovery>('UNKNOWN_RESULT', '原模型操作或候选尚未按原身份、输入和来源核验；没有再次发送。', 'read_extraction_state', 'unknown');
  try {
    const approvalId = typeof approval === 'string' ? approval : approval.id;
    if (typeof approval !== 'string' && (approval.workspaceId !== conversation.workspaceId || approval.baseRevision !== conversation.contentHash)) return unresolved();
    const operationResult = await request(`/api/workspace/extraction-operations/${encodeURIComponent(approvalId)}`, { signal });
    if (signal?.aborted) return unresolved();
    if (!operationResult.ok) return operationResult;
    let extraction: ExtractionOperation | null = null;
    if (operationResult.data !== null) {
      const parsed = ExtractionOperationSchema.safeParse(operationResult.data);
      if (!parsed.success) return unresolved();
      const checked = validateExtraction(parsed.data, conversation, approval);
      if (!checked.ok) return checked;
      extraction = checked.data;
    }
    const candidates = await request(`/api/capture/${encodeURIComponent(conversation.id)}/candidates`, { signal });
    if (!candidates.ok) return candidates;
    const delivery = await checkDeliveryReceipt(candidates.data, conversation);
    if (signal?.aborted) return unresolved();
    if (!delivery.ok) return delivery;
    const state = await resolveState(extraction, delivery.data, approvalId);
    const stage = extraction?.stage ?? 'unknown';
    return { ok: true, data: { state, stage, extraction, operation: extraction ? operationProjection(extraction) : null, delivery: delivery.data } };
  } catch { return unresolved(); }
}

export function readDiscoveredModelRecovery(request: Transport, conversation: Conversation, approval: ModelOperationIdentity | string, signal?: AbortSignal): Promise<Result<ModelRecovery>> {
  return readLegacyModelRecovery(request, conversation, approval, signal);
}

async function readCurrentActor(request: Transport, workspaceId: string, signal?: AbortSignal): Promise<Result<string>> {
  try {
    const response = await request('/api/workspace/session', { method: 'GET', ...(signal ? { signal } : {}) });
    if (!response.ok) return { ok: false, error: { ...response.error, dataState: 'unknown' } };
    const session = WorkspaceSessionSchema.safeParse(response.data);
    if (!session.success || session.data.workspace.id !== workspaceId || session.data.workspace.mode === 'unconfigured')
      return failure('UNKNOWN_RESULT', '当前工作区身份未核验；不会恢复或重新发送原模型操作。', 'read_original_operation', 'unknown');
    return { ok: true, data: session.data.actorId };
  } catch {
    return failure('UNKNOWN_RESULT', '当前工作区身份读取中断；不会恢复或重新发送原模型操作。', 'read_original_operation', 'unknown');
  }
}

export async function readModelRecovery(request: Transport, conversation: Conversation, target: ModelRecoveryTarget, signal?: AbortSignal): Promise<Result<ModelRecovery>> {
  // Conversation discovery predates the shared recovery port and exposes the model approval ID.
  // Keep that read-only path separate; only an original registration ID enters the shared port below.
  if (typeof target !== 'string' && !target.operationId) return readLegacyModelRecovery(request, conversation, target, signal);
  const unresolved = () => failure<ModelRecovery>('UNKNOWN_RESULT', '原模型操作或候选尚未按原登记ID、批准、输入和来源核验；没有再次发送。', 'read_extraction_state', 'unknown');
  const originalOperationId = typeof target === 'string' ? target : target.operationId;
  if (!originalOperationId) return unresolved();
  if (typeof target !== 'string' && (target.workspaceId !== conversation.workspaceId || target.baseRevision !== conversation.contentHash)) return unresolved();

  const recovery = await readModelOperationRecovery(request, {
    operationId: originalOperationId,
    ...(typeof target === 'string' ? {} : {
      actorId: target.actorId, approvalId: target.id, requestHash: target.requestHash,
      contentHash: target.contentHash, baseRevision: target.baseRevision, objectIds: target.objectIds,
    }),
    workspaceId: conversation.workspaceId, purpose: 'extract',
  }, signal);
  if (signal?.aborted) return unresolved();
  if (!recovery.ok) return recovery;
  if (typeof target === 'string') {
    const actor = await readCurrentActor(request, conversation.workspaceId, signal);
    if (!actor.ok || actor.data !== recovery.data.actorId) return unresolved();
  }

  const metadata = recovery.data;
  const approvalId = metadata.approvalId;
  if (typeof target !== 'string' && approvalId !== null && approvalId !== target.id) return unresolved();
  let extraction: ExtractionOperation | null = null;
  if (approvalId !== null) {
    const operationResult = await request(`/api/workspace/extraction-operations/${encodeURIComponent(approvalId)}`, { signal });
    if (signal?.aborted) return unresolved();
    if (!operationResult.ok) return { ok: false, error: { ...operationResult.error, dataState: 'unknown' } };
    if (operationResult.data !== null) {
      const parsed = ExtractionOperationSchema.safeParse(operationResult.data);
      if (!parsed.success) return unresolved();
      const checked = validateExtraction(parsed.data, conversation, {
        id: approvalId, actorId: metadata.actorId, workspaceId: metadata.workspaceId,
        contentHash: metadata.contentHash ?? '', baseRevision: metadata.baseRevision ?? '', objectIds: metadata.objectIds,
      });
      if (!checked.ok) return checked;
      extraction = checked.data;
    }
  }

  const candidates = await request(`/api/capture/${encodeURIComponent(conversation.id)}/candidates`, { signal });
  if (!candidates.ok) return { ok: false, error: { ...candidates.error, dataState: 'unknown' } };
  const delivery = await checkDeliveryReceipt(candidates.data, conversation);
  if (signal?.aborted) return unresolved();
  if (!delivery.ok) return delivery;
  const state = await resolveState(extraction, delivery.data, approvalId ?? 'unregistered-operation');
  const stage = extraction?.stage ?? 'unknown';
  return { ok: true, data: { state, stage, extraction, operation: extraction ? operationProjection(extraction) : null, delivery: delivery.data } };
}
