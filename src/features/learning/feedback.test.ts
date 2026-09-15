import { describe, expect, it } from 'vitest';
import { createFeedback, reviewFeedback } from './feedback';
import { context } from './testing/fixtures';
import { startFixture, submittedFixture } from './testing/attempt';

const correction = { criteria: [{ criterionId: 'criterion-1', finding: 'met', answerQuote: 'A local copy must exist.', rationale: 'The prerequisite is stated explicitly.' }], invalidReason: null };
const now = '2026-09-05T02:00:00Z';

describe('L08 criterion feedback and appeal', () => {
  it('starts unreviewed and never grades by keyword or invents a model result', () => {
    const result = createFeedback(submittedFixture());
    expect(result).toMatchObject({ ok: true, data: { result: 'unverified', source: 'human_self_review', criteria: [{ finding: 'unreviewed', answerQuote: '' }] } });
    expect(createFeedback(startFixture()).ok).toBe(false);
  });
  it('records human criterion decisions and exact answer evidence, retaining earlier revisions', () => {
    const attempt = submittedFixture(); const feedback = createFeedback(attempt);
    if (!feedback.ok) throw new Error('invalid fixture');
    const reviewed = reviewFeedback(feedback.data, correction, attempt, context, 0, now);
    expect(reviewed).toMatchObject({ ok: true, data: { result: 'met_rubric', reviewedBy: context.actorId, version: 1, history: [{ result: 'unverified' }] } });
    expect(feedback.data.result).toBe('unverified');
  });
  it('rejects invented quotes, missing rubric items, stale review versions and foreign actors', () => {
    const attempt = submittedFixture(); const feedback = createFeedback(attempt);
    if (!feedback.ok) throw new Error('invalid fixture');
    expect(reviewFeedback(feedback.data, { ...correction, criteria: [{ ...correction.criteria[0], answerQuote: 'invented evidence' }] }, attempt, context, 0, now).ok).toBe(false);
    expect(reviewFeedback(feedback.data, { ...correction, criteria: [] }, attempt, context, 0, now).ok).toBe(false);
    expect(reviewFeedback(feedback.data, correction, attempt, context, 7, now)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(reviewFeedback(feedback.data, correction, attempt, { ...context, actorId: 'other' }, 0, now)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('lets an invalid-question appeal override grading without changing the original answer', () => {
    const attempt = submittedFixture(); const feedback = createFeedback(attempt);
    if (!feedback.ok) throw new Error('invalid fixture');
    const invalid = reviewFeedback(feedback.data, { criteria: [], invalidReason: 'The stated conditions are contradictory.' }, attempt, context, 0, now);
    expect(invalid).toMatchObject({ ok: true, data: { result: 'invalid_question' } });
    expect(attempt.submission?.answer).toBe('A local copy must exist.');
    if (invalid.ok) expect(reviewFeedback(invalid.data, correction, attempt, context, 1, now).ok).toBe(false);
  });
});
