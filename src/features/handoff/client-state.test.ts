import { describe, expect, it, vi } from 'vitest';
import { applyVerifiedDraftSave, canReplaceReview, hasItemEdits, refreshRelationConfirmations, requestReviewExit, shouldWarnOnExit } from './client-state';
import { draftFixture } from './testing/review';
import { newSubmission } from './submission';
import { relation } from './testing/knowledge';
import { writeStatement, setKeyCondition } from './model';

describe('H12 local editing safety', () => {
  it('requires explicit replacement before losing existing review text', () => {
    const { review } = draftFixture(); review.items[0]!.statement = '仍在编辑的文字';
    expect(canReplaceReview(review, newSubmission(), false).ok).toBe(false);
    expect(canReplaceReview(review, newSubmission(), true).ok).toBe(true);
  });
  it('blocks replacement while commit status is unknown even with discard checked', () => {
    const { review } = draftFixture();
    expect(canReplaceReview(review, { ...newSubmission(), unknown: true }, true).ok).toBe(false);
    expect(canReplaceReview(review, { ...newSubmission(), pending: true }, true).ok).toBe(false);
  });
  it('keeps uncertain draft payloads attached even when replacement is explicitly checked', () => {
    const { review, draft } = draftFixture();
    expect(canReplaceReview(review, newSubmission(), true, { [draft.candidateId!]: draft })).toMatchObject({ ok: false, error: { nextAction: 'read_back' } });
  });
  it('retains relation text but invalidates stale confirmation when the statement or condition changes', () => {
    const { review } = draftFixture(); const original = { ...review.items[0]!, relations: [relation()] };
    expect(writeStatement(original, '已改变的主张').relations[0]?.state).toBe('proposed');
    const changed = setKeyCondition(original, '不同条件', 'unknown');
    if (!changed.ok) throw Error('fixture');
    expect(changed.data.relations[0]?.confirmedBy).toBeUndefined();
    expect(refreshRelationConfirmations(original.relations)[0]?.rationale).toBe(relation().rationale);
  });
  it('requires replacement consent for blank-statement conditions and unfinished relation input', () => {
    const { review } = draftFixture(); const initial = review.items[0]!;
    expect(hasItemEdits(initial)).toBe(false);
    for (const edited of [
      { ...initial, conditions: [{ ...initial.conditions[0]!, text: '只在受控环境适用' }] },
      { ...initial, relationInput: { ...initial.relationInput, rationale: '尚未确认的理由' } },
      { ...initial, sources: [{ ...initial.sources[0]!, limitation: '尚待核验的限制' }] },
    ]) {
      expect(hasItemEdits(edited)).toBe(true);
      expect(canReplaceReview({ ...review, items: [edited] }, newSubmission(), false).ok).toBe(false);
    }
  });
  it('preserves unfinished relation form inputs after saving only the supported draft fields', () => {
    const { review, draft } = draftFixture();
    const item = review.items[0]!;
    item.statement = draft.node.humanStatement; item.disposition = 'handoff';
    item.relationInput = { targetId: 'target-1', type: 'depends_on', direction: 'outgoing', rationale: '尚未确认的关系理由', evidenceIds: ['source-1'] };
    const before = structuredClone(review);
    const saved = applyVerifiedDraftSave(review, draft);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw Error('fixture');
    expect(saved.data.items[0]?.relationInput).toEqual(item.relationInput);
    expect(saved.data.items[0]?.statement).toBe(draft.node.humanStatement);
    expect(saved.data.items[0]?.relations).toEqual(draft.relations);
    expect(review).toEqual(before);
  });
  it('rejects foreign saved drafts and leaves every local input untouched', () => {
    const { review, draft } = draftFixture();
    const before = structuredClone(review);
    expect(applyVerifiedDraftSave(review, { ...draft, candidateId: 'foreign' }).ok).toBe(false);
    expect(review).toEqual(before);
  });
  it('does not ask to discard an untouched review but warns for text, decisions and partial inputs', () => {
    const { review } = draftFixture(); const confirm = vi.fn(() => false);
    expect(shouldWarnOnExit(review, newSubmission(), {}, false)).toBe(false);
    expect(requestReviewExit(review, newSubmission(), {}, false, confirm).ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    for (const item of [
      { ...review.items[0]!, statement: '当前陈述' },
      { ...review.items[0]!, disposition: 'later' as const },
      { ...review.items[0]!, relationInput: { ...review.items[0]!.relationInput, rationale: '仍在填写' } },
    ]) expect(shouldWarnOnExit({ ...review, items: [item] }, newSubmission(), {}, false)).toBe(true);
  });
  it('retains review contents when exit is canceled and permits an explicit discard without any writes', () => {
    const { review } = draftFixture(); review.items[0]!.statement = '不能静默丢失的内容';
    const before = structuredClone(review); const cancel = vi.fn(() => false); const discard = vi.fn(() => true);
    expect(requestReviewExit(review, newSubmission(), {}, false, cancel)).toMatchObject({ ok: false, error: { dataState: 'preserved', nextAction: 'continue_editing' } });
    expect(requestReviewExit(review, newSubmission(), {}, false, discard).ok).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1); expect(discard).toHaveBeenCalledTimes(1);
    expect(review).toEqual(before);
  });
  it('never lets discard consent bypass an active request, registered approval or uncertain write', () => {
    const { review, draft } = draftFixture(); const confirm = vi.fn(() => true);
    const registered = { id: 'approval-1', workspaceId: 'workspace-1', actorId: 'actor-1', purpose: 'commit_knowledge' as const,
      objectIds: [draft.node.id], baseRevision: draft.baseRevision, contentHash: 'fixture-hash',
      approvedAt: '2026-09-05T01:00:00Z', expiresAt: '2026-09-05T01:05:00Z' };
    for (const state of [{ ...newSubmission(), pending: true }, { ...newSubmission(), unknown: true },
      { ...newSubmission(), approvalUnknown: true }, { ...newSubmission(), approval: registered }]) {
      expect(shouldWarnOnExit(review, state, {}, false)).toBe(true);
      expect(requestReviewExit(review, state, {}, false, confirm).ok).toBe(false);
    }
    expect(requestReviewExit(review, newSubmission(), { [draft.candidateId!]: draft }, false, confirm).ok).toBe(false);
    expect(requestReviewExit(review, newSubmission(), {}, true, confirm).ok).toBe(false);
    expect(shouldWarnOnExit(null, newSubmission(), {}, true)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
