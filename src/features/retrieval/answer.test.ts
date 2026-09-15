import { describe, expect, it, vi } from 'vitest';
import { prepareAnswerInput, generateAnswer } from './answer';
import { validateAnswer } from './citations';
import { runQuery } from './query';
import { hashModelInput } from '../../contracts/hash';
import type { Approval, RetrievalResult } from '../../contracts/domain';
import { context, fixtureServices, request, snapshot, node } from './test-support';

export const answerContext = { ...context, scopes: [...context.scopes, 'model:answer', 'settings:read'] };
export const answerRequest = { ...request, task: { ...request.task, mode: 'assisted' as const } };
export async function directResult(): Promise<RetrievalResult> {
  const result = await runQuery(context, answerRequest, fixtureServices());
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}
export async function approvalFor(result: RetrievalResult): Promise<Approval> {
  const input = prepareAnswerInput(answerRequest, result);
  if (!input.ok) throw new Error(input.error.code);
  return { id: 'fixture-approved', actorId: 'u1', workspaceId: 'w1', purpose: 'model_input',
    objectIds: result.groups.eligible.map((n) => n.id).sort(), contentHash: await hashModelInput(input.data),
    baseRevision: result.snapshotRevision, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
}
const settings = async () => ({ ok: true as const, data: { aiExtraction: false, aiAnswer: true, aiReview: false, saveQueryHistory: false, reviewReminders: false } });
export function answerServices(overrides: Parameters<typeof fixtureServices>[0] = {}) { return fixtureServices({ settings, ...overrides }); }

describe('R09 source-grounded model boundary', () => {
  it('prepares only qualified originals and allowed source IDs, with no private conversation or vector text', async () => {
    const result = await directResult();
    const input = prepareAnswerInput(answerRequest, result);
    expect(input.ok).toBe(true); if (!input.ok) return;
    expect(input.data.sourceIds).toEqual(['s-n1']);
    expect(input.data.text).toContain('Cache immutable data.');
    expect(input.data.text).not.toContain('conversation-1');
    expect(input.data.text).not.toContain('candidateIds');
    expect(input.data.text).toContain('untrusted');
  });
  it('never sends independent mode, a rejected/missing approval, or a disabled AI setting', async () => {
    const direct = await directResult(); const services = answerServices();
    await generateAnswer(answerContext, request, direct, undefined, services);
    expect((await generateAnswer(answerContext, answerRequest, direct, undefined, services)).ok).toBe(false);
    const disabled = answerServices({ settings: async () => ({ ok: true, data: { ...(await settings()).data, aiAnswer: false } }) });
    const result = await generateAnswer(answerContext, answerRequest, direct, await approvalFor(direct), disabled);
    expect(result.ok && result.data.answer).toBeNull();
    expect(disabled.complete).not.toHaveBeenCalled(); expect(services.complete).not.toHaveBeenCalled();
  });
  it('leaves the existing direct results unchanged and reports unknown model transmission', async () => {
    const direct = await directResult(); const complete = vi.fn(async () => { throw new Error('private-model-request'); });
    const result = await generateAnswer(answerContext, answerRequest, direct, await approvalFor(direct), answerServices({ complete }));
    expect(complete).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false); if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'UNKNOWN_RESULT', dataState: 'unknown', retryable: false });
    expect(direct.groups.eligible.map((n) => n.id)).toEqual(['n1']); expect(direct.answer).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-model-request');
  });
  it('checks scope, exact content, expiry and pinned revision before completing', async () => {
    const direct = await directResult(); const approval = await approvalFor(direct); const services = answerServices();
    for (const patch of [{ contentHash: 'forged' }, { actorId: 'other' }, { baseRevision: 'fixture-old' }, { objectIds: ['n1', 'private'] }, { expiresAt: '2000-01-01T00:00:00Z' }]) {
      expect((await generateAnswer(answerContext, answerRequest, direct, { ...approval, ...patch }, services)).ok).toBe(false);
    }
    expect((await generateAnswer(context, answerRequest, direct, approval, services)).ok).toBe(false);
    expect(services.complete).not.toHaveBeenCalled();
  });
  it('does not claim an in-flight model request was never sent after cancellation', async () => {
    const direct = await directResult(); const controller = new AbortController();
    const complete = vi.fn(async () => { controller.abort(); throw new Error('Request may have reached provider'); });
    const result = await generateAnswer(answerContext, answerRequest, direct, await approvalFor(direct), answerServices({ complete }), controller.signal);
    expect(complete).toHaveBeenCalledOnce(); expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('可能已发送');
    expect(result.error.message).not.toContain('未保存查询或发送模型');
    expect(JSON.stringify(result)).not.toContain('Cache immutable data.');
  });
  it('revalidates fallback originals when the model fails during a new deletion block', async () => {
    const direct = await directResult(); let reads = 0;
    const services = answerServices({ snapshot: async () => ({ ok: true,
      data: snapshot([node()], { excludedIds: ++reads === 1 ? [] : ['n1'] }),
    }), complete: async () => { throw new Error('provider unavailable'); } });
    const result = await generateAnswer(answerContext, answerRequest, direct, await approvalFor(direct), services);
    expect(result.ok).toBe(false); expect(!result.ok && result.error.code).toBe('CONFLICT');
    expect(JSON.stringify(result)).not.toContain('Cache immutable data.');
    expect(reads).toBe(2);
  });
});

describe('R10 exact citation validation', () => {
  const claim = { nodeRef: { workspaceId: 'w1', objectId: 'n1', revision: 'fixture-r1' }, sourceId: 's-n1', quote: 'Cache immutable data.', text: 'Cache immutable data.' };
  it('accepts a verbatim supported statement with a pinned source citation', async () => {
    const direct = await directResult();
    const result = validateAnswer({ claims: [claim] }, direct);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.citations[0]?.nodeRef.revision).toBe('fixture-r1');
    expect(result.data.text).toContain(claim.text);
  });
  it('rejects fabricated versions, workspaces, source IDs, quotes, claims and extra output', async () => {
    const direct = await directResult();
    for (const patch of [{ nodeRef: { ...claim.nodeRef, revision: 'old' } }, { nodeRef: { ...claim.nodeRef, workspaceId: 'other' } },
      { sourceId: 'fabricated' }, { quote: 'Made up quote' }, { quote: ' ' }, { text: 'Uncited new claim' }, { command: 'execute this' }]) {
      expect(validateAnswer({ claims: [{ ...claim, ...patch }] }, direct).ok).toBe(false);
    }
    expect(validateAnswer({ claims: [claim], prose: 'Unsupported general knowledge' }, direct).ok).toBe(false);
    expect(validateAnswer({ claims: [] }, direct).ok).toBe(false);
  });
  it('returns a checked answer only after a fresh snapshot read and discards broken drafts', async () => {
    const direct = await directResult(); const approval = await approvalFor(direct);
    for (const value of [{ claims: [claim] }, { claims: [{ ...claim, quote: 'INVALID_MODEL_QUOTE' }] }]) {
      const result = await generateAnswer(answerContext, answerRequest, direct, approval, answerServices({ complete: async () => ({ ok: true, data: { value, modelId: 'fixture-model', generatedAt: new Date().toISOString() } }) }));
      expect(result.ok).toBe(true); if (!result.ok) return;
      if (value.claims[0]?.quote === claim.quote) expect(result.data.answer?.citations).toHaveLength(1);
      else { expect(result.data.answer).toBeNull(); expect(result.data.missingConditions.join()).toContain('引用'); }
      expect(JSON.stringify(result)).not.toContain('INVALID_MODEL_QUOTE');
    }
  });
  it('discards model output after cancellation or a concurrent revision', async () => {
    const direct = await directResult(); const approval = await approvalFor(direct);
    const controller = new AbortController();
    const cancelled = await generateAnswer(answerContext, answerRequest, direct, approval, answerServices({ complete: async () => {
      controller.abort(); return { ok: true, data: { value: { claims: [claim] }, modelId: 'fixture', generatedAt: new Date().toISOString() } };
    } }), controller.signal);
    expect(cancelled.ok).toBe(false);
    const read = vi.fn<ReturnType<typeof fixtureServices>['snapshot']>()
      .mockResolvedValueOnce({ ok: true, data: snapshot() })
      .mockResolvedValue({ ok: true, data: snapshot([node('n1', { revision: 'fixture-r2' })], { revision: 'fixture-r2' }) });
    const changed = await generateAnswer(answerContext, answerRequest, direct, approval, answerServices({ snapshot: read,
      complete: async () => ({ ok: true, data: { value: { claims: [claim] }, modelId: 'fixture', generatedAt: new Date().toISOString() } }),
    }));
    expect(!changed.ok && changed.error.code).toBe('CONFLICT');
  });
});
