import { afterEach, describe, expect, it } from 'vitest';
import type { DraftSaveOptions } from '../../contracts/handoff';
import type { Result } from '../../contracts/api';
import { makeOperationRequest } from './operation';
import { buildHandoffOperationPin } from './operation-pin';
import { restoreProgressState, toProgress } from './progress';
import { sourceFor } from './model';
import { handoffPlatformFixture, platformPreview } from './testing/platform';

const close: (() => void)[] = [];
afterEach(() => close.splice(0).reverse().forEach((dispose) => dispose()));
function data<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }

async function setup() {
  const fixture = await handoffPlatformFixture(); close.push(() => fixture.journal.close());
  const prepared = await platformPreview(fixture);
  const saveOptions: DraftSaveOptions = { operationId: 'pin-draft-save', source: sourceFor(prepared.item), expectedConversationHash: fixture.source.contentHash,
    expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  data(await fixture.services.saveDraft(fixture.ctx, prepared.draft, saveOptions));
  const savedState = data(await fixture.services.readDraftState!(fixture.ctx, prepared.draft.id));
  const review = data(await restoreProgressState(prepared.review, savedState));
  const item = review.items[0]!;
  const request = data(makeOperationRequest(prepared.preview, review, item, true));
  data(await fixture.services.saveHandoffOperation!(fixture.ctx, request));
  const receipt = data(await fixture.services.readHandoffOperationReceipt!(fixture.ctx, request.changes.id));
  return { fixture, prepared, review, item, request, receipt: receipt! };
}

describe('W3-REQ-009 operation pin consumer binding', () => {
  it('constructs only the five-field pin from the original saved ChangeSet hash', async () => {
    const s = await setup();
    const result = await buildHandoffOperationPin({ review: s.review, item: s.item, preview: s.prepared.preview, request: s.request, receipt: s.receipt });
    expect(result).toEqual({ ok: true, data: {
      conversationId: s.review.conversation.id, draftId: s.prepared.preview.draft.id, changeSetId: s.prepared.preview.changes.id,
      source: 'candidate', operationHash: s.receipt.changeSetHash,
    } });
    if (result.ok) expect(Object.keys(result.data).sort()).toEqual(['changeSetId', 'conversationId', 'draftId', 'operationHash', 'source']);
  });

  it('rejects a substituted B draft or ChangeSet instead of rebuilding A from mutable state', async () => {
    const s = await setup();
    const changed = structuredClone(s.prepared.preview);
    changed.changes.nodes[0]!.humanStatement = 'Statement B';
    expect(await buildHandoffOperationPin({ review: s.review, item: s.item, preview: changed, request: s.request, receipt: s.receipt })).toMatchObject({ ok: false });
    const changedRequest = structuredClone(s.request);
    changedRequest.draft.node.humanStatement = 'Statement B';
    expect(await buildHandoffOperationPin({ review: s.review, item: s.item, preview: s.prepared.preview, request: changedRequest, receipt: s.receipt })).toMatchObject({ ok: false });
  });

  it('rejects conversation, draft, ChangeSet, actor, workspace, source and hash mismatches', async () => {
    const s = await setup();
    const cases = [
      { review: { ...s.review, conversation: { ...s.review.conversation, id: 'conversation-B' } } },
      { item: { ...s.item, draftId: 'draft-B' } },
      { request: { ...s.request, changes: { ...s.request.changes, id: 'change-B' } } },
      { receipt: { ...s.receipt, actorId: 'actor-B' } },
      { receipt: { ...s.receipt, workspaceId: 'workspace-B' } },
      { receipt: { ...s.receipt, conversationHash: 'b'.repeat(64) } },
      { receipt: { ...s.receipt, requestHash: 'b'.repeat(64) } },
      { request: { ...s.request, source: { kind: 'candidate' as const, candidateId: 'candidate-B' } } },
      { receipt: { ...s.receipt, changeSetHash: 'A'.repeat(64) } },
    ];
    for (const altered of cases) expect(await buildHandoffOperationPin({ review: s.review, item: s.item, preview: s.prepared.preview, request: s.request, receipt: s.receipt, ...altered })).toMatchObject({ ok: false });
  });

  it('does not produce a pin for an unknown original save or expose private fields', async () => {
    const s = await setup();
    expect(await buildHandoffOperationPin({ review: s.review, item: s.item, preview: s.prepared.preview, request: null, receipt: null })).toMatchObject({ ok: false });
    const result = await buildHandoffOperationPin({ review: s.review, item: s.item, preview: s.prepared.preview, request: s.request, receipt: s.receipt });
    if (result.ok) {
      const serialized = JSON.stringify(result.data);
      expect(serialized).not.toContain(s.prepared.preview.draft.node.humanStatement);
      expect(serialized).not.toContain('approval');
      expect(serialized).not.toContain('token');
    }
  });
});
