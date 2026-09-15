import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { Id, Timestamp, type KnowledgeSnapshot, type VersionRef } from '../contracts/domain';
import { canonicalJson, contentHash } from '../contracts/hash';
import {
  ReviewAnswerExposureSchema,
  ReviewAppealRequestSchema,
  ReviewAppealStateSchema,
  ReviewAttemptEventRequestSchema,
  ReviewAttemptPublicSchema,
  ReviewAttemptStartRequestSchema,
  ReviewAttemptStateSchema,
  ReviewFeedbackInputSchema,
  ReviewFeedbackRequestSchema,
  ReviewFeedbackStateSchema,
  ReviewOperationReceiptSchema,
  ReviewOperationRecoverySchema,
  ReviewQuestionQuerySchema,
  ReviewQuestionSchema,
  ReviewRuntimeStatusSchema,
  type ReviewRuntimeStatus,
  type ReviewAttemptPublic,
  type ReviewAppealRequest,
  type ReviewAttemptEventRequest,
  type ReviewAttemptStartRequest,
  type ReviewAttemptState,
  type ReviewFeedbackRequest,
  type ReviewFeedbackState,
  type ReviewOperationKind,
  type ReviewOperationReceipt,
  type ReviewOperationRecovery,
  type ReviewQuestion,
  type ReviewQuestionQuery,
  type ReviewQuestionPublic,
  type ReviewExposureSource,
} from '../contracts/review-session';
import type { Services } from '../contracts/ports';
import type { OperationJournal } from './journal';
import type { SessionRegistry } from './identity';
import { failure } from './result';
import { TaskStore } from './tasks';
import { ReviewExposureLedger } from './review-exposure';

const StoredQuestionSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), question: ReviewQuestionSchema.nullable(),
  state: z.enum(['available', 'expired']).default('available'), expiresAt: Timestamp.optional() }).strict();
const StoredAttemptSchema = z.object({ state: z.enum(['available', 'expired']), attempt: ReviewAttemptStateSchema.nullable(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime({ offset: true }) }).strict()
  .refine((value) => value.state === 'available' ? value.attempt !== null : value.attempt === null);
const ReviewReceiptRecordSchema = z.object({ receipt: ReviewOperationReceiptSchema }).strict();

const publicFailure = <T>(code: 'VALIDATION' | 'FORBIDDEN' | 'CONFLICT' | 'UNKNOWN_RESULT' | 'INTERNAL' | 'NOT_IMPLEMENTED', message: string, nextAction: string, dataState: 'not_written' | 'preserved' | 'unknown' = 'not_written'): Result<T> => failure(code, message, nextAction, dataState, false);
const conflict = <T>(message = 'Review session changed; read the original operation and attempt'): Result<T> => publicFailure('CONFLICT', message, 'read_review_operation', 'preserved');

function isExpired(expiresAt: string, now: number): boolean { return Date.parse(expiresAt) <= now; }

function publicQuestion(question: ReviewQuestion): ReviewQuestionPublic {
  return {
    id: question.id,
    revision: question.revision,
    kind: question.kind,
    nodeRef: question.nodeRef,
    prompt: question.prompt,
    rubricVersion: question.rubric.version,
    reviewStatus: question.review.status,
    transfer: question.transfer ?? null,
  };
}

export class ReviewQuestionStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, initial: readonly ReviewQuestion[] = []) {
    for (const question of initial) {
      const result = this.register(question);
      if (!result) throw new Error(`Review question ${question.id} could not be registered`);
    }
  }

  register(input: unknown): boolean {
    return this.journal.transaction(() => this.registerWithinTransaction(input, new Date(Date.now() + 30 * 86_400_000).toISOString()));
  }

  registerWithinTransaction(input: unknown, expiresAt: string): boolean {
    const parsed = ReviewQuestionSchema.safeParse(input);
    if (!parsed.success) return false;
    const question = parsed.data, hash = this.hash(question), key = createHash('sha256').update(canonicalJson([question.id, question.revision])).digest('hex');
    if (!Timestamp.safeParse(expiresAt).success || Date.parse(expiresAt) <= Date.now()) return false;
    if (this.journal.blocked(question.workspaceId).some((id) => id === question.id || id === question.nodeRef.objectId)) return false;
      const current = this.journal.record(question.workspaceId, '@workspace', 'review_question', key);
      if (current) {
        const stored = StoredQuestionSchema.safeParse(current.value);
        return stored.success && stored.data.hash === hash;
      }
      if (!this.journal.reviewPayloadFits(question.workspaceId, Buffer.byteLength(canonicalJson({ hash, question })))) return false;
      return this.journal.putRecord(question.workspaceId, '@workspace', 'review_question', key, { hash, question, state: 'available', expiresAt }, null);
  }

  bound(question: ReviewQuestion, now: number): boolean {
    const key = createHash('sha256').update(canonicalJson([question.id, question.revision])).digest('hex');
    const row = this.journal.record(question.workspaceId, '@workspace', 'review_question', key);
    if (!row) return false;
    const stored = StoredQuestionSchema.parse(row.value);
    return stored.state === 'available' && stored.question !== null && !isExpired(stored.expiresAt ?? new Date(Date.parse(row.updatedAt ?? '1970-01-01T00:00:00Z') + 30 * 86_400_000).toISOString(), now)
      && stored.hash === this.hash(question) && this.hash(stored.question) === stored.hash;
  }

  private hash(question: ReviewQuestion): string {
    // Registration is server-side only; synchronous canonical hashing is enough for dedupe before persistence.
    return createHash('sha256').update(canonicalJson(question)).digest('hex');
  }

  runtime(ctx: RequestContext): Result<ReviewRuntimeStatus> {
    const access = this.access(ctx, 'knowledge:read'); if (!access.ok) return access;
    try {
      const blocked = new Set(this.journal.blocked(ctx.workspaceId));
      const count = this.journal.records(ctx.workspaceId, '@workspace', 'review_question').filter((row) => {
        const stored = StoredQuestionSchema.parse(row.value), q = stored.question;
        return q && q.review.status === 'approved' && this.bound(q, Date.now()) && !blocked.has(q.id) && !blocked.has(q.nodeRef.objectId);
      }).length;
      return { ok: true, data: ReviewRuntimeStatusSchema.parse({ mode: ctx.mode, catalog: count ? 'ready' : 'empty', availableQuestionCount: count,
        taskBinding: 'revision_hash_atomic', exposure: 'server_observed_unknown_default', unassistedCertification: false, questionRetentionDays: 30, attemptRetentionDays: 30 }) };
    } catch { return publicFailure('INTERNAL', 'Review runtime could not be verified', 'repair_review_storage', 'preserved'); }
  }

  async list(ctx: RequestContext, query: ReviewQuestionQuery): Promise<Result<ReviewQuestion[]>> {
    const access = this.access(ctx, 'knowledge:read', [query.nodeId]); if (!access.ok) return access;
    const parsed = ReviewQuestionQuerySchema.safeParse(query); if (!parsed.success) return publicFailure('VALIDATION', 'Review question node and revision are required', 'select_review_node');
    try {
      const records = this.journal.records(ctx.workspaceId, '@workspace', 'review_question');
      const questions = records.flatMap((row) => {
        const stored = StoredQuestionSchema.parse(row.value);
        const question = stored.question;
        if (!question || stored.state === 'expired' || !this.bound(question, Date.now()) || this.journal.blocked(ctx.workspaceId).includes(question.id)) return [];
        if (this.hash(question) !== stored.hash) throw new Error('Question integrity mismatch');
        return question.workspaceId === ctx.workspaceId && question.nodeRef.objectId === parsed.data.nodeId && question.nodeRef.revision === parsed.data.revision
          ? [structuredClone(question)] : [];
      });
      return { ok: true, data: questions.filter((question) => question.review.status === 'approved') };
    } catch { return publicFailure('INTERNAL', 'Review question catalog could not be verified', 'repair_review_storage', 'preserved'); }
  }

  private access(ctx: RequestContext, scope: string, ids: string[] = []) {
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return publicFailure<never>('FORBIDDEN', 'Private durable review storage is required', 'configure_private_storage');
    if (ids.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return publicFailure<never>('FORBIDDEN', 'Review content is blocked by the active deletion barrier', 'review_delete_report', 'preserved');
    return access;
  }
}

export class ReviewSessionStore {
  private readonly ledger: ReviewExposureLedger;
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly journal: OperationJournal,
    private readonly questions: ReviewQuestionStore,
    private readonly snapshot: Services['snapshot'],
    private readonly readTask: NonNullable<Services['readTaskState']>,
    private readonly exposure?: ReviewExposureSource,
    private readonly now: () => number = Date.now,
  ) { this.ledger = new ReviewExposureLedger(journal, now); }

  recordKnowledgeExposure(ctx: RequestContext, refs: VersionRef[]): Result<{ recorded: number }> {
    try {
      return this.journal.transaction(() => {
        const access = this.access(ctx, 'knowledge:read', refs.map((ref) => ref.objectId)); if (!access.ok) return access;
        let recorded = 0;
        for (const ref of refs) {
          if (ref.workspaceId !== ctx.workspaceId) throw new Error('Exposure workspace mismatch');
          if (!this.ledger.active(ctx, ref)) continue;
          const write = this.access(ctx, 'evidence:write'); if (!write.ok) throw new Error('Exposure permission revoked');
          this.ledger.seen(ctx, ref); recorded += 1;
        }
        return { ok: true, data: { recorded } };
      });
    } catch { return publicFailure('UNKNOWN_RESULT', 'Knowledge exposure could not be recorded; content was withheld', 'read_review_operation', 'unknown'); }
  }

  async listQuestions(ctx: RequestContext, query: ReviewQuestionQuery): Promise<Result<ReviewQuestionPublic[]>> {
    const result = await this.questions.list(ctx, query);
    return result.ok ? { ok: true, data: result.data.map(publicQuestion) } : result;
  }

  async start(ctx: RequestContext, input: ReviewAttemptStartRequest): Promise<Result<ReviewOperationReceipt>> {
    const parsed = ReviewAttemptStartRequestSchema.safeParse(input); if (!parsed.success) return publicFailure('VALIDATION', 'Review attempt start requires its original question and node reference', 'select_review_question');
    const request = parsed.data;
    const access = this.access(ctx, 'evidence:write', [request.taskId, request.nodeRef.objectId]); if (!access.ok) return access;
    const knowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!knowledge.ok) return knowledge;
    const requestHash = await contentHash(request);
    const known = this.receipt(ctx, request.operationId); if (!known.ok) return known;
    if (known.data) return this.recoverApplied(ctx, request.operationId, requestHash, known.data);
    const current = this.journal.record(ctx.workspaceId, '@workspace', 'review_attempt', request.operationId);
    if (current) return conflict('The attempt ID exists without an applied operation receipt; do not overwrite it');

    const task = await this.readTask(ctx, request.taskId); if (!task.ok) return task;
    if (task.data.state !== 'available' || !task.data.task) return conflict('The original task is missing or expired; save or recover the task first');
    if (task.data.revision !== request.taskRevision || task.data.contentHash !== request.taskContentHash)
      return conflict('The confirmed task revision or hash changed; confirm the original task again');
    const snapshot = await this.snapshot(ctx); if (!snapshot.ok) return snapshot;
    const questions = await this.questions.list(ctx, { nodeId: request.nodeRef.objectId, revision: request.nodeRef.revision });
    if (!questions.ok) return questions;
    const question = questions.data.find((item) => item.id === request.questionId && item.revision === request.questionRevision);
    if (!question) return publicFailure('CONFLICT', 'The approved review question is missing or no longer matches the selected node version', 'reload_review_questions', 'preserved');
    const checked = this.checkQuestion(question, request, snapshot.data); if (!checked.ok) return checked;
    if (question.kind === 'near_transfer') {
      if (!request.priorRecallAttemptId) return publicFailure('VALIDATION', 'Near-transfer requires the same-version unexposed recall attempt first', 'start_recall');
      const prior = this.loadAttempt(ctx, request.priorRecallAttemptId); if (!prior) return conflict('The prerequisite recall attempt could not be verified');
      if (prior.actorId !== ctx.actorId || prior.workspaceId !== ctx.workspaceId || prior.taskId !== request.taskId || prior.question.kind !== 'recall'
        || prior.question.nodeRef.objectId !== request.nodeRef.objectId || prior.question.nodeRef.revision !== request.nodeRef.revision
        || prior.phase !== 'submitted' || prior.exposure !== 'unexposed' || prior.hintLevel !== 0 || prior.answerRevealed
        || prior.feedback?.result === 'invalid_question') return publicFailure('VALIDATION', 'A near-transfer attempt needs a submitted, unexposed recall on the exact knowledge version', 'start_recall');
    }
    const exposure = ctx.mode === 'fixture' && this.exposure ? await this.exposure.initial({ actorId: ctx.actorId, workspaceId: ctx.workspaceId, taskId: request.taskId, nodeRef: request.nodeRef }) : 'unknown' as const;
    if (!ReviewAnswerExposureSchema.safeParse(exposure).success) return publicFailure('UNKNOWN_RESULT', 'Initial answer exposure could not be verified', 'read_review_operation', 'unknown');
    const now = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + 30 * 86_400_000).toISOString();
    const state = ReviewAttemptStateSchema.parse({ id: request.operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, taskId: request.taskId,
      task: task.data.task, version: 0, snapshotRevision: snapshot.data.revision, question: checked.data, exposure,
      exposureEvents: [{ operationId: request.operationId, type: 'start', recordedAt: now }], phase: 'confidence',
      confidence: { value: null, recordedAt: null, locked: false }, hintLevel: 0, answerRevealed: false, updatedAt: now,
      submission: null, feedback: null, appeals: [], expiresAt, retentionDays: 30 });
    const receipt = ReviewOperationReceiptSchema.parse({ operationId: request.operationId, attemptId: request.operationId, workspaceId: ctx.workspaceId, actorId: ctx.actorId,
      kind: 'start', requestHash, expectedVersion: 0, resultingVersion: 0, feedbackVersion: null, appliedAt: now, expiresAt, retentionDays: 30, outcome: 'applied' });
    try {
      return this.journal.transaction(() => {
        const finalAccess = this.access(ctx, 'evidence:write', [request.taskId, request.nodeRef.objectId]); if (!finalAccess.ok) return finalAccess;
        const finalKnowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!finalKnowledge.ok) return finalKnowledge;
        const prior = this.receipt(ctx, request.operationId); if (!prior.ok) return prior;
        if (prior.data) return this.recoverApplied(ctx, request.operationId, requestHash, prior.data);
        if (this.journal.record(ctx.workspaceId, '@workspace', 'review_attempt', request.operationId)) return conflict('The attempt ID was claimed concurrently');
        const bound = new TaskStore(this.sessions, this.journal, this.snapshot).boundState(ctx, request.taskId, request.taskRevision, request.taskContentHash);
        if (!bound.ok) return bound;
        if (canonicalJson(bound.data.task) !== canonicalJson(state.task)) return conflict('The task changed while the review start was being prepared');
        if (!this.questions.bound(state.question, this.now())) return conflict('The approved question expired or changed before start');
        if (this.ledger.active(ctx, request.nodeRef)?.seenAt) state.exposure = 'seen';
        const stored = { state: 'available' as const, attempt: state, requestHash, expiresAt };
        if (!this.journal.reviewPayloadFits(ctx.workspaceId, Buffer.byteLength(canonicalJson(stored)))) return publicFailure('VALIDATION', 'Review storage capacity is exhausted', 'reduce_review_retention');
        this.ledger.consent(ctx, request.nodeRef, expiresAt);
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'review_attempt', request.operationId, stored, null)
          || !this.journal.putRecord(ctx.workspaceId, '@workspace', 'review_operation_receipt', request.operationId, { receipt }, null)) throw new Error('Review start transaction failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'review_attempt_started', [request.operationId], 'private_not_indexed');
        return { ok: true, data: structuredClone(receipt) };
      });
    } catch { return publicFailure('UNKNOWN_RESULT', 'Review attempt start could not be verified', 'read_review_operation', 'unknown'); }
  }

  async event(ctx: RequestContext, input: ReviewAttemptEventRequest): Promise<Result<ReviewOperationReceipt>> {
    const parsed = ReviewAttemptEventRequestSchema.safeParse(input); if (!parsed.success) return publicFailure('VALIDATION', 'Review event requires an independent operation ID and expected version', 'read_review_attempt');
    const request = parsed.data, access = this.access(ctx, 'evidence:write', [request.attemptId]); if (!access.ok) return access;
    if (request.event.type !== 'cancel') { const knowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!knowledge.ok) return knowledge; }
    const requestHash = await contentHash(request), known = this.receipt(ctx, request.operationId); if (!known.ok) return known;
    if (known.data) return this.recoverApplied(ctx, request.operationId, requestHash, known.data);
    const current = this.loadAttempt(ctx, request.attemptId); if (!current) return conflict('The original attempt is missing, expired or blocked');
    if (current.actorId !== ctx.actorId || current.workspaceId !== ctx.workspaceId) return publicFailure('FORBIDDEN', 'The attempt belongs to another identity', 'select_authorized_workspace');
    if (request.expectedVersion !== current.version) return conflict('The attempt version changed; read the current attempt before sending another event');
    if (request.event.type !== 'cancel') {
      const read = this.sessions.authorize(ctx, 'knowledge:read'); if (!read.ok) return read;
      const snapshot = await this.snapshot(ctx); if (!snapshot.ok) return snapshot;
      const checked = this.checkSnapshot(current, snapshot.data); if (!checked.ok) return checked;
    }
    const next = this.nextAttempt(current, request, ctx.actorId); if (!next.ok) return next;
    return this.commitMutation(ctx, request.operationId, requestHash, request.event.type, current, next.data, null);
  }

  async feedback(ctx: RequestContext, input: ReviewFeedbackRequest): Promise<Result<ReviewOperationReceipt>> {
    const parsed = ReviewFeedbackRequestSchema.safeParse(input); if (!parsed.success) return publicFailure('VALIDATION', 'Feedback requires an independent operation ID and complete rubric review', 'read_review_attempt');
    const request = parsed.data, access = this.access(ctx, 'evidence:write', [request.attemptId]); if (!access.ok) return access;
    const knowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!knowledge.ok) return knowledge;
    const requestHash = await contentHash(request), known = this.receipt(ctx, request.operationId); if (!known.ok) return known;
    if (known.data) return this.recoverApplied(ctx, request.operationId, requestHash, known.data);
    const current = this.loadAttempt(ctx, request.attemptId); if (!current) return conflict('The original attempt is missing, expired or blocked');
    if (current.actorId !== ctx.actorId || current.workspaceId !== ctx.workspaceId) return publicFailure('FORBIDDEN', 'The attempt belongs to another identity', 'select_authorized_workspace');
    if (current.phase !== 'submitted' || !current.submission || request.expectedVersion !== current.version) return conflict('Feedback must target the current submitted attempt version');
    const feedback = this.buildFeedback(current, request); if (!feedback.ok) return feedback;
    const next = structuredClone(current); next.feedback = feedback.data;
    next.version += 1; next.updatedAt = new Date(this.now()).toISOString();
    return this.commitMutation(ctx, request.operationId, requestHash, 'feedback', current, next, feedback.data.version);
  }

  async appeal(ctx: RequestContext, input: ReviewAppealRequest): Promise<Result<ReviewOperationReceipt>> {
    const parsed = ReviewAppealRequestSchema.safeParse(input); if (!parsed.success) return publicFailure('VALIDATION', 'Appeal requires its own operation ID, exact node version and reason', 'read_review_attempt');
    const request = parsed.data, access = this.access(ctx, 'evidence:write', [request.attemptId, request.nodeRef.objectId]); if (!access.ok) return access;
    const knowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!knowledge.ok) return knowledge;
    const requestHash = await contentHash(request), known = this.receipt(ctx, request.operationId); if (!known.ok) return known;
    if (known.data) return this.recoverApplied(ctx, request.operationId, requestHash, known.data);
    const current = this.loadAttempt(ctx, request.attemptId); if (!current) return conflict('The original attempt is missing, expired or blocked');
    if (current.actorId !== ctx.actorId || current.workspaceId !== ctx.workspaceId) return publicFailure('FORBIDDEN', 'The attempt belongs to another identity', 'select_authorized_workspace');
    if (current.phase !== 'submitted' || request.expectedVersion !== current.version || request.nodeRef.objectId !== current.question.nodeRef.objectId
      || request.nodeRef.revision !== current.question.nodeRef.revision || request.feedbackVersion !== (current.feedback?.version ?? 0)) return conflict('Appeal target no longer matches the submitted attempt or feedback version');
    const appeal = ReviewAppealStateSchema.parse({ operationId: request.operationId, attemptId: current.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId,
      feedbackVersion: request.feedbackVersion, nodeRef: request.nodeRef, reason: request.reason, status: 'open', createdAt: new Date(this.now()).toISOString() });
    const next = structuredClone(current); next.appeals.push(appeal);
    next.version += 1; next.updatedAt = new Date(this.now()).toISOString();
    return this.commitMutation(ctx, request.operationId, requestHash, 'appeal', current, next, request.feedbackVersion);
  }

  read(ctx: RequestContext, attemptId: string): Result<ReviewAttemptPublic | null> {
    const access = this.access(ctx, 'evidence:read', [attemptId]); if (!access.ok) return access;
    const knowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!knowledge.ok) return knowledge;
    if (!Id.safeParse(attemptId).success) return publicFailure('VALIDATION', 'Review attempt ID is invalid', 'read_review_attempt');
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', 'review_attempt', attemptId); if (!row) return { ok: true, data: null };
      const stored = StoredAttemptSchema.parse(row.value);
      if (stored.state === 'expired' || isExpired(stored.expiresAt, this.now())) return { ok: true, data: null };
      if (!stored.attempt || stored.attempt.actorId !== ctx.actorId || stored.attempt.workspaceId !== ctx.workspaceId) return { ok: true, data: null };
      const contentAccess = this.access(ctx, 'evidence:read', [stored.attempt.taskId, stored.attempt.question.nodeRef.objectId]);
      if (!contentAccess.ok) return contentAccess;
      if (stored.attempt.exposure === 'unexposed' && stored.attempt.exposureEvents.some((event) => event.type === 'reveal' || event.type === 'hint')) throw new Error('Exposure state integrity mismatch');
      const viewState = structuredClone(stored.attempt);
      if (!viewState.submission && this.ledger.active(ctx, viewState.question.nodeRef)?.seenAt) viewState.exposure = 'seen';
      return { ok: true, data: this.publicAttempt(viewState) };
    } catch { return publicFailure('INTERNAL', 'Review attempt state could not be verified', 'repair_review_storage', 'preserved'); }
  }

  readOperation(ctx: RequestContext, operationId: string): Result<ReviewOperationRecovery> {
    const access = this.access(ctx, 'evidence:read'); if (!access.ok) return access;
    if (!Id.safeParse(operationId).success) return publicFailure('VALIDATION', 'Review operation ID is invalid', 'read_review_operation');
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', 'review_operation_receipt', operationId);
      if (!row) return { ok: true, data: ReviewOperationRecoverySchema.parse({ operationId, workspaceId: ctx.workspaceId, actorId: ctx.actorId, state: 'unknown', attemptId: null, requestHash: null, receipt: null, absenceIsFinal: false, retryAllowed: false }) };
      const stored = ReviewReceiptRecordSchema.parse(row.value).receipt;
      if (stored.actorId !== ctx.actorId || stored.workspaceId !== ctx.workspaceId) return { ok: true, data: ReviewOperationRecoverySchema.parse({ operationId, workspaceId: ctx.workspaceId, actorId: ctx.actorId, state: 'unknown', attemptId: null, requestHash: null, receipt: null, absenceIsFinal: false, retryAllowed: false }) };
      return { ok: true, data: ReviewOperationRecoverySchema.parse({ operationId, workspaceId: ctx.workspaceId, actorId: ctx.actorId, state: 'applied', attemptId: stored.attemptId, requestHash: stored.requestHash, receipt: stored, absenceIsFinal: false, retryAllowed: false }) };
    } catch { return publicFailure('INTERNAL', 'Review operation receipt could not be verified', 'repair_review_storage', 'preserved'); }
  }

  private access(ctx: RequestContext, scope: string, ids: string[] = []) {
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return publicFailure<never>('FORBIDDEN', 'Private durable review storage is required', 'configure_private_storage');
    if (ids.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return publicFailure<never>('FORBIDDEN', 'Review content is blocked by the active deletion barrier', 'review_delete_report', 'preserved');
    return access;
  }

  private receipt(ctx: RequestContext, operationId: string): Result<ReviewOperationReceipt | null> {
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', 'review_operation_receipt', operationId); if (!row) return { ok: true, data: null };
      const receipt = ReviewReceiptRecordSchema.parse(row.value).receipt;
      if (receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) return publicFailure('FORBIDDEN', 'The operation belongs to another identity', 'select_authorized_workspace');
      return { ok: true, data: receipt };
    } catch { return publicFailure('INTERNAL', 'Review operation receipt is damaged', 'repair_review_storage', 'preserved'); }
  }

  private recoverApplied(ctx: RequestContext, operationId: string, requestHash: string, receipt: ReviewOperationReceipt): Result<ReviewOperationReceipt> {
    if (receipt.requestHash !== requestHash) return conflict('Operation ID was already used for a different complete review request');
    return { ok: true, data: structuredClone(receipt) };
  }

  private loadAttempt(ctx: RequestContext, attemptId: string): ReviewAttemptState | null {
    const row = this.journal.record(ctx.workspaceId, '@workspace', 'review_attempt', attemptId); if (!row) return null;
    try {
      const stored = StoredAttemptSchema.parse(row.value); if (stored.state !== 'available' || !stored.attempt || isExpired(stored.expiresAt, this.now())) return null;
      if (stored.attempt.actorId !== ctx.actorId || stored.attempt.workspaceId !== ctx.workspaceId) return null;
      if (this.journal.blocked(ctx.workspaceId).some((id) => [stored.attempt!.taskId, stored.attempt!.question.nodeRef.objectId].includes(id))) return null;
      return structuredClone(stored.attempt);
    } catch { return null; }
  }

  private checkQuestion(question: ReviewQuestion, request: ReviewAttemptStartRequest, snapshot: KnowledgeSnapshot): Result<ReviewQuestion> {
    if (question.workspaceId !== snapshot.workspaceId || question.nodeRef.workspaceId !== snapshot.workspaceId || question.nodeRef.objectId !== request.nodeRef.objectId
      || question.nodeRef.revision !== request.nodeRef.revision || question.revision !== request.questionRevision || question.id !== request.questionId
      || question.review.status !== 'approved' || !question.review.reviewedBy || !question.review.reviewedAt) return publicFailure('CONFLICT', 'Review question is not an approved exact-version question', 'reload_review_questions', 'preserved');
    const node = snapshot.nodes.find((item) => item.id === question.nodeRef.objectId);
    if (!node || node.workspaceId !== snapshot.workspaceId || node.revision !== question.nodeRef.revision || node.confirmation !== 'confirmed' || node.lifecycle !== 'active' || snapshot.excludedIds.includes(node.id)) return publicFailure('CONFLICT', 'Review question knowledge version is unavailable', 'reload_review_context', 'preserved');
    if (new Set(question.rubric.criteria.map((criterion) => criterion.id)).size !== question.rubric.criteria.length) return publicFailure('VALIDATION', 'Review rubric criterion IDs cannot repeat', 'repair_review_question');
    if (question.kind === 'near_transfer' && (!question.transfer || question.transfer.dimension === 'numbers_only' || !question.rubric.necessaryConditions.length)) return publicFailure('VALIDATION', 'Near-transfer questions require a meaningful changed dimension and necessary conditions', 'choose_recall_question');
    return { ok: true, data: structuredClone(question) };
  }

  private checkSnapshot(attempt: ReviewAttemptState, snapshot: KnowledgeSnapshot): Result<true> {
    if (snapshot.workspaceId !== attempt.workspaceId || snapshot.revision !== attempt.snapshotRevision) return publicFailure('CONFLICT', 'Knowledge snapshot changed during review', 'review_question_again', 'preserved');
    const node = snapshot.nodes.find((item) => item.id === attempt.question.nodeRef.objectId);
    if (!node || node.revision !== attempt.question.nodeRef.revision || node.confirmation !== 'confirmed' || node.lifecycle !== 'active' || snapshot.excludedIds.includes(node.id)) return publicFailure('CONFLICT', 'Review knowledge became unavailable', 'review_question_again', 'preserved');
    return { ok: true, data: true };
  }

  private publicAttempt(state: ReviewAttemptState): ReviewAttemptPublic {
    const visibleAnswer = state.phase === 'submitted' || (state.phase === 'answering' && state.answerRevealed);
    const evidenceClass = !state.submission || state.phase === 'cancelled' ? 'not_submitted' as const
      : state.exposure === 'unknown' ? 'unverified_exposure' as const
        : state.submission.answerVisible || state.submission.hintLevel > 0 ? 'assisted_restatement' as const
          : state.question.kind === 'recall' ? 'unassisted_recall' as const : 'unassisted_near_transfer' as const;
    const feedback = state.phase === 'submitted' && state.feedback ? (() => {
      const { originalAnswer: _originalAnswer, persistence: _persistence, ...publicFeedback } = state.feedback!;
      return publicFeedback;
    })() : null;
    return ReviewAttemptPublicSchema.parse({
      id: state.id,
      version: state.version,
      taskId: state.taskId,
      phase: state.phase,
      question: {
        id: state.question.id,
        revision: state.question.revision,
        kind: state.question.kind,
        nodeRef: state.question.nodeRef,
        prompt: state.question.prompt,
        rubricVersion: state.question.rubric.version,
        reviewStatus: state.question.review.status,
        transfer: state.question.transfer ?? null,
      },
      confidence: state.confidence,
      hintLevel: state.hintLevel,
      hints: state.phase === 'cancelled' ? [] : state.question.hints.slice(0, state.hintLevel),
      answerVisible: state.exposure !== 'unexposed' || (state.phase !== 'cancelled' && state.answerRevealed),
      answerRevealed: state.phase === 'cancelled' ? false : state.answerRevealed,
      evidenceClass,
      submission: state.submission ? structuredClone(state.submission) : null,
      ...(visibleAnswer ? { standardAnswer: state.question.standardAnswer } : {}),
      feedback,
      appeals: state.appeals.map(({ operationId, feedbackVersion, nodeRef, reason, status, createdAt }) => ({ operationId, feedbackVersion, nodeRef, reason, status, createdAt })),
      persistence: 'shared_services',
    });
  }

  private nextAttempt(current: ReviewAttemptState, request: ReviewAttemptEventRequest, actorId: string): Result<ReviewAttemptState> {
    const event = request.event, next = structuredClone(current), now = new Date(this.now()).toISOString();
    if (current.actorId !== actorId || current.phase === 'cancelled') return conflict('Cancelled or foreign review attempts cannot accept another event');
    if (event.type === 'cancel') next.phase = 'cancelled';
    else if (event.type === 'confidence') {
      if (current.phase !== 'confidence' || current.confidence.locked) return conflict('Confidence can only be chosen once before answering');
      next.confidence = { value: event.value, recordedAt: now, locked: false };
    } else if (event.type === 'begin') {
      if (current.phase !== 'confidence' || !current.confidence.value) return publicFailure('CONFLICT', 'Choose or skip confidence before starting the answer', 'choose_confidence', 'preserved');
      next.confidence.locked = true; next.phase = 'answering';
    } else if (event.type === 'hint') {
      if (current.phase !== 'answering' || event.level !== current.hintLevel + 1) return conflict('Hints must be requested one level at a time');
      next.hintLevel = event.level; next.exposure = 'seen';
      next.exposureEvents.push({ operationId: request.operationId, type: 'hint', level: event.level, recordedAt: now });
    } else if (event.type === 'reveal') {
      if (!['answering', 'submitted'].includes(current.phase)) return publicFailure('VALIDATION', 'The answer can only be revealed after the attempt begins', 'begin_review');
      next.answerRevealed = true; if (!current.submission) next.exposure = 'seen';
      next.exposureEvents.push({ operationId: request.operationId, type: 'reveal', recordedAt: now });
    } else if (event.type === 'submit') {
      if (current.phase !== 'answering' || !current.confidence.locked || !current.confidence.value) return conflict('Submit requires a locked confidence choice and an active answer phase');
      next.submission = { answer: event.answer, answerVisible: current.exposure !== 'unexposed' || current.answerRevealed,
        hintLevel: current.hintLevel, selfConfidence: current.confidence.value, submittedAt: now };
      next.feedback = ReviewFeedbackStateSchema.parse({ attemptId: current.id, rubricVersion: current.question.rubric.version,
        originalAnswer: event.answer, source: 'human_self_review', version: 0, result: 'unverified',
        criteria: current.question.rubric.criteria.map((criterion) => ({ criterionId: criterion.id, description: criterion.description,
          expectedEvidence: criterion.expectedEvidence, required: criterion.required, finding: 'unreviewed', answerQuote: '', rationale: '' })),
        invalidReason: null, reviewedBy: null, reviewedAt: null, history: [], persistence: 'shared_services' });
      next.exposureEvents.push({ operationId: request.operationId, type: 'answer_browse', recordedAt: now });
      next.phase = 'submitted';
    }
    next.version += 1; next.updatedAt = now;
    return { ok: true, data: ReviewAttemptStateSchema.parse(next) };
  }

  private buildFeedback(current: ReviewAttemptState, request: ReviewFeedbackRequest): Result<ReviewFeedbackState> {
    if (!current.submission) return conflict('Feedback needs the original submitted answer');
    const parsed = ReviewFeedbackInputSchema.safeParse(request.review); if (!parsed.success) return publicFailure('VALIDATION', 'Feedback fields are incomplete', 'complete_rubric_review');
    const value = parsed.data, previous = current.feedback;
    if ((previous?.result === 'invalid_question') && value.invalidReason === null) return conflict('An invalid-question appeal cannot be silently replaced by a normal grade');
    if (value.invalidReason !== null && value.criteria.length) return publicFailure('VALIDATION', 'An invalid question appeal cannot include criterion grades', 'mark_question_invalid');
    let criteria: ReviewFeedbackState['criteria'] = current.question.rubric.criteria.map((criterion) => ({ criterionId: criterion.id, description: criterion.description,
      expectedEvidence: criterion.expectedEvidence, required: criterion.required, finding: 'unreviewed' as const, answerQuote: '', rationale: '' }));
    let result: ReviewFeedbackState['result'] = 'invalid_question';
    if (value.invalidReason === null) {
      const ids = new Set(value.criteria.map((criterion) => criterion.criterionId));
      if (ids.size !== current.question.rubric.criteria.length || ids.size !== value.criteria.length || current.question.rubric.criteria.some((criterion) => !ids.has(criterion.id))) return publicFailure('VALIDATION', 'Every rubric criterion needs one distinct review', 'complete_rubric_review');
      for (const criterion of value.criteria) {
        if ((criterion.finding !== 'not_met' && !criterion.answerQuote) || (criterion.answerQuote && !current.submission.answer.includes(criterion.answerQuote))) return publicFailure('VALIDATION', 'Criterion evidence must be an exact quote from the original answer', 'correct_rubric_quotes');
      }
      criteria = criteria.map((criterion) => ({ ...criterion, ...value.criteria.find((item) => item.criterionId === criterion.criterionId)! }));
      result = criteria.every((criterion) => criterion.finding === 'met') ? 'met_rubric' : criteria.some((criterion) => criterion.finding !== 'not_met') ? 'partial' : 'not_met';
    }
    const version = previous?.version ?? 0;
    if (request.feedbackVersion !== version) return conflict('Feedback version changed; read the current attempt before reviewing again');
    const now = new Date(this.now()).toISOString();
    const old = previous ? { version: previous.version, result: previous.result, criteria: previous.criteria, invalidReason: previous.invalidReason, reviewedBy: previous.reviewedBy, reviewedAt: previous.reviewedAt } : null;
    return { ok: true, data: ReviewFeedbackStateSchema.parse({ attemptId: current.id, rubricVersion: current.question.rubric.version, originalAnswer: current.submission.answer,
      source: 'human_self_review', version: version + 1, result, criteria, invalidReason: value.invalidReason, reviewedBy: current.actorId, reviewedAt: now,
      history: old ? [...(previous?.history ?? []), old] : [], persistence: 'shared_services' }) };
  }

  private commitMutation(ctx: RequestContext, operationId: string, requestHash: string, kind: ReviewOperationKind, current: ReviewAttemptState, next: ReviewAttemptState, feedbackVersion: number | null): Result<ReviewOperationReceipt> {
    const now = new Date(this.now()).toISOString();
    const receipt = ReviewOperationReceiptSchema.parse({ operationId, attemptId: current.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, kind, requestHash,
      expectedVersion: current.version, resultingVersion: next.version, feedbackVersion, appliedAt: now, expiresAt: current.expiresAt, retentionDays: 30, outcome: 'applied' });
    try {
      return this.journal.transaction(() => {
        const finalAccess = this.access(ctx, 'evidence:write', kind === 'cancel' ? [current.id] : [current.id, current.taskId, current.question.id, current.question.nodeRef.objectId]); if (!finalAccess.ok) return finalAccess;
        if (kind !== 'cancel') { const finalKnowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!finalKnowledge.ok) return finalKnowledge; }
        const prior = this.receipt(ctx, operationId); if (!prior.ok) return prior;
        if (prior.data) return this.recoverApplied(ctx, operationId, requestHash, prior.data);
        const row = this.journal.record(ctx.workspaceId, '@workspace', 'review_attempt', current.id);
        if (!row) return conflict('The original attempt disappeared before the operation was applied');
        const stored = StoredAttemptSchema.parse(row.value);
        if (stored.state !== 'available' || !stored.attempt || isExpired(stored.expiresAt, this.now())) return conflict('The original attempt expired before the operation was applied');
        if (stored.attempt.actorId !== ctx.actorId || stored.attempt.version !== current.version) return conflict('A competing session changed the attempt');
        if (canonicalJson(stored.attempt) !== canonicalJson(current)) return conflict('A competing session changed the persisted attempt state');
        const applied = structuredClone(next);
        if (!current.submission && this.ledger.active(ctx, current.question.nodeRef)?.seenAt) {
          applied.exposure = 'seen';
          if (applied.submission) applied.submission.answerVisible = true;
        }
        const value = { state: 'available' as const, attempt: applied, requestHash: stored.requestHash, expiresAt: stored.expiresAt };
        const oldBytes = Buffer.byteLength(canonicalJson(stored));
        if (!this.journal.reviewPayloadFits(ctx.workspaceId, Buffer.byteLength(canonicalJson(value)), oldBytes, true)) return publicFailure('VALIDATION', 'Review storage capacity is exhausted', 'reduce_review_retention');
        if (['hint', 'reveal', 'submit'].includes(kind)) this.ledger.seen(ctx, current.question.nodeRef);
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'review_attempt', current.id, value, row.version)
          || !this.journal.putRecord(ctx.workspaceId, '@workspace', 'review_operation_receipt', operationId, { receipt }, null)) throw new Error('Review event transaction failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, `review_${kind}_applied`, [current.id], 'private_not_indexed');
        return { ok: true, data: structuredClone(receipt) };
      });
    } catch { return publicFailure('UNKNOWN_RESULT', 'Review operation could not be verified', 'read_review_operation', 'unknown'); }
  }
}
