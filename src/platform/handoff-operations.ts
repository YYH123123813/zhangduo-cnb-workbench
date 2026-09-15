import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { Id, SourceSpanSchema, Timestamp, type HandoffDraft } from '../contracts/domain';
import type { DraftState } from '../contracts/handoff';
import { HandoffOperationReceiptSchema, HandoffOperationSaveRequestSchema, HandoffOperationSnapshotSchema, HandoffOperationStateSchema,
  type HandoffOperationReceipt, type HandoffOperationSaveRequest, type HandoffOperationSnapshot, type HandoffOperationState } from '../contracts/handoff-operation';
import { canonicalJson, contentHash, hashChangeSet, hashConversation, hashSegment } from '../contracts/hash';
import type { Services } from '../contracts/ports';
import type { SessionRegistry } from './identity';
import type { OperationJournal, StoredRecord } from './journal';
import { applyKnowledgeChanges } from './cnb/knowledge-document';
import { failure } from './result';

const StoredSchema = z.object({ state: z.enum(['available', 'expired']), requestHash: Id, contentHash: Id,
  snapshot: HandoffOperationSnapshotSchema.nullable(), sourceSpans: z.array(SourceSpanSchema), referencedIds: z.array(Id), expiresAt: Timestamp }).strict();
const DraftBindingSchema = z.object({ state: z.literal('available'), contentHash: Id, conversationHash: Id,
  objectIds: z.array(Id), spans: z.array(SourceSpanSchema), expiresAt: Timestamp });
const conflict = <T>(message = 'The original preview or its pinned draft version changed'): Result<T> =>
  failure('CONFLICT', message, 'read_original_handoff_operation', 'preserved');

function matchesSavedDraft(draft: HandoffDraft, saved: DraftState, actorId: string): boolean {
  if (saved.document?.kind === 'draft') return canonicalJson(draft) === canonicalJson(saved.document.value);
  if (saved.document?.kind !== 'progress' || !saved.source) return false;
  const progress = saved.document.value;
  if (progress.disposition !== 'handoff' || !progress.statement.trim()) return false;
  const evidenced = progress.sources.filter((source) => source.kind !== 'ai_inference' && source.excerpt.trim() && source.supportedClaim.trim());
  const evidenceStatus = progress.sources.some((source) => source.support === 'does_not_support') ? 'disputed'
    : evidenced.length && evidenced.length === progress.sources.length && evidenced.every((source) => source.support === 'supports') ? 'supported'
      : evidenced.some((source) => ['supports', 'partial'].includes(source.support)) ? 'partial' : 'unverified';
  const candidateId = saved.source.kind === 'candidate' ? saved.source.candidateId : null;
  const expected: HandoffDraft = { id: progress.id, conversationId: progress.conversationId, baseRevision: progress.baseRevision,
    candidateId, relations: progress.relations, node: { id: progress.nodeId, workspaceId: progress.workspaceId, schemaVersion: 1,
      revision: progress.baseRevision, title: progress.title, question: progress.question, humanStatement: progress.statement.trim(),
      authorship: progress.authorship, kind: progress.kind, candidateIds: candidateId ? [candidateId] : [], conversationId: progress.conversationId,
      conditions: progress.conditions.map(({ confirmedBy: _actor, ...condition }) => ({ ...condition, text: condition.text.trim() || '适用前提尚未核验',
        ...(condition.status === 'confirmed' ? { confirmedBy: actorId } : {}) })), boundaries: progress.boundaries.map((text) => text.trim()).filter(Boolean),
      sources: progress.sources, confirmation: 'draft', evidenceStatus,
      lifecycle: evidenceStatus === 'disputed' || progress.conditions.some((condition) => condition.status === 'rejected') ? 'needs_review' : 'active',
      updatedAt: draft.node.updatedAt } };
  return canonicalJson(expected) === canonicalJson(draft);
}

export class HandoffOperationStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal,
    private readonly draftState: NonNullable<Services['readDraftState']>, private readonly conversation: Services['readConversation'],
    private readonly snapshot: Services['snapshot']) {}

  private access(ctx: RequestContext, write = false, ids: string[] = [], candidate = false) {
    const access = this.sessions.authorize(ctx, 'draft:read'); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return failure<never>('FORBIDDEN', 'Private durable operation storage is required', 'configure_private_storage');
    for (const scope of ['conversation:read', 'knowledge:read', ...(write ? ['draft:write'] : []), ...(candidate ? ['candidate:read'] : [])]) {
      const allowed = this.sessions.authorize(ctx, scope); if (!allowed.ok) return allowed;
    }
    const blocked = new Set(this.journal.blocked(ctx.workspaceId));
    if (ids.some((id) => blocked.has(id))) return failure<never>('FORBIDDEN', 'The original operation references blocked content', 'review_delete_report', 'preserved');
    return access;
  }

  private publicState(ctx: RequestContext, id: string, row?: StoredRecord): HandoffOperationState {
    const stored = row ? StoredSchema.parse(row.value) : null;
    return HandoffOperationStateSchema.parse({ operationId: id, workspaceId: ctx.workspaceId, actorId: ctx.actorId,
      state: stored?.state ?? 'missing', revision: row?.version ?? 0, requestHash: stored?.requestHash ?? null, contentHash: stored?.contentHash ?? null,
      snapshot: stored?.snapshot ?? null, ...(stored ? { expiresAt: stored.expiresAt } : {}), retentionDays: 30, absenceIsFinal: false, readOnly: true });
  }

  receipt(ctx: RequestContext, id: string): Result<HandoffOperationReceipt | null> {
    const access = this.sessions.authorize(ctx, 'draft:read'); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return failure('FORBIDDEN', 'Private durable operation storage is required', 'configure_private_storage');
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'Original ChangeSet ID is required', 'read_original_handoff_operation');
    try {
      const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation_receipt', id);
      if (!row) return { ok: true, data: null };
      const receipt = HandoffOperationReceiptSchema.parse(row.value);
      if (receipt.operationId !== id || receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) throw Error('Receipt identity mismatch');
      return { ok: true, data: receipt };
    } catch { return failure('INTERNAL', 'Original operation receipt could not be verified', 'repair_private_storage', 'unknown'); }
  }

  async read(ctx: RequestContext, id: string): Promise<Result<HandoffOperationState>> {
    const access = this.access(ctx, false, [id]); if (!access.ok) return access;
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'Original ChangeSet ID is required', 'read_original_handoff_operation');
    try {
      let row = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation', id);
      if (!row) return { ok: true, data: this.publicState(ctx, id) };
      let stored = StoredSchema.parse(row.value);
      if (stored.state === 'available' && Date.parse(stored.expiresAt) <= Date.now()) {
        this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'handoff_operation', id, { ...stored, state: 'expired', snapshot: null, sourceSpans: [] }, row.version);
        row = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation', id)!; stored = StoredSchema.parse(row.value);
      }
      const original = stored.snapshot, candidate = original?.source.kind === 'candidate';
      const allowed = this.access(ctx, false, stored.referencedIds, candidate); if (!allowed.ok) return allowed;
      if (stored.state === 'available') {
        const receipt = this.receipt(ctx, id); if (!receipt.ok) return receipt;
        if (!original || !receipt.data || original.changes.id !== id || original.changes.workspaceId !== ctx.workspaceId
          || await contentHash(original) !== stored.contentHash || stored.contentHash !== receipt.data.contentHash || stored.requestHash !== receipt.data.requestHash
          || await hashChangeSet(original.changes) !== receipt.data.changeSetHash) throw Error('Original operation integrity mismatch');
        const conversation = await this.conversation(ctx, original.draft.conversationId); if (!conversation.ok) return conversation;
        if (conversation.data.workspaceId !== ctx.workspaceId || conversation.data.state !== 'saved' || !conversation.data.sourceAlreadyPersisted
          || conversation.data.contentHash !== receipt.data.conversationHash || await hashConversation(conversation.data) !== receipt.data.conversationHash)
          return conflict('The original source changed; the saved preview cannot be restored');
        for (const span of stored.sourceSpans) {
          const segment = conversation.data.segments.find((item) => item.id === span.segmentId);
          if (!segment || span.conversationId !== conversation.data.id || span.end > segment.text.length
            || segment.text.slice(span.start, span.end) !== span.quote || await hashSegment(conversation.data.id, segment) !== span.contentHash)
            return conflict('Original source spans cannot be verified');
        }
        const basis = await this.snapshot(ctx, original.changes.baseRevision); if (!basis.ok) return basis;
        const valid = applyKnowledgeChanges(ctx, basis.data, original.changes); if (!valid.ok) return valid;
      }
      const final = this.access(ctx, false, stored.referencedIds, candidate); if (!final.ok) return final;
      // Source checks await remote reads. A second SQLite connection may clear the body before they return.
      const current = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation', id);
      if (!current) return conflict('Original operation state disappeared during verification');
      if (current.version !== row.version) {
        if (StoredSchema.parse(current.value).state !== 'expired') return conflict('Original operation state changed during verification');
        return { ok: true, data: this.publicState(ctx, id, current) };
      }
      if (stored.state === 'available' && Date.parse(stored.expiresAt) <= Date.now()) return this.read(ctx, id);
      return { ok: true, data: this.publicState(ctx, id, row) };
    } catch { return failure('INTERNAL', 'Original preview could not be verified', 'repair_private_storage', 'preserved'); }
  }

  async save(ctx: RequestContext, input: HandoffOperationSaveRequest): Promise<Result<HandoffOperationState>> {
    const access = this.access(ctx, true); if (!access.ok) return access;
    const parsed = HandoffOperationSaveRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'An exact saved draft, original preview and explicit private retention consent are required', 'preview_original_operation');
    const request = parsed.data, { draft, changes, source } = request, id = changes.id;
    const allowed = this.access(ctx, true, [id, draft.id], source.kind === 'candidate'); if (!allowed.ok) return allowed;
    if (changes.workspaceId !== ctx.workspaceId || draft.node.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'Operation workspace does not match the trusted identity', 'select_workspace');
    try {
      const requestHash = await contentHash(request), prior = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation', id);
      if (prior) {
        const original = StoredSchema.parse(prior.value);
        if (original.requestHash !== requestHash || original.state !== 'available' || Date.parse(original.expiresAt) <= Date.now()) return conflict('Original operations are immutable and cannot renew expired consent');
        return this.read(ctx, id);
      }
      const saved = await this.draftState(ctx, draft.id); if (!saved.ok) return saved;
      const savedDraft = saved.data;
      if (savedDraft.state !== 'available' || savedDraft.revision !== request.draftRevision || savedDraft.contentHash !== request.draftContentHash
        || savedDraft.conversationHash !== request.expectedConversationHash || !savedDraft.expiresAt || Date.parse(savedDraft.expiresAt) <= Date.now()
        || canonicalJson(savedDraft.source) !== canonicalJson(source) || !matchesSavedDraft(draft, savedDraft, ctx.actorId)
        || await contentHash({ document: savedDraft.document, source }) !== request.draftContentHash) return conflict();
      const confirmed = changes.nodes[0]!;
      if (draft.node.confirmation !== 'draft' || draft.node.confirmedAt || draft.node.confirmedBy || draft.node.revision !== changes.baseRevision
        || Date.parse(draft.node.updatedAt) > Date.now() || !confirmed.confirmedAt || Date.parse(confirmed.confirmedAt) > Date.now()
        || Date.parse(confirmed.confirmedAt) < Date.parse(draft.node.updatedAt) || !changes.reason.trim() || changes.reason.length > 4000
        || canonicalJson(confirmed) !== canonicalJson({ ...draft.node, confirmation: 'confirmed', confirmedBy: ctx.actorId, confirmedAt: confirmed.confirmedAt, updatedAt: confirmed.confirmedAt })
        || canonicalJson(changes.relations) !== canonicalJson(draft.relations) || await hashChangeSet(changes) !== changes.contentHash)
        return conflict('Original ChangeSet does not match the exact reviewed draft');
      const basis = await this.snapshot(ctx); if (!basis.ok) return basis;
      if (basis.data.nodes.some((node) => node.id === draft.node.id) || basis.data.relations.some((edge) => changes.relations.some((item) => item.id === edge.id))) return conflict('Handoff cannot overwrite existing knowledge');
      const valid = applyKnowledgeChanges(ctx, basis.data, changes); if (!valid.ok) return valid;
      const snapshot: HandoffOperationSnapshot = { draft, changes, source, savedDraft };
      const hash = await contentHash(snapshot);
      if (Buffer.byteLength(canonicalJson(snapshot)) > 700_000) return failure('VALIDATION', 'Original preview exceeds private storage limits', 'reduce_original_scope');
      return this.journal.transaction((): Result<HandoffOperationState> => {
        const current = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff', draft.id);
        const binding = DraftBindingSchema.safeParse(current?.value);
        if (!binding.success || current?.version !== request.draftRevision || binding.data.contentHash !== request.draftContentHash
          || binding.data.conversationHash !== request.expectedConversationHash || Date.parse(binding.data.expiresAt) <= Date.now()) return conflict();
        const ids = [...new Set([id, ...binding.data.objectIds])];
        const final = this.access(ctx, true, ids, source.kind === 'candidate'); if (!final.ok) return final;
        const existing = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation', id);
        if (existing) return StoredSchema.parse(existing.value).requestHash === requestHash && StoredSchema.parse(existing.value).contentHash === hash
          ? { ok: true, data: this.publicState(ctx, id, existing) } : conflict('Original operation ID is already bound to a different preview');
        const now = new Date().toISOString(), expiresAt = binding.data.expiresAt;
        const value = StoredSchema.parse({ state: 'available', requestHash, contentHash: hash, snapshot, sourceSpans: binding.data.spans, referencedIds: ids, expiresAt });
        if (!this.journal.privatePayloadFits(ctx.workspaceId, ctx.actorId, Buffer.byteLength(canonicalJson(value)))) return failure('VALIDATION', 'Private operation storage quota exceeded', 'review_storage_capacity');
        const receipt = HandoffOperationReceiptSchema.parse({ operationId: id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, draftId: draft.id,
          draftRevision: request.draftRevision, draftContentHash: request.draftContentHash, conversationId: draft.conversationId, conversationHash: request.expectedConversationHash,
          baseRevision: changes.baseRevision, changeSetHash: changes.contentHash, requestHash, contentHash: hash, revision: 1, storedAt: now, expiresAt, retentionDays: 30, outcome: 'saved' });
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'handoff_operation', id, value, null)
          || !this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'handoff_operation_receipt', id, receipt, null)) throw Error('Original operation transaction failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'handoff_operation_saved', [id, draft.id], 'private_not_approved');
        return { ok: true, data: this.publicState(ctx, id, this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff_operation', id)) };
      });
    } catch { return failure('UNKNOWN_RESULT', 'Original operation save could not be verified', 'read_original_handoff_operation', 'unknown'); }
  }
}
