import { z } from 'zod';
import { ChangeSetSchema, GitRevisionSchema, Id, Timestamp } from './domain';
import { DraftStateSchema, HandoffDraftSchema, HandoffSourceSchema } from './handoff';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const HandoffOperationSaveRequestSchema = z.object({
  draft: HandoffDraftSchema, changes: ChangeSetSchema, source: HandoffSourceSchema,
  draftRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), draftContentHash: Sha256,
  expectedConversationHash: Sha256, expectedOperationRevision: z.literal(0), retentionDays: z.literal(30), confirmed: z.literal(true),
}).strict().refine((input) => GitRevisionSchema.safeParse(input.changes.baseRevision).success
  && input.draft.baseRevision === input.changes.baseRevision && input.changes.nodes.length === 1 && input.changes.withdrawnIds.length === 0
  && (input.source.kind !== 'manual' || input.source.spans.length > 0),
'An original handoff operation must contain one new knowledge node at its pinned Git revision');
export type HandoffOperationSaveRequest = z.infer<typeof HandoffOperationSaveRequestSchema>;

export const HandoffOperationSnapshotSchema = z.object({ draft: HandoffDraftSchema, changes: ChangeSetSchema,
  source: HandoffSourceSchema, savedDraft: DraftStateSchema }).strict();
export type HandoffOperationSnapshot = z.infer<typeof HandoffOperationSnapshotSchema>;

export const HandoffOperationReceiptSchema = z.object({ operationId: Id, workspaceId: Id, actorId: Id,
  draftId: Id, draftRevision: z.number().int().positive(), draftContentHash: Sha256, conversationId: Id, conversationHash: Sha256,
  baseRevision: GitRevisionSchema, changeSetHash: Sha256, requestHash: Sha256, contentHash: Sha256,
  revision: z.literal(1), storedAt: Timestamp, expiresAt: Timestamp, retentionDays: z.literal(30), outcome: z.literal('saved'),
}).strict();
export type HandoffOperationReceipt = z.infer<typeof HandoffOperationReceiptSchema>;

export const HandoffOperationStateSchema = z.object({ operationId: Id, workspaceId: Id, actorId: Id,
  state: z.enum(['missing', 'available', 'expired']), revision: z.number().int().nonnegative(),
  requestHash: Sha256.nullable(), contentHash: Sha256.nullable(), snapshot: HandoffOperationSnapshotSchema.nullable(),
  expiresAt: Timestamp.optional(), retentionDays: z.literal(30), absenceIsFinal: z.literal(false), readOnly: z.literal(true),
}).strict().refine((state) => state.state === 'available'
  ? state.snapshot !== null && state.contentHash !== null && state.requestHash !== null && state.revision === 1 && state.expiresAt !== undefined
  : state.state === 'missing' ? state.snapshot === null && state.revision === 0 && state.contentHash === null && state.requestHash === null && state.expiresAt === undefined
    : state.snapshot === null && state.revision > 1 && state.contentHash !== null && state.requestHash !== null && state.expiresAt !== undefined);
export type HandoffOperationState = z.infer<typeof HandoffOperationStateSchema>;
