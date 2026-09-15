import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { Id, SourceSpanSchema, Timestamp, type Conversation, type HandoffDraft } from '../contracts/domain';
import { DraftReceiptSchema, DraftSaveOptionsSchema, DraftStateSchema, HandoffDocumentSchema, HandoffSourceSchema,
  type DraftReceipt, type DraftSaveOptions, type DraftState, type ReviewProgress } from '../contracts/handoff';
import { canonicalJson, contentHash, hashConversation, hashSegment } from '../contracts/hash';
import type { Services } from '../contracts/ports';
import type { OperationJournal, StoredRecord } from './journal';
import type { SessionRegistry } from './identity';
import { failure } from './result';

type Document = z.infer<typeof HandoffDocumentSchema>;
const StoredSchema = z.object({ state: z.enum(['available', 'expired']), contentHash: Id, conversationHash: Id, conversationId: Id,
  source: HandoffSourceSchema.nullable(), spans: z.array(SourceSpanSchema), document: HandoffDocumentSchema.nullable(),
  objectIds: z.array(Id), expiresAt: Timestamp }).strict();
const StoredReceiptSchema = z.object({ requestHash: Id, receipt: DraftReceiptSchema }).strict();
const conflict = <T>(message = 'Draft version changed; the saved draft was not overwritten'): Result<T> => failure('CONFLICT', message, 'read_draft_state', 'preserved');
const nodeId = (document: Document) => document.kind === 'draft' ? document.value.node.id : document.value.nodeId;
const nodeFields = (document: Document) => document.kind === 'draft' ? document.value.node : document.value;
const objectIds = (document: Document, source: DraftSaveOptions['source']) => [...new Set([document.value.id, document.value.conversationId, nodeId(document),
  ...(source.kind === 'candidate' ? [source.candidateId] : source.spans.flatMap((span) => [span.id, span.segmentId])),
  ...nodeFields(document).sources.map((item) => item.id), ...nodeFields(document).conditions.flatMap((item) => item.evidenceIds),
  ...document.value.relations.flatMap((item) => [item.id, item.source.objectId, item.target.objectId, ...item.evidenceIds]),
  ...(document.kind === 'progress' ? [document.value.relationInput.targetId, ...document.value.relationInput.evidenceIds].filter(Boolean) : []),
])];

export class DraftStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly conversation: Services['readConversation'],
    private readonly candidates: Services['readCandidates'], private readonly snapshot: Services['snapshot']) {}

  private access(ctx: RequestContext, scope: 'draft:read' | 'draft:write', ids: string[] = []) {
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return failure<never>('FORBIDDEN', 'Private durable draft storage is required', 'configure_private_storage');
    const blocked = new Set(this.journal.blocked(ctx.workspaceId));
    if (ids.some((id) => blocked.has(id))) return failure<never>('FORBIDDEN', 'This draft includes blocked content', 'review_delete_report', 'preserved');
    return access;
  }

  private async verifySpans(conversation: Conversation, spans: z.infer<typeof SourceSpanSchema>[]) {
    if (conversation.state !== 'saved' || !conversation.sourceAlreadyPersisted || await hashConversation(conversation) !== conversation.contentHash) return false;
    if (new Set(spans.map((span) => span.id)).size !== spans.length) return false;
    for (const span of spans) {
      const segment = conversation.segments.find((item) => item.id === span.segmentId);
      const boundary = (offset: number) => !(segment && offset > 0 && offset < segment.text.length && /[\uD800-\uDBFF]/.test(segment.text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(segment.text[offset]!));
      if (!segment || span.conversationId !== conversation.id || segment.text.slice(span.start, span.end) !== span.quote || !boundary(span.start) || !boundary(span.end)
        || span.end > segment.text.length || await hashSegment(conversation.id, segment) !== span.contentHash) return false;
    }
    return true;
  }

  private publicState(id: string, row?: StoredRecord): DraftState {
    if (!row) return { id, revision: 0, state: 'missing', contentHash: null, conversationHash: null, document: null, source: null, retentionDays: 30 };
    const stored = StoredSchema.parse(row.value);
    return DraftStateSchema.parse({ id, revision: row.version, state: stored.state, contentHash: stored.contentHash,
      conversationHash: stored.conversationHash, document: stored.document, source: stored.source, expiresAt: stored.expiresAt, retentionDays: 30 });
  }

  async state(ctx: RequestContext, id: string): Promise<Result<DraftState>> {
    const access = this.access(ctx, 'draft:read', [id]); if (!access.ok) return access;
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'A valid draft ID is required', 'select_draft');
    try {
      let row = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff', id);
      if (!row) return { ok: true, data: this.publicState(id) };
      let stored = StoredSchema.parse(row.value);
      if (stored.state === 'available' && Date.parse(stored.expiresAt) <= Date.now()) {
        this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'handoff', id, { ...stored, state: 'expired', document: null, source: null, spans: [] }, row.version);
        row = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff', id)!; stored = StoredSchema.parse(row.value);
      }
      const allowed = this.access(ctx, 'draft:read', stored.objectIds); if (!allowed.ok) return allowed;
      if (stored.state === 'available') {
        if (!stored.document || stored.document.value.id !== id || await contentHash({ document: stored.document, source: stored.source }) !== stored.contentHash) return failure('INTERNAL', 'Stored draft integrity could not be verified', 'repair_private_storage', 'preserved');
        const conversation = await this.conversation(ctx, stored.conversationId); if (!conversation.ok) return conversation;
        if (conversation.data.contentHash !== stored.conversationHash || !await this.verifySpans(conversation.data, stored.spans)) return conflict('Draft source changed; re-read the original conversation before restoring');
      }
      const final = this.access(ctx, 'draft:read', stored.objectIds); if (!final.ok) return final;
      return { ok: true, data: this.publicState(id, row) };
    } catch { return failure('INTERNAL', 'Private draft state could not be read', 'repair_private_storage', 'preserved'); }
  }

  async read(ctx: RequestContext, id: string): Promise<Result<HandoffDraft>> {
    const state = await this.state(ctx, id); if (!state.ok) return state;
    if (state.data.state === 'missing') return failure('VALIDATION', 'No draft has been saved for this identity', 'draft_missing');
    if (state.data.state === 'expired') return failure('CONFLICT', 'Private draft retention expired', 'draft_expired', 'preserved');
    return state.data.document?.kind === 'draft' ? { ok: true, data: state.data.document.value }
      : failure('VALIDATION', 'Only partial review progress has been saved', 'read_review_progress', 'preserved');
  }

  receipt(ctx: RequestContext, id: string): Result<DraftReceipt | null> {
    const access = this.access(ctx, 'draft:read'); if (!access.ok) return access;
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'A valid draft operation ID is required', 'read_original_operation');
    try {
      const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'draft_receipt', id);
      if (!row) return { ok: true, data: null };
      const { receipt } = StoredReceiptSchema.parse(row.value);
      if (receipt.operationId !== id || receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) throw new Error('Receipt identity mismatch');
      return { ok: true, data: receipt };
    } catch { return failure('INTERNAL', 'Draft receipt could not be verified', 'read_original_operation', 'unknown'); }
  }

  async saveDraft(ctx: RequestContext, draft: HandoffDraft, options?: DraftSaveOptions): Promise<Result<HandoffDraft>> {
    const saved = await this.save(ctx, { kind: 'draft', value: draft }, options);
    if (!saved.ok) return saved;
    return saved.data.document?.kind === 'draft' ? { ok: true, data: saved.data.document.value } : conflict();
  }
  saveProgress(ctx: RequestContext, progress: ReviewProgress, options: DraftSaveOptions): Promise<Result<DraftState>> {
    return this.save(ctx, { kind: 'progress', value: progress }, options);
  }

  private async save(ctx: RequestContext, input: unknown, supplied?: DraftSaveOptions): Promise<Result<DraftState>> {
    const access = this.access(ctx, 'draft:write'); if (!access.ok) return access;
    const parsed = HandoffDocumentSchema.safeParse(input), options = DraftSaveOptionsSchema.safeParse(supplied);
    if (!parsed.success || !options.success) return failure('VALIDATION', 'Draft saving requires explicit storage consent, original operation and CAS conditions', 'preview_draft_storage');
    const document = parsed.data, request = options.data, fields = nodeFields(document), value = document.value;
    if (fields.workspaceId !== ctx.workspaceId || value.relations.some((relation) => relation.workspaceId !== ctx.workspaceId)) return failure('FORBIDDEN', 'Draft workspace does not match the trusted identity', 'select_workspace');
    if (fields.conditions.some((condition) => condition.confirmedBy && condition.confirmedBy !== ctx.actorId)
      || value.relations.some((relation) => relation.proposedBy !== ctx.actorId || (relation.confirmedBy && relation.confirmedBy !== ctx.actorId))) return failure('FORBIDDEN', 'Draft attribution cannot impersonate another actor', 'review_authorship');
    if (document.kind === 'draft' && (document.value.node.confirmation !== 'draft' || document.value.node.confirmedBy || document.value.node.confirmedAt
      || document.value.node.revision !== value.baseRevision || document.value.node.conversationId !== value.conversationId
      || document.value.candidateId !== (request.source.kind === 'candidate' ? request.source.candidateId : null)
      || canonicalJson(document.value.node.candidateIds) !== canonicalJson(request.source.kind === 'candidate' ? [request.source.candidateId] : []))) return failure('VALIDATION', 'A draft cannot become formal knowledge or change its original source binding', 'review_draft');
    if (request.source.kind === 'manual' && fields.authorship === 'ai_accepted') return failure('VALIDATION', 'Manual review cannot impersonate an AI candidate', 'review_authorship');
    if (Buffer.byteLength(canonicalJson({ document, source: request.source })) > 500_000) return failure('VALIDATION', 'Draft storage limit exceeded', 'reduce_draft_scope');
    const ids = objectIds(document, request.source);
    const allowed = this.access(ctx, 'draft:write', ids); if (!allowed.ok) return allowed;
    try {
      const conversation = await this.conversation(ctx, value.conversationId); if (!conversation.ok) return conversation;
      if (conversation.data.contentHash !== request.expectedConversationHash) return conflict('Conversation changed since draft preview');
      let spans = request.source.kind === 'manual' ? request.source.spans : [];
      if (request.source.kind === 'candidate') {
        const candidates = await this.candidates(ctx, value.conversationId); if (!candidates.ok) return candidates;
        const candidateId = request.source.candidateId, candidate = candidates.data.find((item) => item.id === candidateId);
        if (!candidate) return failure('CONFLICT', 'The original candidate is missing or expired', 'read_candidate_state', 'preserved');
        spans = candidate.spans;
        if (fields.sources.some((source) => !candidate.sources.some((original) => (['id', 'kind', 'title', 'url', 'excerpt', 'accessedAt'] as const).every((key) => original[key] === source[key])))) return conflict('Candidate source provenance cannot be rewritten');
      } else if (fields.sources.some((source) => source.kind !== 'conversation' || (source.url && source.url !== conversation.data.issueUrl)
        || !spans.some((span) => source.id === span.id && source.excerpt === span.quote))) return conflict('Manual source records must refer to the selected conversation spans');
      if (!await this.verifySpans(conversation.data, spans)) return conflict('Draft source spans could not be verified');
      ids.push(...spans.flatMap((span) => [span.id, span.segmentId]));
      const snapshot = await this.snapshot(ctx); if (!snapshot.ok) return snapshot;
      if (snapshot.data.revision !== value.baseRevision) return conflict('Knowledge base changed since draft preview');
      if (value.relations.some((relation) => [relation.source, relation.target].some((ref) => ref.objectId === nodeId(document) ? ref.revision !== value.baseRevision
        : !snapshot.data.nodes.some((node) => node.id === ref.objectId && node.revision === ref.revision)))) return conflict('Draft relation endpoints changed or are unavailable');
      const hash = await contentHash({ document, source: request.source });
      const requestHash = await contentHash({ contentHash: hash, options: request });
      const current = await this.conversation(ctx, value.conversationId); if (!current.ok) return current;
      if (canonicalJson(current.data) !== canonicalJson(conversation.data)) return conflict('Conversation changed during draft preparation');
      return this.journal.transaction((): Result<DraftState> => {
        const final = this.access(ctx, 'draft:write', ids); if (!final.ok) return final;
        const prior = this.journal.record(ctx.workspaceId, ctx.actorId, 'handoff', value.id);
        const original = this.journal.record(ctx.workspaceId, ctx.actorId, 'draft_receipt', request.operationId);
        if (original) {
          const receipt = StoredReceiptSchema.parse(original.value);
          if (receipt.requestHash !== requestHash) return conflict('Operation ID was already used for different content or CAS conditions');
          if (prior && StoredSchema.parse(prior.value).contentHash === hash && Date.parse(StoredSchema.parse(prior.value).expiresAt) > Date.now()) return { ok: true, data: this.publicState(value.id, prior) };
          return conflict('Original save completed; the current draft changed or expired. Read the original receipt');
        }
        if ((prior?.version ?? 0) !== request.expectedRevision || (prior ? StoredSchema.parse(prior.value).contentHash : null) !== request.expectedContentHash) return conflict();
        const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
        const stored = StoredSchema.parse({ state: 'available', contentHash: hash, conversationHash: request.expectedConversationHash,
          conversationId: value.conversationId, source: request.source, spans, document, objectIds: ids, expiresAt });
        const replacing = Boolean(prior && StoredSchema.parse(prior.value).state === 'available');
        if (!this.journal.privatePayloadFits(ctx.workspaceId, ctx.actorId, Buffer.byteLength(JSON.stringify(stored)), replacing ? Buffer.byteLength(JSON.stringify(prior!.value)) : 0, replacing)) return conflict('Private storage capacity is exhausted');
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'handoff', value.id, stored, prior?.version ?? null)) return conflict();
        const receipt = DraftReceiptSchema.parse({ operationId: request.operationId, draftId: value.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
          kind: document.kind, contentHash: hash, conversationHash: request.expectedConversationHash, previousRevision: request.expectedRevision,
          revision: request.expectedRevision + 1, expiresAt, outcome: 'saved' });
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'draft_receipt', request.operationId, { requestHash, receipt }, null)) throw new Error('Draft receipt CAS failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'draft_saved', [value.id], 'private_not_indexed');
        return { ok: true, data: this.publicState(value.id, { value: stored, version: receipt.revision }) };
      });
    } catch { return failure('INTERNAL', 'Draft save could not be verified', 'read_draft_receipt', 'unknown'); }
  }
}
