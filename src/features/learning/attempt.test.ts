import { describe, expect, it } from 'vitest';
import { publicAttempt, transitionAttempt } from './attempt';
import { context, snapshot, task } from './testing/fixtures';
import { questionFixture } from './testing/question';
import { startFixture as start, advanceFixture as step, answeringFixture } from './testing/attempt';

describe('L07 protected attempt state machine', () => {
  it('withholds standard answers and all hint text before a requested exposure', () => {
    const state = start(); const view = JSON.stringify(publicAttempt(state));
    expect(view).not.toContain(questionFixture.standardAnswer);
    for (const hint of questionFixture.hints) expect(view).not.toContain(hint);
    expect(transitionAttempt(state, { type: 'submit', answer: 'local copy' }, context, 0, task.updatedAt, snapshot).ok).toBe(false);
  });
  it('freezes confidence, hint level and exposure at submission, then permits feedback', () => {
    const submitted = step(answeringFixture(), { type: 'submit', answer: 'A local copy must exist.' });
    const view = publicAttempt(submitted);
    expect(view.standardAnswer).toBe(questionFixture.standardAnswer);
    expect(view.evidenceClass).toBe('unassisted_recall');
    expect(submitted.submission).toMatchObject({ answerVisible: false, hintLevel: 0, selfConfidence: 'skipped' });
    expect(transitionAttempt(submitted, { type: 'confidence', value: 'high' }, context, submitted.version, '2026-09-05T02:00:00Z', snapshot).ok).toBe(false);
  });
  it('never calls same-session retrieval exposure or unknown exposure unassisted', () => {
    for (const exposure of ['seen', 'unknown'] as const) {
      const state = step(answeringFixture(exposure), { type: 'submit', answer: 'A local copy must exist.' });
      expect(publicAttempt(state).evidenceClass).toBe(exposure === 'seen' ? 'assisted_restatement' : 'unverified_exposure');
      expect(state.submission?.answerVisible).toBe(true);
    }
  });
  it('tracks levels 1 through 3 monotonically and marks hinted answers as assisted', () => {
    let state = answeringFixture();
    for (const level of [1, 2, 3]) { state = step(state, { type: 'hint', level }); expect(publicAttempt(state).hints).toHaveLength(level); }
    expect(transitionAttempt(state, { type: 'hint', level: 0 }, context, state.version, '2026-09-05T01:00:00Z', snapshot).ok).toBe(false);
    expect(publicAttempt(step(state, { type: 'submit', answer: 'Local copy.' })).evidenceClass).toBe('assisted_restatement');
  });
  it('records explicit answer reveal as exposure before submission', () => {
    const revealed = step(answeringFixture(), { type: 'reveal' });
    expect(publicAttempt(revealed).standardAnswer).toBe(questionFixture.standardAnswer);
    expect(step(revealed, { type: 'submit', answer: 'I read the answer.' }).submission?.answerVisible).toBe(true);
  });
  it('allows cancellation but rejects all later writes and preserves the original state', () => {
    const original = answeringFixture(); const cancelled = step(original, { type: 'cancel' });
    expect(cancelled.phase).toBe('cancelled'); expect(original.phase).toBe('answering');
    expect(transitionAttempt(cancelled, { type: 'submit', answer: 'x' }, context, cancelled.version, '2026-09-05T01:00:00Z', snapshot).ok).toBe(false);
    expect(publicAttempt(cancelled).standardAnswer).toBeUndefined();
  });
  it('rejects another actor, stale command versions, changed knowledge and forged exposure fields', () => {
    const state = answeringFixture();
    expect(transitionAttempt(state, { type: 'reveal' }, { ...context, actorId: 'other' }, state.version, '2026-09-05T01:00:00Z', snapshot)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(transitionAttempt(state, { type: 'submit', answer: 'x' }, context, 0, '2026-09-05T01:00:00Z', snapshot)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(transitionAttempt(state, { type: 'submit', answer: 'x', answerVisible: false }, context, state.version, '2026-09-05T01:00:00Z', snapshot).ok).toBe(false);
    expect(transitionAttempt(state, { type: 'submit', answer: 'x' }, context, state.version, '2026-09-05T01:00:00Z', { ...snapshot, revision: 'fixture:r2' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it.each([{ type: 'hint', level: 1 }, { type: 'reveal' }, { type: 'submit', answer: 'My answer' }])('rejects $type when knowledge access is revoked after starting', (event) => {
    const state = answeringFixture(); const original = structuredClone(state);
    const revoked = { ...context, scopes: context.scopes.filter((scope) => scope !== 'knowledge:read') };
    expect(transitionAttempt(state, event, revoked, state.version, '2026-09-05T01:00:00Z', snapshot)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(state).toEqual(original);
    expect(publicAttempt(state).standardAnswer).toBeUndefined();
  });
  it('allows the owning actor to cancel after losing knowledge access, but not another actor', () => {
    const state = answeringFixture();
    const revoked = { ...context, scopes: context.scopes.filter((scope) => scope !== 'knowledge:read') };
    const result = transitionAttempt(state, { type: 'cancel' }, revoked, state.version, '2026-09-05T01:00:00Z', { ...snapshot, revision: 'fixture:r2', nodes: [] });
    expect(result).toMatchObject({ ok: true, data: { phase: 'cancelled' } });
    if (!result.ok) throw new Error('Expected cancellation');
    expect(publicAttempt(result.data)).toMatchObject({ hints: [], evidenceClass: 'not_submitted' });
    expect(publicAttempt(result.data).standardAnswer).toBeUndefined();
    expect(transitionAttempt(state, { type: 'cancel' }, { ...revoked, actorId: 'other' }, state.version, '2026-09-05T01:00:00Z', snapshot)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
