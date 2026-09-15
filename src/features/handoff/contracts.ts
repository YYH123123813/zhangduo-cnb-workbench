import { z } from 'zod';
import { ApprovalSchema, ChangeSetSchema, Id, KnowledgeNodeSchema, RelationSchema, Timestamp } from '../../contracts/domain';
import { KnowledgeApprovalRequestSchema } from '../../contracts/approval';
import { DraftSaveOptionsSchema, ReviewProgressSchema } from '../../contracts/handoff';

export const HandoffSnapshotSchema = z.object({ workspaceId: Id, revision: Id,
  nodes: z.array(KnowledgeNodeSchema), relations: z.array(RelationSchema), excludedIds: z.array(Id), generatedAt: Timestamp }).strict();

export const DraftInputSchema = z.object({ id: Id, conversationId: Id, candidateId: Id.nullable(),
  node: KnowledgeNodeSchema, relations: z.array(RelationSchema).max(100), baseRevision: Id }).strict();
export const SaveDraftRequestSchema = z.object({ draft: DraftInputSchema, consent: z.literal(true), options: DraftSaveOptionsSchema }).strict();
export const SaveProgressRequestSchema = z.object({ progress: ReviewProgressSchema, options: DraftSaveOptionsSchema }).strict();
export const ManualReviewRequestSchema = z.object({ segmentIds: z.array(Id).min(1).max(50), expectedConversationHash: Id, confirmed: z.literal(true) }).strict();
export const PreviewRequestSchema = z.object({ draft: DraftInputSchema, reason: z.string().trim().min(1).max(4000) }).strict();
export const ApprovalRequestSchema = KnowledgeApprovalRequestSchema.extend({ draft: DraftInputSchema }).strict();
export const CommitRequestSchema = z.object({ draft: DraftInputSchema, changes: ChangeSetSchema, approval: ApprovalSchema, confirmed: z.literal(true) }).strict();
