import { z } from 'zod';
import { Id, Timestamp } from './domain';
import { ObjectIdsSchema } from './governance';

export const ModelInputSchema = z.object({ purpose: z.enum(['extract', 'answer', 'review']), text: z.string().min(1).max(32000), sourceIds: ObjectIdsSchema }).strict();
export const ModelApprovalRequestSchema = z.object({ input: ModelInputSchema, objectIds: ObjectIdsSchema, baseRevision: Id, conversationId: Id.optional(), operationId: Id.optional(), confirmed: z.literal(true) }).strict();
export type ModelApprovalRequest = z.infer<typeof ModelApprovalRequestSchema>;
export const ModelOperationReceiptSchema = z.object({ approvalId: Id, actorId: Id, workspaceId: Id, purpose: ModelInputSchema.shape.purpose,
  contentHash: Id, baseRevision: Id, state: z.enum(['sending', 'done', 'unknown', 'discarded', 'not_sent']), modelId: Id.optional(), generatedAt: Timestamp.optional() }).strict();
export type ModelOperationReceipt = z.infer<typeof ModelOperationReceiptSchema>;
export const ModelCloseOperationRequestSchema = z.object({ approvalId: Id, purpose: ModelInputSchema.shape.purpose, contentHash: Id, baseRevision: Id, confirmed: z.literal(true) }).strict();
export type ModelCloseOperationRequest = z.infer<typeof ModelCloseOperationRequestSchema>;
