import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../../contracts/api';
import type { KnowledgeNode, TaskContext } from '../../contracts/domain';
import type { RecoveryAnchor, RecoveryAnchorInput, RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import type { ReviewQuestion } from '../../contracts/review-session';
import type { TaskState } from '../../contracts/task-record';
import { SCOPES } from '../../contracts/scopes';
import { createApp } from '../../server/app';
import { createRuntime } from '../../platform/runtime';
import { ensureReviewTask, type ReviewTaskTransport } from './review-task';
import { recoverRetainedLearningOperation } from './retained-operation';
import { retainLearningRecovery, reviewRecoveryInput, taskRecoveryInput, evidenceRecoveryInput } from './recovery-anchor';
import { EvidenceSaveFlow } from './evidence-save-flow';
import type { EvidenceStoragePreview } from './application-api';
import type { AttemptResponse, TrustedReviewRequest } from './review-api';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
function data<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result.error)); return result.data; }

async function setup(catalog = true) {
  mkdirSync('.local/fixture', { recursive: true });
  const prefix = `.local/fixture/learning-runtime-${randomUUID()}`;
  const file = `${prefix}.sqlite`, catalogFile = `${prefix}.review.json`;
  cleanups.push(() => { for (const path of [catalogFile, file, `${file}-wal`, `${file}-shm`]) rmSync(path, { force: true }); });
  const workspaceId = 'cnb-repo:learning-repo', actorId = 'cnb-user:learning-user', revision = 'a'.repeat(40);
  const task: TaskContext = { id: 'original-task', workspaceId, question: 'Can the original premise be used?', constraints: [], mode: 'independent', updatedAt: '2026-09-12T00:00:00Z' };
  const node: KnowledgeNode = { id: 'k1', workspaceId, schemaVersion: 1, revision, title: 'Original premise', question: task.question,
    humanStatement: 'A local copy is required.', authorship: 'human_written', candidateIds: [], conversationId: 'c1', kind: 'claim', conditions: [], boundaries: [], sources: [],
    confirmation: 'confirmed', evidenceStatus: 'unverified', lifecycle: 'active', confirmedBy: actorId, confirmedAt: task.updatedAt, updatedAt: task.updatedAt };
  const question: ReviewQuestion = { id: 'q1', workspaceId, revision: 'q1-v1', nodeRef: { workspaceId, objectId: node.id, revision }, kind: 'recall', prompt: 'State the prerequisite.',
    standardAnswer: 'PRIVATE ANSWER local copy', hints: ['PRIVATE HINT data', 'Think offline', 'A local copy'],
    rubric: { version: 'rubric-v1', criteria: [{ id: 'criterion-1', description: 'State the premise', expectedEvidence: 'PRIVATE RUBRIC local copy', required: true }], necessaryConditions: [] },
    review: { status: 'approved', reviewedBy: 'server-reviewer', reviewedAt: task.updatedAt } };
  if (catalog) writeFileSync(catalogFile, JSON.stringify({ operationId: 'import-reviewed-q1', workspaceId, questions: [question], retentionDays: 30, confirmed: true }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { CNB_REPO_SLUG: 'fixture/learning', CNB_TOKEN: 'synthetic-token', CNB_TOKEN_SCOPES: 'account-profile:r,repo-basic-info:r,repo-code:r,repo-issue:r',
    CNB_LIVE_READS_FOR: 'fixture/learning', ZHANGDUO_MODE: 'live', ZHANGDUO_BOOTSTRAP_KEY: 'b'.repeat(64), ZHANGDUO_STATE_FILE: file,
    ZHANGDUO_APP_SCOPES: Object.values(SCOPES).join(','), ZHANGDUO_STORAGE_CONFIRMED: 'true', ...(catalog ? { ZHANGDUO_REVIEW_CATALOG_FILE: catalogFile } : {}) };
  const user = { id: 'learning-user', username: 'synthetic-user' };
  const external = vi.fn<typeof fetch>(async (input, init) => {
    expect(!init?.method || init.method === 'GET').toBe(true);
    const url = new URL(String(input));
    if (url.pathname === '/user') return Response.json(user);
    if (url.pathname === '/fixture/learning') return Response.json({ id: 'learning-repo', path: 'fixture/learning', visibility_level: 'Private' });
    if (url.pathname.endsWith('/head')) return Response.json({ name: 'main' });
    if (url.pathname.endsWith('/commits/main')) return Response.json({ sha: revision });
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, workspaceId, nodes: [node], relations: [], excludedIds: [] }));
    return Response.json({ type: 'blob', path: 'knowledge/snapshot.json', encoding: 'base64', content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
  });
  const open = () => { const value = createRuntime(() => env, { transport: external }); cleanups.push(() => value.close()); return value; };
  let runtime = open(), app = createApp(runtime.services, { runtime });
  const common = { Origin: 'http://localhost', 'Content-Type': 'application/json' };
  const connect = async (target = app) => {
    const result = await target.request('/api/workspace/connect', { method: 'POST', headers: common, body: JSON.stringify({ connectionKey: env.ZHANGDUO_BOOTSTRAP_KEY, confirmed: true }) });
    expect(result.status, await result.clone().text()).toBe(200);
    return { ...common, Cookie: result.headers.get('Set-Cookie')!.split(';')[0]! };
  };
  let headers = await connect();
  const calls: string[] = [];
  const transport: ReviewTaskTransport = async (path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    return await (await app.request(path, { ...init, headers })).json() as Result<unknown>;
  };
  const identity = { actorId, workspaceId };
  const retain = (input: RecoveryAnchorInput) => retainLearningRecovery(async (request) => await transport('/api/workspace/recovery-identities', {
    method: 'POST', body: JSON.stringify({ ...request, ...identity }),
  }) as Result<RecoveryAnchor>, identity, input);
  const anchorRead = async (anchor: RecoveryAnchor) => data(await transport(`/api/workspace/recovery-identities/${anchor.id}`) as Result<RecoveryAnchorRead>);
  const saveTask = async () => data(await ensureReviewTask(transport, identity, task, 'save-original-task', { confirmed: true, onPending: () => {} }));
  const startRequest = (state: TaskState, operationId = 'start-1'): Extract<TrustedReviewRequest, { action: 'start' }> => ({ action: 'start', operationId, taskId: task.id,
    taskRevision: state.revision, taskContentHash: state.contentHash!, questionId: question.id, questionRevision: question.revision, nodeRef: question.nodeRef, retentionDays: 30, confirmed: true });
  const post = async (request: TrustedReviewRequest): Promise<Result<AttemptResponse>> => await transport('/api/learning/attempts', { method: 'POST', body: JSON.stringify(request) }) as Result<AttemptResponse>;
  return { task, node, question, user, identity, calls, transport, retain, anchorRead, saveTask, startRequest, post, connect, env,
    get app() { return app; }, get runtime() { return runtime; }, get headers() { return headers; },
    async peer() { const peer = open(), target = createApp(peer.services, { runtime: peer }); return { app: target, headers: await connect(target) }; },
    async reopen() { const previous = headers; runtime.close(); runtime = open(); app = createApp(runtime.services, { runtime });
      expect((await app.request('/api/workspace/session', { headers: previous })).status).toBe(401); headers = await connect(); },
  };
}

describe('learning 1.25/1.26 actual createRuntime + Services + HTTP + SQLite (synthetic external transport)', () => {
  it('uses the verified private catalog and never exposes private answers through runtime/catalog/initial start', async () => {
    const s = await setup();
    expect(data(await s.transport('/api/workspace/review-runtime'))).toMatchObject({ mode: 'fixture', catalog: 'ready', taskBinding: 'revision_hash_atomic', unassistedCertification: false });
    const catalog = await s.transport(`/api/learning/reviews?nodeId=k1&revision=${s.node.revision}`);
    expect(data(catalog)).toMatchObject({ questions: [{ id: s.question.id, revision: s.question.revision }] });
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE');
    const saved = await s.saveTask(), started = data(await s.post(s.startRequest(saved.state)));
    expect(started.view.answerVisible).toBe(true);
    expect(JSON.stringify(started)).not.toContain('PRIVATE');
    expect((await s.post({ ...s.startRequest(saved.state, 'wrong-q'), questionRevision: 'another-version' })).ok).toBe(false);
  });

  it('refuses a missing catalog and unconfigured runtime rather than manufacturing a question', async () => {
    const s = await setup(false), task = await s.saveTask();
    expect(data(await s.transport('/api/workspace/review-runtime'))).toMatchObject({ catalog: 'empty', availableQuestionCount: 0 });
    expect((await s.post(s.startRequest(task.state))).ok).toBe(false);
    const ctx = data(await s.runtime.services.context(new Request('http://localhost', { headers: s.headers })));
    expect(data(await s.runtime.services.readReviewOperation!(ctx, 'start-1'))).toMatchObject({ state: 'unknown', receipt: null });
    const missing = createRuntime(() => ({})); cleanups.push(() => missing.close());
    expect((await createApp(missing.services, { runtime: missing }).request('/api/workspace/review-runtime')).status).toBe(503);
  });

  it('retains the exact task request, then reads its receipt after SQLite reopen without reconstructing changed task A', async () => {
    const s = await setup(); let anchor: RecoveryAnchor | undefined;
    const saved = data(await ensureReviewTask(s.transport, s.identity, s.task, 'task-with-recovery', { confirmed: true, onPending: () => {},
      beforeSave: async (request) => { anchor = data(await s.retain(await taskRecoveryInput(request, new Date(Date.now() + 3_600_000).toISOString()))); return { ok: true, data: true }; },
    }));
    const start = s.startRequest(saved.state), peerHeaders = await s.connect();
    const changed = await s.app.request('/api/workspace/tasks', { method: 'POST', headers: peerHeaders, body: JSON.stringify({ operationId: 'peer-task-B', task: { ...s.task, question: 'Task B' },
      expectedRevision: saved.state.revision, expectedContentHash: saved.state.contentHash, retentionDays: 30, confirmed: true }) });
    expect(changed.status).toBe(200);
    expect(await s.post(start)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await s.reopen();
    const supplied = await s.anchorRead(anchor!), count = s.calls.length;
    const recovered = data(await recoverRetainedLearningOperation(s.transport, s.identity, supplied, true));
    expect(recovered.receipt).toMatchObject({ operationId: 'task-with-recovery', revision: 1 });
    expect(recovered.task).toBeUndefined();
    expect(JSON.stringify(recovered)).not.toContain('Task B');
    expect(s.calls.slice(count).every((call) => call.startsWith('GET '))).toBe(true);
  });

  it('retains each event independently and recovers lost submit/feedback responses with exact receipts after restart', async () => {
    const s = await setup(), saved = await s.saveTask();
    const retained: RecoveryAnchor[] = [];
    const apply = async (request: TrustedReviewRequest) => {
      retained.push(data(await s.retain(await reviewRecoveryInput(request, new Date(Date.now() + 3_600_000).toISOString()))));
      return data(await s.post(request));
    };
    const initial = await apply(s.startRequest(saved.state));
    await apply({ action: 'event', operationId: 'confidence-1', attemptId: initial.view.id, expectedVersion: 0, event: { type: 'confidence', value: 'high' } });
    const begun = await apply({ action: 'event', operationId: 'begin-1', attemptId: initial.view.id, expectedVersion: 1, event: { type: 'begin' } });
    expect(JSON.stringify(begun)).not.toContain('PRIVATE');
    await apply({ action: 'event', operationId: 'hint-1', attemptId: initial.view.id, expectedVersion: 2, event: { type: 'hint', level: 1 } });
    const reveal = await apply({ action: 'event', operationId: 'reveal-1', attemptId: initial.view.id, expectedVersion: 3, event: { type: 'reveal' } });
    expect(reveal.view.standardAnswer).toBe(s.question.standardAnswer);
    const submit: TrustedReviewRequest = { action: 'event', operationId: 'submit-1', attemptId: initial.view.id, expectedVersion: 4, event: { type: 'submit', answer: 'A local copy.' } };
    const submitAnchor = data(await s.retain(await reviewRecoveryInput(submit, new Date(Date.now() + 3_600_000).toISOString())));
    const loseResponse = async (request: TrustedReviewRequest) => { data(await s.post(request)); throw Error('response lost after commit'); };
    await expect(loseResponse(submit)).rejects.toThrow('response lost');
    const feedback: TrustedReviewRequest = { action: 'feedback', operationId: 'feedback-1', attemptId: initial.view.id, expectedVersion: 5, feedbackVersion: 0,
      review: { invalidReason: null, criteria: [{ criterionId: 'criterion-1', finding: 'met', answerQuote: 'A local copy.', rationale: 'The premise is stated.' }] } };
    const feedbackAnchor = data(await s.retain(await reviewRecoveryInput(feedback, new Date(Date.now() + 3_600_000).toISOString())));
    await expect(loseResponse(feedback)).rejects.toThrow('response lost');
    expect(await s.post({ ...feedback, operationId: 'peer-feedback' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await apply({ action: 'appeal', operationId: 'appeal-1', attemptId: initial.view.id, expectedVersion: 6, feedbackVersion: 1, nodeRef: s.question.nodeRef, reason: 'Please review this condition.' });
    await s.reopen();
    for (const anchor of [...retained, submitAnchor, feedbackAnchor]) {
      const supplied = await s.anchorRead(anchor), count = s.calls.length;
      const restored = data(await recoverRetainedLearningOperation(s.transport, s.identity, supplied));
      expect(restored.receipt?.operationId).toBe(anchor.operation.operationId);
      expect(JSON.stringify(restored)).not.toContain('PRIVATE');
      data(await recoverRetainedLearningOperation(s.transport, s.identity, supplied));
      expect(s.calls.slice(count).every((call) => call.startsWith('GET '))).toBe(true);
    }
    const viewed = data(await recoverRetainedLearningOperation(s.transport, s.identity, await s.anchorRead(submitAnchor), true));
    expect(viewed.review?.view).toMatchObject({ version: 7, evidenceClass: 'assisted_restatement' });
    expect(viewed.receipt).toMatchObject({ operationId: 'submit-1', expectedVersion: 4, resultingVersion: 5 });
    expect(viewed.review?.feedback?.version).toBe(1);
  });

  it.each(['adopt', 'reject', 'verify_later'] as const)('retains %s use and failed outcome identities separately, preserving original snapshots on reopen', async (decision) => {
    const s = await setup();
    const response = data(await s.transport('/api/learning/use', { method: 'POST', body: JSON.stringify({ action: 'preview', selection: {
      task: s.task, snapshotRevision: s.node.revision, nodeRefs: [s.question.nodeRef], relationRefs: [], decision, reason: 'Keep the original premise.' },
    }) }) as Result<{ storage: EvidenceStoragePreview }>);
    const save = async (preview: EvidenceStoragePreview) => {
      const anchor = data(await s.retain(await evidenceRecoveryInput(preview, new Date(Date.now() + 3_600_000).toISOString())));
      const flow = new EvidenceSaveFlow(preview, s.transport); await flow.approve(true); await flow.save();
      expect(flow.getSnapshot().phase).toBe('saved'); return anchor;
    };
    const useAnchor = await save(response.storage);
    const outcome = data(await s.transport('/api/learning/outcomes', { method: 'POST', body: JSON.stringify({ action: 'preview', outcome: {
      useRecordId: response.storage.record.id, status: 'failed', summary: 'Did not work', failureReason: 'Original premise was missing' },
    }) }) as Result<{ storage: EvidenceStoragePreview }>);
    const outcomeAnchor = await save(outcome.storage);
    await s.reopen(); const count = s.calls.length;
    for (const anchor of [useAnchor, outcomeAnchor]) {
      const supplied = await s.anchorRead(anchor);
      const metadata = data(await recoverRetainedLearningOperation(s.transport, s.identity, supplied));
      expect(metadata.evidence?.record).toBeNull();
      const body = data(await recoverRetainedLearningOperation(s.transport, s.identity, supplied, true));
      if (body.evidence?.record?.kind === 'use') expect(body.evidence.record.useContext).toMatchObject({ task: s.task, snapshotRevision: s.node.revision });
      else expect(body.evidence?.record?.outcome).toMatchObject({ useRecordId: response.storage.record.id, verification: 'self_reported' });
    }
    expect(s.calls.slice(count).every((call) => call.startsWith('GET '))).toBe(true);
  });

  it('does not continue after a lost anchor response, expires without renewal, and isolates the original identity', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const s = await setup(), state = await s.saveTask(), start = s.startRequest(state.state);
    const input = await reviewRecoveryInput(start, new Date(Date.now() + 60_000).toISOString());
    const lost = await retainLearningRecovery(async (value) => { data(await s.retain(value)); throw Error('anchor response lost'); }, s.identity, input);
    expect(lost).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    const anchors = data(await s.transport('/api/workspace/recovery-identities') as Result<RecoveryAnchor[]>);
    const supplied = await s.anchorRead(anchors[0]!);
    expect(await recoverRetainedLearningOperation(s.transport, s.identity, supplied)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(s.calls.filter((call) => call === 'POST /api/learning/attempts')).toHaveLength(0);
    const count = s.calls.length;
    expect((await recoverRetainedLearningOperation(s.transport, { ...s.identity, actorId: 'another' }, supplied)).ok).toBe(false);
    expect(s.calls).toHaveLength(count);
    time.mockReturnValue(Date.parse(input.expiresAt) + 1);
    expect(data(await s.transport(`/api/workspace/recovery-identities/${anchors[0]!.id}`))).toBeNull();
    time.mockRestore();
    s.user.id = 'another-user';
    const denied = await s.app.request(`/api/workspace/recovery-identities/${anchors[0]!.id}`, { headers: s.headers });
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain(s.question.standardAnswer);
  });

  it('keeps same-content competing events distinct across two runtime SQLite connections and persists cancel separately', async () => {
    const s = await setup(), saved = await s.saveTask(); data(await s.post(s.startRequest(saved.state)));
    const peer = await s.peer();
    const first: TrustedReviewRequest = { action: 'event', operationId: 'confidence-A', attemptId: 'start-1', expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } };
    const second = { ...first, operationId: 'confidence-B' };
    const anchorA = data(await s.retain(await reviewRecoveryInput(first, new Date(Date.now() + 3_600_000).toISOString())));
    const anchorB = data(await s.retain(await reviewRecoveryInput(second, new Date(Date.now() + 3_600_000).toISOString())));
    data(await s.post(first));
    expect((await peer.app.request('/api/learning/attempts', { method: 'POST', headers: peer.headers, body: JSON.stringify(second) })).status).toBe(409);
    expect(data(await recoverRetainedLearningOperation(s.transport, s.identity, await s.anchorRead(anchorA))).receipt?.operationId).toBe(first.operationId);
    expect(await recoverRetainedLearningOperation(s.transport, s.identity, await s.anchorRead(anchorB))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    const cancel: TrustedReviewRequest = { action: 'event', operationId: 'cancel-1', attemptId: 'start-1', expectedVersion: 1, event: { type: 'cancel' } };
    const cancelAnchor = data(await s.retain(await reviewRecoveryInput(cancel, new Date(Date.now() + 3_600_000).toISOString())));
    data(await s.post(cancel)); await s.reopen();
    const recovered = data(await recoverRetainedLearningOperation(s.transport, s.identity, await s.anchorRead(cancelAnchor)));
    expect(recovered.receipt).toMatchObject({ operationId: 'cancel-1', kind: 'cancel', resultingVersion: 2 });
    expect(JSON.stringify(recovered)).not.toContain('PRIVATE');
  });

  it('keeps unobserved exposure unknown even when no hint or reveal was requested', async () => {
    const s = await setup(), saved = await s.saveTask(); data(await s.post(s.startRequest(saved.state)));
    data(await s.post({ action: 'event', operationId: 'confidence', attemptId: 'start-1', expectedVersion: 0, event: { type: 'confidence', value: 'high' } }));
    data(await s.post({ action: 'event', operationId: 'begin', attemptId: 'start-1', expectedVersion: 1, event: { type: 'begin' } }));
    const submitted = data(await s.post({ action: 'event', operationId: 'submit', attemptId: 'start-1', expectedVersion: 2, event: { type: 'submit', answer: 'A local copy.' } }));
    expect(submitted.view).toMatchObject({ evidenceClass: 'unverified_exposure', hintLevel: 0, submission: { answerVisible: true } });
    expect(submitted.view.evidenceClass).not.toMatch(/^unassisted_/);
  });

  it('keeps the dedicated receipt readable after an explicitly authorized synthetic deletion while blocking the attempt body', async () => {
    const s = await setup(), saved = await s.saveTask(); const start = s.startRequest(saved.state);
    const anchor = data(await s.retain(await reviewRecoveryInput(start, new Date(Date.now() + 3_600_000).toISOString())));
    data(await s.post(start));
    const ctx = data(await s.runtime.services.context(new Request('http://localhost', { headers: s.headers })));
    const plan = data(await s.runtime.services.previewDelete(ctx, [s.node.id]));
    const approval = data(await s.runtime.services.approveGovernance!(ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    data(await s.runtime.services.executeDelete(ctx, plan, approval));
    const supplied = await s.anchorRead(anchor);
    expect(data(await recoverRetainedLearningOperation(s.transport, s.identity, supplied)).receipt?.operationId).toBe(start.operationId);
    const body = await recoverRetainedLearningOperation(s.transport, s.identity, supplied, true);
    expect(body.ok).toBe(false); expect(JSON.stringify(body)).not.toContain('PRIVATE');
  });
});
