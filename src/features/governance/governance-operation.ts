import { GovernanceOperationReceiptSchema, GovernanceOperationSaveRequestSchema, GovernanceOperationStateSchema, type GovernanceOperationKind, type GovernanceOperationReceipt, type GovernanceOperationSaveRequest, type GovernanceOperationState } from '../../contracts/governance-operation';
import type { ApiError, Result } from '../../contracts/api';
import { canonicalJson, contentHash } from '../../contracts/hash';
import type { RequestApi } from './approval-flow';
import { OperationRecoverySchema, type OperationRecovery } from '../../contracts/operation-recovery';

export type GovernancePayloadSaveState = 'idle' | 'saving' | 'reading' | 'saved' | 'unknown' | 'failed' | 'conflict' | 'expired';
export function governancePayloadLocked(state: GovernancePayloadSaveState) { return ['saving', 'reading', 'unknown'].includes(state); }

function normalizePayload(value: unknown, inArray = false): unknown {
  if (value === undefined) {
    if (inArray) throw new Error('Undefined array values are not supported');
    return undefined;
  }
  if (Array.isArray(value)) return value.map((item) => normalizePayload(item, true));
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Governance payload must contain plain objects');
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const normalized = normalizePayload(item);
      return normalized === undefined ? [] : [[key, normalized]];
    }));
  }
  return value;
}

export function jsonGovernancePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Governance payload must be an object');
  const normalized = normalizePayload(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new Error('Governance payload must be an object');
  canonicalJson(normalized);
  return normalized as Record<string, unknown>;
}

export function governanceOperationRequest(input: { operationId: string; kind: GovernanceOperationKind; baseRevision: string; payload: Record<string, unknown> }): GovernanceOperationSaveRequest {
  const request = GovernanceOperationSaveRequestSchema.parse({ ...input, payload: jsonGovernancePayload(input.payload), expectedRevision: 0, retentionDays: 30, confirmed: true });
  canonicalJson(request.payload);
  return request;
}

export function parseGovernanceOperationState(value: unknown, expected: { operationId: string; actorId: string; workspaceId: string }): GovernanceOperationState {
  const parsed = GovernanceOperationStateSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid governance operation state');
  if (parsed.data.operationId !== expected.operationId || parsed.data.actorId !== expected.actorId || parsed.data.workspaceId !== expected.workspaceId) {
    throw new Error('Mismatched governance operation state');
  }
  return parsed.data;
}

export function hasRestorablePayload(state: GovernanceOperationState): state is GovernanceOperationState & { payload: Record<string, unknown> } {
  return state.state === 'available' && Date.parse(state.expiresAt) > Date.now() && !!state.payload && typeof state.payload === 'object' && !Array.isArray(state.payload);
}

export function governancePayloadSaveState(error: Pick<ApiError, 'code' | 'dataState'>): 'unknown' | 'failed' | 'conflict' {
  if (error.code === 'CONFLICT') return 'conflict';
  return error.code === 'UNKNOWN_RESULT' || ['unknown', 'partial'].includes(error.dataState) ? 'unknown' : 'failed';
}

const hashPattern = /^[0-9a-f]{64}$/;
const payloadReadUnknown: ApiError = { code: 'UNKNOWN_RESULT', message: '原治理载荷或独立保存回执无法核验，未恢复内容，也未创建新操作。', dataState: 'unknown', retryable: false, nextAction: 'read_original_operation' };
export interface GovernancePayloadIdentity { operationId: string; actorId: string; workspaceId: string }
export interface GovernancePayloadReadback { state: GovernanceOperationState; receipt: GovernanceOperationReceipt }
export interface GovernanceOperationRecoveryIdentity extends GovernancePayloadIdentity {
  kind: GovernanceOperationKind; baseRevision: string; contentHash: string; requestHash: string;
  objectIds?: readonly string[];
}

function sameIdentity(value: { operationId: string; actorId: string; workspaceId: string }, expected: GovernancePayloadIdentity) {
  return value.operationId === expected.operationId && value.actorId === expected.actorId && value.workspaceId === expected.workspaceId;
}

/**
 * Validate both durable records. A successful POST is not enough: the payload
 * and its receipt must describe the same immutable operation and request.
 */
export async function verifyGovernancePayload(stateValue: unknown, receiptValue: unknown, expected: GovernancePayloadIdentity, expectedRequest?: GovernanceOperationSaveRequest): Promise<GovernancePayloadReadback> {
  const state = parseGovernanceOperationState(stateValue, expected);
  const receipt = GovernanceOperationReceiptSchema.parse(receiptValue);
  if (!sameIdentity(receipt, expected) || receipt.kind !== state.kind || receipt.baseRevision !== state.baseRevision
    || receipt.contentHash !== state.contentHash || receipt.requestHash !== state.requestHash || receipt.outcome !== 'saved') throw Error('Mismatched governance operation records');
  if (!hashPattern.test(state.contentHash) || !hashPattern.test(state.requestHash) || !hashPattern.test(receipt.contentHash) || !hashPattern.test(receipt.requestHash)) throw Error('Invalid governance operation hashes');
  if (state.state === 'expired') {
    if (state.payload !== undefined) throw Error('Expired governance operation contains payload');
    if (expectedRequest && await contentHash(expectedRequest) !== state.requestHash) throw Error('Expired governance request changed');
    return { state, receipt };
  }
  if (!hasRestorablePayload(state)) throw Error('Available governance operation has no usable payload');
  if (await contentHash(state.payload) !== state.contentHash) throw Error('Governance payload hash mismatch');
  const reconstructed = governanceOperationRequest({ operationId: state.operationId, kind: state.kind, baseRevision: state.baseRevision, payload: state.payload });
  if (await contentHash(reconstructed) !== state.requestHash) throw Error('Governance request hash mismatch');
  if (expectedRequest && (await contentHash(expectedRequest) !== state.requestHash || expectedRequest.kind !== state.kind || expectedRequest.baseRevision !== state.baseRevision)) throw Error('Governance request does not match the original operation');
  return { state, receipt };
}

function unknownResult(): Result<never> { return { ok: false, error: payloadReadUnknown }; }

export function verifyGovernanceOperationRecovery(value: unknown, expected: GovernanceOperationRecoveryIdentity, state: GovernanceOperationState): OperationRecovery {
  const recovery = OperationRecoverySchema.parse(value);
  const expectedStage = state.state === 'expired' ? 'expired' : 'saved';
  // The shared governance payload receipt currently exposes no business object scope.
  const objectIds = expected.objectIds ?? [];
  if (recovery.kind !== 'governance' || recovery.operationId !== expected.operationId || recovery.actorId !== expected.actorId
    || recovery.workspaceId !== expected.workspaceId || recovery.purpose !== expected.kind || recovery.requestHash !== expected.requestHash
    || recovery.contentHash !== expected.contentHash || recovery.baseRevision !== expected.baseRevision || recovery.stage !== expectedStage
    || recovery.readOnly !== true || recovery.absenceIsFinal !== false
    || recovery.objectIds.length !== objectIds.length || recovery.objectIds.some((id, index) => id !== objectIds[index])) {
    throw Error('Mismatched governance operation recovery metadata');
  }
  return recovery;
}

export async function readGovernanceOperationRecovery(api: RequestApi, expected: GovernanceOperationRecoveryIdentity, state: GovernanceOperationState): Promise<Result<OperationRecovery>> {
  try {
    const response = await api(`/api/workspace/operation-recovery/governance/${encodeURIComponent(expected.operationId)}`);
    if (!response.ok) return unknownResult();
    return { ok: true, data: verifyGovernanceOperationRecovery(response.data, expected, state) };
  } catch { return unknownResult(); }
}

/** Read the original operation and its independent save receipt, never replaying the write. */
export async function readGovernancePayload(api: RequestApi, expected: GovernancePayloadIdentity, expectedRequest?: GovernanceOperationSaveRequest, options: { requireRecovery?: boolean } = {}): Promise<Result<GovernancePayloadReadback>> {
  try {
    const stateResponse = await api(`/api/workspace/governance-operations/${encodeURIComponent(expected.operationId)}`);
    if (!stateResponse.ok || !stateResponse.data) return unknownResult();
    const receiptResponse = await api(`/api/workspace/governance-operation-receipts/${encodeURIComponent(expected.operationId)}`);
    if (!receiptResponse.ok || !receiptResponse.data) return unknownResult();
    const readback = await verifyGovernancePayload(stateResponse.data, receiptResponse.data, expected, expectedRequest);
    if (options.requireRecovery) {
      const recovery = await readGovernanceOperationRecovery(api, { ...expected, kind: readback.state.kind, baseRevision: readback.state.baseRevision,
        contentHash: readback.state.contentHash, requestHash: readback.state.requestHash }, readback.state);
      if (!recovery.ok) return recovery;
    }
    return { ok: true, data: readback };
  } catch { return unknownResult(); }
}

/** Persist once, then settle the result only through the two read-only endpoints. */
export async function saveGovernancePayload(api: RequestApi, request: GovernanceOperationSaveRequest, expected: GovernancePayloadIdentity, options: { requireRecovery?: boolean } = {}): Promise<Result<GovernancePayloadReadback>> {
  if (request.operationId !== expected.operationId) return { ok: false, error: { code: 'VALIDATION', message: '原操作ID不匹配，未保存治理载荷。', dataState: 'not_written', retryable: false, nextAction: 'review_original_operation' } };
  try {
    const response = await api('/api/workspace/governance-operations', { method: 'POST', body: JSON.stringify(request) });
    if (!response.ok) return { ok: false, error: response.error };
    return await readGovernancePayload(api, expected, request, options);
  } catch { return unknownResult(); }
}
