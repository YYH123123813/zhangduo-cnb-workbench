import { z } from 'zod';
import { Id, Timestamp } from './domain';

export const OperationRecoveryKindSchema = z.enum(['capture', 'model', 'evidence', 'task', 'handoff', 'governance', 'demo_export', 'review']);
export type OperationRecoveryKind = z.infer<typeof OperationRecoveryKindSchema>;

const ModelPurposeSchema = z.enum(['extract', 'answer', 'review']);
export const OperationRecoveryQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('capture'), operationId: Id }).strict(),
  z.object({ kind: z.literal('model'), operationId: Id, modelPurpose: ModelPurposeSchema }).strict(),
  z.object({ kind: z.literal('evidence'), operationId: Id }).strict(),
  z.object({ kind: z.literal('task'), operationId: Id }).strict(),
  z.object({ kind: z.literal('handoff'), operationId: Id }).strict(),
  z.object({ kind: z.literal('governance'), operationId: Id }).strict(),
  z.object({ kind: z.literal('demo_export'), operationId: Id }).strict(),
  z.object({ kind: z.literal('review'), operationId: Id }).strict(),
]);
export type OperationRecoveryQuery = z.infer<typeof OperationRecoveryQuerySchema>;

export const OperationRecoveryStageSchema = z.enum([
  'not_registered', 'approved', 'sending', 'saving', 'saved', 'executed', 'unknown', 'done', 'discarded', 'not_sent', 'expired', 'revoked', 'failed',
]);

export const OperationRecoverySchema = z.object({
  kind: OperationRecoveryKindSchema,
  operationId: Id,
  actorId: Id,
  workspaceId: Id,
  approvalId: Id.nullable(),
  recordId: Id.nullable(),
  purpose: Id.nullable(),
  requestHash: Id.nullable(),
  contentHash: Id.nullable(),
  baseRevision: Id.nullable(),
  objectIds: z.array(Id).max(200),
  approvalExpiresAt: Timestamp.nullable(),
  stage: OperationRecoveryStageSchema,
  readOnly: z.literal(true),
  absenceIsFinal: z.literal(false),
}).strict();
export type OperationRecovery = z.infer<typeof OperationRecoverySchema>;
