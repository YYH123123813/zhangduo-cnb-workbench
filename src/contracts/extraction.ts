import { z } from 'zod';
import { Id, Timestamp } from './domain';

export const ExtractionStageSchema = z.enum([
  'model_sending', 'model_done', 'rejected_without_save', 'candidate_saving',
  'saved_empty', 'saved_nonempty', 'unknown',
]);
export type ExtractionStage = z.infer<typeof ExtractionStageSchema>;

// This DTO is operation metadata only. It intentionally has no model input/output or candidate text.
export const ExtractionOperationSchema = z.object({
  operationId: Id, modelApprovalId: Id, conversationId: Id,
  actorId: Id, workspaceId: Id, conversationHash: Id, inputHash: Id,
  sourceIds: z.array(Id).max(100), stage: ExtractionStageSchema,
  settingsRevision: z.number().int().nonnegative(),
  batchRevision: z.number().int().nonnegative().optional(),
  candidateContentHash: Id.optional(),
  rejectionReason: z.enum(['invalid_reference', 'invalid_output', 'source_changed', 'approval_invalid']).optional(),
  legacy: z.boolean().optional(),
  updatedAt: Timestamp,
  retryAllowed: z.literal(false),
}).strict();
export type ExtractionOperation = z.infer<typeof ExtractionOperationSchema>;

export const ExtractionDiscoverySchema = z.object({
  conversationId: Id, conversationHash: Id,
  operations: z.array(ExtractionOperationSchema).max(10000),
  absenceIsFinal: z.literal(false), retryAllowed: z.literal(false),
}).strict();
export type ExtractionDiscovery = z.infer<typeof ExtractionDiscoverySchema>;
