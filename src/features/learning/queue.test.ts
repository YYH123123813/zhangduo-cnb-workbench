import { describe, expect, it } from 'vitest';
import { createQueue, selectQueueItem, updateQueue } from './queue';
import { task, useInput } from './testing/fixtures';

const item = { id: 'queue-1', nodeRef: useInput.nodeRefs[0]!, taskId: task.id, title: 'Offline method' };
const now = '2026-09-05T01:00:00Z';

describe('L04 voluntary session review queue', () => {
  it('cannot open a stale selection after disabling, skipping, deferring or removing it', () => {
    const queue = { ...createQueue(task.workspaceId), enabled: true, items: [{ ...item, status: 'ready' as const, dueAt: now }] };
    expect(selectQueueItem(queue, item.id, now).ok).toBe(true);
    for (const action of [{ type: 'disable' }, { type: 'skip', id: item.id }, { type: 'defer', id: item.id, until: '2026-09-06T01:00:00Z' }, { type: 'remove', id: item.id }]) {
      const changed = updateQueue(queue, action, now);
      if (!changed.ok) throw new Error('invalid fixture');
      expect(selectQueueItem(changed.data, item.id, now).ok).toBe(false);
    }
    const deferred = updateQueue(queue, { type: 'defer', id: item.id, until: '2026-09-06T01:00:00Z' }, now);
    if (!deferred.ok) throw new Error('invalid fixture');
    expect(selectQueueItem(deferred.data, item.id, '2026-09-06T01:00:00Z').ok).toBe(true);
  });
  it('defaults off and requires an explicit opt-in before adding', () => {
    const queue = createQueue(task.workspaceId);
    expect(queue.enabled).toBe(false); expect(queue.items).toEqual([]);
    expect(updateQueue(queue, { type: 'add', item }, now).ok).toBe(false);
    const enabled = updateQueue(queue, { type: 'enable' }, now);
    if (!enabled.ok) throw new Error('invalid fixture');
    expect(updateQueue(enabled.data, { type: 'add', item }, now)).toMatchObject({ ok: true, data: { items: [{ status: 'ready', nodeRef: item.nodeRef }] } });
  });
  it('supports defer, skip, removal and closing without a task gate', () => {
    const queue = { ...createQueue(task.workspaceId), enabled: true, items: [{ ...item, status: 'ready' as const, dueAt: now }] };
    const deferred = updateQueue(queue, { type: 'defer', id: item.id, until: '2026-09-06T01:00:00Z' }, now);
    expect(deferred).toMatchObject({ ok: true, data: { items: [{ status: 'deferred' }] } });
    expect(updateQueue(queue, { type: 'skip', id: item.id }, now)).toMatchObject({ ok: true, data: { items: [{ status: 'skipped' }] } });
    expect(updateQueue(queue, { type: 'remove', id: item.id }, now)).toMatchObject({ ok: true, data: { items: [] } });
    expect(updateQueue(queue, { type: 'disable' }, now)).toMatchObject({ ok: true, data: { enabled: false, items: [{ id: item.id }] } });
    expect(queue.items[0]?.status).toBe('ready');
  });
  it('bounds the queue and rejects foreign references, duplicate versions and invalid dates', () => {
    const queue = { ...createQueue(task.workspaceId), enabled: true };
    expect(updateQueue(queue, { type: 'add', item: { ...item, nodeRef: { ...item.nodeRef, workspaceId: 'other' } } }, now)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const added = updateQueue(queue, { type: 'add', item }, now);
    if (!added.ok) throw new Error('invalid fixture');
    expect(updateQueue(added.data, { type: 'add', item: { ...item, id: 'duplicate' } }, now).ok).toBe(false);
    expect(updateQueue(added.data, { type: 'defer', id: item.id, until: '2020-01-01T00:00:00Z' }, now).ok).toBe(false);
    const full = { ...queue, items: Array.from({ length: 5 }, (_, index) => ({ ...item, id: `q-${index}`, nodeRef: { ...item.nodeRef, objectId: `node-${index + 2}` }, status: 'ready' as const, dueAt: now })) };
    expect(updateQueue(full, { type: 'add', item }, now).ok).toBe(false);
  });
});
