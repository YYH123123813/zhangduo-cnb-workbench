import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../contracts/api';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import type { TaskReceipt, TaskSaveRequest, TaskState } from '../../contracts/task-record';
import { contentHash } from '../../contracts/hash';
import { failure, success } from './errors';
import { ensureReviewTask, readReviewTaskOperation, readReviewTaskState, type ReviewTaskTransport } from './review-task';

const ctx: RequestContext = { requestId: 'request-1', actorId: 'actor-1', workspaceId: 'workspace-1', mode: 'fixture', scopes: ['task:read', 'task:write', 'knowledge:read', 'evidence:write'] };
const task = { id: 'task-review-1', workspaceId: ctx.workspaceId, question: 'Original task', constraints: [{ id: 'limit', text: 'Keep the fixed boundary', confirmedBy: ctx.actorId }], mode: 'assisted' as const, updatedAt: '2026-09-05T00:00:00Z' };
const taskHash = await contentHash(task);
const originalRequest: TaskSaveRequest = { operationId: 'task-save-1', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
const originalRequestHash = await contentHash(originalRequest);
const consent = () => ({ confirmed: true, onPending: vi.fn<(request: TaskSaveRequest) => void>() });
const recovery: OperationRecovery = { kind: 'task', operationId: 'task-save-1', actorId: ctx.actorId, workspaceId: ctx.workspaceId,
  approvalId: null, recordId: task.id, purpose: null, requestHash: 'a'.repeat(64), contentHash: taskHash, baseRevision: null,
  objectIds: [], approvalExpiresAt: null, stage: 'saved', readOnly: true, absenceIsFinal: false };

function state(overrides: Partial<TaskState> = {}): TaskState {
  return { id: task.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, state: 'missing', revision: 0, task: null,
    contentHash: null, retentionDays: 30, absenceIsFinal: false, ...overrides };
}

function receipt(operationId: string, overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  return { operationId, taskId: task.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, requestHash: originalRequestHash,
    contentHash: taskHash, previousRevision: 0, revision: 1, storedAt: '2026-09-05T01:00:00Z', expiresAt: '2026-10-05T01:00:00Z', retentionDays: 30, outcome: 'saved', ...overrides };
}

function available(revision = 1): TaskState {
  return state({ state: 'available', revision, task, contentHash: taskHash, expiresAt: '2026-10-05T01:00:00Z' });
}

describe('S07 original task persistence before starting an attempt', () => {
  it('waits for separate recovery retention and never saves the task after an unknown anchor response', async () => {
    const transport = vi.fn<ReviewTaskTransport>(async () => success(state()));
    const options = { ...consent(), beforeSave: vi.fn(async () => failure<true>('UNKNOWN_RESULT', 'Recovery retention lost', 'read_original_operation', 'unknown')) };
    expect(await ensureReviewTask(transport, ctx, task, 'task-save-1', options)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(options.beforeSave).toHaveBeenCalledWith(originalRequest);
    expect(options.onPending).not.toHaveBeenCalled();
    expect(transport.mock.calls).toHaveLength(1);
  });
  it('uses an exact existing task without writing or rebasing it', async () => {
    const transport = vi.fn(async (path: string) => success(path.includes('/tasks/task-review-1') ? available() : null));
    const result = await ensureReviewTask(transport, ctx, task, 'task-save-1', consent());
    expect(result).toMatchObject({ ok: true, data: { state: available() } });
    expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0]![0]).toBe('/api/workspace/tasks/task-review-1');
  });

  it('saves a missing task with explicit 30-day consent, then verifies its receipt and state', async () => {
    const requestHashes: string[] = [];
    let stateReads = 0;
    const transport = vi.fn<ReviewTaskTransport>(async (path, init) => {
      if (path === `/api/workspace/tasks/${task.id}`) { stateReads += 1; return success(stateReads === 1 ? state() : available()); }
      if (path === '/api/workspace/tasks') { requestHashes.push(await contentHash(JSON.parse(String(init?.body)))); return success(available()); }
      if (path === '/api/workspace/task-receipts/task-save-1') return success(receipt('task-save-1', { requestHash: requestHashes[0] }));
      return failure('UPSTREAM', `Unexpected read ${path}`);
    });
    const options = consent();
    const result = await ensureReviewTask(transport, ctx, task, 'task-save-1', options);
    expect(result).toMatchObject({ ok: true, data: { state: available(), receipt: { operationId: 'task-save-1', taskId: task.id } } });
    expect(JSON.parse(String(transport.mock.calls[1]![1]?.body))).toMatchObject({ operationId: 'task-save-1', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true });
    expect(options.onPending).toHaveBeenCalledWith(originalRequest);
  });

  it('recovers a saved task after a lost save response without retrying the mutation', async () => {
    let writes = 0;
    let stateReads = 0;
    const transport = vi.fn<ReviewTaskTransport>(async (path, init) => {
      if (path === `/api/workspace/tasks/${task.id}`) { stateReads += 1; return success(stateReads === 1 ? state() : available()); }
      if (path === '/api/workspace/tasks') { writes += 1; return failure('UNKNOWN_RESULT', 'Lost response', 'read_task_receipt', 'unknown'); }
      if (path === '/api/workspace/task-receipts/task-save-1') return success(receipt('task-save-1', { requestHash: await contentHash({ operationId: 'task-save-1', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true }) }));
      if (path === '/api/workspace/operation-recovery/task/task-save-1') return success(recovery);
      return failure('UPSTREAM', `Unexpected read ${path}`);
    });
    const result = await ensureReviewTask(transport, ctx, task, 'task-save-1', consent());
    expect(result).toMatchObject({ ok: true, data: { receipt: { operationId: 'task-save-1' } } }); expect(writes).toBe(1);
  });

  it('keeps an unknown task save blocked when receipt and recovery are not conclusive', async () => {
    const transport = vi.fn<ReviewTaskTransport>(async (path) => {
      if (path === `/api/workspace/tasks/${task.id}`) return success(state());
      if (path === '/api/workspace/tasks') return failure('UNKNOWN_RESULT', 'Lost response', 'read_task_receipt', 'unknown');
      if (path === '/api/workspace/task-receipts/task-save-1') return success(null);
      if (path === '/api/workspace/operation-recovery/task/task-save-1') return success({ ...recovery, stage: 'unknown', recordId: null, contentHash: null, requestHash: null });
      return failure('UPSTREAM', `Unexpected read ${path}`);
    });
    const result = await ensureReviewTask(transport, ctx, task, 'task-save-1', consent());
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('recovers an applied task save from W12 metadata, receipt and exact task state without posting again', async () => {
    const appliedReceipt = receipt('task-save-1');
    const transport = vi.fn<ReviewTaskTransport>(async (path, init) => {
      if (path === '/api/workspace/operation-recovery/task/task-save-1') return success({ ...recovery, requestHash: appliedReceipt.requestHash });
      if (path === '/api/workspace/task-receipts/task-save-1') return success(appliedReceipt);
      if (path === `/api/workspace/tasks/${task.id}`) return success(available());
      return failure('UPSTREAM', `Unexpected request ${path}`);
    });
    const result = await readReviewTaskOperation(transport, ctx, originalRequest);
    expect(result).toMatchObject({ ok: true, data: { state: available(), receipt: { operationId: 'task-save-1' } } });
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it.each(['identity', 'content', 'revision'] as const)('checks existing task %s without claiming a new save operation', async (kind) => {
    const current = kind === 'identity' ? { ...available(), actorId: 'other' } : kind === 'content' ? { ...available(), contentHash: 'c'.repeat(64) } : { ...available(), revision: 2 };
    const transport = vi.fn(async () => success(current));
    const result = await ensureReviewTask(transport, ctx, task, 'task-save-1', consent());
    if (kind === 'revision') expect(result).toMatchObject({ ok: true, data: { state: { revision: 2 } } });
    else expect(result).toMatchObject({ ok: false, error: { code: kind === 'identity' || kind === 'content' ? 'UNKNOWN_RESULT' : 'CONFLICT' } });
  });

  it('requires explicit consent before reading or saving the original task', async () => {
    const transport = vi.fn<ReviewTaskTransport>(async () => success(state()));
    const options = { ...consent(), confirmed: false };
    expect(await ensureReviewTask(transport, ctx, task, 'task-save-1', options)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'not_written' } });
    expect(transport).not.toHaveBeenCalled(); expect(options.onPending).not.toHaveBeenCalled();
  });

  it('does not accept matching remote hashes for a different original CAS request', async () => {
    const anotherRequestHash = await contentHash({ ...originalRequest, expectedRevision: 1, expectedContentHash: taskHash });
    const transport = vi.fn<ReviewTaskTransport>(async (path) => {
      if (path.includes('operation-recovery')) return success({ ...recovery, requestHash: anotherRequestHash });
      if (path.includes('task-receipts')) return success(receipt('task-save-1', { requestHash: anotherRequestHash, previousRevision: 1, revision: 2 }));
      return success(available(2));
    });
    expect(await readReviewTaskOperation(transport, ctx, originalRequest)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(transport.mock.calls.some(([path]) => path === `/api/workspace/tasks/${task.id}`)).toBe(false);
  });

  it('reads an existing task by its ID without fabricating a save receipt or sending a mutation', async () => {
    const transport = vi.fn<ReviewTaskTransport>(async () => success(available()));
    expect(await readReviewTaskState(transport, ctx, task.id)).toEqual(success(available()));
    expect(transport).toHaveBeenCalledExactlyOnceWith(`/api/workspace/tasks/${task.id}`);
  });

  it('rejects corrupted task contents and a later task replacing the exact upstream task', async () => {
    const changed = { ...task, question: 'Another task under the same ID' };
    for (const current of [available(), { ...available(2), task: changed, contentHash: await contentHash(changed) }]) {
      const expected = current.revision === 1 ? { ...current, task: changed } : current;
      const transport = vi.fn<ReviewTaskTransport>(async () => success(expected));
      expect(await readReviewTaskState(transport, ctx, task.id, task)).toMatchObject({ ok: false });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['missing', 'expired'] as const)('keeps a %s task explicitly unavailable with zero writes', async (phase) => {
    const remote = phase === 'missing' ? state() : { ...available(), state: 'expired' as const, task: null };
    const transport = vi.fn<ReviewTaskTransport>(async () => success(remote));
    expect(await readReviewTaskState(transport, ctx, task.id)).toEqual(success(remote));
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
});
