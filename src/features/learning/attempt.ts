import { z } from 'zod';
import { EvidenceRecordSchema, Id, Timestamp, type EvidenceRecord, type KnowledgeSnapshot } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { chooseConfidence, initialConfidence, lockConfidence, type ConfidenceChoice } from './confidence';
import { failure, success } from './errors';
import { inspectQuestion, publicQuestion, type ReviewQuestion } from './question';

export type AnswerExposure = 'unexposed' | 'seen' | 'unknown';
export interface AttemptSession {
  id: string; actorId: string; workspaceId: string; taskId: string; version: number;
  snapshotRevision: string; question: ReviewQuestion; exposure: AnswerExposure;
  phase: 'confidence' | 'answering' | 'submitted' | 'cancelled';
  confidence: ConfidenceChoice; hintLevel: number; answerRevealed: boolean; updatedAt: string;
  submission: { answer: string; answerVisible: boolean; hintLevel: number; selfConfidence: EvidenceRecord['selfConfidence']; submittedAt: string } | null;
}
export const AttemptEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('confidence'), value: EvidenceRecordSchema.shape.selfConfidence }).strict(),
  z.object({ type: z.literal('begin') }).strict(),
  z.object({ type: z.literal('hint'), level: z.number().int().min(1).max(3) }).strict(),
  z.object({ type: z.literal('reveal') }).strict(),
  z.object({ type: z.literal('submit'), answer: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
]);
export type AttemptEvent = z.infer<typeof AttemptEventSchema>;

export function startAttempt(input: unknown, question: ReviewQuestion, snapshot: KnowledgeSnapshot, ctx: RequestContext, exposure: AnswerExposure, now: string, priorRecall?: EvidenceRecord): Result<AttemptSession> {
  const parsed = z.object({ id: Id, taskId: Id }).strict().safeParse(input);
  if (!parsed.success || !Timestamp.safeParse(now).success || !['unexposed', 'seen', 'unknown'].includes(exposure)) return failure('VALIDATION', '作答身份或时间无效。');
  if (snapshot.workspaceId !== ctx.workspaceId || !ctx.scopes.includes('knowledge:read') || !ctx.scopes.includes('evidence:write')) return failure('FORBIDDEN', '没有在此工作区开始验证的权限。');
  const inspected = inspectQuestion(question, snapshot);
  if (!inspected.ok) return inspected;
  if (question.kind === 'near_transfer' && (!priorRecall || priorRecall.workspaceId !== ctx.workspaceId || priorRecall.kind !== 'recall' || priorRecall.answerVisible || priorRecall.hintLevel !== 0 || priorRecall.result === 'invalid_question' || !priorRecall.nodeRefs.some((ref) => ref.objectId === question.nodeRef.objectId && ref.revision === question.nodeRef.revision && ref.workspaceId === ctx.workspaceId))) {
    return failure('VALIDATION', '请先进行相同知识版本的无提示回忆，再选择近迁移。', 'start_recall');
  }
  return success({ ...parsed.data, actorId: ctx.actorId, workspaceId: ctx.workspaceId, version: 0,
    snapshotRevision: snapshot.revision, question: inspected.data, exposure,
    phase: 'confidence', confidence: initialConfidence(), hintLevel: 0, answerRevealed: false,
    updatedAt: now, submission: null,
  });
}

export function transitionAttempt(state: AttemptSession, input: unknown, ctx: RequestContext, expectedVersion: number, now: string, snapshot: KnowledgeSnapshot): Result<AttemptSession> {
  if (state.actorId !== ctx.actorId || state.workspaceId !== ctx.workspaceId || !ctx.scopes.includes('evidence:write')) return failure('FORBIDDEN', '不能更改其他操作者或工作区的作答。');
  if (expectedVersion !== state.version) return failure('CONFLICT', '作答状态已变化，请读回最新状态。', 'reload_attempt', 'preserved');
  const parsed = AttemptEventSchema.safeParse(input);
  if (!parsed.success || !Timestamp.safeParse(now).success || Date.parse(now) < Date.parse(state.updatedAt)) return failure('VALIDATION', '作答操作无效，原输入未更改。');
  if (state.phase === 'cancelled') return failure('CONFLICT', '本次作答已退出，不能继续提交。', 'start_new_attempt');
  const event = parsed.data;
  if (event.type !== 'cancel') {
    if (!ctx.scopes.includes('knowledge:read')) return failure('FORBIDDEN', '知识读取权限已撤销，不能继续验证或查看提示与答案。', 'request_access');
    if (snapshot.workspaceId !== ctx.workspaceId || snapshot.revision !== state.snapshotRevision) return failure('CONFLICT', '知识快照已变化，保留原作答并重新审核题目。', 'review_question_again', 'preserved');
    const inspected = inspectQuestion(state.question, snapshot);
    if (!inspected.ok) return inspected;
  }
  const next = structuredClone(state);
  if (event.type === 'cancel') next.phase = 'cancelled';
  else if (event.type === 'confidence') {
    if (next.phase !== 'confidence') return failure('CONFLICT', '已经开始作答，不能改写作答前信心。');
    const confidence = chooseConfidence(next.confidence, event.value, now);
    if (!confidence.ok) return confidence;
    next.confidence = confidence.data;
  } else if (event.type === 'begin') {
    if (next.phase !== 'confidence') return failure('CONFLICT', '本次作答已经开始。');
    const confidence = lockConfidence(next.confidence);
    if (!confidence.ok) return confidence;
    next.confidence = confidence.data; next.phase = 'answering';
  } else if (event.type === 'hint') {
    if (next.phase !== 'answering' || event.level !== next.hintLevel + 1) return failure('CONFLICT', '提示只能在作答期间逐级增加，不能倒退。', 'reload_attempt');
    next.hintLevel = event.level;
  } else if (event.type === 'reveal') {
    if (next.phase !== 'answering' && next.phase !== 'submitted') return failure('VALIDATION', '请先开始作答或退出回顾。');
    next.answerRevealed = true;
  } else if (event.type === 'submit') {
    if (next.phase !== 'answering' || !next.confidence.locked || next.confidence.value === null) return failure('CONFLICT', '不能跳过作答前步骤或重复修改已提交答案。', 'reload_attempt');
    next.submission = { answer: event.answer, answerVisible: next.exposure !== 'unexposed' || next.answerRevealed,
      hintLevel: next.hintLevel, selfConfidence: next.confidence.value, submittedAt: now };
    next.phase = 'submitted';
  }
  next.version += 1; next.updatedAt = now;
  return success(next);
}

export function classifyAttempt(state: AttemptSession) {
  if (!state.submission || state.phase === 'cancelled') return 'not_submitted' as const;
  if (state.question.review.status !== 'approved') return 'practice_only' as const;
  if (state.exposure === 'unknown') return 'unverified_exposure' as const;
  if (state.submission.answerVisible || state.submission.hintLevel > 0) return 'assisted_restatement' as const;
  return state.question.kind === 'recall' ? 'unassisted_recall' as const : 'unassisted_near_transfer' as const;
}

export function publicAttempt(state: AttemptSession) {
  const visible = state.phase !== 'cancelled' && (state.answerRevealed || state.phase === 'submitted');
  return {
    id: state.id, version: state.version, taskId: state.taskId, phase: state.phase,
    question: publicQuestion(state.question), confidence: structuredClone(state.confidence),
    hintLevel: state.hintLevel, hints: state.phase === 'cancelled' ? [] : state.question.hints.slice(0, state.hintLevel),
    answerVisible: state.exposure !== 'unexposed' || state.answerRevealed, answerRevealed: state.answerRevealed,
    evidenceClass: classifyAttempt(state), submission: state.submission ? structuredClone(state.submission) : null,
    ...(visible ? { standardAnswer: state.question.standardAnswer } : {}),
    persistence: 'not_saved' as 'not_saved' | 'shared_services',
  };
}
export type PublicAttemptView = ReturnType<typeof publicAttempt>;
