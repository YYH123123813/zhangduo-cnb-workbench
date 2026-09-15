import type { RequestContext, Result } from '../../contracts/api';
import { contentHash } from '../../contracts/hash';
import {
  ReviewAttemptPublicSchema,
  ReviewQuestionPublicSchema,
  ReviewQuestionQuerySchema,
  ReviewOperationRecoverySchema,
  ReviewRuntimeStatusSchema,
  type ReviewRuntimeStatus,
  type ReviewOperationReceipt,
} from '../../contracts/review-session';
import type { Services } from '../../contracts/ports';
import { failure, success } from './errors';
import type { AttemptResponse, ReviewCatalogResponse, TrustedReviewRequest } from './review-api';
import { AttemptResponseSchema } from './attempt-response';

const reviewUnavailable = <T>(message: string): Result<T> => failure('NOT_IMPLEMENTED', message, 'await_review_integration');
const reviewUnknown = <T>(message: string): Result<T> => failure('UNKNOWN_RESULT', message, 'read_review_operation', 'unknown');

export function hasTrustedReviewPorts(services: Services): boolean {
  return !!(services.readReviewQuestions && services.startReviewAttempt && services.applyReviewEvent
    && services.saveReviewFeedback && services.saveReviewAppeal && services.readReviewAttempt && services.readReviewOperation);
}

export async function readTrustedReviewRuntime(services: Services, ctx: RequestContext): Promise<Result<ReviewRuntimeStatus>> {
  if (!hasTrustedReviewPorts(services) || !services.readReviewRuntime) return reviewUnavailable('受信回顾运行能力尚未连接，未启动新会话。');
  const result = await services.readReviewRuntime(ctx);
  if (!result.ok) return result;
  const parsed = ReviewRuntimeStatusSchema.safeParse(result.data);
  if (!parsed.success || parsed.data.mode !== ctx.mode
    || (parsed.data.catalog === 'ready') !== (parsed.data.availableQuestionCount > 0)) {
    return reviewUnavailable('受信回顾运行能力无法核验，未启动新会话。');
  }
  return success(parsed.data);
}

export async function readTrustedReviewQuestions(services: Services, ctx: RequestContext, query: unknown): Promise<Result<ReviewCatalogResponse>> {
  const parsed = ReviewQuestionQuerySchema.safeParse(query);
  if (!parsed.success) return failure('VALIDATION', '请指定节点 ID 和原知识版本。');
  const readQuestions = services.readReviewQuestions;
  const runtime = await readTrustedReviewRuntime(services, ctx);
  if (!runtime.ok) return runtime;
  if (runtime.data.catalog !== 'ready' || !readQuestions) return reviewUnavailable('当前没有保留中的审核题，未启动新会话。');
  const result = await readQuestions(ctx, parsed.data);
  if (!result.ok) return result;
  if (!Array.isArray(result.data)) return reviewUnavailable('审核题目录结构无法核验，未展示题目。');
  const questions = [];
  for (const input of result.data) {
    const publicInput = ReviewQuestionPublicSchema.safeParse(input);
    if (!publicInput.success || publicInput.data.nodeRef.workspaceId !== ctx.workspaceId
      || publicInput.data.nodeRef.objectId !== parsed.data.nodeId || publicInput.data.nodeRef.revision !== parsed.data.revision
      || publicInput.data.reviewStatus !== 'approved') {
      return failure('CONFLICT', '审核题目录包含不可核验的工作区或知识版本，未展示题目。', 'reload_review_questions', 'preserved');
    }
    questions.push(publicInput.data);
  }
  return success({ questions });
}

function operationPayload<T extends TrustedReviewRequest>(request: T) {
  const { action: _action, ...payload } = request;
  return payload;
}

function checkedRecovery(input: unknown, ctx: RequestContext, operationId: string): Result<ReviewOperationReceipt> {
  const parsed = ReviewOperationRecoverySchema.safeParse(input);
  if (!parsed.success) return reviewUnknown('受信学习操作回执结构无法核验。');
  const recovery = parsed.data, receipt = recovery.receipt;
  if (recovery.state !== 'applied' || !receipt || recovery.operationId !== operationId
    || recovery.actorId !== ctx.actorId || recovery.workspaceId !== ctx.workspaceId
    || receipt.operationId !== operationId || receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId
    || recovery.attemptId !== receipt.attemptId || recovery.requestHash !== receipt.requestHash) {
    return reviewUnknown('原学习操作仍未知，或回执身份、操作与请求摘要不匹配。');
  }
  return success(receipt);
}

function operationExpectation(request: TrustedReviewRequest) {
  const operationId = request.operationId;
  if (request.action === 'start') return { operationId, attemptId: operationId, kind: 'start' as const, expectedVersion: 0, resultingVersion: 0, feedbackVersion: null };
  if (request.action === 'event') return { operationId, attemptId: request.attemptId, kind: request.event.type, expectedVersion: request.expectedVersion,
    resultingVersion: request.expectedVersion + 1, feedbackVersion: null };
  if (request.action === 'feedback') return { operationId, attemptId: request.attemptId, kind: 'feedback' as const, expectedVersion: request.expectedVersion,
    resultingVersion: request.expectedVersion + 1, feedbackVersion: request.feedbackVersion + 1 };
  return { operationId, attemptId: request.attemptId, kind: 'appeal' as const, expectedVersion: request.expectedVersion,
    resultingVersion: request.expectedVersion + 1, feedbackVersion: request.feedbackVersion };
}

function matchesReceipt(receipt: ReviewOperationReceipt, request: TrustedReviewRequest, requestHash: string): boolean {
  const expected = operationExpectation(request);
  return receipt.operationId === expected.operationId && receipt.attemptId === expected.attemptId
    && receipt.actorId.length > 0 && receipt.workspaceId.length > 0
    && receipt.kind === expected.kind && receipt.requestHash === requestHash
    && receipt.expectedVersion === expected.expectedVersion && receipt.resultingVersion === expected.resultingVersion
    && receipt.feedbackVersion === expected.feedbackVersion;
}

async function readAppliedOperation(services: Services, ctx: RequestContext, request: TrustedReviewRequest, requestHash: string): Promise<Result<ReviewOperationReceipt>> {
  if (!services.readReviewOperation) return reviewUnavailable('受信学习操作回执端口尚未连接，未确认本次作答。');
  const result = await services.readReviewOperation(ctx, request.operationId);
  if (!result.ok) return result;
  const receipt = checkedRecovery(result.data, ctx, request.operationId);
  if (!receipt.ok) return receipt;
  if (!matchesReceipt(receipt.data, request, requestHash)) {
    return reviewUnknown('受信学习操作回执缺失、身份/请求摘要不匹配或结果仍未知。');
  }
  return receipt;
}

async function readAttempt(services: Services, ctx: RequestContext, receipt: ReviewOperationReceipt): Promise<Result<import('../../contracts/review-session').ReviewAttemptPublic>> {
  if (!services.readReviewAttempt) return reviewUnavailable('受信作答会话读回端口尚未连接。');
  const result = await services.readReviewAttempt(ctx, receipt.attemptId);
  if (!result.ok) return result;
  if (!result.data) return reviewUnknown('原受信作答会话不存在、已过期或尚未可读。');
  const publicState = ReviewAttemptPublicSchema.safeParse(result.data);
  if (!publicState.success || publicState.data.id !== receipt.attemptId || publicState.data.version < receipt.resultingVersion
    || publicState.data.question.nodeRef.workspaceId !== ctx.workspaceId) return reviewUnknown('原受信作答会话身份、版本或结构无法核验。');
  if (ctx.mode === 'live' && publicState.data.evidenceClass.startsWith('unassisted_')) return reviewUnknown('当前运行不能认证无提示掌握，未接受该作答证明。');
  return success(publicState.data);
}

function responseFrom(state: import('../../contracts/review-session').ReviewAttemptPublic, receipt: ReviewOperationReceipt): Result<AttemptResponse> {
  const { feedback: publicFeedback, appeals: _appeals, ...view } = state;
  const feedback = publicFeedback ? { ...structuredClone(publicFeedback), originalAnswer: view.submission?.answer ?? '', persistence: 'shared_services' as const } : null;
  const parsed = AttemptResponseSchema.safeParse({ view: { ...structuredClone(view), persistence: 'shared_services' }, feedback, receipt });
    return parsed.success ? success(parsed.data) : reviewUnknown('原作答状态不一致，未交付正文。');
}

export async function applyTrustedReviewRequest(services: Services, ctx: RequestContext, request: TrustedReviewRequest): Promise<Result<AttemptResponse>> {
  if (!services.readReviewOperation || !services.readReviewAttempt) return reviewUnavailable('受信会话及专用回执端口尚未连接。');
  if (request.action === 'start') {
    const catalog = await readTrustedReviewQuestions(services, ctx, { nodeId: request.nodeRef.objectId, revision: request.nodeRef.revision });
    if (!catalog.ok) return catalog;
    if (request.nodeRef.workspaceId !== ctx.workspaceId || !catalog.data.questions.some((q) => q.id === request.questionId && q.revision === request.questionRevision)) {
      return failure('CONFLICT', '所选审核题或原知识版本已不可用，未启动作答。', 'reload_review_questions', 'not_written');
    }
  }
  const port = request.action === 'start' ? services.startReviewAttempt : request.action === 'event' ? services.applyReviewEvent
    : request.action === 'feedback' ? services.saveReviewFeedback : services.saveReviewAppeal;
  if (!port) return reviewUnavailable('本次受信学习操作端口尚未连接。');
  const requestHash = await contentHash(operationPayload(request));
  let mutation: Result<unknown>;
  if (request.action === 'start') mutation = await services.startReviewAttempt!(ctx, operationPayload(request));
  else if (request.action === 'event') mutation = await services.applyReviewEvent!(ctx, operationPayload(request));
  else if (request.action === 'feedback') mutation = await services.saveReviewFeedback!(ctx, operationPayload(request));
  else mutation = await services.saveReviewAppeal!(ctx, operationPayload(request));
  if (!mutation.ok) return mutation;
  const receipt = await readAppliedOperation(services, ctx, request, requestHash);
  if (!receipt.ok) return { ok: false, error: { ...receipt.error, dataState: 'unknown', retryable: false, nextAction: 'read_review_operation' } };
  const state = await readAttempt(services, ctx, receipt.data);
  return state.ok ? responseFrom(state.data, receipt.data)
    : { ok: false, error: { ...state.error, dataState: 'unknown', retryable: false, nextAction: 'read_review_operation' } };
}

export async function readTrustedReviewOperation(services: Services, ctx: RequestContext, operationId: string, requestHash?: string): Promise<Result<AttemptResponse>> {
  if (!services.readReviewOperation) return reviewUnavailable('受信学习操作回执端口尚未连接。');
  const recovery = await services.readReviewOperation(ctx, operationId);
  if (!recovery.ok) return recovery;
  const receipt = checkedRecovery(recovery.data, ctx, operationId);
  if (!receipt.ok) return receipt;
  if (requestHash !== undefined && receipt.data.requestHash !== requestHash) return reviewUnknown('原操作回执未匹配保留的请求摘要，未读取会话正文。');
  const state = await readAttempt(services, ctx, receipt.data);
  return state.ok ? responseFrom(state.data, receipt.data) : state;
}

export async function readTrustedReviewReceipt(services: Services, ctx: RequestContext, operationId: string): Promise<Result<ReviewOperationReceipt>> {
  if (!services.readReviewOperation) return reviewUnavailable('受信学习操作回执端口尚未连接。');
  const result = await services.readReviewOperation(ctx, operationId);
  return result.ok ? checkedRecovery(result.data, ctx, operationId) : result;
}
