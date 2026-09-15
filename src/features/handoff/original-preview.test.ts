import { describe, expect, it } from 'vitest';
import type { Result } from '../../contracts/api';
import type { DraftState } from '../../contracts/handoff';
import { contentHash, hashChangeSet } from '../../contracts/hash';
import { draftFixture } from './testing/review';
import { context } from './testing/services';
import { snapshot } from './testing/knowledge';
import { time } from './testing/fixtures';
import { buildChangeSet } from './changes';
import { sourceFor } from './model';
import { restoreDraft } from './draft';
import { toProgress } from './progress';
import { verifyOriginalPreview } from './original-preview';
import type { OriginalPreviewKey } from './original-preview';

function data<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
async function originalFixture() {
  const { draft, review } = draftFixture();
  const changes = data(await buildChangeSet(draft, review, snapshot, context, 'original-operation-A', 'Original reason A', time));
  const source = sourceFor(review.items[0]!);
  const document = { kind: 'draft' as const, value: draft };
  const savedDraft: DraftState = { id: draft.id, state: 'available', revision: 1, contentHash: await contentHash({ document, source }),
    conversationHash: review.conversation.contentHash, document, source, retentionDays: 30,
    expiresAt: new Date(Date.parse(time) + 30 * 86_400_000).toISOString() };
  const key: OriginalPreviewKey = { actorId: context.actorId, workspaceId: context.workspaceId, conversationId: review.conversation.id,
    changeSetId: changes.id, contentHash: changes.contentHash, baseRevision: changes.baseRevision,
    draftId: draft.id, draftRevision: savedDraft.revision, draftContentHash: savedDraft.contentHash! };
  return { key, input: { draft, changes, source, savedDraft }, review, now: Date.parse(time) + 1000 };
}

describe('W3-REQ-008 original preview validation only; no unpublished storage contract', () => {
  it('restores A after the same draft advances to B and never claims B using approval A', async () => {
    const f = await originalFixture();
    const original = structuredClone(f.input);
    const latest = structuredClone(f.input.savedDraft);
    if (latest.document?.kind !== 'draft') throw Error('fixture');
    latest.revision = 2;
    latest.document.value.node.humanStatement = 'A later statement B';
    latest.contentHash = await contentHash({ document: latest.document, source: latest.source });
    expect(await verifyOriginalPreview(f.key, { ...f.input, savedDraft: latest }, f.review, snapshot, context, f.now))
      .toMatchObject({ ok: false, error: { dataState: 'preserved' } });
    const restored = data(await verifyOriginalPreview(f.key, original, f.review, snapshot, context, f.now));
    expect(restored.draft).toEqual(original.draft);
    expect(restored.changes).toEqual(original.changes);
    expect(restored.changes.reason).toBe('Original reason A');
    expect(restored.changes.nodes[0]!.confirmedAt).toBe(time);
    expect(JSON.stringify(restored)).not.toContain('A later statement B');
    original.draft.node.humanStatement = 'Mutation after the read';
    expect(restored.draft.node.humanStatement).not.toBe(original.draft.node.humanStatement);
  });

  it('rejects a new reason or confirmation time even when the altered ChangeSet has its own valid hash', async () => {
    const f = await originalFixture();
    for (const field of ['reason', 'time'] as const) {
      const changed = structuredClone(f.input);
      if (field === 'reason') changed.changes.reason = 'Replacement reason B';
      else changed.changes.nodes[0]!.confirmedAt = new Date(f.now).toISOString();
      changed.changes.contentHash = await hashChangeSet(changed.changes);
      expect((await verifyOriginalPreview(f.key, changed, f.review, snapshot, context, f.now)).ok).toBe(false);
    }
  });

  it('checks the original draft version/hash and source, not just a matching operation ID', async () => {
    const f = await originalFixture();
    const inputs = [
      { ...f.input, draft: { ...f.input.draft, node: { ...f.input.draft.node, title: 'Changed title' } } },
      { ...f.input, savedDraft: { ...f.input.savedDraft, contentHash: 'wrong' } },
      { ...f.input, savedDraft: { ...f.input.savedDraft, revision: 2 } },
      { ...f.input, source: { kind: 'candidate', candidateId: 'another-candidate' } },
      { ...f.input, changes: { ...f.input.changes, id: 'different-operation' } },
    ];
    for (const input of inputs) expect((await verifyOriginalPreview(f.key, input, f.review, snapshot, context, f.now)).ok).toBe(false);
    expect((await verifyOriginalPreview({ ...f.key, draftRevision: 2 }, f.input, f.review, snapshot, context, f.now)).ok).toBe(false);
  });

  it('uses an original partial-progress checkpoint without inventing new timestamps or changing formal content', async () => {
    const f = await originalFixture();
    const restored = data(restoreDraft(f.review, f.input.draft));
    const progress = data(toProgress(restored, restored.items[0]!, snapshot.revision));
    const document = { kind: 'progress' as const, value: progress };
    const savedDraft = { ...f.input.savedDraft, document, contentHash: await contentHash({ document, source: f.input.source }) };
    const result = data(await verifyOriginalPreview({ ...f.key, draftContentHash: savedDraft.contentHash }, { ...f.input, savedDraft }, f.review, snapshot, context, f.now));
    expect(result.draft.node.updatedAt).toBe(time);
    expect(result.changes).toEqual(f.input.changes);
  });

  it('refuses absent/expired/deleted bodies and a source change without falling back to the current draft', async () => {
    const f = await originalFixture();
    for (const savedDraft of [null, { ...f.input.savedDraft, state: 'expired', document: null, source: null },
      { ...f.input.savedDraft, expiresAt: new Date(f.now - 1).toISOString() }, { ...f.input.savedDraft, document: null }]) {
      expect((await verifyOriginalPreview(f.key, { ...f.input, savedDraft }, f.review, snapshot, context, f.now)).ok).toBe(false);
    }
    const changedSource = structuredClone(f.review);
    changedSource.conversation.segments[0]!.text = 'The source no longer matches A';
    expect((await verifyOriginalPreview(f.key, f.input, changedSource, snapshot, context, f.now)).ok).toBe(false);
    expect((await verifyOriginalPreview(f.key, f.input, f.review, { ...snapshot, excludedIds: [f.input.draft.node.id] }, context, f.now)).ok).toBe(false);
    expect((await verifyOriginalPreview(f.key, f.input, f.review, { ...snapshot, revision: 'latest-B' }, context, f.now)).ok).toBe(false);
  });

  it('does not expose A to another actor/workspace or a reader whose content permissions were revoked', async () => {
    const f = await originalFixture();
    for (const identity of [{ ...context, actorId: 'foreign' }, { ...context, workspaceId: 'foreign' }, { ...context, scopes: [] }]) {
      expect(await verifyOriginalPreview(f.key, f.input, f.review, snapshot, identity, f.now))
        .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    const readOnly = { ...context, scopes: context.scopes.filter((scope) => scope !== 'knowledge:write') };
    expect((await verifyOriginalPreview(f.key, f.input, f.review, snapshot, readOnly, f.now)).ok).toBe(true);
  });
});
