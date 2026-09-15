import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/platform/services';
import { ApprovalAuthority } from '../../src/platform/approvals';
import { platformFixture } from './platform-fixture';
import type { ReviewQuestion } from '../../src/contracts/review-session';
import type { TaskContext } from '../../src/contracts/domain';

const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) close(); });

async function setup() {
  const base = await platformFixture();
  closers.push(() => base.journal.close());
  const task: TaskContext = { id: 'review-http-task', workspaceId: base.ctx.workspaceId, question: 'Can this method be used offline?', constraints: [], mode: 'assisted', updatedAt: '2026-09-09T00:00:00Z' };
  const saved = await base.services.saveTask?.(base.ctx, { operationId: 'review-http-task-save', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true });
  if (!saved?.ok) throw new Error('Review HTTP task fixture was not saved');
  const question: ReviewQuestion = { id: 'review-http-question', workspaceId: base.ctx.workspaceId, revision: 'review-http:q1',
    nodeRef: { workspaceId: base.ctx.workspaceId, objectId: base.node.id, revision: base.base }, kind: 'recall', prompt: 'What is required?',
    standardAnswer: 'A local copy.', hints: ['Think about data.', 'Think about offline use.', 'A local copy is required.'],
    rubric: { version: 'review-http:rubric-1', criteria: [{ id: 'criterion-1', description: 'State the prerequisite.', expectedEvidence: 'A local copy.', required: true }], necessaryConditions: [] },
    review: { status: 'approved', reviewedBy: 'reviewer-1', reviewedAt: task.updatedAt } };
  const services = createServices({ ...base.options, reviewQuestions: [question] });
  const app = createApp(services);
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: base.headers, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: base.headers });
  return { ...base, task, savedTask: saved.data, question, services, post, get };
}

describe('S07 shared review HTTP composition', () => {
  it('records actual knowledge responses only with review retention consent and withholds them on ledger rollback', async () => {
    const f = await setup();
    expect((await f.get(`/api/retrieval/nodes/${f.node.id}`)).status).toBe(200);
    expect(f.journal.records(f.ctx.workspaceId, f.ctx.actorId, 'review_exposure')).toHaveLength(0);
    expect(await f.services.startReviewAttempt!(f.ctx, { operationId: 'observed-attempt', taskId: f.task.id,
      taskRevision: f.savedTask.revision, taskContentHash: f.savedTask.contentHash!, questionId: f.question.id,
      questionRevision: f.question.revision, nodeRef: f.question.nodeRef, retentionDays: 30, confirmed: true })).toMatchObject({ ok: true });
    expect(f.journal.records(f.ctx.workspaceId, f.ctx.actorId, 'review_exposure')[0]?.value).toMatchObject({ seenAt: null });
    const put = f.journal.putRecord.bind(f.journal);
    const fault = vi.spyOn(f.journal, 'putRecord').mockImplementation((...args) => args[2] === 'review_exposure' ? false : put(...args));
    const withheld = await f.get(`/api/retrieval/nodes/${f.node.id}`);
    expect(withheld.status).toBe(409);
    expect(JSON.stringify(await withheld.json())).not.toContain(f.node.humanStatement);
    expect(f.journal.records(f.ctx.workspaceId, f.ctx.actorId, 'review_exposure')[0]?.value).toMatchObject({ seenAt: null });
    fault.mockRestore();
    expect((await f.get(`/api/retrieval/nodes/${f.node.id}`)).status).toBe(200);
    expect(f.journal.records(f.ctx.workspaceId, f.ctx.actorId, 'review_exposure')[0]?.value).toMatchObject({ seenAt: expect.any(String) });
    const capability = await f.get('/api/workspace/review-runtime');
    expect(await capability.json()).toMatchObject({ ok: true, data: { catalog: 'ready', unassistedCertification: false, taskBinding: 'revision_hash_atomic' } });
  });

  it('uses the shared question catalog, operation receipts and public attempt projection', async () => {
    const f = await setup();
    const catalogResponse = await f.get(`/api/learning/reviews?nodeId=${f.node.id}&revision=${f.base}`);
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as { ok: boolean; data?: { questions: unknown[] } };
    expect(catalog).toMatchObject({ ok: true, data: { questions: [{ id: f.question.id, reviewStatus: 'approved' }] } });
    expect(JSON.stringify(catalog)).not.toContain(f.question.standardAnswer);

    const start = { action: 'start', operationId: 'review-http-attempt', taskId: f.task.id, questionId: f.question.id,
      taskRevision: f.savedTask.revision, taskContentHash: f.savedTask.contentHash,
      questionRevision: f.question.revision, nodeRef: f.question.nodeRef, retentionDays: 30, confirmed: true };
    const startedResponse = await f.post('/api/learning/attempts', start);
    expect(startedResponse.status).toBe(200);
    const started = await startedResponse.json() as any;
    expect(started).toMatchObject({ ok: true, data: { receipt: { kind: 'start', operationId: start.operationId }, view: { phase: 'confidence' } } });
    expect(JSON.stringify(started)).not.toContain(f.question.standardAnswer);

    const confidenceResponse = await f.post('/api/learning/attempts', { action: 'event', operationId: 'review-http-confidence', attemptId: start.operationId, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } });
    expect(confidenceResponse.status).toBe(200);
    expect(await confidenceResponse.json()).toMatchObject({ ok: true, data: { receipt: { kind: 'confidence', resultingVersion: 1 }, view: { phase: 'confidence' } } });
    const beginResponse = await f.post('/api/learning/attempts', { action: 'event', operationId: 'review-http-begin', attemptId: start.operationId, expectedVersion: 1, event: { type: 'begin' } });
    expect(beginResponse.status).toBe(200);
    expect(await beginResponse.json()).toMatchObject({ ok: true, data: { receipt: { kind: 'begin', resultingVersion: 2 }, view: { phase: 'answering' } } });
    const hintResponse = await f.post('/api/learning/attempts', { action: 'event', operationId: 'review-http-hint', attemptId: start.operationId, expectedVersion: 2, event: { type: 'hint', level: 1 } });
    expect(hintResponse.status).toBe(200);
    const hinted = await hintResponse.json() as any;
    expect(hinted).toMatchObject({ ok: true, data: { receipt: { kind: 'hint', resultingVersion: 3 }, view: { phase: 'answering', hintLevel: 1, hints: [f.question.hints[0]] } } });
    expect(JSON.stringify(hinted)).not.toContain(f.question.standardAnswer);

    const submitResponse = await f.post('/api/learning/attempts', { action: 'event', operationId: 'review-http-submit', attemptId: start.operationId, expectedVersion: 3, event: { type: 'submit', answer: 'A local copy.' } });
    expect(submitResponse.status).toBe(200);
    const submitted = await submitResponse.json() as any;
    expect(submitted).toMatchObject({ ok: true, data: { receipt: { kind: 'submit', resultingVersion: 4 }, view: { phase: 'submitted', standardAnswer: f.question.standardAnswer }, feedback: { version: 0, originalAnswer: 'A local copy.' } } });
    expect(submitted.data.view.question).not.toHaveProperty('standardAnswer');

    const readBackResponse = await f.get(`/api/learning/attempts/${start.operationId}`);
    expect(readBackResponse.status).toBe(200);
    expect(await readBackResponse.json()).toMatchObject({ ok: true, data: { view: { id: start.operationId, phase: 'submitted', version: 4, standardAnswer: f.question.standardAnswer } } });
  });

  it('returns a structured unknown result for a missing operation and never treats absence as final', async () => {
    const f = await setup();
    const response = await f.get('/api/learning/attempts/missing-operation');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', nextAction: 'read_review_operation' } });
  });
});
