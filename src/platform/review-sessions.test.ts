import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext, Result } from '../contracts/api';
import type { TaskContext } from '../contracts/domain';
import type { ReviewAttemptStartRequest, ReviewQuestion } from '../contracts/review-session';
import { contentHash } from '../contracts/hash';
import { createServices } from './services';
import { OperationJournal } from './journal';
import { ReviewQuestionStore, ReviewSessionStore } from './review-sessions';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { ApprovalAuthority } from './approvals';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function data<T>(result: Result<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(result.error.message); return result.data; }
function startRequest(s: Awaited<ReturnType<typeof setup>>, operationId = 'attempt-1'): ReviewAttemptStartRequest {
  return { operationId, taskId: s.task.id, questionId: s.question.id, questionRevision: s.question.revision,
    taskRevision: s.savedTask.revision, taskContentHash: s.savedTask.contentHash!,
    nodeRef: s.question.nodeRef, retentionDays: 30, confirmed: true };
}

async function setup(persistent = false) {
  let file = ':memory:';
  if (persistent) { mkdirSync('.local/fixture', { recursive: true }); const dir = mkdtempSync(resolve('.local/fixture/review-')); file = join(dir, 'state.sqlite'); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); }
  const base = await platformFixture(file);
  const ctx: RequestContext = base.ctx;
  const task: TaskContext = { id: 'review-task', workspaceId: ctx.workspaceId, question: 'Can this method be used offline?', constraints: [], mode: 'assisted', updatedAt: '2026-09-09T00:00:00Z' };
  const question: ReviewQuestion = { id: 'review-question', workspaceId: ctx.workspaceId, revision: 'fixture:q1', nodeRef: { workspaceId: ctx.workspaceId, objectId: base.node.id, revision: base.base }, kind: 'recall', prompt: 'What is required?', standardAnswer: 'A local copy.', hints: ['Think about data.', 'Think about offline use.', 'A local copy is required.'], rubric: { version: 'fixture:rubric-1', criteria: [{ id: 'criterion-1', description: 'State the prerequisite.', expectedEvidence: 'A local copy.', required: true }], necessaryConditions: [] }, review: { status: 'approved', reviewedBy: 'reviewer-1', reviewedAt: task.updatedAt } };
  const savedTask = await base.services.saveTask?.(ctx, { operationId: 'task-save-1', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true });
  if (!savedTask?.ok) throw new Error('Expected task fixture to be saved');
  let journal = base.journal;
  cleanup.push(() => journal.close());
  let services = createServices({ ...base.options, journal, approvalAuthority: new ApprovalAuthority(base.sessions, journal), reviewQuestions: [question] });
  const reopen = () => { journal.close(); journal = new OperationJournal(file, { fixture: true }); services = createServices({ ...base.options, journal, approvalAuthority: new ApprovalAuthority(base.sessions, journal), reviewQuestions: [question] }); };
  return { ...base, ctx, task, question, file, savedTask: savedTask.data, get journal() { return journal; }, services: () => services, reopen };
}

describe('S07 shared trusted review sessions', () => {
  it('clears review bodies under the explicitly approved node deletion barrier and preserves event receipts', async () => {
    const s = await setup(); data(await s.services().startReviewAttempt!(s.ctx, startRequest(s)));
    const plan = data(await s.services().previewDelete(s.ctx, [s.node.id]));
    expect(plan.layers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'review_private_state', supported: true })]));
    const approval = data(await s.services().approveGovernance!(s.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    const report = data(await s.services().executeDelete(s.ctx, plan, approval));
    expect(report.layers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'review_private_state', state: 'done' })]));
    expect(JSON.stringify(s.journal.records(s.ctx.workspaceId, '@workspace', 'review_attempt'))).not.toContain(s.question.standardAnswer);
    expect(JSON.stringify(s.journal.records(s.ctx.workspaceId, '@workspace', 'review_question'))).not.toContain(s.question.standardAnswer);
    expect(data(await s.services().readReviewOperation!(s.ctx, 'attempt-1'))).toMatchObject({ state: 'applied', retryAllowed: false });
    expect(await s.services().readReviewAttempt!(s.ctx, 'attempt-1')).toMatchObject({ ok: true, data: null });
  });

  it('persists cross-attempt exposure before returning answers and never treats a new task as unexposed', async () => {
    const s = await setup(true);
    const services = createServices({ ...s.options, reviewQuestions: [s.question], reviewExposure: { initial: async () => 'unexposed' } });
    for (const id of ['recall-a', 'recall-b']) {
      data(await services.startReviewAttempt!(s.ctx, startRequest(s, id)));
      data(await services.applyReviewEvent!(s.ctx, { operationId: `${id}-confidence`, attemptId: id, expectedVersion: 0, event: { type: 'confidence', value: 'low' } }));
      data(await services.applyReviewEvent!(s.ctx, { operationId: `${id}-begin`, attemptId: id, expectedVersion: 1, event: { type: 'begin' } }));
    }
    data(await services.applyReviewEvent!(s.ctx, { operationId: 'reveal-a', attemptId: 'recall-a', expectedVersion: 2, event: { type: 'reveal' } }));
    data(await services.applyReviewEvent!(s.ctx, { operationId: 'submit-b', attemptId: 'recall-b', expectedVersion: 2, event: { type: 'submit', answer: 'A local copy.' } }));
    expect(data(await services.readReviewAttempt!(s.ctx, 'recall-b'))).toMatchObject({ evidenceClass: 'assisted_restatement', submission: { answerVisible: true } });
    s.reopen();
    data(await s.services().startReviewAttempt!(s.ctx, startRequest(s, 'recall-c')));
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', 'recall-c')?.value).toMatchObject({ attempt: { exposure: 'seen' } });
  });

  it('rejects an unbound start and a task changed by another SQLite connection during start', async () => {
    const s = await setup(true), request = startRequest(s);
    const { taskRevision, taskContentHash, ...unbound } = request;
    expect(await s.services().startReviewAttempt!(s.ctx, unbound as ReviewAttemptStartRequest)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const peerJournal = new OperationJournal(s.file, { fixture: true }); cleanup.push(() => peerJournal.close());
    const peer = createServices({ ...s.options, journal: peerJournal, approvalAuthority: new ApprovalAuthority(s.sessions, peerJournal) });
    const reviews = new ReviewSessionStore(s.sessions, s.journal, new ReviewQuestionStore(s.sessions, s.journal), async (ctx) => {
      data(await peer.saveTask!(ctx, { operationId: 'task-changed-after-confirmation', task: { ...s.task, question: 'Different task B' },
        expectedRevision: taskRevision, expectedContentHash: taskContentHash, retentionDays: 30, confirmed: true }));
      return s.services().snapshot(ctx);
    }, s.services().readTaskState!);
    expect(await reviews.start(s.ctx, request)).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', request.operationId)).toBeUndefined();
    expect(data(await s.services().readReviewOperation!(s.ctx, request.operationId))).toMatchObject({ state: 'unknown' });
  });

  it('replays only the original start receipt after task advancement and SQLite reopen', async () => {
    const s = await setup(true), request = startRequest(s);
    const receipt = data(await s.services().startReviewAttempt!(s.ctx, request));
    data(await s.services().saveTask!(s.ctx, { operationId: 'task-next', task: { ...s.task, question: 'Task B' },
      expectedRevision: s.savedTask.revision, expectedContentHash: s.savedTask.contentHash, retentionDays: 30, confirmed: true }));
    s.reopen();
    expect(data(await s.services().startReviewAttempt!(s.ctx, request))).toEqual(receipt);
    expect(await s.services().startReviewAttempt!(s.ctx, { ...request, operationId: 'different-start' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await s.services().startReviewAttempt!(s.ctx, { ...request, taskRevision: 2 })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', request.operationId)?.value).toMatchObject({ attempt: { task: s.task } });
  });

  it('stores a reviewed question privately and returns only approved exact-version entries', async () => {
    const s = await setup();
    const questions = data(await s.services().readReviewQuestions!(s.ctx, { nodeId: s.question.nodeRef.objectId, revision: s.question.nodeRef.revision }));
    expect(questions).toMatchObject([{ id: s.question.id, revision: s.question.revision, nodeRef: s.question.nodeRef, prompt: s.question.prompt, reviewStatus: 'approved' }]);
    expect(JSON.stringify(questions)).not.toContain(s.question.standardAnswer);
    expect(JSON.stringify(questions)).not.toContain(s.question.hints[0]);
    expect(JSON.stringify(s.journal.records(s.ctx.workspaceId, '@workspace', 'review_question'))).toContain(s.question.standardAnswer);
    expect(data(await s.services().readReviewQuestions!(s.ctx, { nodeId: 'other-node', revision: s.question.nodeRef.revision }))).toEqual([]);
  });

  it('creates one attempt per operation and keeps the answer private until the submitted phase', async () => {
    const s = await setup();
    const start = startRequest(s);
    const first = data(await s.services().startReviewAttempt!(s.ctx, start));
    expect(first).toMatchObject({ operationId: start.operationId, attemptId: start.operationId, kind: 'start', resultingVersion: 0 });
    const initial = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(initial?.phase).toBe('confidence');
    expect(JSON.stringify(initial)).not.toContain(s.question.standardAnswer);
    expect(JSON.stringify(initial)).not.toContain(s.question.hints[0]);
    expect(data(await s.services().startReviewAttempt!(s.ctx, start))).toEqual(first);
    expect(await s.services().startReviewAttempt!(s.ctx, { ...start, retentionDays: 30, confirmed: true, operationId: 'attempt-1', questionRevision: 'fixture:q2' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('uses operation IDs and CAS so only one competing event wins', async () => {
    const s = await setup(); const start = startRequest(s); data(await s.services().startReviewAttempt!(s.ctx, start));
    const confidence = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'confidence-1', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } }));
    data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'begin-1', attemptId: start.operationId, expectedVersion: confidence.resultingVersion, event: { type: 'begin' } }));
    const [a, b] = await Promise.all([
      s.services().applyReviewEvent!(s.ctx, { operationId: 'submit-a', attemptId: start.operationId, expectedVersion: 2, event: { type: 'submit', answer: 'A local copy.' } }),
      s.services().applyReviewEvent!(s.ctx, { operationId: 'submit-b', attemptId: start.operationId, expectedVersion: 2, event: { type: 'submit', answer: 'A remote copy.' } }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const recovered = data(await s.services().readReviewOperation!(s.ctx, a.ok ? 'submit-a' : 'submit-b'));
    expect(recovered.state).toBe('applied'); expect(recovered.retryAllowed).toBe(false);
    const current = data(await s.services().readReviewAttempt!(s.ctx, start.operationId)); expect(current?.phase).toBe('submitted');
    expect(['A local copy.', 'A remote copy.']).toContain(current?.submission?.answer);
  });

  it('persists exposure before returning hints and keeps operation recovery after restart', async () => {
    const s = await setup(true); const start = startRequest(s); data(await s.services().startReviewAttempt!(s.ctx, start));
    const confidence = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'confidence-1', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'low' } }));
    const answering = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'begin-1', attemptId: start.operationId, expectedVersion: confidence.resultingVersion, event: { type: 'begin' } }));
    const hinted = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'hint-1', attemptId: start.operationId, expectedVersion: answering.resultingVersion, event: { type: 'hint', level: 1 } }));
    expect(hinted.resultingVersion).toBe(3);
    const hintedState = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(hintedState?.hintLevel).toBe(1); expect(hintedState?.hints).toHaveLength(1); expect(hintedState?.answerRevealed).toBe(false);
    s.reopen();
    expect(data(await s.services().readReviewOperation!(s.ctx, 'hint-1'))).toMatchObject({ state: 'applied', receipt: { kind: 'hint', resultingVersion: 3 } });
    expect(data(await s.services().readReviewAttempt!(s.ctx, start.operationId))?.hintLevel).toBe(1);
  });

  it('validates exact rubric quotes and stores a separate appeal without changing the answer', async () => {
    const s = await setup(); const start = startRequest(s); data(await s.services().startReviewAttempt!(s.ctx, start));
    const confidence = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'confidence-1', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } }));
    const begin = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'begin-1', attemptId: start.operationId, expectedVersion: confidence.resultingVersion, event: { type: 'begin' } }));
    const submit = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'submit-1', attemptId: start.operationId, expectedVersion: begin.resultingVersion, event: { type: 'submit', answer: 'A local copy.' } }));
    expect(await s.services().saveReviewFeedback!(s.ctx, { operationId: 'feedback-bad', attemptId: start.operationId, expectedVersion: submit.resultingVersion, feedbackVersion: 0, review: { invalidReason: null, criteria: [{ criterionId: 'criterion-1', finding: 'met', answerQuote: 'invented', rationale: 'It is present.' }] } })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const feedbackReceipt = data(await s.services().saveReviewFeedback!(s.ctx, { operationId: 'feedback-1', attemptId: start.operationId, expectedVersion: submit.resultingVersion, feedbackVersion: 0, review: { invalidReason: null, criteria: [{ criterionId: 'criterion-1', finding: 'met', answerQuote: 'A local copy.', rationale: 'The prerequisite is stated.' }] } }));
    const current = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    const appealed = data(await s.services().saveReviewAppeal!(s.ctx, { operationId: 'appeal-1', attemptId: start.operationId, expectedVersion: current!.version, feedbackVersion: feedbackReceipt.feedbackVersion ?? 0, nodeRef: s.question.nodeRef, reason: 'Please recheck the rubric.' }));
    expect(appealed.resultingVersion).toBe(current!.version + 1);
    const appealedState = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(appealedState?.submission?.answer).toBe('A local copy.'); expect(appealedState?.appeals[0]?.operationId).toBe('appeal-1');
  });

  it('does not read a blocked attempt and does not re-open its private payload', async () => {
    const s = await setup(); const start = startRequest(s); data(await s.services().startReviewAttempt!(s.ctx, start));
    s.journal.block(s.ctx.workspaceId, [s.question.nodeRef.objectId], 'delete-plan-1');
    expect(await s.services().readReviewAttempt!(s.ctx, start.operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.services().readReviewOperation!(s.ctx, start.operationId)).toMatchObject({ ok: true, data: { state: 'applied', receipt: { operationId: start.operationId } } });
  });

  it('keeps question revisions separate and rejects a changed body under the same revision key', async () => {
    const s = await setup();
    const store = new ReviewQuestionStore(s.sessions, s.journal);
    const second = { ...s.question, revision: 'fixture:q2' };
    expect(store.register(second)).toBe(true);
    expect(store.register({ ...second, prompt: 'Changed after approval.' })).toBe(false);
    const questions = data(await s.services().readReviewQuestions!(s.ctx, { nodeId: s.question.nodeRef.objectId, revision: s.question.nodeRef.revision }));
    expect(questions.map((item) => item.revision)).toEqual(['fixture:q1', 'fixture:q2']);
  });

  it('does not expose the standard answer before reveal or submit, and exposes feedback only after submit', async () => {
    const s = await setup(); const start = startRequest(s);
    data(await s.services().startReviewAttempt!(s.ctx, start));
    let state = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(state?.standardAnswer).toBeUndefined(); expect(state?.feedback).toBeNull();
    const confidence = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'confidence-answer-1', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } }));
    const begin = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'begin-answer-1', attemptId: start.operationId, expectedVersion: confidence.resultingVersion, event: { type: 'begin' } }));
    state = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(state?.standardAnswer).toBeUndefined();
    const reveal = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'reveal-answer-1', attemptId: start.operationId, expectedVersion: begin.resultingVersion, event: { type: 'reveal' } }));
    state = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(reveal.resultingVersion).toBe(3); expect(state?.standardAnswer).toBe(s.question.standardAnswer);
    const submit = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'submit-answer-1', attemptId: start.operationId, expectedVersion: reveal.resultingVersion, event: { type: 'submit', answer: 'A local copy.' } }));
    state = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(submit.resultingVersion).toBe(4); expect(state?.standardAnswer).toBe(s.question.standardAnswer);
    expect(state?.feedback).toMatchObject({ version: 0, result: 'unverified' });
    expect(state?.feedback).not.toHaveProperty('originalAnswer');
  });

  it('allows only one feedback and one appeal at a submitted attempt version', async () => {
    const s = await setup(); const start = startRequest(s);
    data(await s.services().startReviewAttempt!(s.ctx, start));
    const confidence = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'confidence-cas-1', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } }));
    const begin = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'begin-cas-1', attemptId: start.operationId, expectedVersion: confidence.resultingVersion, event: { type: 'begin' } }));
    const submit = data(await s.services().applyReviewEvent!(s.ctx, { operationId: 'submit-cas-1', attemptId: start.operationId, expectedVersion: begin.resultingVersion, event: { type: 'submit', answer: 'A local copy.' } }));
    const feedbackInput = (operationId: string) => ({ operationId, attemptId: start.operationId, expectedVersion: submit.resultingVersion, feedbackVersion: 0,
      review: { invalidReason: null, criteria: [{ criterionId: 'criterion-1', finding: 'met' as const, answerQuote: 'A local copy.', rationale: 'The prerequisite is stated.' }] } });
    const [feedbackA, feedbackB] = await Promise.all([s.services().saveReviewFeedback!(s.ctx, feedbackInput('feedback-cas-a')), s.services().saveReviewFeedback!(s.ctx, feedbackInput('feedback-cas-b'))]);
    expect([feedbackA.ok, feedbackB.ok].filter(Boolean)).toHaveLength(1);
    const current = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(current?.feedback?.version).toBe(1); expect(current?.version).toBe(4);
    const appealInput = (operationId: string) => ({ operationId, attemptId: start.operationId, expectedVersion: current!.version, feedbackVersion: current!.feedback!.version,
      nodeRef: s.question.nodeRef, reason: 'Please recheck the rubric.' });
    const [appealA, appealB] = await Promise.all([s.services().saveReviewAppeal!(s.ctx, appealInput('appeal-cas-a')), s.services().saveReviewAppeal!(s.ctx, appealInput('appeal-cas-b'))]);
    expect([appealA.ok, appealB.ok].filter(Boolean)).toHaveLength(1);
    const afterAppeal = data(await s.services().readReviewAttempt!(s.ctx, start.operationId));
    expect(afterAppeal?.version).toBe(5); expect(afterAppeal?.appeals).toHaveLength(1);
  });

  it('denies content reads without knowledge access but still permits a content-free cancel receipt', async () => {
    const s = await setup(); const start = startRequest(s);
    data(await s.services().startReviewAttempt!(s.ctx, start));
    const workspace = data(await s.services().workspace(s.ctx));
    const token = s.sessions.issue({ actorId: s.ctx.actorId, workspace, scopes: ['evidence:read', 'evidence:write'] });
    const ctx = data(s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
    const reads = vi.spyOn(s.journal, 'record');
    expect(await s.services().readReviewAttempt!(ctx, start.operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(reads).not.toHaveBeenCalled();
    const request = { operationId: 'cancel-after-revocation', attemptId: start.operationId, expectedVersion: 0, event: { type: 'cancel' as const } };
    const receipt = data(await s.services().applyReviewEvent!(ctx, request));
    expect(receipt).toMatchObject({ kind: 'cancel', resultingVersion: 1, requestHash: await contentHash(request) });
    expect(JSON.stringify(receipt)).not.toContain(s.question.prompt);
    expect(JSON.stringify(receipt)).not.toContain(s.question.standardAnswer);
    expect(data(await s.services().readReviewOperation!(ctx, receipt.operationId))).toMatchObject({ state: 'applied', receipt });
  });

  it('rechecks session authorization after the final snapshot await and writes no event after revocation', async () => {
    const s = await setup(); const start = startRequest(s);
    data(await s.services().startReviewAttempt!(s.ctx, start));
    const workspace = data(await s.services().workspace(s.ctx));
    const token = s.sessions.issue({ actorId: s.ctx.actorId, workspace, scopes: ['workspace:read', 'knowledge:read', 'evidence:read', 'evidence:write'] });
    const ctx = data(s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
    const reviews = new ReviewSessionStore(s.sessions, s.journal, new ReviewQuestionStore(s.sessions, s.journal), async (ctx) => {
      const result = await s.services().snapshot(ctx); s.sessions.revoke(token); return result;
    }, s.services().readTaskState!);
    expect(await reviews.event(ctx, { operationId: 'revoked-confidence', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'low' } }))
      .toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(s.journal.record(ctx.workspaceId, '@workspace', 'review_operation_receipt', 'revoked-confidence')).toBeUndefined();
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', start.operationId)?.value).toMatchObject({ attempt: { version: 0 } });
  });

  it('rolls back the state and exposure event if the exact operation receipt cannot be persisted', async () => {
    const s = await setup(); const start = startRequest(s); const services = s.services();
    data(await services.startReviewAttempt!(s.ctx, start));
    data(await services.applyReviewEvent!(s.ctx, { operationId: 'rollback-confidence', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } }));
    data(await services.applyReviewEvent!(s.ctx, { operationId: 'rollback-begin', attemptId: start.operationId, expectedVersion: 1, event: { type: 'begin' } }));
    const put = s.journal.putRecord.bind(s.journal);
    vi.spyOn(s.journal, 'putRecord').mockImplementation((...args) => args[2] === 'review_operation_receipt' && args[3] === 'rollback-hint' ? false : put(...args));
    expect(await services.applyReviewEvent!(s.ctx, { operationId: 'rollback-hint', attemptId: start.operationId, expectedVersion: 2, event: { type: 'hint', level: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(data(await services.readReviewAttempt!(s.ctx, start.operationId))).toMatchObject({ version: 2, hintLevel: 0, hints: [] });
    expect(data(await services.readReviewOperation!(s.ctx, 'rollback-hint'))).toMatchObject({ state: 'unknown', absenceIsFinal: false, retryAllowed: false });
  });

  it('cleans expired private attempts while retaining the original operation receipt', async () => {
    const s = await setup(true); const start = startRequest(s);
    const receipt = data(await s.services().startReviewAttempt!(s.ctx, start));
    s.journal.expirePrivatePayloads(new Date(Date.parse(receipt.expiresAt) + 1).toISOString());
    s.reopen();
    expect(data(await s.services().readReviewAttempt!(s.ctx, start.operationId))).toBeNull();
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', start.operationId)?.value).toMatchObject({ state: 'expired', attempt: null });
    expect(data(await s.services().readReviewOperation!(s.ctx, start.operationId))).toMatchObject({ state: 'applied', receipt });
  });

  it('uses durable CAS across two independent SQLite connections', async () => {
    const s = await setup(true); const start = startRequest(s);
    data(await s.services().startReviewAttempt!(s.ctx, start));
    const journal = new OperationJournal(s.file, { fixture: true }); cleanup.push(() => journal.close());
    const peer = createServices({ ...s.options, journal, approvalAuthority: new ApprovalAuthority(s.sessions, journal) });
    const results = await Promise.all([
      s.services().applyReviewEvent!(s.ctx, { operationId: 'connection-a', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'low' } }),
      peer.applyReviewEvent!(s.ctx, { operationId: 'connection-b', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'high' } }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const applied = results.find((result) => result.ok)!; if (!applied.ok) throw Error('Expected one applied receipt');
    expect(data(await peer.readReviewOperation!(s.ctx, applied.data.operationId))).toMatchObject({ state: 'applied', receipt: applied.data });
  });
});
