import { z } from 'zod';
import { ApprovalSchema, ChangeSetSchema, ConversationSchema, Id } from './domain';

export const ConversationApprovalRequestSchema = z.object({ conversation: ConversationSchema, baseRevision: Id, operationId: Id.optional(), confirmed: z.literal(true) }).strict();
export type ConversationApprovalRequest = z.infer<typeof ConversationApprovalRequestSchema>;
export const KnowledgeApprovalRequestSchema = z.object({ changes: ChangeSetSchema, confirmed: z.literal(true) }).strict();
export type KnowledgeApprovalRequest = z.infer<typeof KnowledgeApprovalRequestSchema>;
export const KnowledgeApprovalStateSchema = z.object({ changeSetId: Id, workspaceId: Id, actorId: Id,
  status: z.enum(['registered', 'revoked', 'expired', 'not_registered', 'unknown']), approval: ApprovalSchema.nullable(),
  absenceIsFinal: z.literal(false),
}).strict().refine((value) => ['registered', 'revoked', 'expired'].includes(value.status) ? value.approval !== null : value.approval === null);
export type KnowledgeApprovalState = z.infer<typeof KnowledgeApprovalStateSchema>;

export const RegistrationPurposeSchema = z.enum(['save_conversation', 'model_input', 'settings', 'export', 'delete', 'save_evidence', 'demo_export']);
const registrationIdentity = { operationId: Id, purpose: RegistrationPurposeSchema, modelPurpose: z.enum(['extract', 'answer', 'review']).optional() };
export const ApprovalRegistrationQuerySchema = z.object(registrationIdentity).strict()
  .refine((value) => (value.purpose === 'model_input') === (value.modelPurpose !== undefined), 'Model registration requires its exact model purpose');
export type ApprovalRegistrationQuery = z.infer<typeof ApprovalRegistrationQuerySchema>;
export const ApprovalRegistrationStateSchema = z.object({ ...registrationIdentity, workspaceId: Id, actorId: Id,
  status: z.enum(['registered', 'revoked', 'expired', 'not_registered', 'unknown']), approval: ApprovalSchema.nullable(),
  requestHash: Id.nullable(), absenceIsFinal: z.literal(false),
}).strict().superRefine((value, ctx) => {
  const found = ['registered', 'revoked', 'expired'].includes(value.status);
  if ((found ? value.approval === null || value.requestHash === null : value.approval !== null || value.requestHash !== null)
    || (value.purpose === 'model_input') !== (value.modelPurpose !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent approval registration state' });
  if (value.approval && (value.approval.purpose !== value.purpose || value.approval.actorId !== value.actorId || value.approval.workspaceId !== value.workspaceId))
    ctx.addIssue({ code: 'custom', message: 'Approval registration identity mismatch' });
});
export type ApprovalRegistrationState = z.infer<typeof ApprovalRegistrationStateSchema>;
