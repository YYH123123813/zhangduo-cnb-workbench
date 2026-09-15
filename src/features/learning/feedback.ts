import { z } from 'zod';
import { Id, Timestamp, type EvidenceRecord } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import type { AttemptSession } from './attempt';
import { failure, success } from './errors';

const CriterionReviewSchema = z.object({
  criterionId: Id, finding: z.enum(['met', 'partial', 'not_met']),
  answerQuote: z.string().trim().max(16000), rationale: z.string().trim().min(1).max(4000),
}).strict();
export const FeedbackInputSchema = z.object({ criteria: z.array(CriterionReviewSchema).max(12), invalidReason: z.string().trim().min(1).max(4000).nullable() }).strict();
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
export interface CriterionFeedback {
  criterionId: string; description: string; expectedEvidence: string; required: boolean;
  finding: 'unreviewed' | 'met' | 'partial' | 'not_met'; answerQuote: string; rationale: string;
}
interface FeedbackRevision {
  version: number; result: EvidenceRecord['result']; criteria: CriterionFeedback[];
  invalidReason: string | null; reviewedBy: string | null; reviewedAt: string | null;
}
export interface FeedbackDraft extends FeedbackRevision {
  attemptId: string; rubricVersion: string; originalAnswer: string; source: 'human_self_review';
  history: FeedbackRevision[]; persistence: 'not_saved' | 'shared_services';
}

export function createFeedback(attempt: AttemptSession): Result<FeedbackDraft> {
  if (attempt.phase !== 'submitted' || !attempt.submission) return failure('CONFLICT', '请先提交本次作答，评分依据不会提前显示。');
  return success({
    attemptId: attempt.id, rubricVersion: attempt.question.rubric.version, originalAnswer: attempt.submission.answer,
    source: 'human_self_review', version: 0, result: 'unverified', history: [], invalidReason: null,
    reviewedBy: null, reviewedAt: null, persistence: 'not_saved',
    criteria: attempt.question.rubric.criteria.map((criterion) => ({ criterionId: criterion.id, description: criterion.description, expectedEvidence: criterion.expectedEvidence, required: criterion.required, finding: 'unreviewed', answerQuote: '', rationale: '' })),
  });
}

export function reviewFeedback(previous: FeedbackDraft, input: unknown, attempt: AttemptSession, ctx: RequestContext, expectedVersion: number, now: string): Result<FeedbackDraft> {
  if (attempt.actorId !== ctx.actorId || attempt.workspaceId !== ctx.workspaceId || !ctx.scopes.includes('evidence:write')) return failure('FORBIDDEN', '不能更改其他操作者的评阅。');
  if (attempt.phase !== 'submitted' || !attempt.submission || previous.attemptId !== attempt.id || previous.originalAnswer !== attempt.submission.answer || previous.rubricVersion !== attempt.question.rubric.version || expectedVersion !== previous.version) return failure('CONFLICT', '作答或评分规则版本不匹配，请读回原始记录。', 'reload_feedback', 'preserved');
  const parsed = FeedbackInputSchema.safeParse(input);
  if (!parsed.success || !Timestamp.safeParse(now).success || Date.parse(now) < Date.parse(attempt.submission.submittedAt) || (previous.reviewedAt && Date.parse(now) < Date.parse(previous.reviewedAt))) return failure('VALIDATION', '请完整填写分项判断、原文依据与说明。');
  const value = parsed.data;
  if (previous.result === 'invalid_question' && value.invalidReason === null) return failure('CONFLICT', '该题已标记无效，需要重新审核题目并创建新尝试。', 'review_question_again');
  let criteria = structuredClone(previous.criteria);
  let result: EvidenceRecord['result'] = 'invalid_question';
  if (value.invalidReason === null) {
    const ids = new Set(value.criteria.map((criterion) => criterion.criterionId));
    if (ids.size !== value.criteria.length || ids.size !== previous.criteria.length || previous.criteria.some((criterion) => !ids.has(criterion.criterionId))) return failure('VALIDATION', '每一个评分项都需要独立判断，不能遗漏或重复。');
    for (const criterion of value.criteria) {
      if ((criterion.finding !== 'not_met' && !criterion.answerQuote) || (criterion.answerQuote && !attempt.submission.answer.includes(criterion.answerQuote))) return failure('VALIDATION', '评分引用必须逐字出现在本次原始作答中。');
    }
    criteria = previous.criteria.map((criterion) => ({ ...criterion, ...value.criteria.find((item) => item.criterionId === criterion.criterionId)! }));
    result = criteria.every((criterion) => criterion.finding === 'met') ? 'met_rubric' : criteria.some((criterion) => criterion.finding === 'met' || criterion.finding === 'partial') ? 'partial' : 'not_met';
  }
  const { version, result: oldResult, criteria: oldCriteria, invalidReason, reviewedBy, reviewedAt } = previous;
  return success({ ...structuredClone(previous), version: version + 1, criteria, result,
    reviewedBy: ctx.actorId, reviewedAt: now, invalidReason: value.invalidReason,
    history: [...structuredClone(previous.history), structuredClone({ version, result: oldResult, criteria: oldCriteria, invalidReason, reviewedBy, reviewedAt })],
  });
}
