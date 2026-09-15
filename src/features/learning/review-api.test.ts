import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttemptRequestSchema, ReviewAppealRequestSchema, TrustedReviewRequestSchema } from './review-api';
import { useInput } from './testing/fixtures';
import { AppealPanel } from './feedback-panel';

const event = { type: 'submit' as const, answer: 'A bounded answer.' };

describe('S07 consumer request boundaries', () => {
  it('preserves the confirmed task revision and hash in a trusted start request', () => {
    const start = { action: 'start', operationId: 'bound-start', taskId: 'task-1', taskRevision: 3,
      taskContentHash: 'a'.repeat(64), questionId: 'question-1', questionRevision: 'fixture:q1',
      nodeRef: useInput.nodeRefs[0], retentionDays: 30, confirmed: true };
    expect(AttemptRequestSchema.safeParse(start)).toMatchObject({ success: true, data: start });
    expect(TrustedReviewRequestSchema.safeParse(start)).toMatchObject({ success: true, data: start });
    for (const field of ['taskRevision', 'taskContentHash'] as const) {
      expect(AttemptRequestSchema.safeParse({ ...start, [field]: undefined }).success).toBe(false);
      expect(TrustedReviewRequestSchema.safeParse({ ...start, [field]: undefined }).success).toBe(false);
    }
    expect(TrustedReviewRequestSchema.safeParse({ ...start, taskRevision: 0 }).success).toBe(false);
    expect(TrustedReviewRequestSchema.safeParse({ ...start, taskContentHash: 'not-a-hash' }).success).toBe(false);
    expect(TrustedReviewRequestSchema.safeParse({ ...start, answerVisible: false }).success).toBe(false);
  });

  it('requires an independent operation ID for every mutable event and feedback request', () => {
    const eventRequest = { action: 'event' as const, attemptId: 'attempt-1', expectedVersion: 2, event };
    expect(AttemptRequestSchema.safeParse(eventRequest).success).toBe(false);
    expect(AttemptRequestSchema.safeParse({ ...eventRequest, operationId: 'event-submit-1' }).success).toBe(true);

    const feedbackRequest = { action: 'feedback' as const, attemptId: 'attempt-1', expectedVersion: 3, feedbackVersion: 0,
      review: { criteria: [], invalidReason: 'The question is invalid.' } };
    expect(AttemptRequestSchema.safeParse(feedbackRequest).success).toBe(false);
    expect(AttemptRequestSchema.safeParse({ ...feedbackRequest, operationId: 'feedback-1' }).success).toBe(true);
  });

  it('accepts an appeal only with its own operation ID and bounded reason', () => {
    const appeal = { action: 'appeal' as const, operationId: 'appeal-1', attemptId: 'attempt-1', expectedVersion: 4,
      feedbackVersion: 1, nodeRef: useInput.nodeRefs[0], reason: 'The rubric did not match the approved question.' };
    expect(ReviewAppealRequestSchema.safeParse(appeal).success).toBe(true);
    expect(ReviewAppealRequestSchema.safeParse({ ...appeal, operationId: undefined }).success).toBe(false);
    expect(ReviewAppealRequestSchema.safeParse({ ...appeal, reason: ' ' }).success).toBe(false);
  });

  it('renders a private-reason appeal control without embedding answer or rubric data', () => {
    const html = renderToStaticMarkup(createElement(AppealPanel, { busy: false, onAppeal: () => {} }));
    expect(html).toContain('题目申诉');
    expect(html).toContain('申诉理由');
    expect(html).toContain('不会上传标准答案');
    expect(html).not.toContain('standardAnswer');
    expect(html).not.toContain('rubric');
  });
});
