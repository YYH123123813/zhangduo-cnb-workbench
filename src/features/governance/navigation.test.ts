import { describe, expect, it, vi } from 'vitest';
import { governanceGuard, type GovernanceNavigationState } from './navigation';
import type { Approval } from '../../contracts/domain';
import { HashNavigation } from '../../app/routing';

describe('1.8.0 governance navigation adapter', () => {
  it('registers with shared navigation, blocks unknown same-page changes, and unregisters on disposal', () => {
    const write = vi.fn(), confirmDiscard = vi.fn(() => false), onBlocked = vi.fn();
    const navigation = new HashNavigation('#governance?nodeId=k1', { write, confirmDiscard });
    let value: GovernanceNavigationState = { dirty: false, operations: [{ stage: 'unknown', approval: null }] };
    const dispose = navigation.registerLeaveGuard(governanceGuard(() => value, onBlocked));
    expect(navigation.navigate('#governance?nodeId=k2')).toBe(false);
    expect(navigation.getSnapshot().params.nodeId).toBe('k1'); expect(onBlocked).toHaveBeenCalledOnce(); expect(confirmDiscard).not.toHaveBeenCalled();
    value = { dirty: true, operations: [] }; expect(navigation.navigate('#retrieval')).toBe(false); expect(confirmDiscard).toHaveBeenCalledOnce();
    dispose(); expect(navigation.navigate('#retrieval')).toBe(true);
  });
  it('reads current draft and operation state each time instead of a stale registration closure', () => {
    let value: GovernanceNavigationState = { dirty: false, operations: [] };
    const onBlocked = vi.fn(); const guard = governanceGuard(() => value, onBlocked);
    expect(guard.owner).toBe('governance'); expect(guard.getState()).toBe('clean');
    value = { dirty: true, operations: [] }; expect(guard.getState()).toBe('dirty');
    for (const stage of ['approving', 'approval_unknown', 'reading_approval', 'sending', 'verifying', 'unknown', 'revoking', 'revoke_unknown'] as const) {
      value = { dirty: false, operations: [{ stage, approval: null }] }; expect(guard.getState()).toBe('blocked');
    }
    guard.onBlocked?.(); expect(onBlocked).toHaveBeenCalledOnce();
    value = { dirty: false, operations: [{ stage: 'idle', approval: null }] }; expect(guard.getState()).toBe('clean');
  });
  it('blocks registered approvals and treats an unapproved preview as unsaved work', () => {
    let value: GovernanceNavigationState = { dirty: false, operations: [{ stage: 'ready', approval: null }] };
    const guard = governanceGuard(() => value, () => {}); expect(guard.getState()).toBe('dirty');
    for (const stage of ['approved', 'failed', 'succeeded'] as const) {
      value = { dirty: false, operations: [{ stage, approval: { id: 'registered' } as Approval }] }; expect(guard.getState()).toBe('blocked');
    }
  });
  it('blocks navigation while an original payload is saving, reading, or unknown', () => {
    let value: GovernanceNavigationState = { dirty: false, operations: [], payloadState: 'idle' };
    const guard = governanceGuard(() => value, () => {});
    for (const payloadState of ['saving', 'reading', 'unknown'] as const) {
      value = { dirty: false, operations: [], payloadState }; expect(guard.getState()).toBe('blocked');
    }
    value = { dirty: false, operations: [], payloadState: 'conflict' }; expect(guard.getState()).toBe('clean');
  });
});
