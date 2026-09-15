import { z } from 'zod';
import { Id, Timestamp } from './domain';
import { OperationRecoveryQuerySchema, OperationRecoverySchema } from './operation-recovery';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Binding = z.object({ requestHash: Hash.optional(), contentHash: Hash.optional(), baseRevision: Id.optional() }).strict();
export const RecoveryAnchorInputSchema = z.object({ feature: z.enum(['retrieval', 'learning']), operation: OperationRecoveryQuerySchema,
  binding: Binding, expiresAt: Timestamp, confirmed: z.literal(true) }).strict().superRefine((v, ctx) => {
  const kind = v.operation.kind;
  const allowed = v.feature === 'retrieval' ? kind === 'model' && v.operation.modelPurpose === 'answer'
    : ['task', 'evidence', 'review'].includes(kind) || (kind === 'model' && v.operation.modelPurpose === 'review');
  if (!allowed || /[\u0000-\u0020\u007f]/.test(v.operation.operationId)) ctx.addIssue({ code: 'custom', message: 'Recovery operation is outside the feature scope' });
  if (['task', 'review'].includes(kind) ? !v.binding.requestHash : !v.binding.contentHash || !v.binding.baseRevision)
    ctx.addIssue({ code: 'custom', message: 'The original request or content and revision binding is required' });
});
export type RecoveryAnchorInput = z.infer<typeof RecoveryAnchorInputSchema>;
export const RecoveryAnchorRequestSchema = RecoveryAnchorInputSchema.safeExtend({ actorId: Id, workspaceId: Id });
export type RecoveryAnchorRequest = z.infer<typeof RecoveryAnchorRequestSchema>;
export const RecoveryAnchorSchema = z.object({ id: Hash, actorId: Id, workspaceId: Id, feature: z.enum(['retrieval', 'learning']),
  operation: OperationRecoveryQuerySchema, binding: Binding, createdAt: Timestamp, expiresAt: Timestamp, readOnly: z.literal(true) }).strict();
export type RecoveryAnchor = z.infer<typeof RecoveryAnchorSchema>;
export const RecoveryAnchorReadSchema = z.object({ identity: RecoveryAnchorSchema, original: OperationRecoverySchema.nullable(),
  binding: z.enum(['matched', 'unknown', 'mismatch']), readOnly: z.literal(true), retryAllowed: z.literal(false) }).strict();
export type RecoveryAnchorRead = z.infer<typeof RecoveryAnchorReadSchema>;
