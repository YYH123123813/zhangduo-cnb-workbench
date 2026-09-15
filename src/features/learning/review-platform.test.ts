import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Result } from '../../contracts/api';
import type { ReviewExposureSource, ReviewQuestion } from '../../contracts/review-session';
import type { TaskSaveRequest } from '../../contracts/task-record';
import { contentHash } from '../../contracts/hash';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import { ApprovalAuthority } from '../../platform/approvals';
import { OperationJournal } from '../../platform/journal';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { ensureReviewTask, readReviewTaskOperation, readReviewTaskState, type ReviewTaskTransport } from './review-task';
import { AttemptRequestGate } from './attempt-request';
import { failure } from './errors';
import type { AttemptResponse, TrustedReviewRequest } from './review-api';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function data<T>(value: Result<T>): T {
  expect(value.ok, JSON.stringify(value)).toBe(true);
  if (!value.ok) throw new Error(value.error.message);
  return value.data;
}

async function setup(persistent = false, exposure: ReviewExposureSource = { initial: async () => 'unexposed' }) {
  let file = ':memory:';
  if (persistent) {
    mkdirSync('.local/fixture', { recursive: true });
    const directory = mkdtempSync(resolve('.local/fixture/learning-review-'));
    file = join(directory, 'state.sqlite');
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  }
  const base = await platformFixture(file);
  base.documents.set(base.base, { ...base.initial, nodes: [{ ...base.node, revision: base.base }] });
  const task = { id: 'review-task', workspaceId: base.ctx.workspaceId, question: 'Which premise is required?', constraints: [], mode: 'assisted' as const, updatedAt: '2026-09-09T00:00:00Z' };
  const savedTask = data(await base.services.saveTask!(base.ctx, { operationId: 'review-task-save', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true }));
  const question: ReviewQuestion = { id: 'review-question', workspaceId: base.ctx.workspaceId, revision: 'question-revision',
    nodeRef: { workspaceId: base.ctx.workspaceId, objectId: base.node.id, revision: base.base }, kind: 'recall', prompt: 'Which premise is required?',
    standardAnswer: 'A local copy.', hints: ['Think about data.', 'Think about offline use.', 'A local copy is required.'],
    rubric: { version: 'rubric-1', criteria: [{ id: 'criterion-1', description: 'State the prerequisite.', expectedEvidence: 'A local copy.', required: true }], necessaryConditions: [] },
    review: { status: 'approved', reviewedBy: 'reviewer-1', reviewedAt: task.updatedAt } };
  let journal = base.journal;
  let services = createServices({ ...base.options, journal, approvalAuthority: new ApprovalAuthority(base.sessions, journal), reviewQuestions: [question], reviewExposure: exposure });
  const app = () => createApp(services);
  cleanup.push(() => journal.close());
  return { ...base, task, savedTask, file, question, ctx: base.ctx, app, headers: base.headers, get services() { return services; }, get journal() { return journal; },
    reopen() {
      journal.close(); journal = new OperationJournal(file, { fixture: true });
      services = createServices({ ...base.options, journal, approvalAuthority: new ApprovalAuthority(base.sessions, journal), reviewQuestions: [question], reviewExposure: exposure });
    } };
}

describe('S07 learning consumer with shared Services, HTTP and SQLite', () => {
  it.each(['before_start', 'during_start', 'same_content_revision'] as const)('rejects a peer task change at %s without saving a misattributed attempt', async (timing) => {
    let duringStart: (() => Promise<void>) | undefined;
    const s = await setup(true, { initial: async () => { await duringStart?.(); return 'unknown'; } });
    const transport: ReviewTaskTransport = async (path, init) => await (await s.app().request(path, { ...init, headers: s.headers })).json() as Result<unknown>;
    const confirmed = data(await readReviewTaskState(transport, s.ctx, s.task.id, s.task));
    const request: TrustedReviewRequest = { action: 'start', operationId: 'confirmed-task-start', taskId: confirmed.id,
      taskRevision: confirmed.revision, taskContentHash: confirmed.contentHash!, questionId: s.question.id,
      questionRevision: s.question.revision, nodeRef: s.question.nodeRef, retentionDays: 30, confirmed: true };
    const peerJournal = new OperationJournal(s.file, { fixture: true }); cleanup.push(() => peerJournal.close());
    const peer = createApp(createServices({ ...s.options, journal: peerJournal, approvalAuthority: new ApprovalAuthority(s.sessions, peerJournal) }));
    const peerToken = s.sessions.issue({ actorId: s.ctx.actorId, workspace: data(await s.services.workspace(s.ctx)), scopes: [...s.ctx.scopes] });
    const peerTask = timing === 'same_content_revision' ? s.task : { ...s.task, question: 'Different task B confirmed in another session' };
    const changeTask = async () => {
      const saved = await peer.request('/api/workspace/tasks', { method: 'POST', headers: { ...s.headers, Authorization: `Bearer ${peerToken}` },
        body: JSON.stringify({ operationId: 'peer-task-edit', task: peerTask, expectedRevision: confirmed.revision,
          expectedContentHash: confirmed.contentHash, retentionDays: 30, confirmed: true }) });
      expect(saved.status).toBe(200);
    };
    if (timing === 'during_start') duringStart = changeTask;
    else await changeTask();

    const gate = new AttemptRequestGate({ requireReceipt: true });
    const pending = data(await gate.beginTrusted(request));
    const response = await s.app().request('/api/learning/attempts', { method: 'POST', headers: s.headers, body: JSON.stringify(request) });
    const rejected = await response.json() as Result<AttemptResponse>;
    expect(response.status).toBe(409);
    expect(rejected).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    gate.reject(pending, rejected);
    expect(gate.recoveryOperationId).toBe(request.operationId);
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', request.operationId)).toBeUndefined();
    expect(data(await s.services.readReviewOperation!(s.ctx, request.operationId))).toMatchObject({ state: 'unknown', receipt: null, retryAllowed: false });
    expect(data(await s.services.readTaskState!(s.ctx, s.task.id))).toMatchObject({ revision: confirmed.revision + 1, task: peerTask });
  });

  it('recovers a lost start response after restart using only GET while retaining task A and its exact request hash', async () => {
    const s = await setup(true);
    const request: TrustedReviewRequest = { action: 'start', operationId: 'lost-bound-start', taskId: s.task.id,
      taskRevision: s.savedTask.revision, taskContentHash: s.savedTask.contentHash!, questionId: s.question.id,
      questionRevision: s.question.revision, nodeRef: s.question.nodeRef, retentionDays: 30, confirmed: true };
    const methods: string[] = [];
    const transport = async (path: string, init?: RequestInit): Promise<Result<AttemptResponse>> => {
      methods.push(`${init?.method ?? 'GET'} ${path}`);
      const response = await s.app().request(path, { ...init, headers: s.headers });
      expect(response.status).toBe(200);
      if (init?.method === 'POST') throw new Error('response lost after the start transaction committed');
      return await response.json() as Result<AttemptResponse>;
    };
    const gate = new AttemptRequestGate({ requireReceipt: true });
    const pending = data(await gate.beginTrusted(request));
    await expect(transport('/api/learning/attempts', { method: 'POST', body: JSON.stringify(request) })).rejects.toThrow('response lost');
    gate.reject(pending, failure('UNKNOWN_RESULT', 'Start response lost', 'read_review_operation', 'unknown'));
    const newer = data(await s.services.saveTask!(s.ctx, { operationId: 'edit-after-start', task: { ...s.task, question: 'Task B after the saved attempt' },
      expectedRevision: request.taskRevision, expectedContentHash: request.taskContentHash, retentionDays: 30, confirmed: true }));
    expect(await gate.beginTrusted({ ...request, taskRevision: newer.revision, taskContentHash: newer.contentHash! })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const changedReplay = await s.app().request('/api/learning/attempts', { method: 'POST', headers: s.headers,
      body: JSON.stringify({ ...request, taskRevision: newer.revision, taskContentHash: newer.contentHash }) });
    expect(changedReplay.status).toBe(409);
    s.reopen();

    const read = data(gate.beginReadBack());
    const restored = data(await transport(`/api/learning/attempts/${request.operationId}`));
    expect(gate.accept(read, restored).ok).toBe(true);
    const { action: _action, ...payload } = request;
    expect(restored.receipt).toMatchObject({ operationId: request.operationId, requestHash: await contentHash(payload), expectedVersion: 0, resultingVersion: 0 });
    expect(restored.view).toMatchObject({ taskId: s.task.id, phase: 'confidence', version: 0 });
    expect(restored.view).not.toHaveProperty('standardAnswer');
    expect(data(await transport(`/api/learning/attempts/${request.operationId}`))).toEqual(restored);
    expect(methods).toEqual(['POST /api/learning/attempts', `GET /api/learning/attempts/${request.operationId}`, `GET /api/learning/attempts/${request.operationId}`]);
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', request.operationId)?.value).toMatchObject({ attempt: { task: s.task }, requestHash: await contentHash(payload) });
    expect(data(await s.services.readTaskState!(s.ctx, s.task.id))).toMatchObject({ revision: newer.revision, task: newer.task });
  });

  it('saves the original task through the learning helper, recovers a lost response after restart, then starts the trusted attempt', async () => {
    const s = await setup(true);
    const originalTask = { ...s.task, id: 'review-task-flow', question: 'Which premise must remain fixed?' };
    const pending: TaskSaveRequest[] = [];
    const methods: string[] = [];
    let dropSaveResponse = true;
    const transport: ReviewTaskTransport = async (path, init) => {
      methods.push(`${init?.method ?? 'GET'} ${path}`);
      const response = await s.app().request(path, { ...init, headers: s.headers });
      if (path === '/api/workspace/tasks' && init?.method === 'POST' && dropSaveResponse) {
        dropSaveResponse = false;
        throw new Error('simulated lost task save response');
      }
      return await response.json() as Result<unknown>;
    };

    const saved = await ensureReviewTask(transport, s.ctx, originalTask, 'review-task-flow-save', {
      confirmed: true,
      onPending: (request) => pending.push(request),
    });
    expect(saved).toMatchObject({ ok: true, data: { state: { id: originalTask.id, state: 'available' }, receipt: { operationId: 'review-task-flow-save' } } });
    expect(pending).toHaveLength(1);
    expect(methods).toEqual([
      `GET /api/workspace/tasks/${originalTask.id}`,
      'POST /api/workspace/tasks',
      'GET /api/workspace/task-receipts/review-task-flow-save',
      `GET /api/workspace/tasks/${originalTask.id}`,
    ]);

    s.reopen();
    const recovered = await readReviewTaskOperation(transport, s.ctx, pending[0]!);
    expect(recovered).toMatchObject({ ok: true, data: { state: { id: originalTask.id, task: originalTask }, receipt: { operationId: 'review-task-flow-save' } } });
    expect(methods.slice(4).every((entry) => entry.startsWith('GET '))).toBe(true);
    const recoveredTask = data(recovered).state;

    const started = await s.app().request('/api/learning/attempts', { method: 'POST', headers: s.headers, body: JSON.stringify({
      action: 'start', operationId: 'review-task-flow-attempt', taskId: originalTask.id, questionId: s.question.id,
      taskRevision: recoveredTask.revision, taskContentHash: recoveredTask.contentHash,
      questionRevision: s.question.revision, nodeRef: s.question.nodeRef, retentionDays: 30, confirmed: true,
    }) });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ ok: true, data: { view: { taskId: originalTask.id, phase: 'confidence' }, receipt: { kind: 'start', resultingVersion: 0 } } });
  });

  it('keeps private question material out of the catalog and returns independently receipted events', async () => {
    const s = await setup();
    const app = s.app();
    const catalog = await app.request(`/api/learning/reviews?nodeId=${s.question.nodeRef.objectId}&revision=${s.question.nodeRef.revision}`, { headers: s.headers });
    expect(catalog.status).toBe(200);
    const catalogBody = await catalog.json() as { ok: boolean; data?: { questions: unknown[] } };
    expect(catalogBody.ok).toBe(true);
    expect(JSON.stringify(catalogBody)).not.toContain(s.question.standardAnswer);
    expect(JSON.stringify(catalogBody)).not.toContain(s.question.hints[0]!);

    const post = (body: unknown) => s.app().request('/api/learning/attempts', { method: 'POST', headers: s.headers, body: JSON.stringify(body) });
    const start = { action: 'start', operationId: 'review-attempt-1', taskId: s.task.id, questionId: s.question.id, questionRevision: s.question.revision,
      taskRevision: s.savedTask.revision, taskContentHash: s.savedTask.contentHash,
      nodeRef: s.question.nodeRef, retentionDays: 30, confirmed: true };
    const started = await post(start); expect(started.status).toBe(200);
    const startedBody = await started.json() as { ok: boolean; data?: { view: { id: string; version: number; phase: string; standardAnswer?: string }; receipt?: { operationId: string; kind: string; resultingVersion: number } } };
    expect(startedBody).toMatchObject({ ok: true, data: { view: { id: start.operationId, version: 0, phase: 'confidence' }, receipt: { operationId: start.operationId, kind: 'start', resultingVersion: 0 } } });
    expect(JSON.stringify(startedBody)).not.toContain(s.question.standardAnswer);
    expect(JSON.stringify(startedBody)).not.toContain(s.question.hints[0]!);

    const confidence = await post({ action: 'event', operationId: 'review-confidence-1', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'low' } });
    expect(confidence.status).toBe(200);
    const confidenceBody = await confidence.json() as { ok: boolean; data: { view: { version: number; phase: string }; receipt: { operationId: string; kind: string; resultingVersion: number } } };
    expect(confidenceBody).toMatchObject({ ok: true, data: { view: { version: 1, phase: 'confidence' }, receipt: { operationId: 'review-confidence-1', kind: 'confidence', resultingVersion: 1 } } });
    const begin = await post({ action: 'event', operationId: 'review-begin-1', attemptId: start.operationId, expectedVersion: 1, event: { type: 'begin' } });
    expect(begin.status).toBe(200);
    const beginBody = await begin.json() as { ok: boolean; data: { view: { version: number; phase: string } } };
    expect(beginBody).toMatchObject({ ok: true, data: { view: { version: 2, phase: 'answering' } } });
    const hint = await post({ action: 'event', operationId: 'review-hint-1', attemptId: start.operationId, expectedVersion: 2, event: { type: 'hint', level: 1 } });
    expect(hint.status).toBe(200);
    const hintBody = await hint.json() as { ok: boolean; data: { view: { version: number; hintLevel: number; hints: string[]; answerRevealed: boolean }; receipt: { operationId: string; kind: string; resultingVersion: number } } };
    expect(hintBody).toMatchObject({ ok: true, data: { view: { version: 3, hintLevel: 1, hints: [s.question.hints[0]], answerRevealed: false }, receipt: { operationId: 'review-hint-1', kind: 'hint', resultingVersion: 3 } } });
    expect(data(await s.services.readReviewOperation!(s.ctx, 'review-hint-1'))).toMatchObject({ state: 'applied', receipt: { operationId: 'review-hint-1', resultingVersion: 3 } });
    expect(data(await s.services.readReviewAttempt!(s.ctx, start.operationId))).toMatchObject({ hintLevel: 1, answerVisible: true });
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', start.operationId)?.value).toMatchObject({
      state: 'available', attempt: { exposure: 'seen', exposureEvents: expect.arrayContaining([{ operationId: 'review-hint-1', type: 'hint', level: 1, recordedAt: expect.any(String) }]) },
    });

    const submit = await post({ action: 'event', operationId: 'review-submit-1', attemptId: start.operationId, expectedVersion: 3, event: { type: 'submit', answer: 'A local copy.' } });
    expect(submit.status).toBe(200);
    const submitBody = await submit.json() as { ok: boolean; data: { view: { version: number; phase: string; submission: { answer: string; answerVisible: boolean } | null; standardAnswer?: string }; receipt: { operationId: string; kind: string; resultingVersion: number } } };
    expect(submitBody).toMatchObject({ ok: true, data: { view: { version: 4, phase: 'submitted', submission: { answer: 'A local copy.', answerVisible: true }, standardAnswer: s.question.standardAnswer }, receipt: { operationId: 'review-submit-1', kind: 'submit', resultingVersion: 4 } } });

    const feedback = await post({ action: 'feedback', operationId: 'review-feedback-1', attemptId: start.operationId, expectedVersion: 4, feedbackVersion: 0,
      review: { invalidReason: null, criteria: [{ criterionId: 'criterion-1', finding: 'met', answerQuote: 'A local copy.', rationale: 'The prerequisite is stated.' }] } });
    if (feedback.status !== 200) throw new Error(`${await feedback.clone().text()}\nreceipt=${JSON.stringify(await s.services.readReviewOperation!(s.ctx, 'review-feedback-1'))}`);
    const feedbackBody = await feedback.json() as { ok: boolean; data: { view: { version: number }; feedback: { version: number } | null; receipt: { operationId: string; kind: string; resultingVersion: number; feedbackVersion: number | null } } };
    expect(feedbackBody).toMatchObject({ ok: true, data: { view: { version: 5 }, feedback: { version: 1 }, receipt: { operationId: 'review-feedback-1', kind: 'feedback', resultingVersion: 5, feedbackVersion: 1 } } });

    const appeal = await post({ action: 'appeal', operationId: 'review-appeal-1', attemptId: start.operationId, expectedVersion: 5, feedbackVersion: 1,
      nodeRef: s.question.nodeRef, reason: 'Please recheck the rubric.' });
    expect(appeal.status).toBe(200);
    const appealBody = await appeal.json() as { ok: boolean; data: { receipt: { operationId: string; kind: string; resultingVersion: number; feedbackVersion: number | null } } };
    expect(appealBody).toMatchObject({ ok: true, data: { receipt: { operationId: 'review-appeal-1', kind: 'appeal', resultingVersion: 6, feedbackVersion: 1 } } });
    expect(data(await s.services.readReviewAttempt!(s.ctx, start.operationId))).toMatchObject({ appeals: [{ operationId: 'review-appeal-1', feedbackVersion: 1, reason: 'Please recheck the rubric.' }] });
  });

  it('recovers the original operation after SQLite restart and never clears an unknown operation from an empty read', async () => {
    const s = await setup(true);
    const request = { operationId: 'persistent-start-1', taskId: s.task.id, questionId: s.question.id, questionRevision: s.question.revision,
      taskRevision: s.savedTask.revision, taskContentHash: s.savedTask.contentHash!,
      nodeRef: s.question.nodeRef, retentionDays: 30 as const, confirmed: true as const };
    const applied = data(await s.services.startReviewAttempt!(s.ctx, request));
    s.reopen();
    expect(data(await s.services.readReviewOperation!(s.ctx, request.operationId))).toMatchObject({ state: 'applied', receipt: { operationId: request.operationId, requestHash: applied.requestHash } });
    expect(data(await s.services.readReviewAttempt!(s.ctx, request.operationId))).toMatchObject({ id: request.operationId, version: 0, phase: 'confidence' });
    const absent = data(await s.services.readReviewOperation!(s.ctx, 'never-recorded-operation'));
    expect(absent).toMatchObject({ state: 'unknown', attemptId: null, requestHash: null, receipt: null, absenceIsFinal: false, retryAllowed: false });
  });

  it('provides the reviewed rubric projection after submit without exposing the private standard answer early', async () => {
    const s = await setup();
    const start = data(await s.services.startReviewAttempt!(s.ctx, { operationId: 'rubric-attempt-1', taskId: s.task.id,
      taskRevision: s.savedTask.revision, taskContentHash: s.savedTask.contentHash!,
      questionId: s.question.id, questionRevision: s.question.revision, nodeRef: s.question.nodeRef, retentionDays: 30, confirmed: true }));
    const confidence = data(await s.services.applyReviewEvent!(s.ctx, { operationId: 'rubric-confidence-1', attemptId: start.attemptId, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } }));
    const begin = data(await s.services.applyReviewEvent!(s.ctx, { operationId: 'rubric-begin-1', attemptId: start.attemptId, expectedVersion: confidence.resultingVersion, event: { type: 'begin' } }));
    const before = data(await s.services.readReviewAttempt!(s.ctx, start.attemptId));
    expect(before?.feedback).toBeNull();
    expect(JSON.stringify(before)).not.toContain(s.question.standardAnswer);
    data(await s.services.applyReviewEvent!(s.ctx, { operationId: 'rubric-submit-1', attemptId: start.attemptId, expectedVersion: begin.resultingVersion, event: { type: 'submit', answer: 'A local copy.' } }));
    const current = data(await s.services.readReviewAttempt!(s.ctx, start.attemptId));
    expect(current?.feedback).toMatchObject({ version: 0, result: 'unverified', criteria: [{ criterionId: 'criterion-1', expectedEvidence: 'A local copy.', finding: 'unreviewed' }] });
  });
});
