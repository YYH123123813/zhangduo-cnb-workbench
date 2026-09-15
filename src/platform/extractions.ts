import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { ExtractionDiscoverySchema, ExtractionOperationSchema, type ExtractionDiscovery, type ExtractionOperation } from '../contracts/extraction';
import { Id, type Approval, type Conversation } from '../contracts/domain';
import type { Services } from '../contracts/ports';
import type { OperationJournal } from './journal';
import type { SessionRegistry } from './identity';
import { ModelConstraintSchema, ModelOperationSchema } from './model';
import { failure } from './result';

const operationProgress = z.object({
  conversationId: Id, conversationHash: Id, sourceIds: z.array(Id).max(100),
  stage: ExtractionOperationSchema.shape.stage, settingsRevision: z.number().int().nonnegative(),
  batchRevision: z.number().int().nonnegative().optional(), candidateContentHash: Id.optional(),
  rejectionReason: ExtractionOperationSchema.shape.rejectionReason, retryAllowed: z.literal(false), updatedAt: ExtractionOperationSchema.shape.updatedAt,
}).strict();
export type ExtractionProgress = z.infer<typeof operationProgress>;

export class ExtractionOperationStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal,
    private readonly conversation: Services['readConversation']) {}

  private access(ctx: RequestContext, scope: 'workspace:read' | 'model:extract' | 'candidate:read') {
    const result = this.sessions.authorize(ctx, scope);
    if (!result.ok) return result;
    if (ctx.mode === 'live' && this.journal.fixture) return failure<never>('FORBIDDEN', 'Extraction operation readback requires durable storage', 'configure_operation_storage');
    return result;
  }

  private approval(ctx: RequestContext, id: string): Result<Approval> {
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'A valid original extraction operation ID is required', 'read_extraction_state');
    const row = this.journal.approval(id)?.value;
    if (!row) return { ok: true, data: null as never };
    if (row.actorId !== ctx.actorId || row.workspaceId !== ctx.workspaceId || row.purpose !== 'model_input') return failure('FORBIDDEN', 'Extraction operation is unavailable to this identity', 'select_authorized_workspace');
    return { ok: true, data: row };
  }

  private row(ctx: RequestContext, approvalId: string): ExtractionOperation | null {
    const record = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approvalId);
    const approval = this.journal.approval(approvalId)?.value;
    const constraint = this.journal.record(ctx.workspaceId, ctx.actorId, 'model_constraint', approvalId);
    if (!record || !approval || !constraint) return null;
    const operation = ModelOperationSchema.parse(record.value);
    const parsedConstraint = ModelConstraintSchema.parse(constraint.value);
    if (parsedConstraint.purpose !== 'extract' || !parsedConstraint.conversationId || operation.actorId !== ctx.actorId || operation.contentHash !== approval.contentHash) throw Error('Extraction operation identity mismatch');
    const progress = operationProgress.safeParse(operation.extraction);
    if (progress.success) return ExtractionOperationSchema.parse({
      operationId: approvalId, modelApprovalId: approvalId, conversationId: progress.data.conversationId,
      actorId: ctx.actorId, workspaceId: ctx.workspaceId, conversationHash: progress.data.conversationHash,
      inputHash: operation.contentHash, sourceIds: progress.data.sourceIds, stage: progress.data.stage,
      settingsRevision: progress.data.settingsRevision, ...(progress.data.batchRevision === undefined ? {} : { batchRevision: progress.data.batchRevision }),
      ...(progress.data.candidateContentHash ? { candidateContentHash: progress.data.candidateContentHash } : {}),
      ...(progress.data.rejectionReason ? { rejectionReason: progress.data.rejectionReason } : {}),
      updatedAt: progress.data.updatedAt, retryAllowed: false,
    });
    // Records created before 1.19 are never inferred as a successful or rejected save.
    return ExtractionOperationSchema.parse({ operationId: approvalId, modelApprovalId: approvalId, conversationId: parsedConstraint.conversationId,
      actorId: ctx.actorId, workspaceId: ctx.workspaceId, conversationHash: approval.baseRevision, inputHash: operation.contentHash,
      sourceIds: parsedConstraint.objectIds, stage: 'unknown', settingsRevision: parsedConstraint.settingsRevision,
      legacy: true, updatedAt: record.updatedAt ?? new Date().toISOString(), retryAllowed: false });
  }

  read(ctx: RequestContext, approvalId: string): Result<ExtractionOperation | null> {
    const access = this.access(ctx, 'workspace:read'); if (!access.ok) return access;
    const permission = this.access(ctx, 'model:extract'); if (!permission.ok) return permission;
    try {
      const approved = this.approval(ctx, approvalId); if (!approved.ok) return approved;
      if (!approved.data) return { ok: true, data: null };
      const value = this.row(ctx, approvalId);
      if (value && value.sourceIds.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return failure('FORBIDDEN', 'This extraction references content blocked by the deletion barrier', 'review_delete_report');
      return { ok: true, data: value };
    } catch { return failure('INTERNAL', 'Stored extraction operation could not be verified', 'repair_operation_storage', 'preserved'); }
  }

  async discover(ctx: RequestContext, conversationId: string): Promise<Result<ExtractionDiscovery>> {
    const workspace = this.access(ctx, 'workspace:read'); if (!workspace.ok) return workspace;
    const model = this.access(ctx, 'model:extract'); if (!model.ok) return model;
    const candidates = this.access(ctx, 'candidate:read'); if (!candidates.ok) return candidates;
    if (!Id.safeParse(conversationId).success) return failure('VALIDATION', 'A valid conversation ID is required', 'read_extraction_state');
    if (this.journal.blocked(ctx.workspaceId).includes(conversationId)) return failure('FORBIDDEN', 'This conversation is blocked by the deletion barrier', 'review_delete_report');
    const source = await this.conversation(ctx, conversationId); if (!source.ok) return source;
    try {
      const ids = this.journal.extractionOperationIds(ctx.workspaceId, ctx.actorId, conversationId);
      const operations = ids.map((id) => this.row(ctx, id)).filter((value): value is ExtractionOperation => value !== null);
      if (operations.some((operation) => operation.sourceIds.some((id) => this.journal.blocked(ctx.workspaceId).includes(id)))) return failure('FORBIDDEN', 'This extraction references content blocked by the deletion barrier', 'review_delete_report');
      return { ok: true, data: ExtractionDiscoverySchema.parse({ conversationId, conversationHash: source.data.contentHash, operations, absenceIsFinal: false, retryAllowed: false }) };
    } catch { return failure('INTERNAL', 'Extraction operation index could not be verified', 'repair_operation_storage', 'preserved'); }
  }
}

export function extractionProgress(value: unknown): ExtractionProgress | null {
  const parsed = operationProgress.safeParse(value); return parsed.success ? parsed.data : null;
}
