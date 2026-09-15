import { z } from 'zod';
import { Id, TaskContextSchema, Timestamp, VersionRefSchema } from './domain';

const Text = z.string().trim().min(1).max(16_000);
const Version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MutableVersion = Version.max(Number.MAX_SAFE_INTEGER - 1);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

// The complete question is server-private. Only ReviewQuestionPublicSchema may cross the HTTP boundary.
export const ReviewQuestionSchema = z.object({
  id: Id, workspaceId: Id, revision: Id, nodeRef: VersionRefSchema,
  kind: z.enum(['recall', 'near_transfer']), prompt: Text, standardAnswer: Text,
  hints: z.tuple([Text, Text, Text]),
  rubric: z.object({ version: Id,
    criteria: z.array(z.object({ id: Id, description: Text, expectedEvidence: Text, required: z.boolean() }).strict()).min(1).max(12),
    necessaryConditions: z.array(Text).max(20),
  }).strict(),
  review: z.object({ status: z.enum(['pending', 'approved', 'rejected']), reviewedBy: Id.optional(), reviewedAt: Timestamp.optional() }).strict(),
  transfer: z.object({ dimension: z.enum(['scenario', 'constraints', 'representation', 'numbers_only']), change: Text }).strict().optional(),
}).strict();
export type ReviewQuestion = z.infer<typeof ReviewQuestionSchema>;

export const ReviewQuestionPublicSchema = ReviewQuestionSchema.pick({ id: true, revision: true, kind: true, nodeRef: true, prompt: true }).extend({
  rubricVersion: Id, reviewStatus: ReviewQuestionSchema.shape.review.shape.status,
  transfer: ReviewQuestionSchema.shape.transfer.unwrap().nullable(),
}).strict();
export type ReviewQuestionPublic = z.infer<typeof ReviewQuestionPublicSchema>;

export const ReviewQuestionQuerySchema = z.object({ nodeId: Id, revision: Id }).strict();
export type ReviewQuestionQuery = z.infer<typeof ReviewQuestionQuerySchema>;

export const ReviewAnswerExposureSchema = z.enum(['unexposed', 'seen', 'unknown']);
export type ReviewAnswerExposure = z.infer<typeof ReviewAnswerExposureSchema>;
export const ReviewRuntimeStatusSchema = z.object({ mode: z.enum(['fixture', 'live']), catalog: z.enum(['ready', 'empty']),
  availableQuestionCount: z.number().int().nonnegative(), taskBinding: z.literal('revision_hash_atomic'),
  exposure: z.literal('server_observed_unknown_default'), unassistedCertification: z.literal(false),
  questionRetentionDays: z.literal(30), attemptRetentionDays: z.literal(30) }).strict();
export type ReviewRuntimeStatus = z.infer<typeof ReviewRuntimeStatusSchema>;
const ExposureEventSchema = z.object({ operationId: Id, type: z.enum(['start', 'hint', 'reveal', 'answer_browse']),
  level: z.number().int().min(1).max(3).optional(), recordedAt: Timestamp }).strict();
export type ReviewExposureEvent = z.infer<typeof ExposureEventSchema>;

export const ReviewAttemptEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('confidence'), value: z.enum(['low', 'medium', 'high', 'skipped']) }).strict(),
  z.object({ type: z.literal('begin') }).strict(),
  z.object({ type: z.literal('hint'), level: z.number().int().min(1).max(3) }).strict(),
  z.object({ type: z.literal('reveal') }).strict(),
  z.object({ type: z.literal('submit'), answer: Text }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
]);
export type ReviewAttemptEvent = z.infer<typeof ReviewAttemptEventSchema>;

export const ReviewAttemptStartRequestSchema = z.object({
  operationId: Id, taskId: Id, questionId: Id, questionRevision: Id, nodeRef: VersionRefSchema,
  taskRevision: Version.min(1), taskContentHash: Hash,
  priorRecallAttemptId: Id.optional(), retentionDays: z.literal(30), confirmed: z.literal(true),
}).strict();
export type ReviewAttemptStartRequest = z.infer<typeof ReviewAttemptStartRequestSchema>;

export const ReviewAttemptEventRequestSchema = z.object({
  operationId: Id, attemptId: Id, expectedVersion: MutableVersion, event: ReviewAttemptEventSchema,
}).strict();
export type ReviewAttemptEventRequest = z.infer<typeof ReviewAttemptEventRequestSchema>;

const CriterionReviewSchema = z.object({ criterionId: Id, finding: z.enum(['met', 'partial', 'not_met']),
  answerQuote: z.string().trim().max(16_000), rationale: z.string().trim().min(1).max(4_000) }).strict();
export const ReviewFeedbackInputSchema = z.object({ criteria: z.array(CriterionReviewSchema).max(12), invalidReason: z.string().trim().min(1).max(4_000).nullable() }).strict();
export type ReviewFeedbackInput = z.infer<typeof ReviewFeedbackInputSchema>;

export const ReviewFeedbackRequestSchema = z.object({
  operationId: Id, attemptId: Id, expectedVersion: Version, feedbackVersion: MutableVersion, review: ReviewFeedbackInputSchema,
}).strict();
export type ReviewFeedbackRequest = z.infer<typeof ReviewFeedbackRequestSchema>;

export const ReviewAppealRequestSchema = z.object({
  operationId: Id, attemptId: Id, expectedVersion: Version, feedbackVersion: MutableVersion, nodeRef: VersionRefSchema,
  reason: z.string().trim().min(1).max(4_000),
}).strict();
export type ReviewAppealRequest = z.infer<typeof ReviewAppealRequestSchema>;

const ConfidenceSchema = z.object({ value: z.enum(['low', 'medium', 'high', 'skipped']).nullable(), recordedAt: Timestamp.nullable(), locked: z.boolean() }).strict();
const SubmissionSchema = z.object({ answer: Text, answerVisible: z.boolean(), hintLevel: z.number().int().min(0).max(3),
  selfConfidence: z.enum(['low', 'medium', 'high', 'skipped']), submittedAt: Timestamp }).strict();

const FeedbackCriterionSchema = z.object({ criterionId: Id, description: Text, expectedEvidence: Text, required: z.boolean(),
  finding: z.enum(['unreviewed', 'met', 'partial', 'not_met']), answerQuote: z.string().max(16_000), rationale: z.string().max(4_000) }).strict();
const FeedbackRevisionSchema = z.object({ version: Version, result: z.enum(['unverified', 'met_rubric', 'partial', 'not_met', 'invalid_question']),
  criteria: z.array(FeedbackCriterionSchema).max(12), invalidReason: z.string().max(4_000).nullable(),
  reviewedBy: Id.nullable(), reviewedAt: Timestamp.nullable() }).strict();
export const ReviewFeedbackStateSchema = FeedbackRevisionSchema.extend({ attemptId: Id, rubricVersion: Id, originalAnswer: Text,
  source: z.literal('human_self_review'), history: z.array(FeedbackRevisionSchema), persistence: z.literal('shared_services') }).strict();
export type ReviewFeedbackState = z.infer<typeof ReviewFeedbackStateSchema>;

export const ReviewAppealStateSchema = z.object({ operationId: Id, attemptId: Id, workspaceId: Id, actorId: Id,
  feedbackVersion: MutableVersion, nodeRef: VersionRefSchema, reason: z.string().min(1).max(4_000), status: z.literal('open'), createdAt: Timestamp,
}).strict();
export type ReviewAppealState = z.infer<typeof ReviewAppealStateSchema>;

export const ReviewAttemptStateSchema = z.object({
  id: Id, actorId: Id, workspaceId: Id, taskId: Id, task: TaskContextSchema, version: Version,
  snapshotRevision: Id, question: ReviewQuestionSchema, exposure: ReviewAnswerExposureSchema,
  exposureEvents: z.array(ExposureEventSchema).max(100),
  phase: z.enum(['confidence', 'answering', 'submitted', 'cancelled']), confidence: ConfidenceSchema,
  hintLevel: z.number().int().min(0).max(3), answerRevealed: z.boolean(), updatedAt: Timestamp,
  submission: SubmissionSchema.nullable(), feedback: ReviewFeedbackStateSchema.nullable(), appeals: z.array(ReviewAppealStateSchema).max(100),
  expiresAt: Timestamp, retentionDays: z.literal(30),
}).strict().superRefine((state, ctx) => {
  if (state.task.id !== state.taskId || state.task.workspaceId !== state.workspaceId) ctx.addIssue({ code: 'custom', message: 'Attempt task identity is inconsistent' });
  if (state.question.workspaceId !== state.workspaceId || state.question.nodeRef.workspaceId !== state.workspaceId) ctx.addIssue({ code: 'custom', message: 'Question workspace mismatch' });
  if ((state.phase === 'submitted' && !state.submission) || (['confidence', 'answering'].includes(state.phase) && state.submission !== null)) ctx.addIssue({ code: 'custom', message: 'Submission does not match attempt phase' });
  if (state.feedback && (state.feedback.attemptId !== state.id || state.feedback.rubricVersion !== state.question.rubric.version || state.feedback.originalAnswer !== state.submission?.answer)) ctx.addIssue({ code: 'custom', message: 'Feedback does not match attempt' });
});
export type ReviewAttemptState = z.infer<typeof ReviewAttemptStateSchema>;

export const ReviewAttemptPublicSchema = z.object({
  id: Id, version: Version, taskId: Id, phase: z.enum(['confidence', 'answering', 'submitted', 'cancelled']),
  question: ReviewQuestionPublicSchema, confidence: ConfidenceSchema, hintLevel: z.number().int().min(0).max(3),
  hints: z.array(Text).max(3), answerVisible: z.boolean(), answerRevealed: z.boolean(),
  evidenceClass: z.enum(['not_submitted', 'practice_only', 'unverified_exposure', 'assisted_restatement', 'unassisted_recall', 'unassisted_near_transfer']),
  submission: SubmissionSchema.pick({ answer: true, answerVisible: true, hintLevel: true, selfConfidence: true, submittedAt: true }).nullable(),
  standardAnswer: Text.optional(), feedback: ReviewFeedbackStateSchema.omit({ originalAnswer: true, persistence: true }).nullable(),
  appeals: z.array(ReviewAppealStateSchema.pick({ operationId: true, feedbackVersion: true, nodeRef: true, reason: true, status: true, createdAt: true })).max(100),
  persistence: z.literal('shared_services'),
}).strict();
export type ReviewAttemptPublic = z.infer<typeof ReviewAttemptPublicSchema>;

export const ReviewOperationKindSchema = z.enum(['start', 'confidence', 'begin', 'hint', 'reveal', 'submit', 'cancel', 'feedback', 'appeal']);
export type ReviewOperationKind = z.infer<typeof ReviewOperationKindSchema>;
export const ReviewOperationReceiptSchema = z.object({ operationId: Id, attemptId: Id, workspaceId: Id, actorId: Id,
  kind: ReviewOperationKindSchema, requestHash: Hash, expectedVersion: Version, resultingVersion: Version,
  feedbackVersion: MutableVersion.nullable(), appliedAt: Timestamp, expiresAt: Timestamp, retentionDays: z.literal(30), outcome: z.literal('applied'),
}).strict();
export type ReviewOperationReceipt = z.infer<typeof ReviewOperationReceiptSchema>;

export const ReviewOperationRecoverySchema = z.object({ operationId: Id, workspaceId: Id, actorId: Id,
  state: z.enum(['applied', 'unknown']), attemptId: Id.nullable(), requestHash: Hash.nullable(), receipt: ReviewOperationReceiptSchema.nullable(),
  absenceIsFinal: z.literal(false), retryAllowed: z.literal(false),
}).strict().superRefine((state, ctx) => {
  if (state.state === 'applied' && (!state.receipt || !state.attemptId || !state.requestHash)) ctx.addIssue({ code: 'custom', message: 'Applied review operation requires a receipt' });
  if (state.state === 'unknown' && (state.receipt !== null || state.attemptId !== null || state.requestHash !== null)) ctx.addIssue({ code: 'custom', message: 'Unknown review operation cannot expose a receipt' });
});
export type ReviewOperationRecovery = z.infer<typeof ReviewOperationRecoverySchema>;

export interface ReviewExposureSource {
  initial(ctx: { actorId: string; workspaceId: string; taskId: string; nodeRef: z.infer<typeof VersionRefSchema> }): Promise<ReviewAnswerExposure>;
}
