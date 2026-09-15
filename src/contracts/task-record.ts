import { z } from 'zod';
import { Id, TaskContextSchema, Timestamp } from './domain';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const TaskSaveRequestSchema = z.object({ operationId: Id, task: TaskContextSchema, expectedRevision: Revision,
  expectedContentHash: Hash.nullable(), retentionDays: z.literal(30), confirmed: z.literal(true) }).strict()
  .refine((request) => (request.expectedRevision === 0) === (request.expectedContentHash === null), 'Existing tasks require their original revision and content hash');
export type TaskSaveRequest = z.infer<typeof TaskSaveRequestSchema>;
export const TaskStateSchema = z.object({ id: Id, workspaceId: Id, actorId: Id, state: z.enum(['missing', 'available', 'expired']), revision: Revision,
  task: TaskContextSchema.nullable(), contentHash: Hash.nullable(), expiresAt: Timestamp.optional(), retentionDays: z.literal(30), absenceIsFinal: z.literal(false) }).strict()
  .superRefine((state, ctx) => {
    const valid = state.state === 'missing' ? state.revision === 0 && state.task === null && state.contentHash === null && !state.expiresAt
      : state.revision > 0 && state.contentHash !== null && !!state.expiresAt && (state.state === 'available' ? state.task?.id === state.id && state.task.workspaceId === state.workspaceId : state.task === null);
    if (!valid) ctx.addIssue({ code: 'custom', message: 'Task state does not match its persisted identity' });
  });
export type TaskState = z.infer<typeof TaskStateSchema>;
export const TaskReceiptSchema = z.object({ operationId: Id, taskId: Id, workspaceId: Id, actorId: Id, requestHash: Hash, contentHash: Hash,
  previousRevision: Revision, revision: Revision, storedAt: Timestamp, expiresAt: Timestamp, retentionDays: z.literal(30), outcome: z.literal('saved') }).strict()
  .refine((receipt) => receipt.revision === receipt.previousRevision + 1);
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;
