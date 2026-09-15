import { describe, expect, it, vi } from 'vitest';
import { HashNavigation } from '../../app/routing';
import { queryLeaveState, canRecordDetail } from './client-state';
import type { RetrievalResult } from '../../contracts/domain';
import type { NodeDetail } from './api';
import { node, request } from './test-support';

describe('R11 shared navigation guard and fixed-result selection', () => {
  it('reads the latest question/conditions without treating original task feedback as a new draft', () => {
    const baseline = structuredClone(request.task);
    expect(queryLeaveState(structuredClone(baseline), baseline, 'clean')).toBe('clean');
    expect(queryLeaveState({ ...baseline, question: 'edited' }, baseline, 'clean')).toBe('dirty');
    expect(queryLeaveState({ ...baseline, constraints: [{ id: 'c1', text: 'Changed condition' }] }, baseline, 'clean')).toBe('dirty');
    const confirmed = { ...baseline, constraints: [{ id: 'c1', text: 'Changed condition', confirmedBy: 'u1' }] };
    expect(queryLeaveState(confirmed, { ...confirmed, constraints: [{ id: 'c1', text: 'Changed condition' }] }, 'clean')).toBe('dirty');
    expect(queryLeaveState(baseline, baseline, 'blocked')).toBe('blocked');
  });
  it('uses the shared hash guard to block unknown operations and confirm unsent edits', () => {
    const confirmDiscard = vi.fn(() => false); const write = vi.fn(); const onBlocked = vi.fn();
    const navigation = new HashNavigation('#retrieval', { write, confirmDiscard });
    let current = structuredClone(request.task); let operation: 'clean' | 'blocked' = 'clean';
    const unregister = navigation.registerLeaveGuard({ owner: 'retrieval', getState: () => queryLeaveState(current, request.task, operation), onBlocked });
    current = { ...current, question: 'Unsaved question' };
    navigation.navigate('#learning'); expect(navigation.getSnapshot().page).toBe('retrieval'); expect(confirmDiscard).toHaveBeenCalledOnce();
    operation = 'blocked'; navigation.navigate('#governance?nodeId=n1');
    expect(navigation.getSnapshot().page).toBe('retrieval'); expect(onBlocked).toHaveBeenCalledOnce(); expect(confirmDiscard).toHaveBeenCalledOnce();
    operation = 'clean'; current = structuredClone(request.task); navigation.navigate('#learning');
    expect(navigation.getSnapshot().page).toBe('learning'); unregister();
  });
  it('protects an unconfirmed tri-state choice without declaring it a task fact or releasing an unknown model operation', () => {
    expect(queryLeaveState(request.task, request.task, 'clean', true)).toBe('dirty');
    expect(queryLeaveState(request.task, request.task, 'blocked', true)).toBe('blocked');
    expect(queryLeaveState(request.task, request.task, 'clean', false)).toBe('clean');
    let pending = true; const confirmDiscard = vi.fn(() => false);
    const navigation = new HashNavigation('#retrieval', { write: vi.fn(), confirmDiscard });
    navigation.registerLeaveGuard({ owner: 'retrieval', getState: () => queryLeaveState(request.task, request.task, 'clean', pending) });
    navigation.navigate('#learning'); expect(navigation.getSnapshot().page).toBe('retrieval'); expect(confirmDiscard).toHaveBeenCalledOnce();
    pending = false; navigation.navigate('#learning'); expect(navigation.getSnapshot().page).toBe('learning');
    expect(request.task.conditionChecks).toBeUndefined();
  });
  it('allows adoption only for the selected node and version inside the original current result', () => {
    const n = node(); const result: RetrievalResult = { queryId: 'q1', snapshotRevision: 'fixture-r1', groups: { eligible: [n], conditional: [], conflicts: [], excludedIds: [] },
      paths: [], answer: null, missingConditions: [], warnings: [], coverage: 'partial' };
    const detail: NodeDetail = { node: n, snapshotRevision: result.snapshotRevision, neighbors: [], relations: [], paths: [], warnings: [] };
    expect(canRecordDetail(result, detail, false)).toBe(true);
    expect(canRecordDetail(result, { ...detail, node: node('outside-result') }, false)).toBe(false);
    expect(canRecordDetail(result, { ...detail, node: { ...n, revision: 'fixture-r2' } }, false)).toBe(false);
    expect(canRecordDetail(result, { ...detail, snapshotRevision: 'fixture-r2' }, false)).toBe(false);
    expect(canRecordDetail(result, { ...detail, history: { currentSnapshotRevision: 'fixture-r2', currentNodeRevision: 'fixture-r2' } }, false)).toBe(false);
    expect(canRecordDetail(result, detail, true)).toBe(false); expect(canRecordDetail(null, detail, false)).toBe(false);
  });
});
