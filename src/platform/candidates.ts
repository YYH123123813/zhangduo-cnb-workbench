import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { CandidateSchema, Id, Timestamp, type Candidate, type Conversation } from '../contracts/domain';
import { CandidateSaveOptionsSchema, CandidateStateSchema, normalizedCandidateProjections, type CandidateSaveOptions, type CandidateState } from '../contracts/candidates';
import { canonicalJson, contentHash, hashConversation, hashSegment } from '../contracts/hash';
import type { SettingsState } from '../contracts/governance';
import type { Services } from '../contracts/ports';
import type { OperationJournal } from './journal';
import type { ApprovalAuthority } from './approvals';
import type { SessionRegistry } from './identity';
import { ModelConstraintSchema, ModelOperationSchema } from './model';
import { failure } from './result';

const BatchSchema = z.object({ conversationHash: Id, modelApprovalId: Id, contentHash: Id, expiresAt: Timestamp,
  state: z.enum(['available', 'expired']), candidates: z.array(CandidateSchema).max(3) }).strict();
const sourceConflict = <T>(): Result<T> => failure('CONFLICT', 'Candidate sources changed or cannot be verified', 'review_source', 'preserved');
const boundary = (text: string, offset: number) => !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!));
const candidateIds = (candidates: Candidate[]) => candidates.flatMap((candidate) => [candidate.id, ...candidate.spans.flatMap((span) => [span.id, span.segmentId])]);
export class CandidateStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly approvals: ApprovalAuthority,
    private readonly conversation: Services['readConversation'], private readonly settings: (ctx: RequestContext) => Result<SettingsState>) {}
  private access(ctx: RequestContext, scope: 'candidate:read' | 'candidate:write', ids: string[]) {
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return failure<never>('FORBIDDEN', 'Candidate storage requires a private workspace and matching durable mode', 'configure_private_storage');
    if (ids.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return failure<never>('FORBIDDEN', 'Candidate content is blocked from this workspace', 'review_delete_report');
    return access;
  }
  private async verifySources(conversation: Conversation, candidates: Candidate[], allowedIds?: string[]): Promise<boolean> {
    if (conversation.state !== 'saved' || !conversation.sourceAlreadyPersisted || await hashConversation(conversation) !== conversation.contentHash) return false;
    if (new Set(candidates.map((item) => item.id)).size !== candidates.length) return false;
    for (const candidate of candidates) {
      if (candidate.conversationId !== conversation.id || new Set(candidate.spans.map((span) => span.id)).size !== candidate.spans.length) return false;
      for (const span of candidate.spans) {
        const segment = conversation.segments.find((item) => item.id === span.segmentId);
        if (!segment || (allowedIds && !allowedIds.includes(segment.id)) || span.conversationId !== conversation.id || span.end > segment.text.length
          || !boundary(segment.text, span.start) || !boundary(segment.text, span.end) || segment.text.slice(span.start, span.end) !== span.quote
          || await hashSegment(conversation.id, segment) !== span.contentHash) return false;
      }
      if (candidate.sources.length !== candidate.spans.length || new Set(candidate.sources.map((source) => source.id)).size !== candidate.sources.length) return false;
      if (candidate.sources.some((source) => source.kind !== 'conversation' || source.support !== 'unverified' || source.supportedClaim !== candidate.claim
        || !candidate.spans.some((span) => span.id === source.id && span.quote === source.excerpt))) return false;
    }
    return true;
  }
  async state(ctx: RequestContext, id: string): Promise<Result<CandidateState>> {
    const access = this.access(ctx, 'candidate:read', [id]); if (!access.ok) return access;
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'A valid conversation ID is required', 'select_conversation');
    const conversation = await this.conversation(ctx, id); if (!conversation.ok) return conversation;
    try {
      let row = this.journal.record(ctx.workspaceId, ctx.actorId, 'candidates', id);
      if (!row) {
        const stillAuthorized = this.access(ctx, 'candidate:read', [id]); if (!stillAuthorized.ok) return stillAuthorized;
        return { ok: true, data: { conversationId: id, conversationHash: conversation.data.contentHash, candidates: [], revision: 0, state: 'missing', retentionDays: 7 } };
      }
      let batch = BatchSchema.parse(row.value);
      if (batch.state === 'available' && Date.parse(batch.expiresAt) <= Date.now()) {
        this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'candidates', id, { ...batch, state: 'expired', candidates: [] }, row.version);
        row = this.journal.record(ctx.workspaceId, ctx.actorId, 'candidates', id)!; batch = BatchSchema.parse(row.value);
      }
      if (batch.state === 'available' && (batch.conversationHash !== conversation.data.contentHash || !await this.verifySources(conversation.data, batch.candidates) || await contentHash(batch.candidates) !== batch.contentHash)) return sourceConflict();
      const stillAuthorized = this.access(ctx, 'candidate:read', [id, ...candidateIds(batch.candidates)]); if (!stillAuthorized.ok) return stillAuthorized;
      return { ok: true, data: CandidateStateSchema.parse({ conversationId: id, conversationHash: batch.conversationHash, revision: row.version,
        state: batch.state, candidates: batch.candidates, modelApprovalId: batch.modelApprovalId, expiresAt: batch.expiresAt, retentionDays: 7 }) };
    } catch { return failure('INTERNAL', 'Stored candidate batch could not be verified', 'repair_private_storage', 'preserved'); }
  }
  async read(ctx: RequestContext, id: string): Promise<Result<Candidate[]>> {
    const state = await this.state(ctx, id); if (!state.ok) return state;
    return state.data.state === 'expired' ? failure('CONFLICT', 'Candidate payload expired; the prior model operation still exists', 'read_model_operation', 'preserved') : { ok: true, data: state.data.candidates };
  }
  async save(ctx: RequestContext, id: string, input: Candidate[], supplied?: CandidateSaveOptions): Promise<Result<Candidate[]>> {
    const access = this.access(ctx, 'candidate:write', [id]); if (!access.ok) return access;
    const parsed = z.array(CandidateSchema).max(3).safeParse(input), options = CandidateSaveOptionsSchema.safeParse(supplied);
    if (!parsed.success || !options.success || !Id.safeParse(id).success) return failure('VALIDATION', 'Candidate persistence requires the confirmed original model scope, storage retention and expected batch revision', 'preview_candidate_storage');
    const candidates = parsed.data, request = options.data, approval = request.modelApproval;
    const expected = { purpose: 'model_input' as const, objectIds: approval.objectIds, contentHash: approval.contentHash, baseRevision: request.expectedConversationHash };
    const valid = this.approvals.validate(ctx, 'model:extract', approval, expected); if (!valid.ok) return valid;
    try {
      const constraint = ModelConstraintSchema.safeParse(this.journal.record(ctx.workspaceId, ctx.actorId, 'model_constraint', approval.id)?.value);
      const operation = ModelOperationSchema.safeParse(this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approval.id)?.value);
      if (!constraint.success || constraint.data.purpose !== 'extract' || constraint.data.conversationId !== id || !operation.success || operation.data.state !== 'done'
        || operation.data.actorId !== ctx.actorId || operation.data.contentHash !== approval.contentHash || operation.data.purpose !== 'extract') return failure('FORBIDDEN', 'A verified completed extraction is required before candidate persistence', 'read_model_operation');
      const projections = candidates.map(({ title, question, claim, kind, whyKeep, uncertainties, spans }) => ({ title, question, claim, kind, whyKeep, uncertainties, spans: spans.map(({ segmentId, start, end, quote }) => ({ segmentId, start, end, quote })) }));
      const projectionHash = await contentHash(normalizedCandidateProjections(projections));
      if (projectionHash !== operation.data.candidateProjectionHash || candidates.some((candidate) => candidate.modelId !== operation.data.modelId || candidate.generatedAt !== operation.data.generatedAt)) return failure('CONFLICT', 'Candidate content or model provenance differs from the completed extraction', 'review_model_output', 'preserved');
      const conversation = await this.conversation(ctx, id); if (!conversation.ok) return conversation;
      if (conversation.data.contentHash !== request.expectedConversationHash || !await this.verifySources(conversation.data, candidates, valid.data.objectIds)) return sourceConflict();
      const hash = await contentHash(candidates);
      if (Buffer.byteLength(canonicalJson(candidates)) > 256_000) return failure('VALIDATION', 'Candidate batch exceeds private storage budget', 'reduce_candidate_scope');
      const current = await this.conversation(ctx, id); if (!current.ok) return current;
      // Remote Issue reads cannot join SQLite CAS. Compare the last read with the fully verified source before entering the synchronous transaction.
      if (canonicalJson(current.data) !== canonicalJson(conversation.data)) return sourceConflict();
      const stillAuthorized = this.access(ctx, 'candidate:write', [id, ...candidateIds(candidates)]); if (!stillAuthorized.ok) return stillAuthorized;
      const stillValid = this.approvals.validate(ctx, 'model:extract', approval, expected); if (!stillValid.ok) return stillValid;
      const settings = this.settings(ctx); if (!settings.ok) return settings;
      if (!settings.data.settings.aiExtraction || settings.data.revision !== constraint.data.settingsRevision) return failure('CONFLICT', 'AI settings changed before candidate storage', 'preview_candidate_storage', 'preserved');
      const prior = this.journal.record(ctx.workspaceId, ctx.actorId, 'candidates', id);
      if (prior) {
        const stored = BatchSchema.parse(prior.value);
        if (stored.state === 'available' && Date.parse(stored.expiresAt) > Date.now() && stored.contentHash === hash && stored.modelApprovalId === approval.id && canonicalJson(stored.candidates) === canonicalJson(candidates)) return { ok: true, data: stored.candidates };
        return failure('CONFLICT', 'This conversation already has a different or expired immutable candidate batch', 'read_candidate_state', 'preserved');
      }
      if (request.expectedRevision !== 0) return failure('CONFLICT', 'Candidate revision changed', 'read_candidate_state', 'preserved');
      const liveOperationRow = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approval.id);
      const liveOperation = liveOperationRow ? ModelOperationSchema.safeParse(liveOperationRow.value) : null;
      if (!liveOperationRow || !liveOperation?.success || liveOperation.data.state !== 'done' || liveOperation.data.extraction?.stage !== 'model_done') {
        return failure('UNKNOWN_RESULT', 'The original extraction save stage is not verified; candidate content was not written', 'read_extraction_state', 'unknown');
      }
      const batch = { conversationHash: request.expectedConversationHash, modelApprovalId: approval.id, contentHash: hash, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), state: 'available', candidates };
      if (!this.journal.privatePayloadFits(ctx.workspaceId, ctx.actorId, Buffer.byteLength(JSON.stringify(batch)))) return failure('CONFLICT', 'Private storage capacity is exhausted', 'review_private_storage', 'preserved');
      const saving = { ...liveOperation.data, extraction: { ...liveOperation.data.extraction, stage: 'candidate_saving' as const, updatedAt: new Date().toISOString() } };
      if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'model_operation', approval.id, saving, liveOperationRow.version)) {
        return failure('UNKNOWN_RESULT', 'The original extraction save stage could not be registered; candidate content was not written', 'read_extraction_state', 'unknown');
      }
      const stagedVersion = liveOperationRow.version + 1;
      try {
        return this.journal.transaction(() => {
          const authorized = this.access(ctx, 'candidate:write', [id, ...candidateIds(candidates)]); if (!authorized.ok) return authorized;
          const validAgain = this.approvals.validate(ctx, 'model:extract', approval, expected); if (!validAgain.ok) return validAgain;
          const settingsAgain = this.settings(ctx); if (!settingsAgain.ok) return settingsAgain;
          if (!settingsAgain.data.settings.aiExtraction || settingsAgain.data.revision !== constraint.data.settingsRevision) return failure('CONFLICT', 'AI settings changed before candidate storage', 'preview_candidate_storage', 'preserved');
          const current = this.journal.record(ctx.workspaceId, '@workspace', 'model_operation', approval.id);
          if (!current || current.version !== stagedVersion) throw new Error('Extraction saving stage changed');
          const competing = this.journal.record(ctx.workspaceId, ctx.actorId, 'candidates', id);
          if (competing) return failure('CONFLICT', 'This conversation already has a different immutable candidate batch', 'read_candidate_state', 'preserved');
          if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'candidates', id, batch, null)) throw new Error('Candidate CAS did not insert');
          const finished = { ...saving, extraction: { ...saving.extraction, stage: candidates.length ? 'saved_nonempty' as const : 'saved_empty' as const,
            batchRevision: 1, candidateContentHash: hash, updatedAt: new Date().toISOString() } };
          if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'model_operation', approval.id, finished, stagedVersion)) throw new Error('Extraction receipt CAS did not update');
          this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'candidates_saved', candidates.map((candidate) => candidate.id), 'private_temporary_not_indexed');
          return { ok: true, data: candidates };
        });
      } catch { return failure('UNKNOWN_RESULT', 'Candidate persistence or its original receipt is unknown; verify the original extraction operation', 'read_extraction_state', 'unknown'); }
    } catch { return failure('INTERNAL', 'Candidate storage transaction could not be verified', 'read_candidate_state', 'unknown'); }
  }
}
