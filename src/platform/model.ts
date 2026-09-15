import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { unavailable } from '../contracts/api';
import { Id, Timestamp, type Approval } from '../contracts/domain';
import { ModelApprovalRequestSchema, ModelCloseOperationRequestSchema, ModelInputSchema, ModelOperationReceiptSchema, type ModelApprovalRequest, type ModelOperationReceipt, type ModelCloseOperationRequest } from '../contracts/model';
import { CandidateOutputSchema, normalizedCandidateProjections } from '../contracts/candidates';
import { ExtractionStageSchema } from '../contracts/extraction';
import type { SettingsState } from '../contracts/governance';
import type { Services } from '../contracts/ports';
import { canonicalJson, contentHash, hashModelInput } from '../contracts/hash';
import type { SessionRegistry } from './identity';
import type { OperationJournal } from './journal';
import type { ApprovalAuthority } from './approvals';
import { failure } from './result';

type Input = z.infer<typeof ModelInputSchema>;
type ModelResponse = { value: unknown; modelId: string; generatedAt: string };
export interface ModelTransport {
  readonly mode: 'fixture' | 'live';
  ready?(ctx?: RequestContext): Result<true>;
  complete(ctx: RequestContext, input: Input & { maxOutputTokens: number }): Promise<Result<ModelResponse>>;
}
const ConstraintSchema = z.object({ purpose: z.enum(['extract', 'answer', 'review']), objectIds: z.array(Id), conversationId: Id.optional(), settingsRevision: z.number().int().nonnegative() }).strict();
const ExtractionProgressSchema = z.object({ conversationId: Id, conversationHash: Id, sourceIds: z.array(Id).max(100), stage: ExtractionStageSchema,
  settingsRevision: z.number().int().nonnegative(), batchRevision: z.number().int().nonnegative().optional(), candidateContentHash: Id.optional(),
  rejectionReason: z.enum(['invalid_reference', 'invalid_output', 'source_changed', 'approval_invalid']).optional(), retryAllowed: z.literal(false), updatedAt: Timestamp }).strict();
const OperationSchema = z.object({ actorId: Id, contentHash: Id, purpose: z.enum(['extract', 'answer', 'review']), state: z.enum(['sending', 'done', 'unknown', 'discarded', 'not_sent']), date: z.string(), expiresAt: z.number(), modelId: Id.optional(), generatedAt: Timestamp.optional(), candidateProjectionHash: Id.optional(), extraction: ExtractionProgressSchema.optional() }).strict();
export { ConstraintSchema as ModelConstraintSchema, OperationSchema as ModelOperationSchema };
const modelUnknown = <T>(): Result<T> => failure('UNKNOWN_RESULT', 'The model call was not verified and will not be repeated automatically', 'review_model_operation', 'unknown');

export class BoundedModel {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly approvals: ApprovalAuthority,
    private readonly transport: ModelTransport, private readonly settings: (ctx: RequestContext) => Result<SettingsState>,
    private readonly snapshot: Services['snapshot'], private readonly conversation: Services['readConversation']) {}

  read(ctx: RequestContext, approvalId: string): Result<ModelOperationReceipt | null> {
    const access = this.sessions.authorize(ctx, 'workspace:read'); if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure('FORBIDDEN', 'Live operation readback requires durable storage', 'configure_operation_storage');
    if (!Id.safeParse(approvalId).success) return failure('VALIDATION', 'A valid original model approval ID is required', 'read_model_operation');
    try {
      const approved = this.journal.approval(approvalId)?.value;
      if (!approved) return { ok: true, data: null };
      if (approved.actorId !== ctx.actorId || approved.workspaceId !== ctx.workspaceId || approved.purpose !== 'model_input') return failure('FORBIDDEN', 'Model operation is unavailable to this identity', 'select_authorized_workspace');
      const constraint = ConstraintSchema.parse(this.journal.record(ctx.workspaceId, ctx.actorId, 'model_constraint', approvalId)?.value);
      const permission = this.sessions.authorize(ctx, `model:${constraint.purpose}`); if (!permission.ok) return permission;
      const record = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approvalId);
      if (!record) return { ok: true, data: null };
      const operation = OperationSchema.parse(record.value);
      if (operation.actorId !== ctx.actorId || operation.contentHash !== approved.contentHash || operation.purpose !== constraint.purpose) throw new Error('Model operation identity mismatch');
      return { ok: true, data: ModelOperationReceiptSchema.parse({ approvalId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, contentHash: operation.contentHash,
        baseRevision: approved.baseRevision, purpose: operation.purpose, state: operation.state === 'sending' && operation.expiresAt <= Date.now() ? 'unknown' : operation.state,
        ...(operation.modelId ? { modelId: operation.modelId } : {}), ...(operation.generatedAt ? { generatedAt: operation.generatedAt } : {}) }) };
    } catch { return failure('INTERNAL', 'Stored model operation could not be verified', 'repair_operation_storage', 'preserved'); }
  }

  close(ctx: RequestContext, supplied: unknown): Result<ModelOperationReceipt> {
    const parsed = ModelCloseOperationRequestSchema.safeParse(supplied);
    if (!parsed.success) return failure('VALIDATION', 'The original model operation binding and explicit close confirmation are required', 'read_model_operation');
    const request: ModelCloseOperationRequest = parsed.data;
    const access = this.sessions.authorize(ctx, `model:${request.purpose}`); if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure('FORBIDDEN', 'Model close requires durable operation storage', 'configure_operation_storage');
    const registered = this.journal.approval(request.approvalId);
    if (!registered || registered.value.actorId !== ctx.actorId || registered.value.workspaceId !== ctx.workspaceId || registered.value.purpose !== 'model_input'
      || registered.value.contentHash !== request.contentHash || registered.value.baseRevision !== request.baseRevision) return failure('FORBIDDEN', 'The close request does not match the original model approval', 'read_model_operation');
    const constraint = this.journal.record(ctx.workspaceId, ctx.actorId, 'model_constraint', request.approvalId);
    if (!constraint) return failure('UNKNOWN_RESULT', 'The original model operation constraint is unavailable', 'read_model_operation', 'unknown');
    const parsedConstraint = ConstraintSchema.safeParse(constraint.value);
    if (!parsedConstraint.success || parsedConstraint.data.purpose !== request.purpose) return failure('FORBIDDEN', 'The close request purpose does not match the original model operation', 'read_model_operation');
    try {
      return this.journal.transaction(() => {
        const existing = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', request.approvalId);
        if (existing) {
          const operation = OperationSchema.parse(existing.value);
          if (operation.state === 'not_sent') return { ok: true, data: ModelOperationReceiptSchema.parse({ approvalId: request.approvalId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, contentHash: operation.contentHash, baseRevision: registered.value.baseRevision, purpose: operation.purpose, state: 'not_sent' }) };
          return failure('UNKNOWN_RESULT', 'The original model transmission already has a possible in-flight or completed state', 'read_model_operation', 'unknown');
        }
        const operation = { actorId: ctx.actorId, contentHash: request.contentHash, purpose: request.purpose, state: 'not_sent' as const,
          date: new Date().toISOString().slice(0, 10), expiresAt: 0 };
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'model_operation', request.approvalId, operation, null)) return failure('UNKNOWN_RESULT', 'The close marker was not verified', 'read_model_operation', 'unknown');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, `model_${request.purpose}`, registered.value.objectIds, 'not_sent');
        return { ok: true, data: ModelOperationReceiptSchema.parse({ approvalId: request.approvalId, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
          contentHash: request.contentHash, baseRevision: request.baseRevision, purpose: request.purpose, state: 'not_sent' }) };
      });
    } catch { return failure('UNKNOWN_RESULT', 'The original model close result is unknown; read the original operation', 'read_model_operation', 'unknown'); }
  }

  private policy(ctx: RequestContext, purpose: Input['purpose']): Result<SettingsState> {
    const access = this.sessions.authorize(ctx, `model:${purpose}`);
    if (!access.ok) return access;
    if (ctx.mode !== this.transport.mode || (ctx.mode === 'live' && this.journal.fixture)) return failure('FORBIDDEN', 'Model transport does not match the trusted operation mode', 'configure_model_transport');
    const ready = this.transport.ready?.(ctx);
    if (ready && !ready.ok) return ready;
    const current = this.settings(ctx);
    if (!current.ok) return current;
    const key = { extract: 'aiExtraction', answer: 'aiAnswer', review: 'aiReview' } as const;
    return current.data.settings[key[purpose]] ? current : failure('FORBIDDEN', 'This AI purpose is disabled by server settings', 'continue_without_ai');
  }

  private async sources(ctx: RequestContext, input: ModelApprovalRequest): Promise<Result<true>> {
    if (input.input.purpose === 'extract') {
      if (!input.conversationId || canonicalJson([...input.objectIds].sort()) !== canonicalJson([...input.input.sourceIds].sort())) return failure('VALIDATION', 'Extraction must identify the selected saved conversation and segments', 'preview_model_scope');
      const conversation = await this.conversation(ctx, input.conversationId);
      if (!conversation.ok) return conversation;
      if (conversation.data.state !== 'saved' || !conversation.data.sourceAlreadyPersisted || conversation.data.contentHash !== input.baseRevision
        || input.input.sourceIds.some((id) => !conversation.data.segments.some((segment) => segment.id === id))) return failure('CONFLICT', 'Saved extraction sources changed', 'preview_model_scope');
      return { ok: true, data: true };
    }
    const snapshot = await this.snapshot(ctx);
    if (!snapshot.ok) return snapshot;
    if (snapshot.data.revision !== input.baseRevision) return failure('CONFLICT', 'Model knowledge base changed', 'preview_model_scope');
    const nodes = snapshot.data.nodes.filter((node) => input.objectIds.includes(node.id) && node.confirmation === 'confirmed' && node.lifecycle === 'active' && !snapshot.data.excludedIds.includes(node.id));
    const sourceIds = new Set(nodes.flatMap((node) => node.sources.map((source) => source.id)));
    if (nodes.length !== input.objectIds.length || input.input.sourceIds.some((id) => !sourceIds.has(id))) return failure('FORBIDDEN', 'Model sources are outside the approved current knowledge scope', 'preview_model_scope');
    return { ok: true, data: true };
  }

  async approve(ctx: RequestContext, input: unknown): Promise<Result<Approval>> {
    const parsed = ModelApprovalRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'A confirmed bounded model preview is required', 'preview_model_scope');
    const request = parsed.data;
    const access = this.sessions.authorize(ctx, `model:${request.input.purpose}`); if (!access.ok) return access;
    const registration = { operationId: request.operationId, requestHash: await contentHash(request), modelPurpose: request.input.purpose };
    const previous = this.approvals.previousRegistration(ctx, 'model_input', registration);
    if (!previous.ok) return previous;
    if (previous.data) return { ok: true, data: previous.data };
    const policy = this.policy(ctx, request.input.purpose); if (!policy.ok) return policy;
    const sourceCheck = await this.sources(ctx, request); if (!sourceCheck.ok) return sourceCheck;
    const hash = await hashModelInput(request.input);
    return this.approvals.registerOperation(ctx, { purpose: 'model_input', objectIds: request.objectIds, contentHash: hash, baseRevision: request.baseRevision }, {
      ...registration, constraint: { kind: 'model_constraint', value: { purpose: request.input.purpose, objectIds: request.objectIds,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}), settingsRevision: policy.data.revision } },
      beforeRegister: () => {
        const current = this.policy(ctx, request.input.purpose); if (!current.ok) return current;
        if (current.data.revision !== policy.data.revision) return failure('CONFLICT', 'AI settings changed during approval', 'preview_model_scope');
        return { ok: true, data: true };
      },
    });
  }

  async complete(ctx: RequestContext, supplied: Input & { approval: Approval }): Promise<Result<ModelResponse>> {
    const parsed = ModelInputSchema.safeParse({ purpose: supplied.purpose, text: supplied.text, sourceIds: supplied.sourceIds });
    if (!parsed.success) return failure('VALIDATION', 'Model input exceeds the supported scope or size', 'reduce_model_scope');
    const input = parsed.data, approval = supplied.approval;
    const policy = this.policy(ctx, input.purpose); if (!policy.ok) return policy;
    const hash = await hashModelInput(input);
    const expected = { purpose: 'model_input' as const, objectIds: approval.objectIds, contentHash: hash, baseRevision: approval.baseRevision };
    const valid = this.approvals.validate(ctx, `model:${input.purpose}`, approval, expected); if (!valid.ok) return valid;
    const constraint = ConstraintSchema.safeParse(this.journal.record(ctx.workspaceId, ctx.actorId, 'model_constraint', approval.id)?.value);
    if (!constraint.success || constraint.data.purpose !== input.purpose || constraint.data.settingsRevision !== policy.data.revision) return failure('CONFLICT', 'Model settings or approval constraints changed', 'preview_model_scope');
    const sourceRequest: ModelApprovalRequest = { input, objectIds: valid.data.objectIds, baseRevision: valid.data.baseRevision, ...(constraint.data.conversationId ? { conversationId: constraint.data.conversationId } : {}), confirmed: true };
    const sourceCheck = await this.sources(ctx, sourceRequest); if (!sourceCheck.ok) return sourceCheck;
    const operation = { actorId: ctx.actorId, contentHash: hash, purpose: input.purpose, state: 'sending' as const, date: new Date().toISOString().slice(0, 10), expiresAt: Date.now() + 120_000,
      ...(input.purpose === 'extract' ? { extraction: { conversationId: sourceRequest.conversationId!, conversationHash: sourceRequest.baseRevision,
        sourceIds: [...sourceRequest.input.sourceIds], stage: 'model_sending' as const, settingsRevision: constraint.data.settingsRevision,
        retryAllowed: false as const, updatedAt: new Date().toISOString() } } : {}) };
    try {
      const claim = this.journal.transaction((): Result<true> => {
        const current = this.policy(ctx, input.purpose); if (!current.ok) return current;
        if (current.data.revision !== constraint.data.settingsRevision) return failure('CONFLICT', 'AI settings changed before transmission', 'preview_model_scope');
        const stillValid = this.approvals.validate(ctx, `model:${input.purpose}`, approval, expected); if (!stillValid.ok) return stillValid;
        if (input.purpose === 'extract' && sourceRequest.conversationId) {
          // Two already-approved callers may race to finish one preview. A new caller may not
          // reuse a source after an older attempt became unknown or reached a terminal stage.
          for (const originalId of this.journal.extractionOperationIds(ctx.workspaceId, ctx.actorId, sourceRequest.conversationId)) {
            if (originalId === approval.id) continue;
            const prior = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', originalId);
            const priorOperation = prior ? OperationSchema.parse(prior.value) : undefined;
            const activeSending = priorOperation?.state === 'sending' && priorOperation.expiresAt > Date.now()
              && priorOperation.extraction?.stage === 'model_sending';
            if (!activeSending) return failure('CONFLICT', 'An original extraction operation for this conversation must be verified before another paid attempt', 'read_extraction_state', 'preserved');
          }
        }
        const existing = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approval.id);
        if (existing) return OperationSchema.parse(existing.value).state === 'done' ? failure('CONFLICT', 'This model approval was already used', 'read_existing_result', 'preserved') : modelUnknown();
        const usage = this.journal.modelBudgetUsage(ctx.workspaceId, operation.date, Date.now());
        if (usage.daily >= 20 || usage.active >= 2) return failure('FORBIDDEN', 'The server model request budget is exhausted', 'wait_for_model_budget');
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'model_operation', approval.id, operation, null)) return modelUnknown();
        return { ok: true, data: true };
      });
      if (!claim.ok) return claim;
    } catch { return failure('INTERNAL', 'Model operation could not be registered; no call was sent', 'check_operation_storage'); }
    const finish = (state: 'done' | 'unknown' | 'discarded', modelId?: string, generatedAt?: string, candidateProjectionHash?: string,
      extractionStage?: z.infer<typeof ExtractionStageSchema>, rejectionReason?: 'invalid_reference' | 'invalid_output' | 'source_changed' | 'approval_invalid') => {
      const current = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approval.id);
      if (!current) throw new Error('Original model operation disappeared');
      const stored = OperationSchema.parse(current.value);
      const extraction = stored.extraction ? { ...stored.extraction, stage: extractionStage ?? (state === 'unknown' ? 'unknown' : 'model_done'),
        ...(rejectionReason ? { rejectionReason } : {}), updatedAt: new Date().toISOString() } : undefined;
      if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'model_operation', approval.id, { ...stored, state, ...(modelId ? { modelId } : {}), ...(generatedAt ? { generatedAt } : {}), ...(candidateProjectionHash ? { candidateProjectionHash } : {}), ...(extraction ? { extraction } : {}) }, current.version)) throw new Error('Model operation result was not recorded');
      this.journal.addAudit(ctx.workspaceId, ctx.actorId, `model_${input.purpose}`, valid.data.objectIds, state);
    };
    try {
      const result = await this.transport.complete(ctx, { ...input, maxOutputTokens: 2048 });
      if (!result.ok) { finish('unknown'); return result.error.dataState === 'unknown' ? modelUnknown() : { ok: false, error: { ...result.error, dataState: 'preserved', retryable: false } }; }
      // Settings, approval and source validity are checked before interpreting the
      // response. A response that arrived after shutdown is discarded even when its
      // shape would also be invalid; otherwise an in-flight extract could be marked
      // done merely because candidate validation ran first.
      const stillAvailableBeforeAccept = await this.sources(ctx, sourceRequest);
      const currentBeforeAccept = this.policy(ctx, input.purpose);
      const stillValidBeforeAccept = this.approvals.validate(ctx, `model:${input.purpose}`, approval, expected);
      if (!currentBeforeAccept.ok || currentBeforeAccept.data.revision !== constraint.data.settingsRevision || !stillValidBeforeAccept.ok || !stillAvailableBeforeAccept.ok) {
        finish('discarded', undefined, undefined, undefined, input.purpose === 'extract' ? 'rejected_without_save' : undefined,
          input.purpose === 'extract' ? 'source_changed' : undefined);
        return failure('FORBIDDEN', 'The in-flight AI output was discarded after settings, approval or sources changed', 'continue_without_ai', 'preserved');
      }
      const response = z.object({ value: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]), modelId: Id, generatedAt: Timestamp }).strict().safeParse(result.data);
      if (!response.success || Buffer.byteLength(canonicalJson(response.data.value)) > 128_000) { finish('discarded', undefined, undefined, undefined, input.purpose === 'extract' ? 'rejected_without_save' : undefined, input.purpose === 'extract' ? 'invalid_output' : undefined); return failure('UPSTREAM', 'Model output failed the structured response limit', 'continue_without_ai', 'preserved'); }
      const candidates = input.purpose === 'extract' ? CandidateOutputSchema.safeParse(response.data.value) : null;
      if (input.purpose === 'extract' && candidates && !candidates.success) {
        finish('done', response.data.modelId, response.data.generatedAt, undefined, 'rejected_without_save', 'invalid_output');
        return failure('UPSTREAM', 'Model output failed candidate validation; no candidate save was attempted', 'continue_manually', 'preserved');
      }
      const projectionHash = candidates?.success ? await contentHash(normalizedCandidateProjections(candidates.data.candidates)) : undefined;
      if (input.purpose === 'extract' && candidates?.success) {
        const source = await this.conversation(ctx, sourceRequest.conversationId!);
        // A changed source is handled by the later source recheck and remains a
        // preserved conflict, rather than being mislabeled as a bad citation.
        const validReferences = !source.ok || source.data.contentHash !== sourceRequest.baseRevision || (source.data.state === 'saved'
          && candidates.data.candidates.every((candidate) => candidate.spans.every((span) => {
            const segment = source.data.segments.find((item) => item.id === span.segmentId);
            return !!segment && sourceRequest.input.sourceIds.includes(span.segmentId) && span.end > span.start && span.end <= segment.text.length
              && !(span.start > 0 && /[\uD800-\uDBFF]/.test(segment.text[span.start - 1]!) && /[\uDC00-\uDFFF]/.test(segment.text[span.start]!))
              && !(span.end > 0 && /[\uD800-\uDBFF]/.test(segment.text[span.end - 1]!) && /[\uDC00-\uDFFF]/.test(segment.text[span.end]!))
              && segment.text.slice(span.start, span.end) === span.quote;
          })));
        if (!validReferences) {
          finish('done', response.data.modelId, response.data.generatedAt, undefined, 'rejected_without_save', 'invalid_reference');
          return failure('UPSTREAM', 'Model output cited text outside the approved source; no candidate save was attempted', 'continue_manually', 'preserved');
        }
      }
      const stillAvailable = await this.sources(ctx, sourceRequest);
      const current = this.policy(ctx, input.purpose);
      const stillValid = this.approvals.validate(ctx, `model:${input.purpose}`, approval, expected);
      if (!current.ok || current.data.revision !== constraint.data.settingsRevision || !stillValid.ok || !stillAvailable.ok) { finish('discarded', response.data.modelId, undefined, undefined, input.purpose === 'extract' ? 'rejected_without_save' : undefined, input.purpose === 'extract' ? 'source_changed' : undefined); return failure('FORBIDDEN', 'The in-flight AI output was discarded after settings, approval or sources changed', 'continue_without_ai', 'preserved'); }
      finish('done', response.data.modelId, response.data.generatedAt, projectionHash);
      return { ok: true, data: response.data };
    } catch { try { finish('unknown'); } catch { /* Durable sending state remains recoverable as unknown. */ } return modelUnknown(); }
  }
}

export const missingModelSettings = (): Result<SettingsState> => unavailable('Trusted settings storage is required for AI');
