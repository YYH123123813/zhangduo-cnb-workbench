import { z } from 'zod';
import { Id, Timestamp } from './domain';

export const GovernanceOperationKindSchema = z.enum(['change', 'settings', 'delete', 'export', 'demo']);
export type GovernanceOperationKind = z.infer<typeof GovernanceOperationKindSchema>;
const PayloadSchema = z.record(z.string(), z.unknown());
export const GovernanceOperationSaveRequestSchema = z.object({
  operationId: Id, kind: GovernanceOperationKindSchema, baseRevision: Id,
  payload: PayloadSchema, expectedRevision: z.literal(0), retentionDays: z.literal(30), confirmed: z.literal(true),
}).strict();
export type GovernanceOperationSaveRequest = z.infer<typeof GovernanceOperationSaveRequestSchema>;
export const GovernanceOperationStateSchema = z.object({
  operationId: Id, kind: GovernanceOperationKindSchema, actorId: Id, workspaceId: Id, baseRevision: Id,
  contentHash: Id, requestHash: Id, state: z.enum(['available', 'expired']),
  payload: PayloadSchema.optional(), expiresAt: Timestamp, createdAt: Timestamp,
}).strict();
export type GovernanceOperationState = z.infer<typeof GovernanceOperationStateSchema>;
export const GovernanceOperationReceiptSchema = z.object({
  operationId: Id, kind: GovernanceOperationKindSchema, actorId: Id, workspaceId: Id,
  baseRevision: Id, contentHash: Id, requestHash: Id, outcome: z.literal('saved'), savedAt: Timestamp,
}).strict();
export type GovernanceOperationReceipt = z.infer<typeof GovernanceOperationReceiptSchema>;
