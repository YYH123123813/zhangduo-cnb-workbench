import { describe, expect, it, vi } from 'vitest';
import type { ApiError, Result } from '../../contracts/api';
import type { KnowledgeApprovalState } from '../../contracts/approval';
import type { Approval, CommitReceipt } from '../../contracts/domain';
import { draftFixture } from './testing/review';
import { context, fixtureServices } from './testing/services';
import { snapshot } from './testing/knowledge';
import { time } from './testing/fixtures';
import { buildChangeSet } from './changes';
import { readableDiff } from './preview';
import type { HandoffPreview } from './preview';
import { beginOriginalRecovery, acceptOriginalPreview, cancelOriginalRecovery, reconcileOriginalFacts, readOriginalFacts } from './original-recovery';

function data<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
const denied: ApiError = { code: 'FORBIDDEN', message: 'Content access revoked', dataState: 'preserved', retryable: false, nextAction: 'request_access' };
async function setup() {
  const { draft, review } = draftFixture();
  const changes = data(await buildChangeSet(draft, review, snapshot, context, 'original-A', 'Original reason', time));
  const preview: HandoffPreview = { draft, changes, diff: readableDiff(changes, snapshot, review.items[0]!.subject) };
  const key = { actorId: context.actorId, workspaceId: context.workspaceId, conversationId: draft.conversationId,
    changeSetId: changes.id, contentHash: changes.contentHash, baseRevision: changes.baseRevision,
    draftId: draft.id, draftRevision: 1, draftContentHash: 'original-pinned-draft-hash' };
  const state = acceptOriginalPreview(beginOriginalRecovery(key), { ok: true, data: preview });
  const now = Date.parse(time) + 1000;
  const approval: Approval = { id: 'original-approval', purpose: 'commit_knowledge', actorId: context.actorId, workspaceId: context.workspaceId,
    objectIds: changes.nodes.map((node) => node.id), contentHash: changes.contentHash, baseRevision: changes.baseRevision,
    approvedAt: time, expiresAt: new Date(now + 100_000).toISOString() };
  const registration: KnowledgeApprovalState = { changeSetId: changes.id, actorId: context.actorId, workspaceId: context.workspaceId,
    approval, status: 'registered', absenceIsFinal: false };
  const receipt: CommitReceipt = { changeSetId: changes.id, revision: 'fixture-original-revision', commitUrl: 'https://cnb.cool/fixture/private/-/commit/original', indexing: 'pending' };
  return { state, preview, key, approval, registration, receipt, now };
}

describe('W3-REQ-008 read-only recovery states, not a persistence or submission adapter', () => {
  it('does not treat a recovered preview as approval, a Git result or permission to submit', async () => {
    const { state, preview } = await setup();
    expect(state).toMatchObject({ phase: 'read_only', canSubmit: false, approval: null, receipt: null, commitState: 'unknown', preview });
  });
  it('keeps empty Git readback unknown for registered, revoked, expired, unknown and not_registered approvals', async () => {
    const { state, registration, now } = await setup();
    for (const status of ['registered', 'revoked', 'expired', 'unknown', 'not_registered'] as const) {
      const original: KnowledgeApprovalState = { ...registration, status,
        approval: status === 'unknown' || status === 'not_registered' ? null : status === 'expired'
          ? { ...registration.approval!, expiresAt: new Date(now - 1).toISOString() } : registration.approval };
      const restored = await reconcileOriginalFacts(state, { ok: true, data: original }, { ok: true, data: null }, context, now);
      expect(restored).toMatchObject({ phase: 'read_only', canSubmit: false, receipt: null, commitState: 'unknown' });
      expect(restored.preview).toEqual(state.preview);
    }
  });
  it('never claims a mismatched approval as A even when a receipt has the expected operation ID', async () => {
    const { state, registration, receipt, now } = await setup();
    const originals = [{ ...registration, changeSetId: 'B' }, { ...registration, actorId: 'foreign' },
      ...[{ contentHash: 'B' }, { baseRevision: 'B' }, { objectIds: ['B'] }, { workspaceId: 'foreign' }].map((change) => ({ ...registration, approval: { ...registration.approval!, ...change } }))];
    for (const original of originals) {
      const restored = await reconcileOriginalFacts(state, { ok: true, data: original }, { ok: true, data: receipt }, context, now);
      expect(restored).toMatchObject({ phase: 'read_only', canSubmit: false, approval: null, receipt: null, commitState: 'unknown' });
      expect(restored.error?.dataState).toBe('unknown');
    }
  });
  it('reports only the exact Git receipt and keeps indexing separate without permitting another commit', async () => {
    const { state, registration, receipt, now } = await setup();
    expect(await reconcileOriginalFacts(state, { ok: true, data: registration }, { ok: true, data: receipt }, context, now))
      .toMatchObject({ phase: 'committed', canSubmit: false, commitState: 'saved', receipt: { indexing: 'pending' } });
    const wrong = await reconcileOriginalFacts(state, { ok: true, data: registration }, { ok: true, data: { ...receipt, changeSetId: 'B' } }, context, now);
    expect(wrong).toMatchObject({ phase: 'read_only', canSubmit: false, receipt: null, commitState: 'unknown' });
  });
  it('keeps an authoritative Git receipt independent from a temporarily unavailable approval read', async () => {
    const { state, receipt, now } = await setup();
    const unavailable: Result<KnowledgeApprovalState> = { ok: false, error: { code: 'UPSTREAM',
      message: 'Approval read response lost', retryable: true, dataState: 'unknown', nextAction: 'check_approval' } };
    expect(await reconcileOriginalFacts(state, unavailable, { ok: true, data: receipt }, context, now))
      .toMatchObject({ phase: 'committed', commitState: 'saved', approval: null, receipt,
        canSubmit: false, error: { code: 'UPSTREAM', nextAction: 'check_approval' } });
    expect(await reconcileOriginalFacts(state, unavailable, { ok: true, data: null }, context, now))
      .toMatchObject({ phase: 'read_only', commitState: 'unknown', approval: null, receipt: null, canSubmit: false });
  });
  it('does not erase a previously verified Git success on a later empty or failed read', async () => {
    const { state, registration, receipt, now } = await setup();
    const committed = await reconcileOriginalFacts(state, { ok: true, data: registration }, { ok: true, data: receipt }, context, now);
    const reads: Result<CommitReceipt | null>[] = [{ ok: true, data: null }, { ok: false, error: {
      code: 'UPSTREAM', message: 'Receipt service unavailable', retryable: true, dataState: 'unknown', nextAction: 'read_back' } }];
    for (const read of reads) {
      expect(await reconcileOriginalFacts(committed, { ok: true, data: registration }, read, context, now))
        .toMatchObject({ phase: 'committed', commitState: 'saved', receipt, canSubmit: false });
    }
    expect(await reconcileOriginalFacts(committed, { ok: true, data: registration }, { ok: false, error: denied }, context, now))
      .toMatchObject({ phase: 'unavailable', preview: null, receipt: null, canSubmit: false });
  });
  it('distinguishes a journaled branch rejection from failed reads, without unlocking a restored operation', async () => {
    const { state, registration, now } = await setup();
    for (const [error, expected] of [
      [{ code: 'CONFLICT', dataState: 'preserved', nextAction: 'preview_again' }, 'rejected'],
      [{ code: 'CONFLICT', dataState: 'unknown', nextAction: 'preview_again' }, 'unknown'],
      [{ code: 'UPSTREAM', dataState: 'preserved', nextAction: 'retry_read' }, 'unknown'],
    ] as const) {
      const restored = await reconcileOriginalFacts(state, { ok: true, data: registration }, { ok: false, error: { ...error, message: 'Fixture response', retryable: false } }, context, now);
      expect(restored).toMatchObject({ phase: 'read_only', canSubmit: false, commitState: expected });
    }
  });
  it('clears retained private content after a denied/expired preview or identity change', async () => {
    const { state, registration, receipt, now } = await setup();
    expect(acceptOriginalPreview(state, { ok: false, error: denied })).toMatchObject({ phase: 'unavailable', preview: null, approval: null, receipt: null, canSubmit: false });
    expect(await reconcileOriginalFacts(state, { ok: false, error: denied }, { ok: true, data: receipt }, context, now))
      .toMatchObject({ phase: 'unavailable', preview: null, receipt: null });
    expect(await reconcileOriginalFacts(state, { ok: true, data: registration }, { ok: true, data: receipt }, { ...context, actorId: 'other' }, now))
      .toMatchObject({ phase: 'unavailable', preview: null, receipt: null });
  });
  it('cancels only the recovery read and ignores late successes without calling any remote mutation', async () => {
    const { state, preview, registration, receipt, now } = await setup();
    const cancelled = cancelOriginalRecovery(state);
    expect(cancelled).toMatchObject({ phase: 'cancelled', preview: null, canSubmit: false, commitState: 'unknown' });
    expect(acceptOriginalPreview(cancelled, { ok: true, data: preview })).toBe(cancelled);
    expect(await reconcileOriginalFacts(cancelled, { ok: true, data: registration }, { ok: true, data: receipt }, context, now)).toBe(cancelled);
    const services = fixtureServices();
    expect(await readOriginalFacts(cancelled, services, context, now)).toBe(cancelled);
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('calls the two existing Services reads with the original context and never a registration or write', async () => {
    const { state, registration, now } = await setup();
    const services = fixtureServices({ readKnowledgeApproval: vi.fn(async () => ({ ok: true as const, data: registration })),
      readCommit: vi.fn(async () => ({ ok: true as const, data: null })), approveKnowledge: vi.fn() });
    expect(await readOriginalFacts(state, services, context, now)).toMatchObject({ phase: 'read_only', commitState: 'unknown', canSubmit: false });
    expect(services.readKnowledgeApproval).toHaveBeenCalledExactlyOnceWith(context, state.key.changeSetId);
    expect(services.readCommit).toHaveBeenCalledExactlyOnceWith(context, state.key.changeSetId);
    expect(vi.mocked(services.readCommit!).mock.calls[0]![0]).toBe(context);
    expect(services.approveKnowledge).not.toHaveBeenCalled();
    expect(services.commit).not.toHaveBeenCalled();
    expect(services.saveDraft).not.toHaveBeenCalled();
  });
});
