import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { Id } from '../contracts/domain';
import { ApprovalRegistrationStateSchema, type ApprovalRegistrationState } from '../contracts/approval';
import { EvidenceReceiptSchema } from '../contracts/evidence';
import { GovernanceOperationReceiptSchema, GovernanceOperationStateSchema } from '../contracts/governance-operation';
import { HandoffOperationReceiptSchema, HandoffOperationStateSchema } from '../contracts/handoff-operation';
import { DemoExportReceiptSchema } from '../contracts/demo-export';
import { TaskReceiptSchema } from '../contracts/task-record';
import { ReviewOperationReceiptSchema } from '../contracts/review-session';
import { OperationRecoveryQuerySchema, OperationRecoverySchema, type OperationRecovery, type OperationRecoveryQuery } from '../contracts/operation-recovery';
import { ModelOperationSchema } from './model';
import type { OperationJournal } from './journal';
import type { SessionRegistry } from './identity';
import type { ApprovalAuthority } from './approvals';
import { failure } from './result';

const stageForRegistration = (state: ApprovalRegistrationState['status']): OperationRecovery['stage'] => state === 'registered' ? 'approved'
  : state === 'revoked' ? 'revoked' : state === 'expired' ? 'expired' : state === 'unknown' ? 'unknown' : 'not_registered';
const stageForConversation = (state: 'inflight' | 'unknown' | 'done'): OperationRecovery['stage'] => state === 'inflight' ? 'sending' : state;
const scopeFor = (query: OperationRecoveryQuery) => query.kind === 'capture' ? 'conversation:write'
  : query.kind === 'model' ? `model:${query.modelPurpose}` : query.kind === 'evidence' ? 'evidence:write'
    : query.kind === 'task' ? 'task:read' : query.kind === 'review' ? 'evidence:read' : query.kind === 'handoff' ? 'draft:read' : query.kind === 'demo_export' ? 'data:export' : 'workspace:read';

export class OperationRecoveryStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly approvals: ApprovalAuthority) {}

  private access(ctx: RequestContext, scope: string) {
    const access = this.sessions.authorize(ctx, scope);
    if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure<never>('FORBIDDEN', 'Operation recovery requires durable storage', 'configure_operation_storage');
    return access;
  }

  private base(ctx: RequestContext, query: OperationRecoveryQuery, values: Partial<OperationRecovery> = {}): OperationRecovery {
    return OperationRecoverySchema.parse({ kind: query.kind, operationId: query.operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
      approvalId: null, recordId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null,
      stage: 'not_registered', readOnly: true, absenceIsFinal: false, ...values });
  }

  private fromRegistration(ctx: RequestContext, query: OperationRecoveryQuery, registration: ApprovalRegistrationState, values: Partial<OperationRecovery> = {}) {
    return this.base(ctx, query, { approvalId: registration.approval?.id ?? null, purpose: (query.kind === 'model' ? query.modelPurpose : undefined) ?? registration.approval?.purpose ?? null,
      requestHash: registration.requestHash, contentHash: registration.approval?.contentHash ?? null, baseRevision: registration.approval?.baseRevision ?? null,
      objectIds: registration.approval?.objectIds ?? [], approvalExpiresAt: registration.approval?.expiresAt ?? null, stage: stageForRegistration(registration.status), ...values });
  }

  private registration(ctx: RequestContext, query: OperationRecoveryQuery): Result<ApprovalRegistrationState> {
    const purpose = query.kind === 'capture' ? 'save_conversation' : query.kind === 'model' ? 'model_input' : query.kind === 'evidence' ? 'save_evidence' : 'demo_export';
    return this.approvals.readRegistration(ctx, { operationId: query.operationId, purpose, ...(query.kind === 'model' ? { modelPurpose: query.modelPurpose } : {}) });
  }

  read(ctx: RequestContext, supplied: unknown): Result<OperationRecovery> {
    const parsed = OperationRecoveryQuerySchema.safeParse(supplied);
    if (!parsed.success) return failure('VALIDATION', 'The original operation kind, ID and model purpose are required', 'read_operation_recovery');
    const query = parsed.data;
    const access = this.access(ctx, scopeFor(query)); if (!access.ok) return access;
    try {
      if (query.kind === 'review') {
        const row = this.journal.record(ctx.workspaceId, '@workspace', 'review_operation_receipt', query.operationId);
        if (!row) return { ok: true, data: this.base(ctx, query) };
        const receipt = z.object({ receipt: ReviewOperationReceiptSchema }).strict().parse(row.value).receipt;
        if (receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) return { ok: true, data: this.base(ctx, query, { stage: 'unknown' }) };
        return { ok: true, data: this.base(ctx, query, { recordId: receipt.attemptId, requestHash: receipt.requestHash, purpose: receipt.kind, stage: 'saved' }) };
      }
      if (['capture', 'model', 'evidence', 'demo_export'].includes(query.kind)) {
        const registration = this.registration(ctx, query);
        if (!registration.ok) return registration;
        let recovery = this.fromRegistration(ctx, query, registration.data);
        if (query.kind === 'model') {
          const approval = registration.data.approval;
          if (!approval) return { ok: true, data: recovery };
          const operation = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approval.id);
          if (!operation) return { ok: true, data: recovery };
          const parsedOperation = ModelOperationSchema.parse(operation.value);
          if (parsedOperation.actorId !== ctx.actorId || parsedOperation.contentHash !== approval.contentHash || parsedOperation.purpose !== query.modelPurpose) return { ok: true, data: this.base(ctx, query, { stage: 'unknown' }) };
          return { ok: true, data: this.fromRegistration(ctx, query, registration.data, { stage: parsedOperation.state, purpose: query.modelPurpose, objectIds: approval.objectIds }) };
        }
        if (query.kind === 'evidence') {
          const row = this.journal.record(ctx.workspaceId, '@workspace', 'evidence_receipt', query.operationId);
          if (!row) return { ok: true, data: recovery };
          const receipt = EvidenceReceiptSchema.parse(row.value);
          return { ok: true, data: this.fromRegistration(ctx, query, registration.data, { stage: 'saved', recordId: receipt.recordId, contentHash: receipt.contentHash, baseRevision: receipt.baseRevision }) };
        }
        if (query.kind === 'demo_export') {
          const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'demo_export_receipt', query.operationId);
          if (!row) return { ok: true, data: recovery };
          const receipt = DemoExportReceiptSchema.parse(z.object({ receipt: DemoExportReceiptSchema }).strict().parse(row.value).receipt);
          return { ok: true, data: this.fromRegistration(ctx, query, registration.data, { stage: 'executed', objectIds: receipt.objectIds, contentHash: receipt.contentHash, baseRevision: receipt.baseRevision }) };
        }
        const conversationId = registration.data.approval?.objectIds[0];
        const conversation = conversationId ? this.journal.conversation(ctx.workspaceId, conversationId) : undefined;
        if (conversation && conversation.actorId === ctx.actorId) recovery = this.fromRegistration(ctx, query, registration.data, { stage: stageForConversation(conversation.state), objectIds: [conversation.objectId], contentHash: conversation.contentHash });
        return { ok: true, data: recovery };
      }

      if (query.kind === 'task') {
        const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'task_receipt', query.operationId);
        if (!row) return { ok: true, data: this.base(ctx, query) };
        const receipt = TaskReceiptSchema.parse(row.value);
        return { ok: true, data: this.base(ctx, query, { recordId: receipt.taskId, requestHash: receipt.requestHash, contentHash: receipt.contentHash,
          stage: 'saved' }) };
      }
      if (query.kind === 'handoff') {
        const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation_receipt', query.operationId);
        if (row) {
          const receipt = HandoffOperationReceiptSchema.parse(row.value);
          return { ok: true, data: this.base(ctx, query, { recordId: receipt.draftId, requestHash: receipt.requestHash, contentHash: receipt.contentHash,
            baseRevision: receipt.baseRevision, stage: 'saved' }) };
        }
        const state = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation', query.operationId);
        if (!state) return { ok: true, data: this.base(ctx, query) };
        const parsedState = HandoffOperationStateSchema.parse(state.value);
        return { ok: true, data: this.base(ctx, query, { requestHash: parsedState.requestHash, contentHash: parsedState.contentHash, stage: parsedState.state === 'available' ? 'saving' : 'expired' }) };
      }
      const receiptRow = this.journal.record(ctx.workspaceId, ctx.actorId, 'governance_operation_receipt', query.operationId);
      if (receiptRow) {
        const receipt = GovernanceOperationReceiptSchema.parse(receiptRow.value);
        return { ok: true, data: this.base(ctx, query, { requestHash: receipt.requestHash, contentHash: receipt.contentHash, baseRevision: receipt.baseRevision, purpose: receipt.kind, stage: 'saved' }) };
      }
      const stateRow = this.journal.record(ctx.workspaceId, ctx.actorId, 'governance_operation', query.operationId);
      if (!stateRow) return { ok: true, data: this.base(ctx, query) };
      const state = GovernanceOperationStateSchema.parse(stateRow.value);
      return { ok: true, data: this.base(ctx, query, { requestHash: state.requestHash, contentHash: state.contentHash, baseRevision: state.baseRevision,
        purpose: state.kind, stage: state.state === 'available' ? 'saved' : 'expired' }) };
    } catch { return { ok: true, data: this.base(ctx, query, { stage: 'unknown' }) }; }
  }
}
