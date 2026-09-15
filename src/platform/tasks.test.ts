import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import type { RequestContext, Result } from '../contracts/api';
import type { TaskSaveRequest, TaskState } from '../contracts/task-record';
import { createApp } from '../server/app';
import { contentHash } from '../contracts/hash';
import { createServices } from './services';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });
function data<T>(result: Result<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
async function setup() {
  mkdirSync('.local/fixture', { recursive: true }); const dir = mkdtempSync(resolve('.local/fixture/tasks-')), file = join(dir, 'state.sqlite');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = await platformFixture(file); let journal = f.journal; cleanup.push(() => journal.close()); let services = f.services;
  const request: TaskSaveRequest = { operationId: 'save-task-A', task: { id: 'task-A', workspaceId: f.ctx.workspaceId,
    question: 'Private current task, not automatic query history', constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() },
    expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  return { ...f, file, request, services: () => services, reopen() { journal.close(); journal = new OperationJournal(file, { fixture: true });
    services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }); } };
}
async function newContext(f: Awaited<ReturnType<typeof setup>>, scopes = [...f.ctx.scopes], actorId = f.ctx.actorId): Promise<RequestContext> {
  const workspace = data(await f.services().workspace(f.ctx)), token = f.sessions.issue({ actorId, workspace, scopes });
  return data(f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
}

describe('W2-REQ-006 private task storage through actual Services and SQLite', () => {
  it('explicitly saves a task through the shared HTTP route and restores its exact original receipt after restart', async () => {
    const f = await setup(), app = createApp(f.services());
    const response = await app.request('/api/workspace/tasks', { method: 'POST', headers: f.headers, body: JSON.stringify(f.request) });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const saved = data(await response.json() as Result<TaskState>);
    expect(saved).toMatchObject({ id: f.request.task.id, state: 'available', revision: 1, task: f.request.task, retentionDays: 30, absenceIsFinal: false });
    f.reopen(); const reopened = createApp(f.services());
    expect(data(await (await reopened.request(`/api/workspace/tasks/${saved.id}`, { headers: f.headers })).json())).toEqual(saved);
    expect(data(await (await reopened.request(`/api/workspace/task-receipts/${f.request.operationId}`, { headers: f.headers })).json())).toMatchObject({ operationId: f.request.operationId,
      taskId: saved.id, previousRevision: 0, revision: 1, contentHash: await contentHash(f.request.task), requestHash: await contentHash(f.request), outcome: 'saved' });
    expect(f.git.publish).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it('performs exact idempotency and two-connection CAS without mistaking a newer version for the original save', async () => {
    const f = await setup(), otherJournal = new OperationJournal(f.file, { fixture: true }); cleanup.push(() => otherJournal.close());
    const other = createServices({ ...f.options, journal: otherJournal, approvalAuthority: new ApprovalAuthority(f.sessions, otherJournal) });
    const a = f.request, b = { ...f.request, operationId: 'save-task-B', task: { ...f.request.task, question: 'Other current task' } };
    const results = await Promise.all([f.services().saveTask!(f.ctx, a), other.saveTask!(f.ctx, b)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'CONFLICT', dataState: 'preserved' } });
    const winner = results[0]!.ok ? a : b, saved = data(results.find((result) => result.ok)!);
    expect(data(await other.saveTask!(f.ctx, winner))).toEqual(saved);
    const receipt = data(await other.readTaskReceipt!(f.ctx, winner.operationId));
    expect((await other.saveTask!(f.ctx, { ...winner, task: { ...winner.task, question: 'Different full request under the same operation' } })).ok).toBe(false);
    const next = { ...winner, operationId: 'task-next', expectedRevision: saved.revision, expectedContentHash: saved.contentHash, task: { ...winner.task, question: 'A later explicitly saved task' } };
    expect(data(await other.saveTask!(f.ctx, next))).toMatchObject({ revision: 2, task: next.task });
    expect(await f.services().saveTask!(f.ctx, winner)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    f.reopen(); expect(data(await f.services().readTaskReceipt!(f.ctx, winner.operationId))).toEqual(receipt);
    expect(data(await f.services().readTaskState!(f.ctx, winner.task.id))).toMatchObject({ revision: 2, task: next.task });
  });
  it('rolls back payload, receipt and audit together and never writes without explicit consent or capacity', async () => {
    const f = await setup(), services = f.services();
    expect((await services.saveTask!(f.ctx, { ...f.request, confirmed: false } as never)).ok).toBe(false);
    const put = f.journal.putRecord.bind(f.journal);
    vi.spyOn(f.journal, 'putRecord').mockImplementation((...args) => args[2] === 'task_receipt' ? false : put(...args));
    expect(await services.saveTask!(f.ctx, f.request)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(data(await services.readTaskState!(f.ctx, f.request.task.id))).toMatchObject({ state: 'missing', absenceIsFinal: false });
    expect(data(await services.readTaskReceipt!(f.ctx, f.request.operationId))).toBeNull();
    expect(data(await services.audit(f.ctx))).toEqual([]);
    vi.restoreAllMocks(); vi.spyOn(f.journal, 'privatePayloadFits').mockReturnValue(false);
    expect(await services.saveTask!(f.ctx, f.request)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(data(await services.readTaskState!(f.ctx, f.request.task.id))).toMatchObject({ state: 'missing' });
  });
  it('keeps actor namespaces separate and checks trusted permissions before touching stored payloads', async () => {
    const f = await setup(), services = f.services(); data(await services.saveTask!(f.ctx, f.request));
    const foreign = await newContext(f, [...f.ctx.scopes], 'other-actor');
    expect(data(await services.readTaskState!(foreign, f.request.task.id))).toMatchObject({ state: 'missing', task: null, actorId: 'other-actor' });
    expect(data(await services.readTaskReceipt!(foreign, f.request.operationId))).toBeNull();
    const denied = await newContext(f, f.ctx.scopes.filter((scope) => !['task:read', 'task:write'].includes(scope)));
    const read = vi.spyOn(f.journal, 'record');
    for (const ctx of [denied, { ...f.ctx }]) {
      expect((await services.readTaskState!(ctx, f.request.task.id)).ok).toBe(false);
      expect((await services.saveTask!(ctx, f.request)).ok).toBe(false);
      expect((await services.readTaskReceipt!(ctx, f.request.operationId)).ok).toBe(false);
    }
    expect(read).not.toHaveBeenCalled(); f.sessions.revoke(f.token);
    expect((await services.readTaskState!(f.ctx, f.request.task.id)).ok).toBe(false); expect(read).not.toHaveBeenCalled();
  });
  it('preserves exact condition bindings and denies stale, foreign and newly blocked references', async () => {
    const f = await setup(), services = f.services();
    f.initial.nodes[0]!.conditions = [{ id: 'premise-A', text: 'A required premise', status: 'confirmed', evidenceIds: [] }];
    const check = { nodeRef: { workspaceId: f.ctx.workspaceId, objectId: 'k1', revision: f.base }, conditionId: 'premise-A', status: 'not_satisfied' as const, confirmedBy: f.ctx.actorId };
    const request = { ...f.request, task: { ...f.request.task, conditionChecks: [check] } };
    for (const changed of [{ ...check, confirmedBy: 'other-actor' }, { ...check, conditionId: 'unknown-premise' }, { ...check, nodeRef: { ...check.nodeRef, revision: 'b'.repeat(40) } }]) {
      expect((await services.saveTask!(f.ctx, { ...request, task: { ...request.task, conditionChecks: [changed] } })).ok).toBe(false);
    }
    const noKnowledge = await newContext(f, f.ctx.scopes.filter((scope) => scope !== 'knowledge:read'));
    expect((await services.saveTask!(noKnowledge, request)).ok).toBe(false);
    data(await services.saveTask!(f.ctx, request));
    expect((await services.readTaskState!(noKnowledge, request.task.id)).ok).toBe(false);
    f.journal.block(f.ctx.workspaceId, ['k1'], 'approved-delete'); f.reopen();
    expect(await f.services().readTaskState!(f.ctx, request.task.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await f.services().saveTask!(f.ctx, request)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(data(await f.services().readTaskReceipt!(f.ctx, request.operationId))).toMatchObject({ outcome: 'saved' });
  });
  it('expires only the task body after 30 days and retains the original receipt without renewing an old operation', async () => {
    const f = await setup(), services = f.services(), saved = data(await services.saveTask!(f.ctx, f.request));
    const original = data(await services.readTaskReceipt!(f.ctx, f.request.operationId));
    expect(f.journal.expirePrivatePayloads(saved.expiresAt!)).toBe(1);
    expect(JSON.stringify(f.journal.record(f.ctx.workspaceId, f.ctx.actorId, 'task', f.request.task.id)?.value)).not.toContain(f.request.task.question);
    f.reopen();
    expect(data(await f.services().readTaskState!(f.ctx, f.request.task.id))).toMatchObject({ state: 'expired', task: null, revision: 2 });
    expect(data(await f.services().readTaskReceipt!(f.ctx, f.request.operationId))).toEqual(original);
    expect(await f.services().saveTask!(f.ctx, f.request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const fresh = await f.services().readTaskState!(f.ctx, f.request.task.id);
    expect(data(fresh).expiresAt).toBe(saved.expiresAt);
  });
});
