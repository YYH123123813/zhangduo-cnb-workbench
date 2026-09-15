import { ApprovalSchema, type Approval } from '../../contracts/domain';
import { ApprovalRegistrationStateSchema } from '../../contracts/approval';
import { EvidenceApprovalRequestSchema, EvidenceReceiptSchema, type EvidenceApprovalRequest } from '../../contracts/evidence';
import { contentHash, hashEvidence } from '../../contracts/hash';
import { failure, success } from './errors';

export interface EvidenceExpectation { request: EvidenceApprovalRequest; actorId: string; recordHash: string; requestHash: string }
export async function evidenceExpectation(request: EvidenceApprovalRequest, actorId: string): Promise<EvidenceExpectation> {
  const value = EvidenceApprovalRequestSchema.parse(request);
  return { request: value, actorId, recordHash: await hashEvidence(value.record), requestHash: await contentHash(value) };
}
const unknown = () => failure<never>('UNKNOWN_RESULT', '响应没有匹配原证据操作，仍需按原操作 ID 核验。', 'read_original_evidence_operation', 'unknown');

export function checkEvidenceApproval(input: unknown, expected: EvidenceExpectation) {
  const parsed = ApprovalSchema.safeParse(input);
  if (!parsed.success) return unknown();
  const value = parsed.data, { request, actorId, recordHash } = expected;
  if (value.actorId !== actorId || value.workspaceId !== request.record.workspaceId || value.purpose !== 'save_evidence'
    || value.objectIds.length !== 1 || value.objectIds[0] !== request.record.id || value.contentHash !== recordHash
    || value.baseRevision !== request.baseRevision || Date.parse(value.approvedAt) >= Date.parse(value.expiresAt)) return unknown();
  return success(value);
}

export function checkEvidenceRegistration(input: unknown, expected: EvidenceExpectation) {
  const parsed = ApprovalRegistrationStateSchema.safeParse(input);
  if (!parsed.success) return unknown();
  const value = parsed.data;
  if (value.operationId !== expected.request.operationId || value.purpose !== 'save_evidence' || value.modelPurpose !== undefined
    || value.workspaceId !== expected.request.record.workspaceId || value.actorId !== expected.actorId) return unknown();
  if (value.approval && (value.requestHash !== expected.requestHash || !checkEvidenceApproval(value.approval, expected).ok)) return unknown();
  return success(value);
}

export function checkEvidenceReceipt(input: unknown, expected: EvidenceExpectation, approval: Approval) {
  const parsed = EvidenceReceiptSchema.safeParse(input);
  if (!parsed.success) return unknown();
  const value = parsed.data, { request } = expected;
  if (value.operationId !== request.operationId || value.approvalId !== approval.id || value.recordId !== request.record.id
    || value.workspaceId !== request.record.workspaceId || value.actorId !== expected.actorId || value.contentHash !== expected.recordHash
    || value.baseRevision !== request.baseRevision || value.recordedAt !== request.record.recordedAt
    || Date.parse(value.storedAt) < Date.parse(value.recordedAt)) return unknown();
  return success(value);
}
