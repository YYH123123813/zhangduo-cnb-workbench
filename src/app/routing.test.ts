import { describe, expect, it, vi } from 'vitest';
import { HashNavigation, parseRoute, routeHash } from './routing';

describe('W12 bounded hash routing and unload protection', () => {
  it('parses shared ID/version links without placing body text in a route', () => {
    expect(parseRoute('')).toEqual({ page: 'retrieval', params: {} });
    expect(parseRoute('#handoff?conversationId=cnb%3A7&candidateId=c1&draftId=d1')).toEqual({ page: 'handoff', params: { conversationId: 'cnb:7', candidateId: 'c1', draftId: 'd1' } });
    expect(parseRoute(`#governance?nodeId=k1&revision=${'a'.repeat(40)}`)).toEqual({ page: 'governance', params: { nodeId: 'k1', revision: 'a'.repeat(40) } });
    expect(routeHash(parseRoute('#learning?queryId=q1&taskId=t1&nodeId=k1'))).toBe('#learning?nodeId=k1&queryId=q1&taskId=t1');
    expect(parseRoute('#capture?conversationId=c1&approvalId=a1')).toEqual({ page: 'capture', params: { conversationId: 'c1', approvalId: 'a1' } });
    expect(parseRoute('#handoff?conversationId=c1&source=manual')).toEqual({ page: 'handoff', params: { conversationId: 'c1', source: 'manual' } });
    expect(parseRoute('#governance?taskId=t1&useId=use1&evidenceId=result1&draftId=d1')).toEqual({ page: 'governance', params: { taskId: 't1', useId: 'use1', evidenceId: 'result1', draftId: 'd1' } });
  });
  it('rejects unknown, repeated, invalid encoded and overlong parameters without echoing private URL contents', () => {
    for (const hash of ['#retrieval?question=PRIVATE', '#learning?taskId=a&taskId=b', '#governance?revision=HEAD', '#capture?conversationId=%FF', `#handoff?draftId=${'x'.repeat(161)}`, '#unknown?token=PRIVATE', '#handoff?source=live', '#handoff?source=manual&source=candidate', '#governance?useId=A&useId=B', '#governance?reason=PRIVATE', '#learning?answer=PRIVATE']) {
      expect(parseRoute(hash)).toEqual({ page: 'invalid', params: {} });
      expect(routeHash(parseRoute(hash))).not.toContain('PRIVATE');
    }
  });
  it('asks once for a dirty page and preserves both route and input when the user cancels', () => {
    const write = vi.fn(), confirm = vi.fn(() => false);
    const navigation = new HashNavigation('#capture', { write, confirmDiscard: confirm });
    navigation.registerLeaveGuard({ owner: 'capture', getState: () => 'dirty' });
    expect(navigation.navigate('#handoff?conversationId=c1')).toBe(false);
    expect(navigation.getSnapshot().page).toBe('capture'); expect(write).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    expect(navigation.navigate('#handoff?conversationId=c1')).toBe(true); expect(confirm).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith('#handoff?conversationId=c1', false);
  });
  it('blocks unknown operations even after a discard confirmation and protects same-page parameter changes', () => {
    const write = vi.fn(), confirm = vi.fn(() => true), onBlocked = vi.fn();
    const navigation = new HashNavigation('#governance?nodeId=k1', { write, confirmDiscard: confirm });
    navigation.registerLeaveGuard({ owner: 'governance', getState: () => 'blocked', onBlocked });
    expect(navigation.navigate('#governance?nodeId=k2')).toBe(false);
    expect(navigation.navigate('#retrieval', true)).toBe(false);
    expect(navigation.shouldWarnBeforeUnload()).toBe(true);
    expect(onBlocked).toHaveBeenCalledTimes(2); expect(confirm).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledWith('#governance?nodeId=k1', true);
  });
  it('rechecks after confirmation, fails closed on guard errors, and unregisters only that instance', () => {
    let state: 'dirty' | 'blocked' = 'dirty';
    const navigation = new HashNavigation('#handoff', { write: vi.fn(), confirmDiscard: () => { state = 'blocked'; return true; } });
    const unregister = navigation.registerLeaveGuard({ owner: 'handoff', getState: () => state });
    expect(navigation.navigate('#capture')).toBe(false); unregister();
    const failed = navigation.registerLeaveGuard({ owner: 'handoff', getState: () => { throw new Error('unknown state'); } });
    const current = navigation.registerLeaveGuard({ owner: 'handoff', getState: () => 'blocked' }); failed();
    expect(navigation.navigate('#capture')).toBe(false); current();
    expect(navigation.shouldWarnBeforeUnload()).toBe(false); expect(navigation.navigate('#capture')).toBe(true);
  });

  it('pins the current handoff operation in place without consulting the leave guard', () => {
    const write = vi.fn(), confirmDiscard = vi.fn(() => false), onBlocked = vi.fn();
    const navigation = new HashNavigation('#handoff?conversationId=conversation-A', { write, confirmDiscard });
    let state: 'clean' | 'blocked' = 'blocked';
    navigation.registerLeaveGuard({ owner: 'handoff', getState: () => state, onBlocked });

    const pinned = navigation.pinHandoffOperation({
      conversationId: 'conversation-A', draftId: 'draft-A', changeSetId: 'change-A', source: 'manual', operationHash: 'a'.repeat(64),
    });

    expect(pinned).toMatchObject({ ok: true, history: 'replace', preservedPage: true, hash: '#handoff?changeSetId=change-A&conversationId=conversation-A&draftId=draft-A&operationHash=' + 'a'.repeat(64) + '&source=manual' });
    expect(navigation.getSnapshot()).toMatchObject({ page: 'handoff', params: { conversationId: 'conversation-A', draftId: 'draft-A', changeSetId: 'change-A', source: 'manual', operationHash: 'a'.repeat(64) } });
    expect(write).toHaveBeenCalledWith(pinned.ok ? pinned.hash : '', true);
    expect(confirmDiscard).not.toHaveBeenCalled(); expect(onBlocked).not.toHaveBeenCalled();

    expect(navigation.navigate('#retrieval')).toBe(false);
    state = 'clean';
    expect(navigation.pinHandoffOperation({
      conversationId: 'conversation-B', draftId: 'draft-B', changeSetId: 'change-B', source: 'candidate', operationHash: 'b'.repeat(64),
    })).toMatchObject({ ok: false, reason: 'conversation_mismatch' });
  });

  it('rejects an unsafe or cross-page operation pin without changing the address', () => {
    const write = vi.fn(), navigation = new HashNavigation('#retrieval', { write, confirmDiscard: () => true });
    expect(navigation.pinHandoffOperation({
      conversationId: 'conversation-A', draftId: 'draft-A', changeSetId: 'change-A', source: 'manual', operationHash: 'a'.repeat(64),
    })).toMatchObject({ ok: false, reason: 'wrong_page' });
    expect(navigation.getSnapshot()).toEqual({ page: 'retrieval', params: {} });
    expect(write).not.toHaveBeenCalled();

    const handoff = new HashNavigation('#handoff?conversationId=conversation-A', { write, confirmDiscard: () => true });
    expect(handoff.pinHandoffOperation({
      conversationId: 'conversation-A', draftId: 'draft-A', changeSetId: 'change-A', source: 'manual', operationHash: 'not-a-hash',
    })).toMatchObject({ ok: false, reason: 'invalid_address' });
    expect(handoff.getSnapshot()).toEqual({ page: 'handoff', params: { conversationId: 'conversation-A' } });
  });
});
