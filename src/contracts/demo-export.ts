import { z } from 'zod';
import { ApprovalSchema, Id } from './domain';

const PublicText = z.string().trim().min(1).max(20_000);

export const DemoExportItemSchema = z.object({
  nodeId: Id,
  publicTitle: PublicText.max(120),
  publicStatement: PublicText,
  publicConditions: z.array(PublicText).max(40),
  publicSourceLabels: z.array(PublicText).max(40),
}).strict();
export type DemoExportItem = z.infer<typeof DemoExportItemSchema>;

export const DemoExportRequestSchema = z.object({
  operationId: Id,
  baseRevision: Id,
  destination: z.literal('local_download'),
  items: z.array(DemoExportItemSchema).min(1).max(20),
  modelDeclaration: z.enum(['not_used', 'used', 'unknown']),
  confirmed: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.items.map((item) => item.nodeId)).size !== value.items.length) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'Demo export items must reference unique nodes' });
  }
});
export type DemoExportRequest = z.infer<typeof DemoExportRequestSchema>;

export const DemoExportFileSchema = z.object({ path: z.string().min(1).max(240), content: z.string() }).strict();
export type DemoExportFile = z.infer<typeof DemoExportFileSchema>;

export const DemoExportAuthorizationBindingSchema = z.object({
  purpose: z.literal('demo_export'),
  destination: z.literal('local_download'),
  operationId: Id,
  actorId: Id,
  workspaceId: Id,
  baseRevision: Id,
  objectIds: z.array(Id).min(1).max(20),
  requestHash: Id,
  contentHash: Id,
}).strict();
export type DemoExportAuthorizationBinding = z.infer<typeof DemoExportAuthorizationBindingSchema>;

export const DemoExportReceiptSchema = z.object({
  operationId: Id,
  approvalId: Id,
  actorId: Id,
  workspaceId: Id,
  baseRevision: Id,
  objectIds: z.array(Id).min(1).max(20),
  requestHash: Id,
  contentHash: Id,
  destination: z.literal('local_download'),
  files: z.array(DemoExportFileSchema).min(1).max(10),
  limitations: z.array(z.string().min(1).max(4_000)).max(20),
  published: z.literal(false),
  authorizationBinding: DemoExportAuthorizationBindingSchema,
}).strict();
export type DemoExportReceipt = z.infer<typeof DemoExportReceiptSchema>;

export const DemoExportExecutionRequestSchema = DemoExportRequestSchema.extend({ approval: ApprovalSchema }).strict();
export type DemoExportExecutionRequest = z.infer<typeof DemoExportExecutionRequestSchema>;

export const DemoExportRecoverySchema = z.object({
  operationId: Id,
  actorId: Id,
  workspaceId: Id,
  status: z.enum(['not_registered', 'approved', 'executed', 'revoked', 'expired', 'unknown']),
  approval: ApprovalSchema.nullable(),
  requestHash: Id.nullable(),
  receipt: DemoExportReceiptSchema.nullable(),
  absenceIsFinal: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'executed' && !value.receipt) ctx.addIssue({ code: 'custom', message: 'Executed demo export must have a receipt' });
  if (value.status === 'approved' && !value.approval) ctx.addIssue({ code: 'custom', message: 'Approved demo export must have an approval' });
  if (value.status === 'not_registered' && (value.approval || value.requestHash || value.receipt)) ctx.addIssue({ code: 'custom', message: 'Unregistered demo export cannot expose operation data' });
});
export type DemoExportRecovery = z.infer<typeof DemoExportRecoverySchema>;
