import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createServices } from '../../platform/services';
import type { ModelTransport } from '../../platform/model';
import type { Approval } from '../../contracts/domain';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import type { Services } from '../../contracts/ports';
import { hashModelInput, hashSettings } from '../../contracts/hash';
import { startAttempt, transitionAttempt } from './attempt';
import { createFeedback } from './feedback';
import { prepareReviewModel, approveReviewModel, requestReviewModel, type ReviewModelDependencies } from './model-review';
import { inspectReviewModelOperation } from './model-operation';
import { questionFixture } from './testing/question';
import { success } from './errors';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

async function setup(enabled = true) {
  const base = await platformFixture(); cleanup.push(() => base.journal.close());
  base.node.sources.push({ id: 'source-1', kind: 'user_observation', title: 'Synthetic prerequisite', excerpt: 'Fixture evidence',
    accessedAt: questionFixture.review.reviewedAt!, support: 'partial', supportedClaim: 'Fixture claim', limitation: 'Synthetic only',
  });
  const now = new Date().toISOString();
  const complete = vi.fn<ModelTransport['complete']>();
  const services = createServices({ ...base.options, model: { mode: 'fixture', complete } });
  const snapshot = await services.snapshot(base.ctx); if (!snapshot.ok) throw new Error('Expected fixture knowledge');
  const question = { ...structuredClone(questionFixture), workspaceId: base.ctx.workspaceId,
    nodeRef: { workspaceId: base.ctx.workspaceId, objectId: 'k1', revision: base.base },
  };
  const started = startAttempt({ id: 'attempt-1', taskId: 'task-1' }, question, snapshot.data, base.ctx, 'unknown', now);
  if (!started.ok) throw new Error('Expected fixture attempt');
  let attempt = started.data;
  for (const event of [{ type: 'confidence', value: 'high' }, { type: 'begin' }, { type: 'submit', answer: 'A local copy must exist.' }]) {
    const result = transitionAttempt(attempt, event, base.ctx, attempt.version, now, snapshot.data);
    if (!result.ok) throw new Error('Expected submitted fixture'); attempt = result.data;
  }
  const value = { attemptId: attempt.id, attemptVersion: attempt.version, questionId: question.id,
    questionRevision: question.revision, rubricVersion: question.rubric.version,
    criteria: [{ criterionId: 'criterion-1', finding: 'met', answerQuote: 'A local copy must exist.',
      rationale: 'The answer states the prerequisite.', sourceQuotes: [{ sourceId: 'source-1', quote: 'Fixture evidence' }],
    }],
  };
  complete.mockImplementation(async () => success({ value: structuredClone(value), modelId: 'actual-fixture-review-model', generatedAt: now }));
  const readAttempt = vi.fn<NonNullable<ReviewModelDependencies['readAttempt']>>(async () => success(structuredClone(attempt)));
  const dependencies: ReviewModelDependencies = { services, readAttempt };
  const approvePort = vi.spyOn(services, 'approveModel'); const evidence = vi.spyOn(services, 'appendEvidence');
  async function setAI(aiReview: boolean) {
    const current = await services.settingsState!(base.ctx); if (!current.ok) throw new Error('Expected settings');
    const settings = { ...current.data.settings, aiReview };
    const approval = await services.approveGovernance!(base.ctx, { purpose: 'settings', settings, baseRevision: base.base,
      expectedSettingsHash: await hashSettings(base.ctx.workspaceId, base.base, current.data.settings),
      expectedSettingsRevision: current.data.revision, confirmed: true,
    });
    if (!approval.ok || !(await services.saveSettings(base.ctx, settings, approval.data)).ok) throw new Error('Expected fixture settings save');
  }
  if (enabled) await setAI(true);
  const preview = () => prepareReviewModel(attempt.id, dependencies, base.ctx);
  let approvalOperationId: string | null = null;
  const approve = async () => {
    const prepared = await preview(); if (!prepared.ok) throw new Error(prepared.error.message);
    approvalOperationId = crypto.randomUUID();
    const approved = await approveReviewModel({ operationId: approvalOperationId, attemptId: attempt.id, previewHash: prepared.data.contentHash, confirmed: true }, dependencies, base.ctx);
    if (!approved.ok) throw new Error(approved.error.message); return approved.data;
  };
  const send = (approval: Approval, confirmed = true) => requestReviewModel({ attemptId: attempt.id, approval, confirmed }, dependencies, base.ctx);
  return { ...base, services, snapshot: snapshot.data, attempt, value, dependencies, complete, readAttempt, approvePort, evidence, preview, approve, send, setAI,
    get approvalOperationId() { return approvalOperationId; } };
}

describe('L08 shared approved review-model adapter (synthetic transport, no production session)', () => {
  it('retains separately consented model-review metadata before its original approval registration', async () => {
    const s = await setup(), preview = await s.preview(); if (!preview.ok) throw Error('preview');
    const save = s.services.saveRecoveryAnchor!, approve = s.services.approveModel!;
    const retain = vi.fn<NonNullable<Services['saveRecoveryAnchor']>>((ctx, input) => save(ctx, input));
    const approveWithOrder = vi.fn<NonNullable<Services['approveModel']>>((ctx, input) => approve(ctx, input));
    s.services.saveRecoveryAnchor = retain; s.services.approveModel = approveWithOrder;
    const approved = await approveReviewModel({ operationId: 'retained-model-review', attemptId: s.attempt.id, previewHash: preview.data.contentHash, confirmed: true },
      s.dependencies, s.ctx, { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), confirmed: true });
    expect(approved.ok).toBe(true);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0]?.[1]).toMatchObject({ feature: 'learning', operation: { kind: 'model', operationId: 'retained-model-review', modelPurpose: 'review' },
      binding: { contentHash: preview.data.contentHash, baseRevision: preview.data.baseRevision } });
    expect(JSON.stringify(retain.mock.calls[0]?.[1])).not.toContain(s.attempt.question.standardAnswer);
    expect(retain.mock.invocationCallOrder[0]).toBeLessThan(approveWithOrder.mock.invocationCallOrder[0]!);
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('does not register model approval after a lost recovery retention response', async () => {
    const s = await setup(), preview = await s.preview(); if (!preview.ok) throw Error('preview');
    const save = s.services.saveRecoveryAnchor!;
    s.services.saveRecoveryAnchor = vi.fn<NonNullable<Services['saveRecoveryAnchor']>>(async (ctx, input) => { await save(ctx, input); throw Error('lost anchor response'); });
    const approved = await approveReviewModel({ operationId: 'unknown-model-anchor', attemptId: s.attempt.id, previewHash: preview.data.contentHash, confirmed: true },
      s.dependencies, s.ctx, { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), confirmed: true });
    expect(approved).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(s.approvePort).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });
  it('requires a server session reader and explicit consent, without touching model ports', async () => {
    const s = await setup();
    expect(await prepareReviewModel(s.attempt.id, { services: s.services }, s.ctx)).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
    expect(await approveReviewModel({ operationId: crypto.randomUUID(), attemptId: s.attempt.id, previewHash: 'a'.repeat(64), confirmed: false }, s.dependencies, s.ctx)).toMatchObject({ ok: false });
    expect(await requestReviewModel({ attemptId: s.attempt.id, confirmed: false }, s.dependencies, s.ctx)).toMatchObject({ ok: false });
    expect(s.readAttempt).not.toHaveBeenCalled(); expect(s.approvePort).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it('builds a bounded exact preview with saved source IDs, without sending, approving or exposing confidence', async () => {
    const s = await setup(); const preview = await s.preview();
    expect(preview).toMatchObject({ ok: true, data: { baseRevision: s.base, objectIds: ['k1'], input: { purpose: 'review', sourceIds: ['source-1'] }, persistence: 'not_saved' } });
    if (!preview.ok) throw new Error('Expected preview');
    expect(preview.data.contentHash).toBe(await hashModelInput(preview.data.input));
    const data = JSON.parse(preview.data.input.text);
    expect(data.submission).toEqual({ answer: s.attempt.submission!.answer });
    expect(data.question.standardAnswer).toBe(s.attempt.question.standardAnswer);
    expect(preview.data.input.text).not.toContain('selfConfidence'); expect(preview.data.input.text).not.toContain(s.ctx.actorId);
    expect(s.approvePort).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled(); expect(s.evidence).not.toHaveBeenCalled();
  });

  it('rejects model approval without a stable operation ID before touching the shared port', async () => {
    const s = await setup(); const preview = await s.preview(); if (!preview.ok) throw new Error('Expected preview');
    const result = await approveReviewModel({ attemptId: s.attempt.id, previewHash: preview.data.contentHash, confirmed: true }, s.dependencies, s.ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(s.approvePort).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it.each(['model:review', 'knowledge:read', 'evidence:read'])('rejects missing %s before transmission', async (scope) => {
    const s = await setup();
    expect(await prepareReviewModel(s.attempt.id, s.dependencies, { ...s.ctx, scopes: s.ctx.scopes.filter((value) => value !== scope) })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.readAttempt).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it.each(['owner', 'unsubmitted', 'unreviewed', 'stale', 'source_missing', 'oversized'])('rejects invalid review context: %s', async (scenario) => {
    const s = await setup();
    if (scenario === 'owner') s.attempt.actorId = 'another-actor';
    if (scenario === 'unsubmitted') { s.attempt.phase = 'answering'; s.attempt.submission = null; }
    if (scenario === 'unreviewed') s.attempt.question.review = { status: 'pending' };
    if (scenario === 'stale') s.attempt.snapshotRevision = 'b'.repeat(40);
    if (scenario === 'source_missing') s.node.sources = [];
    if (scenario === 'oversized') s.attempt.question.rubric.criteria = Array.from({ length: 12 }, (_, index) => ({
      id: `criterion-${index}`, description: 'x'.repeat(7900), expectedEvidence: 'Expected evidence', required: true,
    }));
    expect(await s.preview()).toMatchObject({ ok: false }); expect(s.approvePort).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it('keeps manual feedback usable while AI is off or an approval port is missing', async () => {
    const s = await setup(false); expect(await s.preview()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(createFeedback(s.attempt)).toMatchObject({ ok: true, data: { result: 'unverified', source: 'human_self_review' } });
    await s.setAI(true); const preview = await s.preview(); if (!preview.ok) throw new Error('Expected preview');
    const services = { ...s.services, approveModel: undefined };
    expect(await approveReviewModel({ operationId: crypto.randomUUID(), attemptId: s.attempt.id, previewHash: preview.data.contentHash, confirmed: true }, { ...s.dependencies, services }, s.ctx)).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
    expect(s.complete).not.toHaveBeenCalled();
  });

  it('rejects changed preview content before registering approval', async () => {
    const s = await setup(); const preview = await s.preview(); if (!preview.ok) throw new Error('Expected preview');
    s.attempt.submission!.answer = 'Changed answer'; s.attempt.version += 1;
    expect(await approveReviewModel({ operationId: crypto.randomUUID(), attemptId: s.attempt.id, previewHash: preview.data.contentHash, confirmed: true }, s.dependencies, s.ctx)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.approvePort).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it('uses a registered approval once and returns only a nonfinal, unsaved suggestion', async () => {
    const s = await setup(); const frozen = structuredClone(s.attempt); const approval = await s.approve();
    expect(approval).toMatchObject({ purpose: 'model_input', actorId: s.ctx.actorId, objectIds: ['k1'] });
    expect(s.complete).not.toHaveBeenCalled();
    const result = await s.send(approval);
    expect(result).toMatchObject({ ok: true, data: { source: 'ai_suggestion', requiresHumanReview: true,
      persistence: 'not_saved', indexing: 'excluded', modelId: 'actual-fixture-review-model', criteria: s.value.criteria,
    } });
    expect(result.ok && 'result' in result.data).toBe(false);
    expect(s.attempt).toEqual(frozen); expect(s.evidence).not.toHaveBeenCalled();
    expect(await s.send(approval)).toMatchObject({ ok: false }); expect(s.complete).toHaveBeenCalledTimes(1);
    expect(s.approvePort).toHaveBeenCalledTimes(1);
  });

  it.each(['revoked', 'forged', 'scope', 'changed', 'deleted', 'disabled', 'expired', 'purpose'])('honors shared approval/source checks: %s', async (scenario) => {
    const s = await setup(); let approval = await s.approve();
    if (scenario === 'revoked') s.authority.revoke(s.ctx, approval.id);
    if (scenario === 'forged') approval = { ...approval, id: 'unregistered-approval' };
    if (scenario === 'scope') approval = { ...approval, objectIds: ['another-node'] };
    if (scenario === 'expired') approval = { ...approval, expiresAt: '2026-09-01T00:00:00Z' };
    if (scenario === 'purpose') approval = { ...approval, purpose: 'save_evidence' };
    if (scenario === 'changed') { s.attempt.submission!.answer = 'Changed answer'; s.attempt.version += 1; }
    if (scenario === 'deleted') s.journal.block(s.ctx.workspaceId, ['k1'], 'fixture-delete');
    if (scenario === 'disabled') await s.setAI(false);
    expect(await s.send(approval)).toMatchObject({ ok: false }); expect(s.complete).not.toHaveBeenCalled();
  });

  it.each(['answer_quote', 'source_quote', 'source_id', 'criterion_id', 'missing_criterion', 'duplicate_criterion', 'attempt_version', 'rubric', 'extra_grade', 'string'])('rejects invalid model output: %s', async (scenario) => {
    const s = await setup(); const approval = await s.approve();
    const value = structuredClone(s.value);
    if (scenario === 'answer_quote') value.criteria[0]!.answerQuote = 'INVENTED PRIVATE OUTPUT';
    if (scenario === 'source_quote') value.criteria[0]!.sourceQuotes[0]!.quote = 'INVENTED PRIVATE OUTPUT';
    if (scenario === 'source_id') value.criteria[0]!.sourceQuotes[0]!.sourceId = 'k1';
    if (scenario === 'criterion_id') value.criteria[0]!.criterionId = 'other';
    if (scenario === 'missing_criterion') value.criteria = [];
    if (scenario === 'duplicate_criterion') value.criteria.push(structuredClone(value.criteria[0]!));
    if (scenario === 'attempt_version') value.attemptVersion += 1;
    if (scenario === 'rubric') value.rubricVersion = 'other';
    const output = scenario === 'extra_grade' ? { ...value, mastery: 100 } : scenario === 'string' ? JSON.stringify(value) : value;
    s.complete.mockResolvedValue(success({ value: output, modelId: 'fixture-review', generatedAt: new Date().toISOString() }));
    const result = await s.send(approval);
    expect(result).toMatchObject({ ok: false, error: { code: 'UPSTREAM', retryable: false, dataState: 'preserved' } });
    expect(JSON.stringify(result)).not.toContain('INVENTED PRIVATE OUTPUT'); expect(s.complete).toHaveBeenCalledTimes(1); expect(s.evidence).not.toHaveBeenCalled();
  });

  it.each(['attempt', 'deleted', 'disabled', 'revoked'])('discards in-flight output when %s changes', async (scenario) => {
    const s = await setup(); const approval = await s.approve();
    s.complete.mockImplementation(async () => {
      if (scenario === 'attempt') { s.attempt.phase = 'cancelled'; s.attempt.version += 1; }
      if (scenario === 'deleted') s.journal.block(s.ctx.workspaceId, ['k1'], 'fixture-delete');
      if (scenario === 'disabled') await s.setAI(false);
      if (scenario === 'revoked') s.authority.revoke(s.ctx, approval.id);
      return success({ value: s.value, modelId: 'fixture-review', generatedAt: new Date().toISOString() });
    });
    const result = await s.send(approval); expect(result).toMatchObject({ ok: false, error: { dataState: 'preserved', retryable: false } });
    expect(JSON.stringify(result)).not.toContain('sourceQuotes'); expect(s.complete).toHaveBeenCalledTimes(1); expect(s.evidence).not.toHaveBeenCalled();
  });

  it('retains unknown model status without automatic approval, retry or evidence writes', async () => {
    const s = await setup(); const approval = await s.approve();
    s.complete.mockRejectedValue(new Error('PRIVATE transport failure'));
    const result = await s.send(approval);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', retryable: false, dataState: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await s.send(approval)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(s.complete).toHaveBeenCalledTimes(1); expect(s.approvePort).toHaveBeenCalledTimes(1); expect(s.evidence).not.toHaveBeenCalled();
  });

  it('reads only the original model metadata; null or unknown never permits retry', async () => {
    const s = await setup(); const approval = await s.approve();
    const operationId = s.approvalOperationId!;
    expect(await inspectReviewModelOperation(approval, s.services, s.ctx, operationId)).toMatchObject({ ok: true, data: {
      state: 'unknown', receipt: null, recovery: { kind: 'model', operationId, readOnly: true },
      scope: 'operation_metadata_only', reviewResult: 'not_recovered', retryAllowed: false,
    } });
    s.complete.mockRejectedValue(new Error('Synthetic unknown send')); await s.send(approval);
    expect(await inspectReviewModelOperation(approval, s.services, s.ctx, operationId)).toMatchObject({ ok: true, data: {
      state: 'unknown', receipt: null, recovery: { kind: 'model', operationId, stage: 'unknown' }, retryAllowed: false,
    } });
    expect(s.complete).toHaveBeenCalledTimes(1); expect(s.approvePort).toHaveBeenCalledTimes(1); expect(s.evidence).not.toHaveBeenCalled();
  });

  it('uses the 1.22 review recovery endpoint and never reads a private model receipt', async () => {
    const s = await setup(); const approval = await s.approve();
    const operationId = s.approvalOperationId!;
    const recovery: OperationRecovery = {
      kind: 'model', operationId, actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId,
      approvalId: approval.id, recordId: null, purpose: 'review', requestHash: 'b'.repeat(64),
      contentHash: approval.contentHash, baseRevision: approval.baseRevision, objectIds: ['k1'],
      approvalExpiresAt: approval.expiresAt, stage: 'done', readOnly: true, absenceIsFinal: false,
    };
    const readRecovery = vi.fn(async () => success(recovery));
    const readLegacy = vi.fn(async () => { throw new Error('private model receipt must not be read'); });
    const services: Services = { ...s.services, readOperationRecovery: readRecovery, readModelOperation: readLegacy };
    const result = await inspectReviewModelOperation(approval, services, s.ctx, operationId);
    expect(result).toMatchObject({ ok: true, data: {
      state: 'done', receipt: null, recovery: { kind: 'model', operationId, stage: 'done', readOnly: true },
      scope: 'operation_metadata_only', reviewResult: 'not_recovered', retryAllowed: false,
    } });
    expect(readRecovery).toHaveBeenCalledWith(s.ctx, { kind: 'model', operationId, modelPurpose: 'review' });
    expect(readLegacy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private model receipt');
  });

  it('can inspect a completed send after approval revocation, AI shutdown and knowledge deletion without recovering private output', async () => {
    const s = await setup(); const approval = await s.approve(); expect((await s.send(approval)).ok).toBe(true);
    const operationId = s.approvalOperationId!;
    s.authority.revoke(s.ctx, approval.id); await s.setAI(false); s.journal.block(s.ctx.workspaceId, ['k1'], 'fixture-delete');
    const settings = vi.spyOn(s.services, 'settings'); const snapshot = vi.spyOn(s.services, 'snapshot');
    const result = await inspectReviewModelOperation(approval, s.services, s.ctx, operationId);
    expect(result).toMatchObject({ ok: true, data: { state: 'done', receipt: null, recovery: { kind: 'model', operationId, stage: 'done' },
      reviewResult: 'not_recovered', retryAllowed: false,
    } });
    expect(JSON.stringify(result)).not.toContain(s.attempt.submission!.answer);
    expect(JSON.stringify(result)).not.toContain('criteria'); expect(s.complete).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled(); expect(s.evidence).not.toHaveBeenCalled();
  });

  it.each(['approval', 'hash', 'purpose', 'workspace', 'scope', 'private_output'])('rejects mismatched operation read-back: %s', async (scenario) => {
    const s = await setup(); const approval = await s.approve(); await s.send(approval);
    const operationId = s.approvalOperationId!;
    const existing = await s.services.readOperationRecovery!(s.ctx, { kind: 'model', operationId, modelPurpose: 'review' });
    if (!existing.ok) throw new Error('Expected metadata');
    const recovery = { ...existing.data } as OperationRecovery & { output?: string };
    if (scenario === 'approval') recovery.approvalId = 'another-approval';
    if (scenario === 'hash') recovery.contentHash = 'c'.repeat(64);
    if (scenario === 'purpose') recovery.purpose = 'answer';
    if (scenario === 'workspace') recovery.workspaceId = 'another-workspace';
    if (scenario === 'scope') recovery.objectIds = ['another-node'];
    if (scenario === 'private_output') recovery.output = 'PRIVATE response body';
    const services: Services = { ...s.services, readOperationRecovery: async () => success(recovery) };
    const result = await inspectReviewModelOperation(approval, services, s.ctx, operationId);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', retryable: false } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(s.complete).toHaveBeenCalledTimes(1);
  });

  it('does not invent a read-back when the port is missing or identity is unauthorized', async () => {
    const s = await setup(); const approval = await s.approve();
    const operationId = s.approvalOperationId!;
    expect(await inspectReviewModelOperation(approval, { ...s.services, readOperationRecovery: undefined }, s.ctx, operationId)).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED', dataState: 'unknown' } });
    const read = vi.spyOn(s.services, 'readOperationRecovery');
    expect(await inspectReviewModelOperation(approval, s.services, { ...s.ctx, actorId: 'another' }, operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await inspectReviewModelOperation(approval, s.services, { ...s.ctx, scopes: ['workspace:read'] }, operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(read).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });
});
