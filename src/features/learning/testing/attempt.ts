import { startAttempt, transitionAttempt, type AttemptSession, type AnswerExposure } from '../attempt';
import { context, snapshot, task } from './fixtures';
import { questionFixture } from './question';

export function startFixture(exposure: AnswerExposure = 'unexposed') {
  const result = startAttempt({ id: 'attempt-1', taskId: task.id }, questionFixture, snapshot, context, exposure, task.updatedAt);
  if (!result.ok) throw new Error(result.error.message); return result.data;
}
export function advanceFixture(state: AttemptSession, event: unknown) {
  const result = transitionAttempt(state, event, context, state.version, '2026-09-05T01:00:00Z', snapshot);
  if (!result.ok) throw new Error(result.error.message); return result.data;
}
export function answeringFixture(exposure: AnswerExposure = 'unexposed') {
  return advanceFixture(advanceFixture(startFixture(exposure), { type: 'confidence', value: 'skipped' }), { type: 'begin' });
}
export function submittedFixture(exposure: AnswerExposure = 'unexposed') {
  return advanceFixture(answeringFixture(exposure), { type: 'submit', answer: 'A local copy must exist.' });
}
