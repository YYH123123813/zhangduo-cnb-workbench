import { describe, expect, it, vi } from 'vitest';
import { HashNavigation, parseRoute } from '../../app/routing';
import { handoffGuard, handoffBlockedError, handoffOperationHash } from './navigation';
import type { HandoffNavigationState } from './navigation';
import { newSubmission } from './submission';
import { RequestGate } from './request-gate';
import { draftFixture } from './testing/review';

const clean = (): HandoffNavigationState => ({ review: null, submission: newSubmission(), unknownDrafts: {}, busy: false });
describe('W12 handoff registration with shared HashNavigation (not browser acceptance)', () => {
  it('builds a bounded recovery address with the original operation and draft identities only', () => {
    const hash = handoffOperationHash({ conversationId: 'conversation-A', draftId: 'draft-A', changeSetId: 'change-A', source: 'manual', operationHash: 'a'.repeat(64) });
    expect(parseRoute(hash)).toEqual({ page: 'handoff', params: {
      changeSetId: 'change-A', conversationId: 'conversation-A', draftId: 'draft-A', operationHash: 'a'.repeat(64), source: 'manual',
    } });
    expect(hash).not.toContain('humanStatement');
    expect(hash).not.toContain('token');
  });

  it('reads live state for sidebar and same-page parameter changes and unregisters on disposal', () => {
    const write = vi.fn(), confirmDiscard = vi.fn(() => false), onBlocked = vi.fn();
    const navigation = new HashNavigation('#handoff?conversationId=c1', { write, confirmDiscard });
    let state = clean();
    const dispose = navigation.registerLeaveGuard(handoffGuard(() => state, onBlocked));
    state = { ...state, submission: { ...newSubmission(), approvalUnknown: true } };
    expect(navigation.navigate('#handoff?conversationId=c2')).toBe(false);
    expect(navigation.getSnapshot().params.conversationId).toBe('c1');
    expect(navigation.navigate('#retrieval')).toBe(false);
    expect(onBlocked).toHaveBeenCalledTimes(2); expect(confirmDiscard).not.toHaveBeenCalled();
    state = clean();
    expect(navigation.navigate('#handoff?conversationId=c2')).toBe(true);
    state = { ...state, busy: true }; dispose();
    expect(navigation.navigate('#retrieval')).toBe(true);
  });
  it('asks once for ordinary edits and restores an already changed history hash on cancellation', () => {
    const { review } = draftFixture(); review.items[0]!.relationInput.rationale = '尚未确认的关系';
    const write = vi.fn(), confirmDiscard = vi.fn(() => false);
    const navigation = new HashNavigation('#handoff?conversationId=c1', { write, confirmDiscard });
    navigation.registerLeaveGuard(handoffGuard(() => ({ ...clean(), review })));
    expect(navigation.shouldWarnBeforeUnload()).toBe(true);
    expect(navigation.navigate('#capture?conversationId=c1', true)).toBe(false);
    expect(write).toHaveBeenLastCalledWith('#handoff?conversationId=c1', true);
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    confirmDiscard.mockReturnValue(true);
    expect(navigation.navigate('#capture?conversationId=c1')).toBe(true);
    expect(confirmDiscard).toHaveBeenCalledTimes(2);
    expect(review.items[0]?.relationInput.rationale).toBe('尚未确认的关系');
  });
  it('blocks immediately on the synchronous request gate before a React disabled state renders', () => {
    const requests = new RequestGate(), confirmDiscard = vi.fn(() => true);
    const navigation = new HashNavigation('#handoff', { write: vi.fn(), confirmDiscard });
    navigation.registerLeaveGuard(handoffGuard(() => ({ ...clean(), busy: requests.pending })));
    const ticket = requests.begin()!;
    expect(navigation.navigate('#retrieval')).toBe(false);
    expect(confirmDiscard).not.toHaveBeenCalled();
    requests.finish(ticket);
    expect(navigation.navigate('#retrieval')).toBe(true);
  });
  it('keeps draft, approval and commit uncertainty blocked with distinct recovery reasons', () => {
    const { draft } = draftFixture();
    for (const [state, action] of [
      [{ ...clean(), unknownDrafts: { [draft.candidateId!]: draft } }, 'read_back'],
      [{ ...clean(), submission: { ...newSubmission(), approvalUnknown: true } }, 'check_approval'],
      [{ ...clean(), submission: { ...newSubmission(), unknown: true } }, 'read_back'],
      [{ ...clean(), submission: { ...newSubmission(), pending: true } }, 'wait_request'],
    ] as const) {
      expect(handoffGuard(() => state).getState()).toBe('blocked');
      expect(handoffBlockedError(state).nextAction).toBe(action);
    }
  });

  it('keeps a dirty handoff instance and makes a repeated same-operation pin idempotent', () => {
    const write = vi.fn(), confirmDiscard = vi.fn(() => false), navigation = new HashNavigation('#handoff?conversationId=conversation-A', { write, confirmDiscard });
    const { review } = draftFixture(); review.items[0]!.relationInput.rationale = '仍在编辑';
    navigation.registerLeaveGuard(handoffGuard(() => ({ ...clean(), review })));
    const address = { conversationId: 'conversation-A', draftId: 'draft-A', changeSetId: 'change-A', source: 'manual' as const, operationHash: 'a'.repeat(64) };
    expect(navigation.pinHandoffOperation(address)).toMatchObject({ ok: true, history: 'replace', preservedPage: true });
    expect(navigation.pinHandoffOperation(address)).toMatchObject({ ok: true, history: 'replace', preservedPage: true });
    expect(write).toHaveBeenCalledOnce(); expect(confirmDiscard).not.toHaveBeenCalled();
    expect(navigation.shouldWarnBeforeUnload()).toBe(true);
  });
  it('retains a registered approval as blocked even after a rejected commit', () => {
    const state = { ...clean(), submission: { ...newSubmission(), rejected: true, approval: {
      id: 'approval-1', actorId: 'actor-1', workspaceId: 'workspace-1', purpose: 'commit_knowledge' as const,
      objectIds: ['node-1'], contentHash: 'fixture-hash', baseRevision: 'fixture-r1',
      approvedAt: '2026-09-05T00:00:00Z', expiresAt: '2099-09-05T00:00:00Z',
    } } };
    expect(handoffGuard(() => state).getState()).toBe('blocked');
    expect(handoffBlockedError(state)).toMatchObject({ nextAction: 'revoke_approval', dataState: 'preserved' });
  });
  it('blocks an unknown original snapshot save without describing it as a draft or Git write', () => {
    const state = { ...clean(), unknownOperation: true };
    expect(handoffGuard(() => state).getState()).toBe('blocked');
    expect(handoffBlockedError(state)).toMatchObject({ nextAction: 'read_original_operation', dataState: 'unknown' });
  });
});
