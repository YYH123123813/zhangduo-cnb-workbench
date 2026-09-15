import { describe, expect, it } from 'vitest';
import type { DraftReceipt, DraftSaveOptions, DraftState } from '../../contracts/handoff';
import { contentHash } from '../../contracts/hash';
import { hasItemEdits } from './client-state';
import { createReview, writeStatement } from './model';
import { progressFingerprint, restoreProgressState, toProgress, validateProgress, verifyProgressReceipt, verifyProgressState } from './progress';
import { candidate, conversation } from './testing/fixtures';
import { context } from './testing/services';
import { snapshot } from './testing/knowledge';

export async function progressFixture() {
  const created = createReview(conversation, [candidate(), candidate('candidate-2'), candidate('candidate-3')]);
  if (!created.ok) throw Error('fixture');
  const review = created.data; review.actorId = context.actorId;
  const item = review.items[0]!;
  const result = toProgress(review, item, snapshot.revision);
  if (!result.ok) throw Error('fixture');
  const progress = result.data;
  const options: DraftSaveOptions = { operationId: 'progress-operation-1', source: { kind: 'candidate', candidateId: item.subject.id },
    expectedConversationHash: conversation.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  const document = { kind: 'progress' as const, value: progress };
  const hash = await contentHash({ document, source: options.source });
  const receipt: DraftReceipt = { operationId: options.operationId, draftId: item.draftId, actorId: context.actorId, workspaceId: context.workspaceId,
    kind: 'progress', contentHash: hash, conversationHash: conversation.contentHash, previousRevision: 0, revision: 1,
    expiresAt: '2026-10-05T00:00:00Z', outcome: 'saved' };
  const state: DraftState = { id: item.draftId, state: 'available', revision: 1, contentHash: hash,
    conversationHash: conversation.contentHash, document, source: options.source, expiresAt: receipt.expiresAt, retentionDays: 30 };
  return { review, item, progress, options, state, receipt, pending: { progress, options } };
}

describe('H07 partial progress and exact saved checkpoints', () => {
  it('saves an untouched blank review without treating it as a formal draft', async () => {
    const { progress, review, options } = await progressFixture();
    expect(progress).toMatchObject({ statement: '', disposition: null, relations: [], authorship: 'human_written' });
    expect(validateProgress(progress, options, review, context)).toEqual({ ok: true, data: progress });
  });
  it('round-trips partial decisions and unfinished relation fields without touching the other two items', async () => {
    const { review, item, options, state } = await progressFixture();
    item.disposition = 'later'; item.relationInput.rationale = '  尚未完成的关系理由\n';
    item.conditions[0]!.text = '条件尚待确认'; item.sources[0]!.limitation = '尚未核验的范围';
    const partial = toProgress(review, item, snapshot.revision); if (!partial.ok) throw Error('fixture');
    state.document = { kind: 'progress', value: partial.data };
    state.contentHash = await contentHash({ document: state.document, source: options.source });
    const before = structuredClone(review.items.slice(1));
    const restored = await restoreProgressState(review, state);
    expect(restored.ok).toBe(true); if (!restored.ok) return;
    expect(restored.data.items[0]).toMatchObject({ disposition: 'later', statement: '', relationInput: item.relationInput });
    expect(restored.data.items.slice(1)).toEqual(before);
    expect(hasItemEdits(restored.data.items[0]!)).toBe(false);
    const edited = writeStatement(restored.data.items[0]!, '只修改第一项');
    expect(hasItemEdits(edited)).toBe(true);
    expect(progressFingerprint(restored.data.items[1]!)).toBe(progressFingerprint(review.items[1]!));
  });
  it('distinguishes authoritative missing and expired states from permission failures', async () => {
    const { review, item } = await progressFixture();
    const missing: DraftState = { id: item.draftId, state: 'missing', revision: 0, contentHash: null, conversationHash: null,
      source: null, document: null, retentionDays: 30 };
    const restored = await restoreProgressState(review, missing);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.data.items[0]?.draftVersion).toMatchObject({ revision: 0, contentHash: null, state: 'missing' });
    expect(await restoreProgressState(review, { ...missing, id: 'foreign' })).toMatchObject({ ok: false });
    expect(await restoreProgressState(review, null)).toMatchObject({ ok: false });
  });
  it('rejects forged sources, cross-item identity, stale statements and source hashes without replacing local edits', async () => {
    const { review, progress, options, state } = await progressFixture();
    for (const input of [{ ...progress, workspaceId: 'other' }, { ...progress, nodeId: 'other' },
      { ...progress, sources: [{ ...progress.sources[0]!, excerpt: '伪造原句' }] },
      { ...progress, sources: [{ ...progress.sources[0]!, support: 'supports', supportedClaim: '旧主张' }] }]) {
      expect(validateProgress(input, options, review, context)).toMatchObject({ ok: false });
    }
    const before = structuredClone(review);
    expect(await restoreProgressState(review, { ...state, conversationHash: 'wrong' })).toMatchObject({ ok: false });
    expect(await restoreProgressState(review, { ...state, contentHash: 'wrong' })).toMatchObject({ ok: false });
    expect(review).toEqual(before);
  });
  it('does not resolve an unknown save from an older or a later document with the same draft ID', async () => {
    const { pending, state } = await progressFixture();
    expect((await verifyProgressState(pending, state)).ok).toBe(true);
    expect(await verifyProgressState(pending, { ...state, revision: 2 })).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    expect(await verifyProgressState(pending, { ...state, document: { kind: 'progress', value: { ...pending.progress, statement: '另一会话的内容' } } }))
      .toMatchObject({ ok: false, error: { dataState: 'unknown' } });
  });
  it('uses original operation, identity, source hash, payload hash and CAS revision to recover a lost save', async () => {
    const { pending, receipt } = await progressFixture();
    expect(await verifyProgressReceipt(pending, receipt, context)).toEqual({ ok: true, data: receipt });
    for (const input of [null, { ...receipt, operationId: 'another-operation' }, { ...receipt, actorId: 'other' },
      { ...receipt, contentHash: 'different' }, { ...receipt, conversationHash: 'old' }, { ...receipt, previousRevision: 1, revision: 2 }]) {
      expect(await verifyProgressReceipt(pending, input, context)).toMatchObject({ ok: false, error: { dataState: 'unknown', nextAction: 'read_back' } });
    }
  });
});
