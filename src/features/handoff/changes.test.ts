import { describe, expect, it } from 'vitest';
import { hashChangeSet } from '../../contracts/hash';
import { ChangeSetSchema } from '../../contracts/domain';
import { buildChangeSet } from './changes';
import { draftFixture } from './testing/review';
import { context } from './testing/services';
import { snapshot } from './testing/knowledge';
import { time } from './testing/fixtures';

describe('H08 atomic node and relation change set', () => {
  it('builds a schema-valid, hashed proposed commit without mutating the draft', async () => {
    const { draft, review } = draftFixture();
    const result = await buildChangeSet(draft, review, snapshot, context, 'operation-1', '保留有边界的陈述', time);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ChangeSetSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.contentHash).toBe(await hashChangeSet(result.data));
    expect(result.data.nodes[0]?.confirmedBy).toBe(context.actorId);
    expect(result.data.relations).toEqual([]);
    expect(result.data.withdrawnIds).toEqual([]);
    expect(draft.node.confirmation).toBe('draft');
  });
  it('rejects stale versions, invalid kinds and missing commit scope', async () => {
    const { draft, review } = draftFixture();
    expect((await buildChangeSet({ ...draft, baseRevision: 'fixture-old' }, review, snapshot, context, 'op', 'reason', time)).ok).toBe(false);
    expect((await buildChangeSet({ ...draft, node: { ...draft.node, kind: 'nonsense' as 'fact' } }, review, snapshot, context, 'op', 'reason', time)).ok).toBe(false);
    expect((await buildChangeSet(draft, review, snapshot, { ...context, scopes: [] }, 'op', 'reason', time)).ok).toBe(false);
  });
  it('does not overwrite existing formal knowledge or accept a blank reason', async () => {
    const { draft, review } = draftFixture();
    expect((await buildChangeSet(draft, review, { ...snapshot, nodes: [...snapshot.nodes, draft.node] }, context, 'op', 'reason', time)).ok).toBe(false);
    expect((await buildChangeSet(draft, review, snapshot, context, 'op', ' ', time)).ok).toBe(false);
  });
  it('blocks an unverified source save and a relation whose prior confirmation has been invalidated', async () => {
    const { draft, review } = draftFixture();
    expect((await buildChangeSet(draft, { ...review, conversation: { ...review.conversation, state: 'unknown' } }, snapshot, context, 'op', 'reason', time)).ok).toBe(false);
    draft.relations = [{ id: 'pending-relation', workspaceId: context.workspaceId,
      source: { workspaceId: context.workspaceId, objectId: draft.node.id, revision: snapshot.revision },
      target: { workspaceId: context.workspaceId, objectId: snapshot.nodes[0]!.id, revision: snapshot.nodes[0]!.revision },
      type: 'depends_on', rationale: '尚待重新确认', evidenceIds: ['source-1'], state: 'proposed', proposedBy: context.actorId, updatedAt: time }];
    expect((await buildChangeSet(draft, review, snapshot, context, 'op', 'reason', time)).ok).toBe(false);
  });
});
