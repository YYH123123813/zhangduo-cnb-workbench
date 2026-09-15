import { describe, expect, it, vi } from 'vitest';
import { appFor } from './testing/app';
import { fixtureServices, context } from './testing/services';
import { conversation } from './testing/fixtures';
import { snapshot } from './testing/knowledge';
import type { Review } from './model';
import { acceptAI, writeStatement } from './model';
import { toDraft } from './draft';
import { toProgress, restoreProgressState } from './progress';
import { withManualSource } from './manual';
import type { DraftState } from '../../contracts/handoff';
import { contentHash } from '../../contracts/hash';

describe('H01 manual source without a fake AI candidate', () => {
  it('starts a blank independent review from selected authorized segments with AI and candidate ports unused', async () => {
    const services = fixtureServices();
    const response = await appFor(services).request('/api/handoff/conversation-1/manual', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIds: ['segment-1'], expectedConversationHash: conversation.contentHash, confirmed: true }) });
    expect(response.status).toBe(200); const review = (await response.json()).data as Review;
    const item = review.items[0]!;
    expect(item).toMatchObject({ subject: { origin: 'manual', title: '', question: '' }, statement: '', authorship: 'human_written', disposition: null });
    expect(item.subject).not.toHaveProperty('modelId'); expect(item.subject).not.toHaveProperty('generatedAt');
    expect(item.subject).not.toHaveProperty('claim'); expect(acceptAI(item)).toBe(item);
    expect(services.readCandidates).not.toHaveBeenCalled(); expect(services.complete).not.toHaveBeenCalled(); expect(services.saveDraft).not.toHaveBeenCalled();
  });
  it('rejects cancellation, stale source hashes, unknown segments and foreign actors without storing anything', async () => {
    const services = fixtureServices(); const app = appFor(services);
    for (const input of [{ segmentIds: [], confirmed: true }, { segmentIds: ['segment-1'], confirmed: false },
      { segmentIds: ['foreign'], confirmed: true }, { segmentIds: ['segment-1'], confirmed: true, expectedConversationHash: 'old' }]) {
      const response = await app.request('/api/handoff/conversation-1/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedConversationHash: conversation.contentHash, ...input }) });
      expect(response.status).not.toBe(200);
    }
    expect(services.saveDraft).not.toHaveBeenCalled(); expect(services.commit).not.toHaveBeenCalled();
  });
  it('restores a manual progress source and derives formal null candidate provenance, with independent review IDs', async () => {
    const services = fixtureServices(); const app = appFor(services);
    async function start() { return (await (await app.request('/api/handoff/conversation-1/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segmentIds: ['segment-1'], expectedConversationHash: conversation.contentHash, confirmed: true }) })).json()).data as Review; }
    const review = await start(), second = await start();
    expect(review.items[0]!.draftId).not.toBe(second.items[0]!.draftId);
    let item = review.items[0]!;
    item = writeStatement({ ...item, disposition: 'handoff', subject: { ...item.subject, title: '人的标题', question: '人的问题' } }, conversation.segments[0]!.text);
    expect(item.authorship).toBe('human_written');
    const progress = toProgress(review, item, snapshot.revision); if (!progress.ok) throw Error('fixture');
    const source = { kind: 'manual' as const, spans: item.subject.spans }, document = { kind: 'progress' as const, value: progress.data };
    const state: DraftState = { id: item.draftId, state: 'available', revision: 1, contentHash: await contentHash({ document, source }),
      conversationHash: conversation.contentHash, source, document, retentionDays: 30 };
    const empty: Review = { conversation, items: [], activeId: null, actorId: context.actorId };
    const restored = await restoreProgressState(empty, state); expect(restored.ok).toBe(true); if (!restored.ok) return;
    const draft = toDraft(restored.data, restored.data.items[0]!, snapshot.revision, new Date().toISOString());
    expect(draft).toMatchObject({ ok: true, data: { candidateId: null, node: { candidateIds: [], authorship: 'human_written', humanStatement: item.statement } } });
    expect((await withManualSource(empty, { ...source, spans: [{ ...source.spans[0]!, quote: '伪造原句' }] }, progress.data)).ok).toBe(false);
  });
  it('does not turn an empty manual source selection into valid provenance when saving or restoring', async () => {
    const empty: Review = { conversation, items: [], activeId: null, actorId: context.actorId };
    const fields = { id: `handoff-manual-${crypto.randomUUID()}`, title: '', question: '', kind: 'claim' as const };
    expect(await withManualSource(empty, { kind: 'manual', spans: [] }, fields))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION', dataState: 'preserved' } });
  });
});
