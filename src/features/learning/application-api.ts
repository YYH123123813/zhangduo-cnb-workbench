import { z } from 'zod';
import { ApprovalSchema, EvidenceRecordSchema, GitRevisionSchema, Id } from '../../contracts/domain';
import { EvidenceApprovalRequestSchema, EvidenceReceiptSchema } from '../../contracts/evidence';

export const EvidenceStoragePreviewSchema = z.object({ operationId: Id, actorId: Id, record: EvidenceRecordSchema,
  baseRevision: GitRevisionSchema, retention: z.literal('until_deleted'), persistence: z.literal('not_saved'), indexing: z.literal('excluded') }).strict();
export type EvidenceStoragePreview = z.infer<typeof EvidenceStoragePreviewSchema>;
export const ApplicationExecuteSchema = z.object({ action: z.literal('execute'), request: EvidenceApprovalRequestSchema, approval: ApprovalSchema }).strict();
export const ApplicationSavedSchema = z.object({ receipt: EvidenceReceiptSchema, persistence: z.literal('saved'), indexing: z.literal('excluded') }).strict();
export type ApplicationSaved = z.infer<typeof ApplicationSavedSchema>;
