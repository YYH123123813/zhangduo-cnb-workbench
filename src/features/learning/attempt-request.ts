import type { Result } from '../../contracts/api';
import type { VersionRef } from '../../contracts/domain';
import type { ReviewOperationReceipt } from '../../contracts/review-session';
import { contentHash } from '../../contracts/hash';
import { ReviewRequestSchema, TrustedReviewRequestSchema, type ReviewRequest, type AttemptResponse } from './review-api';
import { AttemptResponseSchema } from './attempt-response';
import type { AttemptEvent } from './attempt';
import { failure, success } from './errors';

interface Expectation {
  id: string; operationId: string;
  requestHash?: string;
  minVersion: number;
  minFeedbackVersion?: number;
  taskId?: string;
  questionId?: string;
  questionRevision?: string;
  rubricVersion?: string;
  nodeRef?: VersionRef;
  eventType?: AttemptEvent['type'];
  operationKind?: ReviewOperationReceipt['kind'];
  expectedFeedbackVersion?: number;
  resultingVersion?: number;
  hintLevel?: number;
  confidenceValue?: string;
}
interface RequestTicket { readonly kind: 'mutation' | 'read_back'; readonly target: Expectation }

function matches(target: Expectation, response: AttemptResponse, requireReceipt: boolean) {
  const view = response?.view;
  if (!view || view.id !== target.id || !Number.isSafeInteger(view.version) || view.version < target.minVersion) return false;
  if (!['confidence', 'answering', 'submitted', 'cancelled'].includes(view.phase)) return false;
  if (target.taskId && view.taskId !== target.taskId) return false;
  if (target.questionId && (view.question?.id !== target.questionId || view.question.revision !== target.questionRevision)) return false;
  if (target.rubricVersion && view.question.rubricVersion !== target.rubricVersion) return false;
  if (target.nodeRef && (view.question?.nodeRef?.workspaceId !== target.nodeRef.workspaceId
    || view.question.nodeRef.objectId !== target.nodeRef.objectId || view.question.nodeRef.revision !== target.nodeRef.revision)) return false;
  if (target.minFeedbackVersion !== undefined && (!response.feedback || response.feedback.attemptId !== target.id
    || !Number.isSafeInteger(response.feedback.version) || response.feedback.version < target.minFeedbackVersion)) return false;
  if (target.expectedFeedbackVersion !== undefined && (!response.feedback || response.feedback.attemptId !== target.id
    || (requireReceipt ? response.feedback.version < target.expectedFeedbackVersion : response.feedback.version !== target.expectedFeedbackVersion))) return false;
  if (requireReceipt) {
    const receipt = response.receipt;
    const expectedKind = target.operationKind ?? target.eventType ?? (target.minFeedbackVersion !== undefined ? 'feedback' : 'start');
    const expectedVersion = target.operationKind === 'start' ? 0 : target.operationKind === 'feedback' ? target.minVersion : target.minVersion - 1;
    const expectedFeedbackVersion = target.minFeedbackVersion ?? target.expectedFeedbackVersion ?? null;
    if (!receipt || receipt.operationId !== target.operationId || receipt.attemptId !== view.id
      || receipt.kind !== expectedKind || target.resultingVersion === undefined || receipt.expectedVersion !== expectedVersion
      || (target.requestHash !== undefined && target.resultingVersion !== undefined
        ? receipt.resultingVersion !== target.resultingVersion : receipt.resultingVersion < target.minVersion)
      || view.version < receipt.resultingVersion || (target.requestHash && receipt.requestHash !== target.requestHash)
      || receipt.feedbackVersion !== expectedFeedbackVersion) return false;
    return true;
  }
  if (target.eventType === 'submit' && !view.submission) return false;
  if (target.eventType === 'cancel' && view.phase !== 'cancelled') return false;
  if (target.eventType === 'begin' && !view.confidence.locked) return false;
  if (target.eventType === 'reveal' && !view.answerRevealed) return false;
  if (target.hintLevel !== undefined && view.hintLevel < target.hintLevel) return false;
  if (target.confidenceValue !== undefined && view.confidence.value !== target.confidenceValue) return false;
  return true;
}

// Only request metadata is held here. It neither stores answers nor replaces server CAS/operation logs.
export class AttemptRequestGate {
  private active: RequestTicket | null = null;
  private unresolved: Expectation | null = null;
  private confirmed: (Expectation & { phase: AttemptResponse['view']['phase'] }) | null = null;

  constructor(private readonly options: { requireReceipt?: boolean } = {}) {}

  get blocked() { return this.active !== null || this.unresolved !== null; }
  get needsReadBack() { return this.unresolved !== null; }
  get recoveryId() { return this.unresolved?.id ?? null; }
  get recoveryOperationId() { return this.unresolved?.operationId ?? null; }
  get recoveryRequestHash() { return this.unresolved?.requestHash ?? null; }

  async beginTrusted(input: ReviewRequest): Promise<Result<RequestTicket>> {
    const pending = this.begin(input);
    if (!pending.ok) return pending;
    const parsed = TrustedReviewRequestSchema.safeParse(input);
    if (!parsed.success) {
      this.reject(pending.data, failure('VALIDATION', '受信作答请求尚未满足共享保存条件。'));
      return failure('VALIDATION', '受信作答请求尚未满足共享保存条件。');
    }
    const { action: _action, ...payload } = parsed.data;
    const requestHash = await contentHash(payload);
    if (this.active !== pending.data) return failure('CONFLICT', '作答请求已被其他操作取代。', 'read_back', 'preserved');
    pending.data.target.requestHash = requestHash;
    return pending;
  }

  begin(input: ReviewRequest): Result<RequestTicket> {
    if (this.blocked) return failure('CONFLICT', '上一作答操作仍在进行或结果未知，请先核验原会话。', 'read_back', 'preserved');
    const parsed = ReviewRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', '作答请求格式不正确。');
    const request = parsed.data;
    if (request.action !== 'start' && this.confirmed?.id === request.attemptId && request.expectedVersion !== this.confirmed.minVersion) {
      return failure('CONFLICT', '请求版本与已核验的作答状态不一致，未发送操作。', 'use_last_verified_version', 'preserved');
    }
    const target: Expectation = request.action === 'start'
      ? { id: request.operationId, operationId: request.operationId, minVersion: 0, resultingVersion: 0, operationKind: 'start', taskId: request.taskId, questionId: request.questionId,
        questionRevision: request.questionRevision, nodeRef: structuredClone(request.nodeRef) }
      : { ...(this.confirmed?.id === request.attemptId ? this.confirmed : {}), id: request.attemptId, operationId: request.operationId,
        minVersion: request.action === 'feedback' ? request.expectedVersion : request.expectedVersion + 1,
        resultingVersion: request.expectedVersion + 1,
        ...(request.action === 'event' ? { operationKind: request.event.type, eventType: request.event.type,
          ...(request.event.type === 'hint' ? { hintLevel: request.event.level } : {}),
          ...(request.event.type === 'confidence' ? { confidenceValue: request.event.value } : {}) }
          : request.action === 'feedback' ? { operationKind: 'feedback' as const, minFeedbackVersion: request.feedbackVersion + 1 }
            : { operationKind: 'appeal' as const, expectedFeedbackVersion: request.feedbackVersion, nodeRef: structuredClone(request.nodeRef) }) };
    this.active = { kind: 'mutation', target };
    return success(this.active);
  }

  beginReadBack(): Result<RequestTicket> {
    if (this.active || !this.unresolved) return failure('CONFLICT', '没有可核验的空闲作答请求。', 'wait_for_current_request');
    this.active = { kind: 'read_back', target: this.unresolved };
    return success(this.active);
  }

  accept(ticket: RequestTicket, response: unknown): Result<AttemptResponse> {
    if (this.active !== ticket) return failure('CONFLICT', '已忽略过期请求响应。', 'read_back', 'preserved');
    this.active = null;
    const parsed = AttemptResponseSchema.safeParse(response);
    if (!parsed.success || !matches(ticket.target, parsed.data, this.options.requireReceipt === true)) {
      this.unresolved = ticket.target;
      return failure('UNKNOWN_RESULT', '响应不属于原作答，或尚未反映刚才的状态变更。', 'read_back_same_attempt_id', 'unknown');
    }
    const { view } = parsed.data;
    this.confirmed = { id: view.id, operationId: ticket.target.operationId, minVersion: view.version, phase: view.phase, taskId: view.taskId, questionId: view.question.id,
      questionRevision: view.question.revision, rubricVersion: view.question.rubricVersion, nodeRef: structuredClone(view.question.nodeRef) };
    this.unresolved = null;
    return success(parsed.data);
  }

  reject(ticket: RequestTicket, result: Result<unknown>) {
    if (this.active !== ticket) return;
    this.active = null;
    this.unresolved = ticket.kind === 'read_back' || result.ok || result.error.code === 'CONFLICT'
      || result.error.dataState !== 'not_written' ? ticket.target : null;
  }

  // Releasing a local view does not cancel, persist or delete its server-side attempt.
  releaseView(attemptId: string): Result<null> {
    if (this.blocked) return failure('CONFLICT', '原作答操作尚未核验，不能关闭本次作答视图。', 'read_back', 'preserved');
    if (this.confirmed?.id !== attemptId || !['submitted', 'cancelled'].includes(this.confirmed.phase)) {
      return failure('CONFLICT', '请先提交作答或核验取消结果，再返回回顾队列。', 'cancel_or_complete_attempt', 'preserved');
    }
    this.confirmed = null;
    return success(null);
  }

  interrupt() {
    if (this.active) this.unresolved = this.active.target;
    this.active = null;
  }
}
