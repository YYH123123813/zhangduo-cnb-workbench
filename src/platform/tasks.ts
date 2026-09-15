import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { RequestContext, Result } from '../contracts/api';
import { Id, TaskContextSchema, Timestamp, type TaskContext } from '../contracts/domain';
import { canonicalJson, contentHash } from '../contracts/hash';
import { validateTaskContext } from '../contracts/task';
import { TaskReceiptSchema, TaskSaveRequestSchema, TaskStateSchema, type TaskReceipt, type TaskState } from '../contracts/task-record';
import type { Services } from '../contracts/ports';
import type { SessionRegistry } from './identity';
import type { OperationJournal, StoredRecord } from './journal';
import { failure } from './result';

const StoredSchema = z.object({ state: z.enum(['available', 'expired']), task: TaskContextSchema.nullable(), contentHash: Id,
  referencedIds: z.array(Id), expiresAt: Timestamp }).strict().refine((stored) => (stored.state === 'available') === (stored.task !== null));
const references = (task: TaskContext) => [...new Set([task.id, ...(task.conditionChecks?.map((check) => check.nodeRef.objectId) ?? [])])];
const conflict = <T>(message = 'Task changed; the existing version was preserved'): Result<T> => failure('CONFLICT', message, 'read_task_receipt_and_state', 'preserved');

export class TaskStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly snapshot: Services['snapshot']) {}

  // Synchronous so start can validate and persist its immutable task in one SQLite transaction.
  boundState(ctx: RequestContext, id: string, revision: number, hash: string): Result<TaskState> {
    const access = this.access(ctx, 'task:read', [id]); if (!access.ok) return access;
    const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'task', id);
    const stored = row ? StoredSchema.parse(row.value) : null;
    if (!row || !stored?.task || stored.state !== 'available' || row.version !== revision || stored.contentHash !== hash
      || Date.parse(stored.expiresAt) <= Date.now()) return conflict('The confirmed task revision or hash changed or expired; confirm the task again');
    const allowed = this.access(ctx, 'task:read', stored.referencedIds, Boolean(stored.task.conditionChecks?.length)); if (!allowed.ok) return allowed;
    if (stored.task.id !== id || stored.task.workspaceId !== ctx.workspaceId
      || createHash('sha256').update(canonicalJson(stored.task)).digest('hex') !== hash
      || canonicalJson(references(stored.task)) !== canonicalJson(stored.referencedIds)) return conflict('The original task binding cannot be verified');
    return { ok: true, data: this.publicState(ctx, id, row) };
  }

  private access(ctx: RequestContext, scope: 'task:read' | 'task:write', ids: string[] = [], knowledge = false) {
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return failure<never>('FORBIDDEN', 'Private durable task storage is required', 'configure_private_storage');
    if (knowledge) { const read = this.sessions.authorize(ctx, 'knowledge:read'); if (!read.ok) return read; }
    const blocked = new Set(this.journal.blocked(ctx.workspaceId));
    if (ids.some((id) => blocked.has(id))) return failure<never>('FORBIDDEN', 'Task or a checked condition is blocked', 'review_delete_report', 'preserved');
    return access;
  }

  private publicState(ctx: RequestContext, id: string, row?: StoredRecord): TaskState {
    const stored = row ? StoredSchema.parse(row.value) : null;
    return TaskStateSchema.parse({ id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, state: stored?.state ?? 'missing', revision: row?.version ?? 0,
      task: stored?.task ?? null, contentHash: stored?.contentHash ?? null, ...(stored ? { expiresAt: stored.expiresAt } : {}), retentionDays: 30, absenceIsFinal: false });
  }

  async state(ctx: RequestContext, id: string): Promise<Result<TaskState>> {
    const access = this.access(ctx, 'task:read', [id]); if (!access.ok) return access;
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'Original task ID is required', 'read_task_state');
    try {
      let row = this.journal.record(ctx.workspaceId, ctx.actorId, 'task', id);
      if (!row) return { ok: true, data: this.publicState(ctx, id) };
      let stored = StoredSchema.parse(row.value);
      if (stored.state === 'available' && Date.parse(stored.expiresAt) <= Date.now()) {
        this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'task', id, { ...stored, state: 'expired', task: null }, row.version);
        row = this.journal.record(ctx.workspaceId, ctx.actorId, 'task', id)!; stored = StoredSchema.parse(row.value);
      }
      const allowed = this.access(ctx, 'task:read', stored.referencedIds, Boolean(stored.task?.conditionChecks?.length)); if (!allowed.ok) return allowed;
      if (stored.task && (stored.task.id !== id || stored.task.workspaceId !== ctx.workspaceId || await contentHash(stored.task) !== stored.contentHash
        || canonicalJson(references(stored.task)) !== canonicalJson(stored.referencedIds))) throw new Error('Stored task integrity mismatch');
      const final = this.access(ctx, 'task:read', stored.referencedIds, Boolean(stored.task?.conditionChecks?.length)); if (!final.ok) return final;
      return { ok: true, data: this.publicState(ctx, id, row) };
    } catch { return failure('INTERNAL', 'Private task state could not be verified', 'repair_private_storage', 'preserved'); }
  }

  receipt(ctx: RequestContext, operationId: string): Result<TaskReceipt | null> {
    const access = this.access(ctx, 'task:read'); if (!access.ok) return access;
    if (!Id.safeParse(operationId).success) return failure('VALIDATION', 'Original task save operation ID is required', 'read_task_receipt');
    try {
      const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'task_receipt', operationId);
      if (!row) return { ok: true, data: null };
      const receipt = TaskReceiptSchema.parse(row.value);
      if (receipt.operationId !== operationId || receipt.workspaceId !== ctx.workspaceId || receipt.actorId !== ctx.actorId) throw new Error('Task receipt identity mismatch');
      return { ok: true, data: receipt };
    } catch { return failure('INTERNAL', 'Original task receipt could not be verified', 'read_task_receipt', 'unknown'); }
  }

  async save(ctx: RequestContext, input: unknown): Promise<Result<TaskState>> {
    const access = this.access(ctx, 'task:write'); if (!access.ok) return access;
    const readable = this.access(ctx, 'task:read'); if (!readable.ok) return readable;
    const parsed = TaskSaveRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Task storage requires its complete scope, original operation, CAS and explicit 30-day consent', 'preview_task_storage');
    const request = parsed.data, task = request.task, ids = references(task);
    if (task.workspaceId !== ctx.workspaceId || task.constraints.some((condition) => condition.confirmedBy && condition.confirmedBy !== ctx.actorId)
      || task.conditionChecks?.some((check) => check.nodeRef.workspaceId !== ctx.workspaceId || (check.confirmedBy && check.confirmedBy !== ctx.actorId)))
      return failure('FORBIDDEN', 'Task attribution must match its trusted workspace and actor', 'review_task_conditions');
    const allowed = this.access(ctx, 'task:write', ids, Boolean(task.conditionChecks?.length)); if (!allowed.ok) return allowed;
    let hash: string, requestHash: string;
    try {
      if (Buffer.byteLength(canonicalJson(task)) > 100_000 || Date.parse(task.updatedAt) > Date.now()) return failure('VALIDATION', 'Task exceeds its size or timestamp boundary', 'review_task_scope');
      hash = await contentHash(task); requestHash = await contentHash(request);
    } catch { return failure('VALIDATION', 'Task must contain bounded plain JSON data', 'review_task_scope'); }
    try {
      const previous = (): Result<TaskState | null> => {
        const receipt = this.receipt(ctx, request.operationId); if (!receipt.ok) return receipt;
        if (!receipt.data) return { ok: true, data: null };
        if (receipt.data.requestHash !== requestHash || receipt.data.taskId !== task.id) return conflict('The original task operation is bound to a different complete request');
        const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'task', task.id), stored = row ? StoredSchema.parse(row.value) : null;
        if (!stored?.task || row?.version !== receipt.data.revision || stored.contentHash !== hash || Date.parse(stored.expiresAt) <= Date.now())
          return conflict('The saved task advanced or expired; read the original receipt without overwriting the current task');
        const valid = this.access(ctx, 'task:write', stored.referencedIds, Boolean(stored.task.conditionChecks?.length)); if (!valid.ok) return valid;
        return { ok: true, data: this.publicState(ctx, task.id, row) };
      };
      const prior = previous(); if (!prior.ok) return prior; if (prior.data) return { ok: true, data: prior.data };
      if (task.conditionChecks?.length) {
        const snapshot = await this.snapshot(ctx); if (!snapshot.ok) return snapshot;
        const valid = validateTaskContext(task, snapshot.data, ctx.actorId); if (!valid.ok) return valid;
      }
      return this.journal.transaction((): Result<TaskState> => {
        const valid = this.access(ctx, 'task:write', ids, Boolean(task.conditionChecks?.length)); if (!valid.ok) return valid;
        const prior = previous(); if (!prior.ok) return prior; if (prior.data) return { ok: true, data: prior.data };
        const current = this.journal.record(ctx.workspaceId, ctx.actorId, 'task', task.id), stored = current ? StoredSchema.parse(current.value) : null;
        if ((current?.version ?? 0) !== request.expectedRevision || (stored?.contentHash ?? null) !== request.expectedContentHash) return conflict();
        const now = Date.now(), expiresAt = new Date(now + 30 * 86_400_000).toISOString();
        const value = { state: 'available', task, contentHash: hash, referencedIds: ids, expiresAt };
        const replacing = stored?.state === 'available';
        if (!this.journal.privatePayloadFits(ctx.workspaceId, ctx.actorId, Buffer.byteLength(canonicalJson(value)), replacing ? Buffer.byteLength(canonicalJson(stored)) : 0, replacing))
          return failure('VALIDATION', 'Private task and review storage quota exceeded', 'review_storage_capacity');
        const receipt = TaskReceiptSchema.parse({ operationId: request.operationId, taskId: task.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId,
          requestHash, contentHash: hash, previousRevision: request.expectedRevision, revision: request.expectedRevision + 1, storedAt: new Date(now).toISOString(), expiresAt, retentionDays: 30, outcome: 'saved' });
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'task', task.id, value, current?.version ?? null)
          || !this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'task_receipt', request.operationId, receipt, null)) throw new Error('Task save transaction failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'task_saved', [task.id], 'private_not_indexed');
        return { ok: true, data: this.publicState(ctx, task.id, this.journal.record(ctx.workspaceId, ctx.actorId, 'task', task.id)) };
      });
    } catch { return failure('UNKNOWN_RESULT', 'Task save transaction could not be verified', 'read_task_receipt', 'unknown'); }
  }
}
