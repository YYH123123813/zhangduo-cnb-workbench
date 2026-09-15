import { describe, expect, it } from 'vitest';
import type { AttemptRequest, AttemptResponse, ReviewRequest } from './review-api';
import { AttemptRequestGate } from './attempt-request';
import { publicAttempt } from './attempt';
import { createFeedback } from './feedback';
import { advanceFixture, answeringFixture, startFixture, submittedFixture } from './testing/attempt';
import { task, useInput } from './testing/fixtures';
import { failure } from './errors';
import { contentHash } from '../../contracts/hash';

const start: AttemptRequest = { action: 'start', operationId: 'attempt-1', taskId: task.id,
  taskRevision: 1, taskContentHash: 'a'.repeat(64),
  questionId: 'question-1', questionRevision: 'fixture:q1', nodeRef: useInput.nodeRefs[0]!,
};
function initialResponse(): AttemptResponse {
  const view = publicAttempt(startFixture());
  return { view, feedback: null };
}
function receiptFor(operationId: string, attemptId: string, resultingVersion: number, kind: NonNullable<AttemptResponse['receipt']>['kind'] = 'start', expectedVersion = 0, feedbackVersion: number | null = null): NonNullable<AttemptResponse['receipt']> {
  return { operationId, attemptId, workspaceId: 'workspace-1', actorId: 'actor-1', kind,
    requestHash: 'a'.repeat(64), expectedVersion, resultingVersion, feedbackVersion,
    appliedAt: '2026-09-05T01:00:00Z', expiresAt: '2026-10-05T01:00:00Z', retentionDays: 30, outcome: 'applied' };
}
function ticket(gate: AttemptRequestGate, request: ReviewRequest) {
  const result = gate.begin(request);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

describe('L07 client attempt request ownership (no persistence)', () => {
  it('synchronously blocks double starts and retains the first operation ID after cancellation', () => {
    const gate = new AttemptRequestGate();
    const pending = ticket(gate, start);
    expect(gate.begin({ ...start, operationId: 'attempt-2' }).ok).toBe(false);
    gate.interrupt();
    expect(gate.needsReadBack).toBe(true);
    expect(gate.recoveryId).toBe('attempt-1');
    expect(gate.begin({ ...start, operationId: 'attempt-2' }).ok).toBe(false);
    expect(gate.accept(pending, initialResponse()).ok).toBe(false);
    expect(gate.needsReadBack).toBe(true);
    const recovery = gate.beginReadBack();
    if (!recovery.ok) throw new Error('missing recovery ticket');
    expect(gate.accept(recovery.data, initialResponse()).ok).toBe(true);
    expect(gate.needsReadBack).toBe(false);
  });

  it('requires the original operation receipt before a production gate exposes a response', () => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const pending = ticket(gate, start);
    const response = initialResponse();
    expect(gate.accept(pending, response)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(gate.recoveryOperationId).toBe(start.operationId);
    const recovery = gate.beginReadBack();
    if (!recovery.ok) throw new Error('missing recovery ticket');
    const verified = initialResponse(); verified.receipt = receiptFor(start.operationId, verified.view.id, verified.view.version);
    expect(gate.accept(recovery.data, verified).ok).toBe(true);
    expect(gate.recoveryOperationId).toBeNull();
  });

  it('does not accept a receipt for another operation or version', () => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const pending = ticket(gate, start);
    const foreign = initialResponse(); foreign.receipt = receiptFor('other-operation', foreign.view.id, foreign.view.version);
    expect(gate.accept(pending, foreign)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    const recovery = gate.beginReadBack();
    if (!recovery.ok) throw new Error('missing recovery ticket');
    const wrongVersion = initialResponse(); wrongVersion.receipt = receiptFor(start.operationId, wrongVersion.view.id, wrongVersion.view.version + 1);
    expect(gate.accept(recovery.data, wrongVersion)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
  });

  it('does not accept a receipt with a different CAS or feedback version', () => {
    const startGate = new AttemptRequestGate({ requireReceipt: true });
    const pendingStart = ticket(startGate, start);
    const wrongCas = initialResponse();
    wrongCas.receipt = receiptFor(start.operationId, wrongCas.view.id, wrongCas.view.version, 'start', 1);
    expect(startGate.accept(pendingStart, wrongCas)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });

    const gate = new AttemptRequestGate({ requireReceipt: true });
    const submitted = submittedFixture(); const feedback = createFeedback(submitted);
    if (!feedback.ok) throw new Error('invalid feedback fixture');
    const started = { view: publicAttempt(submitted), feedback: feedback.data, receipt: receiptFor(start.operationId, submitted.id, 0) };
    expect(gate.accept(ticket(gate, start), started).ok).toBe(true);
    const request: ReviewRequest = { action: 'feedback', operationId: 'feedback-cas-1', attemptId: submitted.id,
      expectedVersion: submitted.version, feedbackVersion: feedback.data.version,
      review: { criteria: [], invalidReason: 'Question is invalid' } };
    const response: AttemptResponse = { view: { ...publicAttempt(submitted), version: submitted.version + 1 }, feedback: { ...feedback.data, version: 1 },
      receipt: receiptFor(request.operationId, submitted.id, submitted.version + 1, 'feedback', submitted.version - 1, 99) };
    expect(gate.accept(ticket(gate, request), response)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
  });

  it('binds the production gate to the shared request hash before sending', async () => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const pending = await gate.beginTrusted({ ...start, taskRevision: 1, taskContentHash: await contentHash(task), retentionDays: 30, confirmed: true });
    if (!pending.ok) throw new Error(pending.error.message);
    const response = initialResponse(); response.receipt = receiptFor(start.operationId, response.view.id, response.view.version);
    response.receipt.requestHash = 'b'.repeat(64);
    expect(gate.accept(pending.data, response)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
  });

  it.each(['taskRevision', 'taskContentHash'] as const)('keeps an unknown start bound to its original %s during read-only recovery', async (field) => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const request = { ...start, taskRevision: 1, taskContentHash: await contentHash(task), retentionDays: 30 as const, confirmed: true as const };
    const pending = await gate.beginTrusted(request);
    if (!pending.ok) throw new Error(pending.error.message);
    gate.interrupt();
    expect(gate.recoveryOperationId).toBe(start.operationId);
    const recovery = gate.beginReadBack();
    if (!recovery.ok) throw new Error(recovery.error.message);
    const { action: _action, ...payload } = request;
    const response = initialResponse();
    response.receipt = receiptFor(start.operationId, response.view.id, 0);
    response.receipt.requestHash = await contentHash({ ...payload, [field]: field === 'taskRevision' ? 2 : 'b'.repeat(64) });
    expect(gate.accept(recovery.data, response)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(gate.needsReadBack).toBe(true);
    expect((await gate.beginTrusted({ ...request, operationId: 'replacement-start' })).ok).toBe(false);
    const original = gate.beginReadBack();
    if (!original.ok) throw new Error(original.error.message);
    response.receipt.requestHash = await contentHash(payload);
    expect(gate.accept(original.data, response).ok).toBe(true);
  });

  it('refuses a trusted start without an explicit saved task binding', async () => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const { taskRevision: _revision, taskContentHash: _hash, ...unbound } = start;
    expect(await gate.beginTrusted({ ...unbound, retentionDays: 30, confirmed: true } as ReviewRequest)).toMatchObject({ ok: false, error: { code: 'VALIDATION', dataState: 'not_written' } });
    expect(gate.blocked).toBe(false);
  });

  it('does not reopen mutations when read-back still shows the pre-mutation version', () => {
    const gate = new AttemptRequestGate();
    const before = publicAttempt(answeringFixture());
    const pending = ticket(gate, { action: 'event', operationId: 'event-submit-1', attemptId: before.id, expectedVersion: before.version, event: { type: 'submit', answer: 'My answer' } });
    gate.reject(pending, failure('UNKNOWN_RESULT', 'Unknown', 'read_back', 'unknown'));
    const recovery = gate.beginReadBack();
    if (!recovery.ok) throw new Error('missing recovery ticket');
    expect(gate.accept(recovery.data, { view: before, feedback: null })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(gate.needsReadBack).toBe(true);
    const next = gate.beginReadBack();
    if (!next.ok) throw new Error('missing recovery ticket');
    expect(gate.accept(next.data, { view: publicAttempt(submittedFixture()), feedback: null }).ok).toBe(true);
  });

  it('rejects another attempt, task, question or node before exposing a response', () => {
    for (const field of ['attempt', 'task', 'question', 'node'] as const) {
      const gate = new AttemptRequestGate(); const pending = ticket(gate, start);
      const response = initialResponse();
      if (field === 'attempt') response.view.id = 'other';
      if (field === 'task') response.view.taskId = 'other';
      if (field === 'question') response.view.question.id = 'other';
      if (field === 'node') response.view.question.nodeRef.workspaceId = 'other';
      expect(gate.accept(pending, response).ok).toBe(false);
      expect(gate.needsReadBack).toBe(true);
    }
  });

  it('requires an advanced feedback version, not just the old attempt state', () => {
    const gate = new AttemptRequestGate();
    const attempt = submittedFixture(); const feedback = createFeedback(attempt);
    if (!feedback.ok) throw new Error('invalid fixture');
    const pending = ticket(gate, { action: 'feedback', operationId: 'feedback-1', attemptId: attempt.id, expectedVersion: attempt.version,
      feedbackVersion: 0, review: { criteria: [], invalidReason: 'Question is invalid' } });
    expect(gate.accept(pending, { view: publicAttempt(attempt), feedback: feedback.data }).ok).toBe(false);
    const recovery = gate.beginReadBack();
    if (!recovery.ok) throw new Error('missing recovery ticket');
    expect(gate.accept(recovery.data, { view: publicAttempt(attempt), feedback: { ...feedback.data, version: 1 } }).ok).toBe(true);
  });

  it('accepts an invalid-question feedback receipt with no criteria', () => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const submitted = submittedFixture(); const feedback = createFeedback(submitted);
    if (!feedback.ok) throw new Error('invalid fixture');
    const started = initialResponse(); started.view = publicAttempt(submitted); started.receipt = receiptFor(start.operationId, submitted.id, 0);
    expect(gate.accept(ticket(gate, start), started).ok).toBe(true);
    const request: ReviewRequest = { action: 'feedback', operationId: 'feedback-invalid-1', attemptId: submitted.id,
      expectedVersion: submitted.version, feedbackVersion: feedback.data.version,
      review: { criteria: [], invalidReason: 'The approved question is ambiguous.' } };
    const invalidFeedback = { ...feedback.data, version: 1, result: 'invalid_question' as const, criteria: [],
      invalidReason: 'The approved question is ambiguous.', reviewedBy: 'actor-1', reviewedAt: '2026-09-12T08:00:00Z' };
    const response: AttemptResponse = { view: { ...publicAttempt(submitted), version: submitted.version + 1 }, feedback: invalidFeedback,
      receipt: receiptFor(request.operationId, submitted.id, submitted.version + 1, 'feedback', submitted.version, 1) };
    expect(gate.accept(ticket(gate, request), response).ok).toBe(true);
  });

  it('clears only a definitive not-written mutation failure and keeps read-back failures unresolved', () => {
    const gate = new AttemptRequestGate(); const pending = ticket(gate, start);
    gate.reject(pending, failure('NOT_IMPLEMENTED', 'Not connected'));
    expect(gate.needsReadBack).toBe(false);
    const next = ticket(gate, start);
    gate.reject(next, failure('CONFLICT', 'State changed'));
    const recovery = gate.beginReadBack();
    if (!recovery.ok) throw new Error('missing recovery ticket');
    gate.reject(recovery.data, failure('FORBIDDEN', 'No longer permitted'));
    expect(gate.needsReadBack).toBe(true);
    expect(gate.recoveryId).toBe('attempt-1');
  });

  it('rejects feedback or standard answers in a confidence-stage response', () => {
    const gate = new AttemptRequestGate(); const pending = ticket(gate, start);
    const response = initialResponse(); response.view.standardAnswer = 'Do not reveal yet';
    expect(gate.accept(pending, response).ok).toBe(false);
  });

  it.each(['task', 'question', 'questionRevision', 'rubricVersion', 'node', 'nodeRevision', 'workspace'] as const)('retains the original %s binding after start when accepting later events', (field) => {
    const gate = new AttemptRequestGate();
    expect(gate.accept(ticket(gate, start), initialResponse()).ok).toBe(true);
    const pending = ticket(gate, { action: 'event', operationId: 'event-confidence-1', attemptId: 'attempt-1', expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } });
    const view = publicAttempt(advanceFixture(startFixture(), { type: 'confidence', value: 'skipped' }));
    if (field === 'task') view.taskId = 'foreign-task';
    if (field === 'question') view.question.id = 'foreign-question';
    if (field === 'questionRevision') view.question.revision = 'foreign-question-version';
    if (field === 'rubricVersion') view.question.rubricVersion = 'foreign-rubric-version';
    if (field === 'node') view.question.nodeRef.objectId = 'foreign-node';
    if (field === 'nodeRevision') view.question.nodeRef.revision = 'foreign-node-version';
    if (field === 'workspace') view.question.nodeRef.workspaceId = 'foreign-workspace';
    expect(gate.accept(pending, { view, feedback: null })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(gate.recoveryId).toBe('attempt-1'); expect(gate.needsReadBack).toBe(true);
  });

  it.each(['earlyAnswer', 'unknownEarlyAnswer', 'missingHints', 'missingSubmission', 'earlyEvidence', 'privateQuestion', 'wrongFeedback'] as const)('rejects inconsistent or private attempt response fields: %s', (field) => {
    const gate = new AttemptRequestGate(); const pending = ticket(gate, start);
    const state = field === 'missingSubmission' || field === 'wrongFeedback' ? submittedFixture() : answeringFixture(field === 'unknownEarlyAnswer' ? 'unknown' : 'unexposed');
    const response: AttemptResponse = { view: publicAttempt(state), feedback: null };
    if (field === 'earlyAnswer' || field === 'unknownEarlyAnswer') response.view.standardAnswer = 'Unexpected answer before reveal';
    if (field === 'missingHints') response.view.hintLevel = 1;
    if (field === 'missingSubmission') response.view.submission = null;
    if (field === 'earlyEvidence') response.view.evidenceClass = 'unassisted_recall';
    if (field === 'privateQuestion') Object.assign(response.view.question, { standardAnswer: 'Private answer', rubric: state.question.rubric });
    if (field === 'wrongFeedback') {
      const feedback = createFeedback(state); if (!feedback.ok) throw new Error('invalid fixture');
      response.feedback = { ...feedback.data, rubricVersion: 'wrong-rubric' };
    }
    expect(gate.accept(pending, response)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(gate.needsReadBack).toBe(true);
  });

  it('does not acknowledge a submit when a different event advanced the attempt version', () => {
    const gate = new AttemptRequestGate(); const before = answeringFixture();
    const pending = ticket(gate, { action: 'event', operationId: 'event-submit-2', attemptId: before.id, expectedVersion: before.version, event: { type: 'submit', answer: 'My answer' } });
    const unrelated = advanceFixture(before, { type: 'hint', level: 1 });
    expect(gate.accept(pending, { view: publicAttempt(unrelated), feedback: null })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(gate.needsReadBack).toBe(true);
  });

  it('accepts the public projections of legitimate phases, exposures and feedback', () => {
    const submitted = submittedFixture(); const feedback = createFeedback(submitted);
    if (!feedback.ok) throw new Error('invalid fixture');
    const states = [startFixture(), answeringFixture(), advanceFixture(answeringFixture(), { type: 'hint', level: 1 }),
      advanceFixture(answeringFixture(), { type: 'reveal' }), submitted,
      submittedFixture('unknown'), submittedFixture('seen'), advanceFixture(submitted, { type: 'cancel' }),
    ];
    for (const state of states) {
      const gate = new AttemptRequestGate();
      expect(gate.accept(ticket(gate, start), { view: publicAttempt(state), feedback: state === submitted ? feedback.data : null }).ok, state.phase).toBe(true);
    }
  });

  it('rejects a stale local event before sending it instead of rolling back an accepted view', () => {
    const gate = new AttemptRequestGate();
    const view = publicAttempt(answeringFixture());
    expect(gate.accept(ticket(gate, start), { view, feedback: null }).ok).toBe(true);
    expect(gate.begin({ action: 'event', operationId: 'event-confidence-2', attemptId: view.id, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(gate.blocked).toBe(false);
  });

  it('rejects counters that cannot be incremented exactly', () => {
    const gate = new AttemptRequestGate();
    expect(gate.begin({ action: 'event', operationId: 'event-cancel-1', attemptId: 'attempt-1', expectedVersion: Number.MAX_SAFE_INTEGER, event: { type: 'cancel' } })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(gate.begin({ action: 'feedback', operationId: 'feedback-2', attemptId: 'attempt-1', expectedVersion: 3, feedbackVersion: Number.MAX_SAFE_INTEGER,
      review: { criteria: [], invalidReason: 'Invalid question' } })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(gate.blocked).toBe(false);
  });

  it('binds an appeal to its own operation, attempt version, node and feedback version', () => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const submitted = submittedFixture(); const feedback = createFeedback(submitted);
    if (!feedback.ok) throw new Error('invalid feedback fixture');
    const started = initialResponse(); started.view = publicAttempt(submitted);
    started.receipt = receiptFor(start.operationId, submitted.id, 0);
    expect(gate.accept(ticket(gate, start), started).ok).toBe(true);
    const appeal: ReviewRequest = { action: 'appeal', operationId: 'appeal-1', attemptId: submitted.id, expectedVersion: submitted.version,
      feedbackVersion: feedback.data.version, nodeRef: submitted.question.nodeRef, reason: 'The rubric does not match the approved question.' };
    const pending = ticket(gate, appeal);
    const response: AttemptResponse = { view: { ...publicAttempt(submitted), version: submitted.version + 1 }, feedback: feedback.data,
      receipt: receiptFor(appeal.operationId, submitted.id, submitted.version + 1, 'appeal', submitted.version, feedback.data.version) };
    expect(gate.accept(pending, response).ok).toBe(true);
    expect(gate.begin({ ...appeal, operationId: 'appeal-2' }).ok).toBe(false);
  });
});

describe('appeal recovery after a concurrent feedback revision', () => {
  it('accepts only the original event receipt even when current feedback has advanced', async () => {
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const submitted = submittedFixture(), feedback = createFeedback(submitted);
    if (!feedback.ok) throw new Error('invalid feedback fixture');
    const originalStart = { ...start, retentionDays: 30 as const, confirmed: true as const };
    const { action: _startAction, ...startPayload } = originalStart;
    const started = await gate.beginTrusted(originalStart);
    if (!started.ok) throw new Error(started.error.message);
    expect(gate.accept(started.data, { view: publicAttempt(submitted), feedback: feedback.data,
      receipt: { ...receiptFor(start.operationId, submitted.id, 0), requestHash: await contentHash(startPayload) } }).ok).toBe(true);
    const appeal = { action: 'appeal' as const, operationId: 'appeal-lost-response', attemptId: submitted.id,
      expectedVersion: submitted.version, feedbackVersion: feedback.data.version,
      nodeRef: submitted.question.nodeRef, reason: 'Question wording is ambiguous.' };
    const { action: _appealAction, ...appealPayload } = appeal;
    const pending = await gate.beginTrusted(appeal);
    if (!pending.ok) throw new Error(pending.error.message);
    gate.reject(pending.data, failure('UNKNOWN_RESULT', 'Response lost', 'read_back', 'unknown'));
    expect(gate.recoveryRequestHash).toBe(await contentHash(appealPayload));
    const response: AttemptResponse = { view: { ...publicAttempt(submitted), version: submitted.version + 2 },
      feedback: { ...feedback.data, version: feedback.data.version + 1 },
      receipt: { ...receiptFor(appeal.operationId, submitted.id, submitted.version + 1, 'appeal', submitted.version, feedback.data.version),
        requestHash: await contentHash(appealPayload) } };
    const wrong = gate.beginReadBack(); if (!wrong.ok) throw new Error('missing read-back');
    expect(gate.accept(wrong.data, { ...response, receipt: { ...response.receipt!, requestHash: 'f'.repeat(64) } }).ok).toBe(false);
    const original = gate.beginReadBack(); if (!original.ok) throw new Error('missing original read-back');
    expect(gate.accept(original.data, response).ok).toBe(true);
    expect(gate.blocked).toBe(false);
  });
});

describe('L04 returning a settled attempt to the temporary queue', () => {
  it.each(['submitted', 'cancelled'] as const)('releases only the local %s view without starting another attempt', (phase) => {
    const gate = new AttemptRequestGate();
    const state = phase === 'submitted' ? submittedFixture() : advanceFixture(startFixture(), { type: 'cancel' });
    const pending = ticket(gate, start);
    expect(gate.accept(pending, { view: publicAttempt(state), feedback: null }).ok).toBe(true);
    expect(gate.releaseView('foreign-attempt').ok).toBe(false);
    expect(gate.releaseView(state.id)).toEqual({ ok: true, data: null });
    expect(gate.blocked).toBe(false); expect(gate.recoveryId).toBeNull();
    expect(gate.accept(pending, initialResponse()).ok).toBe(false);
    expect(gate.releaseView(state.id).ok).toBe(false);
    expect(state.phase).toBe(phase);
    const next = ticket(gate, { ...start, operationId: 'attempt-2' });
    const response = initialResponse(); response.view.id = 'attempt-2';
    expect(gate.accept(next, response).ok).toBe(true);
  });

  it.each([startFixture, answeringFixture])('requires unfinished attempts to be cancelled or submitted first: %#', (fixture) => {
    const gate = new AttemptRequestGate(); const state = fixture();
    expect(gate.accept(ticket(gate, start), { view: publicAttempt(state), feedback: null }).ok).toBe(true);
    expect(gate.releaseView(state.id)).toMatchObject({ ok: false, error: { code: 'CONFLICT', nextAction: 'cancel_or_complete_attempt' } });
  });

  it('preserves a pending, interrupted or recovering start instead of treating local exit as cancellation', () => {
    const gate = new AttemptRequestGate(); ticket(gate, start);
    expect(gate.releaseView(start.operationId).ok).toBe(false);
    expect(gate.blocked).toBe(true);
    gate.interrupt();
    expect(gate.releaseView(start.operationId).ok).toBe(false);
    expect(gate.recoveryId).toBe(start.operationId);
    const read = gate.beginReadBack(); if (!read.ok) throw new Error('missing read-back');
    expect(gate.releaseView(start.operationId).ok).toBe(false);
    expect(gate.accept(read.data, initialResponse()).ok).toBe(true);
    expect(gate.releaseView(start.operationId).ok).toBe(false);
  });

  it('does not release a previously submitted view while a cancellation remains unknown', () => {
    const gate = new AttemptRequestGate(); const state = submittedFixture();
    expect(gate.accept(ticket(gate, start), { view: publicAttempt(state), feedback: null }).ok).toBe(true);
    const cancel = ticket(gate, { action: 'event', operationId: 'event-cancel-2', attemptId: state.id, expectedVersion: state.version, event: { type: 'cancel' } });
    expect(gate.releaseView(state.id).ok).toBe(false);
    gate.reject(cancel, failure('UNKNOWN_RESULT', 'Unknown cancellation', 'read_back', 'unknown'));
    expect(gate.releaseView(state.id).ok).toBe(false);
    const old = gate.beginReadBack(); if (!old.ok) throw new Error('missing read-back');
    expect(gate.accept(old.data, { view: publicAttempt(state), feedback: null }).ok).toBe(false);
    expect(gate.releaseView(state.id).ok).toBe(false);
    expect(gate.recoveryId).toBe(state.id);
    const read = gate.beginReadBack(); if (!read.ok) throw new Error('missing read-back');
    expect(gate.accept(read.data, { view: publicAttempt(advanceFixture(state, { type: 'cancel' })), feedback: null }).ok).toBe(true);
    expect(gate.releaseView(state.id).ok).toBe(true);
  });

  it('keeps an unknown feedback operation blocked even though the answer is submitted', () => {
    const gate = new AttemptRequestGate(); const state = submittedFixture(); const feedback = createFeedback(state);
    if (!feedback.ok) throw new Error('invalid feedback fixture');
    expect(gate.accept(ticket(gate, start), { view: publicAttempt(state), feedback: feedback.data }).ok).toBe(true);
    const pending = ticket(gate, { action: 'feedback', operationId: 'feedback-3', attemptId: state.id, expectedVersion: state.version,
      feedbackVersion: feedback.data.version, review: { criteria: [], invalidReason: 'Question is ambiguous' } });
    gate.reject(pending, failure('UNKNOWN_RESULT', 'Unknown feedback', 'read_back', 'unknown'));
    expect(gate.releaseView(state.id).ok).toBe(false);
    expect(gate.needsReadBack).toBe(true); expect(gate.recoveryId).toBe(state.id);
  });
});
