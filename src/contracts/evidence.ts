import { z } from 'zod';
import { EvidenceRecordSchema, GitRevisionSchema, Id, Timestamp } from './domain';

export const EvidenceApprovalRequestSchema = z.object({ operationId: Id, record: EvidenceRecordSchema, baseRevision: GitRevisionSchema,
  retention: z.literal('until_deleted'), confirmed: z.literal(true) }).strict();
export type EvidenceApprovalRequest = z.infer<typeof EvidenceApprovalRequestSchema>;
export const EvidenceReceiptSchema = z.object({ operationId: Id, approvalId: Id, recordId: Id, workspaceId: Id, actorId: Id,
  contentHash: Id, baseRevision: GitRevisionSchema, recordedAt: Timestamp, storedAt: Timestamp,
  retention: z.literal('until_deleted'), outcome: z.literal('saved') }).strict();
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
