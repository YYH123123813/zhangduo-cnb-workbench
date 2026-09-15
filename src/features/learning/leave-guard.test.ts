import { describe, expect, it, vi } from 'vitest';
import type { LeaveGuard } from '../../contracts/navigation';
import { LearningLeaveGroup } from './leave-guard';
import { AttemptRequestGate } from './attempt-request';
import { publicAttempt } from './attempt';
import { startFixture } from './testing/attempt';
import { task, useInput } from './testing/fixtures';
import { failure } from './errors';

describe('W12 learning leave-state aggregation (not browser navigation acceptance)', () => {
  it('reads live application and outcome draft state instead of capturing the first render', () => {
    const group = new LearningLeaveGroup();
    let application: ReturnType<LeaveGuard['getState']> = 'clean';
    let outcome: ReturnType<LeaveGuard['getState']> = 'clean';
    const removeApplication = group.register({ owner: 'learning', getState: () => application });
    const removeOutcome = group.register({ owner: 'learning', getState: () => outcome });
    expect(group.getState()).toBe('clean');
    application = 'dirty'; expect(group.getState()).toBe('dirty');
    application = 'clean'; outcome = 'dirty'; expect(group.getState()).toBe('dirty');
    outcome = 'clean'; expect(group.getState()).toBe('clean');
    removeApplication(); removeOutcome(); expect(group.getState()).toBe('clean');
  });

  it('blocks unload synchronously while sending and after a locally interrupted unknown attempt', () => {
    const gate = new AttemptRequestGate(); const group = new LearningLeaveGroup(); const notify = vi.fn();
    group.register({ owner: 'learning', getState: () => gate.blocked ? 'blocked' : 'dirty', onBlocked: notify });
    const pending = gate.begin({ action: 'start', operationId: 'attempt-1', taskId: task.id,
      taskRevision: 1, taskContentHash: 'a'.repeat(64),
      questionId: 'question-1', questionRevision: 'fixture:q1', nodeRef: useInput.nodeRefs[0]!,
    });
    expect(pending.ok).toBe(true); expect(group.getState()).toBe('blocked');
    group.onBlocked(); expect(notify).toHaveBeenCalledTimes(1); expect(gate.blocked).toBe(true);
    gate.interrupt(); expect(gate.recoveryId).toBe('attempt-1'); expect(group.getState()).toBe('blocked');
    const denied = gate.beginReadBack(); if (!denied.ok) throw new Error('Expected read-back');
    gate.reject(denied.data, failure('FORBIDDEN', 'Read-back unavailable'));
    expect(group.getState()).toBe('blocked');
    const recovered = gate.beginReadBack(); if (!recovered.ok) throw new Error('Expected read-back');
    expect(gate.accept(recovered.data, { view: publicAttempt(startFixture()), feedback: null }).ok).toBe(true);
    expect(group.getState()).toBe('dirty');
  });

  it('does not clear another panel or a newer registration during cleanup', () => {
    const group = new LearningLeaveGroup();
    const dirty: LeaveGuard = { owner: 'learning', getState: () => 'dirty' };
    const old = group.register(dirty); const newer = group.register(dirty);
    old(); expect(group.getState()).toBe('dirty');
    const blocked = group.register({ owner: 'learning', getState: () => 'blocked' });
    newer(); expect(group.getState()).toBe('blocked');
    blocked(); expect(group.getState()).toBe('clean');
  });

  it('only notifies blocked panels and fails closed when a state reader fails', () => {
    const group = new LearningLeaveGroup(); const dirtyNotice = vi.fn(); const blockedNotice = vi.fn();
    group.register({ owner: 'learning', getState: () => 'dirty', onBlocked: dirtyNotice });
    group.register({ owner: 'learning', getState: () => { throw new Error('Synthetic read failure'); }, onBlocked: blockedNotice });
    expect(group.getState()).toBe('blocked'); group.onBlocked();
    expect(dirtyNotice).not.toHaveBeenCalled(); expect(blockedNotice).toHaveBeenCalledTimes(1);
  });
});
