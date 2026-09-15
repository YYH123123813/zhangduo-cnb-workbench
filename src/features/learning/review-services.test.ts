import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../contracts/ports';
import type { ReviewAttemptPublic, ReviewOperationReceipt, ReviewOperationRecovery, ReviewRuntimeStatus } from '../../contracts/review-session';
import { contentHash } from '../../contracts/hash';
import { AttemptResponseSchema } from './attempt-response';
import { publicAttempt } from './attempt';
import { failure, success } from './errors';
import type { TrustedReviewRequest } from './review-api';
import { applyTrustedReviewRequest, readTrustedReviewOperation, readTrustedReviewQuestions, readTrustedReviewReceipt } from './review-services';
import { startFixture } from './testing/attempt';
import { questionFixture } from './testing/question';
import { context, fixtureServices, task, useInput } from './testing/fixtures';

const start: TrustedReviewRequest = { action: 'start', operationId: 'attempt-1', taskId: task.id,
  taskRevision: 1, taskContentHash: 'a'.repeat(64),
  questionId: 'question-1', questionRevision: 'fixture:q1', nodeRef: useInput.nodeRefs[0]!, retentionDays: 30, confirmed: true };

async function setup() {
  const { action: _action, ...payload } = start;
  const receipt: ReviewOperationReceipt = { operationId: start.operationId, attemptId: start.operationId,
    actorId: context.actorId, workspaceId: context.workspaceId, kind: 'start', requestHash: await contentHash(payload),
    expectedVersion: 0, resultingVersion: 0, feedbackVersion: null, appliedAt: '2026-09-09T01:00:00Z',
    expiresAt: '2026-10-09T01:00:00Z', retentionDays: 30, outcome: 'applied' };
  const recovery: ReviewOperationRecovery = { operationId: receipt.operationId, actorId: context.actorId, workspaceId: context.workspaceId,
    state: 'applied', attemptId: receipt.attemptId, requestHash: receipt.requestHash, receipt, absenceIsFinal: false, retryAllowed: false };
  const state: ReviewAttemptPublic = { ...publicAttempt(startFixture('unknown')), persistence: 'shared_services', feedback: null, appeals: [] };
  const services = fixtureServices({
    readReviewRuntime: vi.fn(async () => success<ReviewRuntimeStatus>({ mode: 'fixture', catalog: 'ready', availableQuestionCount: 1,
      taskBinding: 'revision_hash_atomic', exposure: 'server_observed_unknown_default', unassistedCertification: false, questionRetentionDays: 30, attemptRetentionDays: 30 })),
    readReviewQuestions: vi.fn(async () => success([state.question])),
    startReviewAttempt: vi.fn(async () => success(receipt)), applyReviewEvent: vi.fn(async () => success(receipt)),
    saveReviewFeedback: vi.fn(async () => success(receipt)), saveReviewAppeal: vi.fn(async () => success(receipt)),
    readReviewOperation: vi.fn(async () => success(recovery)), readReviewAttempt: vi.fn(async () => success(state)),
  });
  return { services, receipt, recovery, state };
}

describe('S07 learning consumer receipt and public response boundary', () => {
  it('uses the original trusted context and projects only fields accepted by the UI', async () => {
    const f = await setup();
    const result = await applyTrustedReviewRequest(f.services, context, start);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(AttemptResponseSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.view).not.toHaveProperty('appeals');
    expect(result.data.view).not.toHaveProperty('feedback');
    expect(result.data.view).not.toHaveProperty('standardAnswer');
    expect(vi.mocked(f.services.startReviewAttempt!).mock.calls[0]?.[0]).toBe(context);
    expect(vi.mocked(f.services.startReviewAttempt!).mock.calls[0]?.[1]).toMatchObject({ taskId: task.id, taskRevision: start.taskRevision, taskContentHash: start.taskContentHash });
    expect(vi.mocked(f.services.readReviewOperation!).mock.calls[0]).toEqual([context, start.operationId]);
    expect(vi.mocked(f.services.readReviewAttempt!).mock.calls[0]).toEqual([context, start.operationId]);
  });

  it.each(['taskRevision', 'taskContentHash'] as const)('rejects a start receipt bound to a different %s before reading the attempt', async (field) => {
    const f = await setup();
    const { action: _action, ...payload } = start;
    f.receipt.requestHash = await contentHash({ ...payload, [field]: field === 'taskRevision' ? 2 : 'b'.repeat(64) });
    f.recovery.requestHash = f.receipt.requestHash;
    expect(await applyTrustedReviewRequest(f.services, context, start)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(f.services.readReviewAttempt).not.toHaveBeenCalled();
  });

  it('rejects a private question payload from the shared public directory port', async () => {
    const f = await setup();
    vi.mocked(f.services.readReviewQuestions!).mockImplementation(async () => success([questionFixture as never]));
    expect(await readTrustedReviewQuestions(f.services, context, {
      nodeId: useInput.nodeRefs[0]!.objectId, revision: useInput.nodeRefs[0]!.revision,
    })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it.each(['actor', 'workspace', 'outerOperation', 'outerAttempt', 'outerHash'] as const)('rejects mismatched %s in a mutation receipt before reading private state', async (field) => {
    const f = await setup();
    if (field === 'actor') f.receipt.actorId = 'another-actor';
    if (field === 'workspace') f.receipt.workspaceId = 'another-workspace';
    if (field === 'outerOperation') f.recovery.operationId = 'another-operation';
    if (field === 'outerAttempt') f.recovery.attemptId = 'another-attempt';
    if (field === 'outerHash') f.recovery.requestHash = 'b'.repeat(64);
    expect(await applyTrustedReviewRequest(f.services, context, start)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(f.services.readReviewAttempt).not.toHaveBeenCalled();
  });

  it.each(['operation', 'actor', 'workspace', 'hash', 'attempt'] as const)('binds cold operation recovery to its original %s', async (field) => {
    const f = await setup();
    if (field === 'operation') f.receipt.operationId = 'another-operation';
    if (field === 'actor') f.recovery.actorId = 'another-actor';
    if (field === 'workspace') f.recovery.workspaceId = 'another-workspace';
    if (field === 'hash') f.receipt.requestHash = 'b'.repeat(64);
    if (field === 'attempt') f.receipt.attemptId = 'another-attempt';
    expect(await readTrustedReviewOperation(f.services, context, start.operationId)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(f.services.readReviewAttempt).not.toHaveBeenCalled();
  });

  it('does not expose a foreign current attempt even with a matching original receipt', async () => {
    const f = await setup(); f.state.id = 'another-attempt';
    expect(await readTrustedReviewOperation(f.services, context, start.operationId)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
  });

  it('does not treat an empty original operation as not written or consult current state', async () => {
    const f = await setup();
    vi.mocked(f.services.readReviewOperation!).mockImplementation(async () => success({ operationId: start.operationId,
      actorId: context.actorId, workspaceId: context.workspaceId, state: 'unknown', attemptId: null, requestHash: null,
      receipt: null, absenceIsFinal: false, retryAllowed: false }));
    expect(await readTrustedReviewOperation(f.services, context, start.operationId)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(f.services.readReviewAttempt).not.toHaveBeenCalled();
  });

  it('uses published runtime capability and an exact approved question for live-mode requests', async () => {
    const f = await setup();
    const live = { ...context, mode: 'live' as const };
    const runtime = await f.services.readReviewRuntime!(context); if (!runtime.ok) throw Error('runtime fixture');
    vi.mocked(f.services.readReviewRuntime!).mockResolvedValue(success({ ...runtime.data, mode: 'live' }));
    expect((await applyTrustedReviewRequest(f.services, live, start)).ok).toBe(true);
    expect(f.services.readReviewQuestions).toHaveBeenCalledWith(live, { nodeId: start.nodeRef.objectId, revision: start.nodeRef.revision });
  });

  it.each(['missing', 'empty', 'contradiction', 'mode', 'taskBinding', 'privateField', 'certification'] as const)('refuses a new start when runtime capability is %s', async (change) => {
    const f = await setup();
    const runtime = await f.services.readReviewRuntime!(context); if (!runtime.ok) throw Error('runtime fixture');
    const invalid = { ...runtime.data };
    if (change === 'missing') f.services.readReviewRuntime = undefined;
    else {
      if (change === 'empty') { invalid.catalog = 'empty'; invalid.availableQuestionCount = 0; }
      if (change === 'contradiction') invalid.availableQuestionCount = 0;
      const value = change === 'mode' ? { ...invalid, mode: 'live' }
        : change === 'taskBinding' ? { ...invalid, taskBinding: 'client_get' }
          : change === 'privateField' ? { ...invalid, standardAnswer: 'PRIVATE' }
            : change === 'certification' ? { ...invalid, unassistedCertification: true } : invalid;
      vi.mocked(f.services.readReviewRuntime!).mockResolvedValue(success(value as ReviewRuntimeStatus));
    }
    expect((await applyTrustedReviewRequest(f.services, context, start)).ok).toBe(false);
    expect(f.services.startReviewAttempt).not.toHaveBeenCalled();
  });

  it.each(['empty', 'question', 'node', 'revision'] as const)('does not substitute a %s catalog for the selected question', async (change) => {
    const f = await setup(); const q = structuredClone(f.state.question);
    if (change === 'question') q.id = 'other-question';
    if (change === 'node') q.nodeRef.objectId = 'other-node';
    if (change === 'revision') q.revision = 'other-revision';
    vi.mocked(f.services.readReviewQuestions!).mockResolvedValue(success(change === 'empty' ? [] : [q]));
    expect((await applyTrustedReviewRequest(f.services, context, start)).ok).toBe(false);
    expect(f.services.startReviewAttempt).not.toHaveBeenCalled();
  });

  it('recovers an existing live-mode operation without consulting current runtime or catalog', async () => {
    const f = await setup(); f.services.readReviewRuntime = undefined; f.services.readReviewQuestions = undefined;
    expect((await readTrustedReviewOperation(f.services, { ...context, mode: 'live' }, start.operationId)).ok).toBe(true);
  });

  it('reads a dedicated receipt without fetching any attempt or question body', async () => {
    const f = await setup();
    expect(await readTrustedReviewReceipt(f.services, context, start.operationId)).toEqual(success(f.receipt));
    expect(f.services.readReviewAttempt).not.toHaveBeenCalled();
    expect(f.services.readReviewQuestions).not.toHaveBeenCalled();
  });

  it('checks the retained original hash before reading an allowed attempt body', async () => {
    const f = await setup();
    expect(await readTrustedReviewOperation(f.services, context, start.operationId, 'b'.repeat(64))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(f.services.readReviewAttempt).not.toHaveBeenCalled();
  });
  it.each(['receipt', 'body'] as const)('does not label a committed event not_written when %s read-back loses access', async (stage) => {
    const f = await setup();
    if (stage === 'receipt') vi.mocked(f.services.readReviewOperation!).mockResolvedValue(failure('FORBIDDEN', 'Receipt read access revoked'));
    else vi.mocked(f.services.readReviewAttempt!).mockResolvedValue(failure('FORBIDDEN', 'Body read access revoked'));
    expect(await applyTrustedReviewRequest(f.services, context, start)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'unknown', retryable: false } });
    expect(f.services.startReviewAttempt).toHaveBeenCalledTimes(1);
  });
});
