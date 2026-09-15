import { z } from 'zod';
import { CandidateSchema, ConditionSchema, Id, KnowledgeNodeSchema, RelationSchema, SourceRecordSchema, SourceSpanSchema, Timestamp } from './domain';

export const HandoffDraftSchema = z.object({ id: Id, conversationId: Id, candidateId: Id.nullable(), node: KnowledgeNodeSchema,
  relations: z.array(RelationSchema).max(100), baseRevision: Id }).strict();
export const HandoffSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('candidate'), candidateId: Id }).strict(),
  z.object({ kind: z.literal('manual'), spans: z.array(SourceSpanSchema).max(50) }).strict(),
]);
export const ReviewProgressSchema = z.object({
  id: Id, workspaceId: Id, conversationId: Id, nodeId: Id, baseRevision: Id,
  disposition: z.enum(['handoff', 'archive', 'reject', 'later']).nullable(),
  title: z.string().max(1000), question: z.string().max(8000), statement: z.string().max(32000),
  kind: CandidateSchema.shape.kind, authorship: z.enum(['human_written', 'human_edited', 'ai_accepted']),
  conditions: z.array(ConditionSchema.extend({ text: z.string().max(4000) })).max(100), boundaries: z.array(z.string().max(4000)).max(100),
  sources: z.array(SourceRecordSchema).max(100), relations: z.array(RelationSchema).max(100),
  relationInput: z.object({ targetId: z.string().max(160), type: z.enum(['', 'supports', 'depends_on', 'contradicts', 'supersedes']),
    direction: z.enum(['', 'outgoing', 'incoming']), rationale: z.string().max(8000), evidenceIds: z.array(Id).max(100) }).strict(),
}).strict();
export type ReviewProgress = z.infer<typeof ReviewProgressSchema>;
export const DraftSaveOptionsSchema = z.object({ operationId: Id, source: HandoffSourceSchema, expectedConversationHash: Id,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), expectedContentHash: Id.nullable(), retentionDays: z.literal(30), confirmed: z.literal(true) }).strict();
export type DraftSaveOptions = z.infer<typeof DraftSaveOptionsSchema>;
export const HandoffDocumentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft'), value: HandoffDraftSchema }).strict(),
  z.object({ kind: z.literal('progress'), value: ReviewProgressSchema }).strict(),
]);
export const DraftStateSchema = z.object({ id: Id, state: z.enum(['missing', 'available', 'expired']), revision: z.number().int().nonnegative(),
  contentHash: Id.nullable(), conversationHash: Id.nullable(), document: HandoffDocumentSchema.nullable(), source: HandoffSourceSchema.nullable(),
  expiresAt: Timestamp.optional(), retentionDays: z.literal(30),
}).strict().refine((value) => value.state === 'available' ? value.document !== null && value.source !== null && value.contentHash !== null && value.revision > 0 : value.document === null);
export type DraftState = z.infer<typeof DraftStateSchema>;
export const DraftReceiptSchema = z.object({ operationId: Id, draftId: Id, actorId: Id, workspaceId: Id, kind: z.enum(['draft', 'progress']),
  contentHash: Id, conversationHash: Id, previousRevision: z.number().int().nonnegative(), revision: z.number().int().positive(),
  expiresAt: Timestamp, outcome: z.literal('saved'),
}).strict().refine((value) => value.revision === value.previousRevision + 1);
export type DraftReceipt = z.infer<typeof DraftReceiptSchema>;
