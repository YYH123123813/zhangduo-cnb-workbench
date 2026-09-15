import { describe, expect, it, vi } from 'vitest';
import type { DraftReceipt, DraftSaveOptions, DraftState } from '../../contracts/handoff';
import type { Services } from '../../contracts/ports';
import { contentHash } from '../../contracts/hash';
import type { Review } from './model';
import { toProgress } from './progress';
import { appFor } from './testing/app';
import { fixtureServices, context } from './testing/services';
import { snapshot } from './testing/knowledge';

async function setup() {
  const services = fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot }) });
  const app = appFor(services);
  const review = (await (await app.request('/api/handoff/conversation-1')).json()).data as Review;
  const result = toProgress(review, review.items[0]!, snapshot.revision); if (!result.ok) throw Error('fixture');
  const progress = result.data;
  const options: DraftSaveOptions = { operationId: 'save-partial-1', expectedConversationHash: review.conversation.contentHash,
    source: { kind: 'candidate', candidateId: 'candidate-1' }, expectedRevision: 0, expectedContentHash: null, confirmed: true, retentionDays: 30 };
  const document = { kind: 'progress' as const, value: progress };
  const hash = await contentHash({ document, source: options.source });
  const receipt: DraftReceipt = { operationId: options.operationId, draftId: progress.id, actorId: context.actorId, workspaceId: context.workspaceId,
    kind: 'progress', contentHash: hash, conversationHash: options.expectedConversationHash, previousRevision: 0, revision: 1,
    expiresAt: '2026-10-05T00:00:00Z', outcome: 'saved' };
  const state: DraftState = { id: progress.id, revision: 1, state: 'available', contentHash: hash, conversationHash: options.expectedConversationHash,
    source: options.source, document, retentionDays: 30, expiresAt: receipt.expiresAt };
  services.saveReviewProgress = vi.fn<NonNullable<Services['saveReviewProgress']>>(async () => ({ ok: true, data: structuredClone(state) }));
  services.readDraftState = vi.fn<NonNullable<Services['readDraftState']>>(async () => ({ ok: true, data: structuredClone(state) }));
  services.readDraftReceipt = vi.fn<NonNullable<Services['readDraftReceipt']>>(async () => ({ ok: true, data: structuredClone(receipt) }));
  const save = (body: unknown = { progress, options }) => app.request('/api/handoff/conversation-1/progress', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { services, app, save, progress, options, state, receipt };
}

describe('H07 shared progress HTTP adapter', () => {
  it('passes the exact trusted context, source consent and CAS conditions then verifies both state and original receipt', async () => {
    const s = await setup(); const response = await s.save();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ state: s.state, receipt: s.receipt });
    expect(s.services.saveReviewProgress).toHaveBeenCalledWith(context, s.progress, s.options);
    expect(vi.mocked(s.services.saveReviewProgress!).mock.calls[0]?.[0]).toBe(context);
    expect(s.services.readDraftState).toHaveBeenCalledWith(context, s.progress.id);
    expect(s.services.readDraftReceipt).toHaveBeenCalledWith(context, s.options.operationId);
    expect(s.services.commit).not.toHaveBeenCalled(); expect(s.services.complete).not.toHaveBeenCalled();
  });
  it('refuses missing consent/options, foreign scope, forged sources and stale base before any persistence', async () => {
    const s = await setup();
    for (const body of [{ progress: s.progress }, { progress: s.progress, options: { ...s.options, confirmed: false } },
      { progress: s.progress, options: { ...s.options, retentionDays: 7 } },
      { progress: { ...s.progress, baseRevision: 'fixture-old' }, options: s.options },
      { progress: { ...s.progress, sources: [{ ...s.progress.sources[0]!, excerpt: '伪造来源' }] }, options: s.options },
      { progress: s.progress, options: { ...s.options, expectedConversationHash: 'changed' } }]) expect((await s.save(body)).status).not.toBe(200);
    expect(s.services.saveReviewProgress).not.toHaveBeenCalled();
  });
  it('does not treat a forbidden state or unavailable persistence as an empty draft', async () => {
    const s = await setup();
    s.services.readDraftState = async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'denied', retryable: false, dataState: 'preserved', nextAction: 'request_access' } });
    expect((await s.app.request(`/api/handoff/conversation-1/draft-state?draftId=${s.progress.id}`)).status).toBe(403);
    delete s.services.saveReviewProgress;
    expect((await s.save()).status).toBe(503);
  });
  it('keeps a conflicting save preserved and a mismatching or missing receipt unknown without retrying', async () => {
    const s = await setup();
    s.services.readDraftReceipt = async () => ({ ok: true, data: null });
    expect((await (await s.save()).json()).error).toMatchObject({ dataState: 'unknown', nextAction: 'read_back' });
    expect(s.services.saveReviewProgress).toHaveBeenCalledTimes(1);
    s.services.saveReviewProgress = vi.fn<NonNullable<Services['saveReviewProgress']>>(async () => ({ ok: false, error: { code: 'CONFLICT', message: 'CAS lost', retryable: false, dataState: 'preserved', nextAction: 'read_draft_state' } }));
    expect((await (await s.save()).json()).error).toMatchObject({ code: 'CONFLICT', dataState: 'preserved' });
    expect(s.services.saveReviewProgress).toHaveBeenCalledTimes(1);
  });
  it('reads the original receipt with no writes and refuses another candidate or actor receipt', async () => {
    const s = await setup();
    const url = `/api/handoff/conversation-1/draft-receipt?draftId=${s.progress.id}&operationId=${s.options.operationId}`;
    expect((await (await s.app.request(url)).json()).data).toEqual(s.receipt);
    s.services.readDraftReceipt = async () => ({ ok: true, data: { ...s.receipt, actorId: 'another' } });
    expect((await s.app.request(url)).status).not.toBe(200);
    expect(s.services.saveReviewProgress).not.toHaveBeenCalled(); expect(s.services.commit).not.toHaveBeenCalled();
  });
});
