import { afterEach, describe, expect, it } from 'vitest';
import type { Result } from '../../contracts/api';
import type { DraftSaveOptions } from '../../contracts/handoff';
import { contentHash } from '../../contracts/hash';
import { makeOperationRequest, verifyOperationEnvelope } from './operation';
import { sourceFor } from './model';
import { restoreProgressState, toProgress } from './progress';
import { handoffPlatformFixture, platformPreview } from './testing/platform';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));
function data<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
async function setup(kind: 'draft' | 'progress' = 'draft') {
  const f = await handoffPlatformFixture(); cleanup.push(() => f.journal.close());
  const p = await platformPreview(f);
  const options: DraftSaveOptions = { operationId: 'envelope-draft', source: sourceFor(p.item), expectedConversationHash: f.source.contentHash,
    expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  if (kind === 'draft') data(await f.services.saveDraft(f.ctx, p.draft, options));
  else data(await f.services.saveReviewProgress!(f.ctx, data(toProgress(p.review, p.item, f.base)), options));
  const saved = data(await f.services.readDraftState!(f.ctx, p.draft.id));
  const review = data(await restoreProgressState(p.review, saved)), item = review.items[0]!;
  const request = data(makeOperationRequest(p.preview, review, item, true));
  const state = data(await f.services.saveHandoffOperation!(f.ctx, request));
  const receipt = data(await f.services.readHandoffOperationReceipt!(f.ctx, request.changes.id));
  const verify = (body: unknown = state, proof: unknown = receipt, identity = f.ctx, now = Date.now()) =>
    verifyOperationEnvelope(body, proof, identity, f.source.id, p.preview.changes.id, now);
  return { f, p, review, item, request, state, receipt: receipt!, verify };
}

describe('1.17 original operation envelope consumer with actual shared storage', () => {
  it.each(['draft', 'progress'] as const)('binds a separately consented snapshot to the original saved %s and verifies both platform hashes', async (kind) => {
    const s = await setup(kind);
    expect(s.request).toMatchObject({ changes: s.p.preview.changes, draftRevision: 1, expectedOperationRevision: 0, retentionDays: 30, confirmed: true });
    expect(data(await s.verify())).toMatchObject({ key: { changeSetId: s.request.changes.id, draftRevision: 1,
      draftContentHash: s.request.draftContentHash, contentHash: s.request.changes.contentHash }, snapshot: s.state.snapshot, receipt: s.receipt });
    expect(s.receipt.requestHash).toBe(await contentHash(s.request));
    expect(s.receipt.contentHash).toBe(await contentHash(s.state.snapshot));
    expect(s.state.snapshot!.savedDraft.document!.kind).toBe(kind);
    const restored = await s.f.request(`/operation?changeSetId=${s.request.changes.id}`);
    expect(restored.result).toMatchObject({ ok: true, data: { recovery: { preview: { draft: s.p.draft, changes: s.p.preview.changes }, canSubmit: false } } });
    expect(s.f.git.publish).not.toHaveBeenCalled();
    expect(data(await s.f.services.readKnowledgeApproval!(s.f.ctx, s.request.changes.id)).status).toBe('not_registered');
  });
  it('does not prepare a save without explicit consent, a matching saved version or unchanged local review', async () => {
    const s = await setup();
    expect(makeOperationRequest(s.p.preview, s.review, s.item, false).ok).toBe(false);
    expect(makeOperationRequest(s.p.preview, s.review, { ...s.item, draftVersion: undefined }, true).ok).toBe(false);
    expect(makeOperationRequest(s.p.preview, s.review, { ...s.item, statement: 'Unsaved B' }, true).ok).toBe(false);
  });
  it('rejects missing/expired content, a missing receipt and cross-identity envelopes', async () => {
    const s = await setup();
    for (const state of [{ ...s.state, state: 'missing', revision: 0, snapshot: null, contentHash: null, requestHash: null },
      { ...s.state, state: 'expired', snapshot: null }, { ...s.state, expiresAt: new Date(Date.now() - 1).toISOString() },
      { ...s.state, actorId: 'other' }, { ...s.state, workspaceId: 'other' }]) {
      expect((await s.verify(state)).ok).toBe(false);
    }
    expect((await s.verify(s.state, null)).ok).toBe(false);
    expect((await s.verify(s.state, s.receipt, { ...s.f.ctx, actorId: 'other' })).ok).toBe(false);
    expect((await s.verify(s.state, s.receipt, { ...s.f.ctx, mode: 'unconfigured' })).ok).toBe(false);
  });
  it('rejects receipt or snapshot substitution including a correctly rehashed replacement B', async () => {
    const s = await setup();
    for (const changed of [{ draftRevision: 2 }, { draftContentHash: 'b'.repeat(64) }, { changeSetHash: 'b'.repeat(64) },
      { requestHash: 'b'.repeat(64) }, { baseRevision: 'b'.repeat(40) }, { conversationId: 'other' }, { operationId: 'other' }]) {
      expect((await s.verify(s.state, { ...s.receipt, ...changed })).ok).toBe(false);
    }
    const snapshot = structuredClone(s.state.snapshot!); snapshot.draft.node.humanStatement = 'Replacement B';
    expect((await s.verify({ ...s.state, snapshot, contentHash: await contentHash(snapshot) })).ok).toBe(false);
    expect((await s.verify({ ...s.state, expiresAt: new Date(Date.parse(s.receipt.expiresAt) + 1).toISOString() })).ok).toBe(false);
  });
});
