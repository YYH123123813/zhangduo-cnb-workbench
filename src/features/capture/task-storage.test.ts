import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import { CONTRACT_VERSION, type TaskContext } from '../../contracts/domain';
import { contentHash } from '../../contracts/hash';
import { TaskSaveRequestSchema, type TaskReceipt, type TaskState } from '../../contracts/task-record';
import { ctx, sessionFixture } from './fixtures.test-support';
import { CaptureTaskFlow } from './task-storage';
import { taskForStorage, taskDraftFromContext, taskForStorageAtState } from './task';

const ok = <T>(data: T): ApiResponse<T> => ({ ok: true, data, meta: { requestId: 'fixture', mode: 'fixture', contractVersion: CONTRACT_VERSION } });
async function setup() {
  const task: TaskContext = { id: 'original-task', workspaceId: ctx.workspaceId, question: 'Original task question', constraints: [{ id: 'constraint-A', text: 'Original limit', confirmedBy: ctx.actorId }],
    conditionChecks: [{ nodeRef: { workspaceId: ctx.workspaceId, objectId: 'node-A', revision: 'a'.repeat(40) }, conditionId: 'condition-A', status: 'unknown' }], sourceIssueNumber: 7, mode: 'assisted', updatedAt: new Date().toISOString() };
  let state: TaskState = { id: task.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, state: 'missing', revision: 0, task: null, contentHash: null, retentionDays: 30, absenceIsFinal: false };
  let receipt: TaskReceipt | null = null;
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
    if (path === '/api/workspace/session') return ok(sessionFixture);
    if (path === '/api/workspace/tasks') {
      const body = TaskSaveRequestSchema.parse(JSON.parse(String(init!.body)));
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      state = { ...state, state: 'available', revision: 1, task: body.task, contentHash: await contentHash(body.task), expiresAt };
      receipt = { operationId: body.operationId, taskId: task.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId, requestHash: await contentHash(body), contentHash: state.contentHash!, previousRevision: 0, revision: 1, storedAt: new Date().toISOString(), expiresAt, retentionDays: 30, outcome: 'saved' };
      return ok(state);
    }
    return path.includes('task-receipts/') ? ok(receipt) : ok(state);
  });
  const flow = new CaptureTaskFlow(request);
  return { task, request, flow, state: () => state, receipt: () => receipt, setState: (value: TaskState) => { state = value; } };
}

describe('C01 consent-bound task storage consumer', () => {
  it('never writes without explicit consent or before reading the original task CAS', async () => {
    const s = await setup(); await s.flow.save(s.task, true); await s.flow.load(s.task.id, ctx.workspaceId); await s.flow.save(s.task, false);
    expect(s.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(s.flow.getSnapshot().pending).toBeNull();
  });
  it('saves the complete task with separate 30-day consent and exact original request/receipt hashes', async () => {
    const s = await setup(); const locks: string[] = []; s.flow.subscribe(() => locks.push(s.flow.getLeaveState()));
    await s.flow.load(s.task.id, ctx.workspaceId); await s.flow.save(s.task, true);
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'saved', remote: { task: s.task, revision: 1 }, receipt: s.receipt() });
    const body = TaskSaveRequestSchema.parse(JSON.parse(String(s.request.mock.calls.find(([path]) => path === '/api/workspace/tasks')![1]!.body)));
    expect(body).toMatchObject({ task: s.task, operationId: expect.any(String), expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true });
    expect(s.flow.getSnapshot().pending?.requestHash).toBe(await contentHash(body));
    expect(s.flow.getLeaveState()).toBe('clean');
    expect(locks.at(-1)).toBe('clean');
  });
  it('retains an unknown original write, refuses repeats and recovers by GET only', async () => {
    const s = await setup(), normal = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => { const value = await normal(path, init); if (path === '/api/workspace/tasks') throw Error('Synthetic lost task response'); return value; });
    await s.flow.load(s.task.id, ctx.workspaceId); await s.flow.save(s.task, true);
    expect(s.flow.getLeaveState()).toBe('blocked'); const original = s.flow.getSnapshot().pending;
    await s.flow.cancel(); await s.flow.load('other-task'); await s.flow.save({ ...s.task, question: 'Changed' }, true);
    expect(s.flow.getSnapshot().pending).toBe(original);
    await s.flow.readBack(); expect(s.flow.getSnapshot()).toMatchObject({ phase: 'saved', receipt: s.receipt() });
    expect(s.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('does not accept null or a same-content foreign receipt as proof of the original save', async () => {
    const s = await setup(); await s.flow.load(s.task.id, ctx.workspaceId);
    const normal = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => { const value = await normal(path, init); if (path === '/api/workspace/tasks') throw Error('Lost'); return value; });
    await s.flow.save(s.task, true);
    for (const changed of [null, { ...s.receipt(), operationId: 'another-operation' }, { ...s.receipt(), actorId: 'another-actor' }, { ...s.receipt(), requestHash: 'a'.repeat(64) }]) {
      s.request.mockImplementation(async (path, init) => path.includes('task-receipts/') ? ok(changed) : normal(path, init));
      await s.flow.readBack(); expect(s.flow.getSnapshot().phase).toBe('unknown'); expect(s.flow.getLeaveState()).toBe('blocked');
    }
  });
  it('confirms an old receipt without overwriting a newer task revision', async () => {
    const s = await setup(); await s.flow.load(s.task.id); await s.flow.save(s.task, true);
    const next = { ...s.task, question: 'Newer task question' };
    s.setState({ ...s.state(), task: next, revision: 2, contentHash: await contentHash(next) });
    await s.flow.readBack();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'saved', receipt: { revision: 1 }, remote: { revision: 2, task: next } });
    expect(s.flow.getSnapshot().pending?.request.task).toEqual(s.task);
  });
  it('does not fabricate missing/expired tasks and removes stale private read data after permission failure', async () => {
    const s = await setup(); await s.flow.load(s.task.id); expect(s.flow.getSnapshot().remote?.task).toBeNull();
    await s.flow.save(s.task, true); s.setState({ ...s.state(), task: null, state: 'expired', revision: 2 });
    await s.flow.load(s.task.id); expect(s.flow.getSnapshot().remote).toMatchObject({ state: 'expired', task: null });
    s.request.mockResolvedValueOnce({ ok: false, error: { code: 'FORBIDDEN', message: 'Denied', dataState: 'preserved', nextAction: 'check_permissions', retryable: false }, meta: ok(null).meta });
    await s.flow.load(s.task.id); expect(s.flow.getSnapshot()).toMatchObject({ phase: 'failed', remote: null });
  });
  it('preserves the original structured task on restore and clears attribution only for edited constraints', async () => {
    const s = await setup(), restored = taskDraftFromContext(s.task); if (!restored.ok) throw Error('Expected draft');
    const result = taskForStorage(restored.data, ctx.workspaceId, s.task, s.task.updatedAt);
    expect(result).toEqual({ ok: true, data: s.task });
    const changed = taskForStorage({ ...restored.data, constraints: [{ id: 'constraint-A', text: 'Edited limit' }] }, ctx.workspaceId, s.task, s.task.updatedAt);
    expect(changed).toMatchObject({ ok: true, data: { conditionChecks: s.task.conditionChecks, sourceIssueNumber: 7, constraints: [{ id: 'constraint-A', text: 'Edited limit' }] } });
    if (changed.ok) expect(changed.data.constraints[0]).not.toHaveProperty('confirmedBy');
  });
  it.each(['different_content', 'same_content_new_revision', 'missing', 'expired'])('does not rebase an edited original task onto %s during preview', async (fault) => {
    const s = await setup(); await s.flow.load(s.task.id); await s.flow.save(s.task, true);
    const original = { task: s.task, revision: 1 }, draft = taskDraftFromContext(s.task);
    if (!draft.ok) throw Error('Expected original draft');
    const edited = { ...draft.data, question: 'My unsaved edit of the original task' };
    const otherTask = { ...s.task, question: 'Concurrent task edit' };
    const remote: TaskState = fault === 'missing' ? { id: s.task.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, state: 'missing', revision: 0, task: null, contentHash: null, retentionDays: 30, absenceIsFinal: false }
      : fault === 'expired' ? { ...s.state(), state: 'expired', task: null, revision: 2 }
      : { ...s.state(), revision: 2, ...(fault === 'different_content' ? { task: otherTask, contentHash: await contentHash(otherTask) } : {}) };
    expect(await taskForStorageAtState(edited, remote, original)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(edited.question).toBe('My unsaved edit of the original task');
  });
  it('previews a new task or the explicitly restored exact revision, keeping full original context', async () => {
    const s = await setup(), draft = taskDraftFromContext(s.task); if (!draft.ok) throw Error('Expected original draft');
    await s.flow.load(s.task.id);
    expect(await taskForStorageAtState(draft.data, s.state())).toMatchObject({ ok: true });
    await s.flow.save(s.task, true);
    expect(await taskForStorageAtState(draft.data, s.state())).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await taskForStorageAtState({ ...draft.data, question: 'My current edit' }, s.state(), { task: s.task, revision: 1 })).toMatchObject({ ok: true, data: { question: 'My current edit', conditionChecks: s.task.conditionChecks, sourceIssueNumber: 7, constraints: s.task.constraints } });
  });
});
