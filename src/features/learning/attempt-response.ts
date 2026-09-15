import { z } from 'zod';
import { EvidenceRecordSchema, Id, Timestamp } from '../../contracts/domain';
import { ReviewOperationReceiptSchema } from '../../contracts/review-session';
import { ReviewQuestionSchema } from './question';
import type { AttemptResponse } from './review-api';

const Version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Text = z.string().min(1).max(8000);
const Question = ReviewQuestionSchema.pick({ id: true, revision: true, kind: true, nodeRef: true, prompt: true }).extend({
  rubricVersion: Id, reviewStatus: ReviewQuestionSchema.shape.review.shape.status,
  transfer: ReviewQuestionSchema.shape.transfer.unwrap().nullable(),
}).strict();
const Criterion = z.object({ criterionId: Id, description: Text, expectedEvidence: Text, required: z.boolean(),
  finding: z.enum(['unreviewed', 'met', 'partial', 'not_met']), answerQuote: z.string().max(16000), rationale: z.string().max(4000),
}).strict();
const FeedbackRevision = z.object({ version: Version, result: EvidenceRecordSchema.shape.result,
  criteria: z.array(Criterion).max(12), invalidReason: z.string().min(1).max(4000).nullable(),
  reviewedBy: Id.nullable(), reviewedAt: Timestamp.nullable(),
}).strict();
const Feedback = FeedbackRevision.extend({ attemptId: Id, rubricVersion: Id, originalAnswer: z.string().min(1).max(16000),
  source: z.literal('human_self_review'), history: z.array(FeedbackRevision), persistence: z.enum(['not_saved', 'shared_services']),
}).strict();
const View = z.object({
  id: Id, version: Version, taskId: Id, phase: z.enum(['confidence', 'answering', 'submitted', 'cancelled']), question: Question,
  confidence: z.object({ value: EvidenceRecordSchema.shape.selfConfidence.nullable(), recordedAt: Timestamp.nullable(), locked: z.boolean() }).strict(),
  hintLevel: EvidenceRecordSchema.shape.hintLevel, hints: z.array(Text).max(3), answerVisible: z.boolean(), answerRevealed: z.boolean(),
  evidenceClass: z.enum(['not_submitted', 'practice_only', 'unverified_exposure', 'assisted_restatement', 'unassisted_recall', 'unassisted_near_transfer']),
  submission: z.object({ answer: z.string().min(1).max(16000), answerVisible: z.boolean(), hintLevel: EvidenceRecordSchema.shape.hintLevel,
    selfConfidence: EvidenceRecordSchema.shape.selfConfidence, submittedAt: Timestamp,
  }).strict().nullable(),
  standardAnswer: Text.optional(), persistence: z.enum(['not_saved', 'shared_services']),
}).strict();

// This checks public consistency, not the server's trusted cross-session exposure evidence.
export const AttemptResponseSchema: z.ZodType<AttemptResponse> = z.object({ view: View, feedback: Feedback.nullable(), receipt: ReviewOperationReceiptSchema.optional() }).strict().superRefine(({ view, feedback }, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  const { phase, confidence, submission, question } = view;
  if ((confidence.value === null) !== (confidence.recordedAt === null)) invalid('Confidence choice and timestamp must be paired');
  if (phase === 'confidence' && (confidence.locked || view.hintLevel !== 0 || view.answerRevealed)) invalid('Confidence phase cannot have started or revealed');
  if ((phase === 'answering' || phase === 'submitted') && (!confidence.locked || confidence.value === null)) invalid('Answering requires a locked confidence choice');
  if (view.hints.length !== (phase === 'cancelled' ? 0 : view.hintLevel)) invalid('Hint text must match the recorded level');
  if (view.answerRevealed && !view.answerVisible) invalid('Explicit reveal cannot be marked unexposed');
  const answerAllowed = phase === 'submitted' || (phase === 'answering' && view.answerRevealed);
  if (answerAllowed !== (view.standardAnswer !== undefined)) invalid('Standard answer does not match the recorded phase or reveal');
  if ((phase === 'submitted' && !submission) || ((phase === 'confidence' || phase === 'answering') && submission)) invalid('Submission does not match the phase');
  if (submission) {
    if (!confidence.locked || confidence.value !== submission.selfConfidence || view.hintLevel !== submission.hintLevel
      || !confidence.recordedAt || Date.parse(confidence.recordedAt) > Date.parse(submission.submittedAt)
      || (submission.answerVisible && !view.answerVisible)) invalid('Frozen submission metadata is inconsistent');
  }
  if (!submission || phase === 'cancelled') {
    if (view.evidenceClass !== 'not_submitted') invalid('Unsubmitted or cancelled attempts cannot be evidence');
  } else if (question.reviewStatus !== 'approved') {
    if (view.evidenceClass !== 'practice_only') invalid('Unreviewed questions are practice only');
  } else if (view.evidenceClass === 'unverified_exposure') {
    if (!submission.answerVisible) invalid('Unknown exposure must remain conservative');
  } else {
    const evidence = submission.answerVisible || submission.hintLevel > 0 ? 'assisted_restatement'
      : question.kind === 'recall' ? 'unassisted_recall' : 'unassisted_near_transfer';
    if (view.evidenceClass !== evidence) invalid('Evidence classification contradicts the frozen submission');
  }
  if (feedback && (phase !== 'submitted' || feedback.attemptId !== view.id || feedback.rubricVersion !== question.rubricVersion
    || feedback.originalAnswer !== submission?.answer)) invalid('Feedback must belong to this submitted attempt and rubric');
});
