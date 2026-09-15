import { z } from 'zod';
import { Id, VersionRefSchema } from '../../contracts/domain';
import {
  ReviewAppealRequestSchema as SharedReviewAppealRequestSchema,
  ReviewAttemptEventRequestSchema,
  ReviewAttemptStartRequestSchema,
  ReviewFeedbackRequestSchema,
  ReviewOperationReceiptSchema,
  type ReviewOperationReceipt,
} from '../../contracts/review-session';
import { AttemptEventSchema, type PublicAttemptView } from './attempt';
import { FeedbackInputSchema, type FeedbackDraft } from './feedback';
import type { PublicReviewQuestion } from './question';

export const ReviewQuerySchema = z.object({ nodeId: Id, revision: Id }).strict();
const Version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MutableVersion = Version.max(Number.MAX_SAFE_INTEGER - 1);
// Local state fixtures may omit consent; all starts require the shared task binding.
export const AttemptRequestSchema = z.discriminatedUnion('action', [
  ReviewAttemptStartRequestSchema.partial({ retentionDays: true, confirmed: true })
    .extend({ action: z.literal('start') }),
  z.object({ action: z.literal('event'), operationId: Id, attemptId: Id, expectedVersion: MutableVersion, event: AttemptEventSchema }).strict(),
  z.object({ action: z.literal('feedback'), operationId: Id, attemptId: Id, expectedVersion: Version, feedbackVersion: MutableVersion, review: FeedbackInputSchema }).strict(),
]);
export type AttemptRequest = z.infer<typeof AttemptRequestSchema>;
export const ReviewAppealRequestSchema = z.object({ action: z.literal('appeal'), operationId: Id, attemptId: Id,
  expectedVersion: Version, feedbackVersion: MutableVersion, nodeRef: VersionRefSchema,
  reason: z.string().trim().min(1).max(4000) }).strict();
export type ReviewAppealRequest = z.infer<typeof ReviewAppealRequestSchema>;
// The UI schema is not an authorization gate. HTTP uses the complete shared
// requests below; new starts also verify runtime capability and exact catalog versions.
export const ReviewRequestSchema = z.union([AttemptRequestSchema, ReviewAppealRequestSchema]);
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
const TrustedStartRequestSchema = ReviewAttemptStartRequestSchema.extend({ action: z.literal('start') });
const TrustedEventRequestSchema = ReviewAttemptEventRequestSchema.extend({ action: z.literal('event') });
const TrustedFeedbackRequestSchema = ReviewFeedbackRequestSchema.extend({ action: z.literal('feedback') });
const TrustedAppealRequestSchema = SharedReviewAppealRequestSchema.extend({ action: z.literal('appeal') });
export const TrustedReviewRequestSchema = z.discriminatedUnion('action', [TrustedStartRequestSchema, TrustedEventRequestSchema, TrustedFeedbackRequestSchema, TrustedAppealRequestSchema]);
export type TrustedReviewRequest = z.infer<typeof TrustedReviewRequestSchema>;
export interface ReviewCatalogResponse { questions: PublicReviewQuestion[] }
export interface AttemptResponse { view: PublicAttemptView; feedback: FeedbackDraft | null; receipt?: ReviewOperationReceipt }
