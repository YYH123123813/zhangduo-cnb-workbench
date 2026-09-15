import { z } from 'zod';
import { ApprovalSchema, GitRevisionSchema, Id, Timestamp } from './domain';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const IndexPreviewRequestSchema = z.object({ operationId: Id, baseRevision: GitRevisionSchema }).strict();
export type IndexPreviewRequest = z.infer<typeof IndexPreviewRequestSchema>;
export const IndexPlanSchema = IndexPreviewRequestSchema.extend({ workspaceId: Id, actorId: Id, embeddingModel: Id,
  files: z.array(z.object({ path: z.string().regex(/^knowledge-index\/[a-f0-9]{64}\.md$/), sha256: Hash, bytes: z.number().int().positive().max(1_000_000) }).strict()).min(1).max(100),
  objectIds: z.array(Id).min(1).max(100), totalBytes: z.number().int().positive().max(5_000_000), contentHash: Hash,
  issueSyncEnabled: z.literal(false), forceRebuild: z.literal(false), ignoreProcessFailures: z.literal(false) }).strict();
export type IndexPlan = z.infer<typeof IndexPlanSchema>;
export const IndexApprovalRequestSchema = z.object({ plan: IndexPlanSchema, confirmed: z.literal(true) }).strict();
export type IndexApprovalRequest = z.infer<typeof IndexApprovalRequestSchema>;
export const IndexExecutionRequestSchema = z.object({ operationId: Id, approval: ApprovalSchema }).strict();
export type IndexExecutionRequest = z.infer<typeof IndexExecutionRequestSchema>;
export const IndexOperationSchema = z.object({ operationId: Id, workspaceId: Id, actorId: Id, baseRevision: GitRevisionSchema, planHash: Hash, approvalId: Id,
  state: z.enum(['approved', 'pending', 'current', 'failed', 'unknown']), reason: Id, buildSn: Id.nullable(),
  observedIndexRevision: GitRevisionSchema.nullable(), observedBuildStatus: z.string().max(160).nullable(),
  updatedAt: Timestamp, dispatchedAt: Timestamp.nullable(), readOnly: z.literal(true), retryAllowed: z.literal(false), physicalPruning: z.literal('unverified') }).strict();
export type IndexOperation = z.infer<typeof IndexOperationSchema>;
export const IndexStatusSchema = z.object({ baseRevision: GitRevisionSchema, state: z.enum(['not_requested', 'approved', 'pending', 'current', 'failed', 'unknown']),
  updateAuthorized: z.boolean(), embeddingModel: Id.nullable(), operations: z.array(IndexOperationSchema).max(1000) }).strict();
export type IndexStatus = z.infer<typeof IndexStatusSchema>;
