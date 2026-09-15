import { z } from 'zod';
import { Id, type Settings } from './domain';

export const SettingsSchema = z.object({ aiExtraction: z.boolean(), aiAnswer: z.boolean(), aiReview: z.boolean(), saveQueryHistory: z.boolean(), reviewReminders: z.boolean() }).strict();
export interface SettingsState { settings: Settings; revision: number }
export const SettingsReceiptSchema = z.object({
  approvalId: Id, workspaceId: Id, actorId: Id, contentHash: Id, baseRevision: Id,
  previousRevision: z.number().int().nonnegative(), revision: z.number().int().positive(),
  settings: SettingsSchema, outcome: z.literal('saved'),
}).strict().refine((receipt) => receipt.revision === receipt.previousRevision + 1, 'Settings receipt must describe exactly one revision');
export type SettingsReceipt = z.infer<typeof SettingsReceiptSchema>;
export const ObjectIdsSchema = z.array(Id).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, 'Duplicate object IDs');
export const DeleteLayerSchema = z.object({ name: Id, supported: z.boolean(), consequence: z.string().min(1), reversible: z.boolean(), capability: z.enum(['supported', 'unsupported', 'unknown']).optional() }).strict();
export const DeletePlanSchema = z.object({ id: Id, workspaceId: Id, objectIds: ObjectIdsSchema, contentHash: Id, baseRevision: Id, layers: z.array(DeleteLayerSchema).max(100) }).strict();
export const DeleteReportSchema = z.object({ planId: Id, retrievalBlocked: z.boolean(), layers: z.array(z.object({ name: Id, state: z.enum(['done', 'pending', 'unsupported', 'failed', 'unknown']), detail: z.string() }).strict()).max(100) }).strict();
export const GovernanceApprovalRequestSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('settings'), settings: SettingsSchema, baseRevision: Id, expectedSettingsHash: Id, expectedSettingsRevision: z.number().int().nonnegative(), operationId: Id.optional(), confirmed: z.literal(true) }).strict(),
  z.object({ purpose: z.literal('export'), objectIds: ObjectIdsSchema, baseRevision: Id, operationId: Id.optional(), confirmed: z.literal(true) }).strict(),
  z.object({ purpose: z.literal('delete'), planId: Id, operationId: Id.optional(), confirmed: z.literal(true) }).strict(),
]);
export type GovernanceApprovalRequest = z.infer<typeof GovernanceApprovalRequestSchema>;
