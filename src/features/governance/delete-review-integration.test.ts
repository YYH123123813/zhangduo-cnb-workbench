import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import type { ApiResponse, Result } from '../../contracts/api';
import type { Approval, DeletePlan, TaskContext } from '../../contracts/domain';
import type { ReviewQuestion, ReviewOperationReceipt } from '../../contracts/review-session';
import { hashDeletePlan } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import { ApprovalAuthority } from '../../platform/approvals';
import { OperationJournal } from '../../platform/journal';
import { createServices } from '../../platform/services';
import { createApp } from '../../server/app';
import { post, type RequestApi } from './approval-flow';
import { DataFlow } from './data-flow';
import type { previewDeletion } from './deletion';
import type { OperationInspection } from './operation-readback';
import { OperationSummary } from './operation-view';
import { DataControls } from './views';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function data<T>(result: Result<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error(result.error.message);
  return result.data;
}
type DeletePreview = Awaited<ReturnType<typeof previewDeletion>>;

async function setup(persistent = false) {
  let file = ':memory:';
  if (persistent) {
    mkdirSync('.local/fixture', { recursive: true });
    const directory = mkdtempSync(resolve('.local/fixture/governance-review-delete-'));
    file = join(directory, 'state.sqlite');
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  }
  const base = await platformFixture(file);
  base.initial.nodes.push({ ...base.node, id: 'k2', title: 'Unselected knowledge' });
  const questions: ReviewQuestion[] = ['k1', 'k2'].map((nodeId) => ({
    id: `question-${nodeId}`, workspaceId: base.ctx.workspaceId, revision: 'fixture:question-v1',
    nodeRef: { workspaceId: base.ctx.workspaceId, objectId: nodeId, revision: base.base },
    kind: 'recall', prompt: `Private reviewed prompt ${nodeId}`, standardAnswer: `Private standard answer ${nodeId}`,
    hints: [`Private first hint ${nodeId}`, `Private second hint ${nodeId}`, `Private third hint ${nodeId}`],
    rubric: { version: 'fixture:rubric-v1', criteria: [{ id: 'criterion', description: 'State the premise', expectedEvidence: `Private rubric ${nodeId}`, required: true }], necessaryConditions: [] },
    review: { status: 'approved', reviewedBy: 'fixture-reviewer', reviewedAt: new Date().toISOString() },
  }));
  let journal = base.journal;
  cleanups.push(() => journal.close());
  let services = createServices({ ...base.options, reviewQuestions: questions });
  let app = createApp(services);
  const request = vi.fn<RequestApi>(async (path, init) => (await app.request(path, { ...init, headers: base.headers })).json());
  async function send<T>(path: string, body?: unknown): Promise<T> {
    const response = await request(path, body === undefined ? undefined : post(body));
    return data(response as ApiResponse<T>);
  }
  const receipts: ReviewOperationReceipt[] = [];
  for (const question of questions) {
    const id = question.nodeRef.objectId;
    const task: TaskContext = { id: `task-${id}`, workspaceId: base.ctx.workspaceId, question: `Private task ${id}`, constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() };
    const saved = data(await services.saveTask!(base.ctx, { operationId: `task-save-${id}`, task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true }));
    const start = data(await services.startReviewAttempt!(base.ctx, { operationId: `attempt-${id}`, taskId: task.id, taskRevision: saved.revision,
      taskContentHash: saved.contentHash!, questionId: question.id, questionRevision: question.revision, nodeRef: question.nodeRef, retentionDays: 30, confirmed: true }));
    receipts.push(start);
    const events = [{ type: 'confidence', value: 'low' }, { type: 'begin' }, { type: 'reveal' }, { type: 'submit', answer: `Private submitted answer ${id}` }] as const;
    for (const [expectedVersion, event] of events.entries()) receipts.push(data(await services.applyReviewEvent!(base.ctx, {
      operationId: `${event.type}-${id}`, attemptId: start.attemptId, expectedVersion, event,
    })));
  }
  const preview = (objectIds = ['k1']) => send<DeletePreview>('/api/governance/delete/preview', { action: 'preview', objectIds, baseRevision: base.base });
  const flow = async () => {
    const previewed = await preview();
    const value = new DataFlow(request);
    value.prepare({ kind: 'delete', workspaceId: base.ctx.workspaceId, preview: previewed }, base.ctx.actorId);
    return { flow: value, preview: previewed, plan: previewed.plan };
  };
  return { ...base, questions, receipts, request, send, preview, flow,
    get services() { return services; }, get journal() { return journal; }, get app() { return app; },
    reopen() {
      journal.close(); journal = new OperationJournal(file, { fixture: true });
      // Reopen the persisted catalog, without importing a second copy of deleted question bodies.
      services = createServices({ ...base.options, journal, approvalAuthority: new ApprovalAuthority(base.sessions, journal) });
      app = createApp(services);
    },
  };
}

async function expectReviewPresent(s: Awaited<ReturnType<typeof setup>>, id = 'k1') {
  expect(data(await s.services.readReviewAttempt!(s.ctx, `attempt-${id}`))).toMatchObject({ submission: { answer: `Private submitted answer ${id}` } });
  expect(s.journal.records(s.ctx.workspaceId, s.ctx.actorId, 'review_exposure').some((row) => JSON.stringify(row.value).includes(id))).toBe(true);
  expect(s.journal.blocked(s.ctx.workspaceId)).not.toContain(id);
}

describe('review_private_state with actual shared Services, SQLite and public HTTP', () => {
  it('previews the exact new layer but does not clean before explicit approval and execution', async () => {
    const s = await setup(); const { flow, preview, plan } = await s.flow();
    expect(preview.layers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'review_private_state', label: '审核题、作答与答案暴露记录', capability: 'supported', reversible: false })]));
    expect(data(await s.services.readDeletePlan!(s.ctx, plan.id))).toEqual(plan);
    expect(await s.send(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}`)).toEqual(plan);
    expect(await hashDeletePlan(plan)).toBe(plan.contentHash);
    expect(await s.request('/api/governance/delete/execute', post({ action: 'execute', plan }))).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await s.request('/api/workspace/approvals/governance', post({ purpose: 'delete', planId: plan.id, confirmed: false }))).toMatchObject({ ok: false });
    await flow.commit();
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/delete/execute'))).toHaveLength(1);
    await expectReviewPresent(s);
    expect(await s.send(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}/report`)).toBeNull();
    const inspection = await s.send<OperationInspection>(`/api/governance/operations/delete/${encodeURIComponent(plan.id)}`);
    const html = renderToStaticMarkup(createElement(OperationSummary, { data: inspection }));
    expect(html).toContain('审核题、作答与答案暴露记录'); expect(html).toContain('不能据此认定未执行');
    expect(html).not.toContain('报告尚未登记');
    await flow.approve(); expect(flow.getSnapshot().stage).toBe('approved');
    expect(flow.getSnapshot().approval).toMatchObject({ contentHash: plan.contentHash, objectIds: plan.objectIds, baseRevision: plan.baseRevision, actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId });
    await expectReviewPresent(s);
    await flow.revoke(); expect(flow.getSnapshot().stage).toBe('idle');
    await expectReviewPresent(s);
  });

  it('cleans only associated row bodies, reads the original report and retains minimal event receipts', async () => {
    const s = await setup(); const { flow, plan } = await s.flow();
    const execute = vi.spyOn(s.services, 'executeDelete');
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('succeeded');
    const original = data(await s.services.readDeleteReport!(s.ctx, plan.id))!;
    expect(original.planId).toBe(plan.id);
    expect(original.layers.map((layer) => layer.name)).toEqual(plan.layers.map((layer) => layer.name));
    expect(original.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'application', state: 'done' }), expect.objectContaining({ name: 'review_private_state', state: 'done' }),
      expect.objectContaining({ name: 'worktree', state: 'unsupported' }), expect.objectContaining({ name: 'backup', state: 'unknown' }),
    ]));
    expect(await s.send(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}/report`)).toEqual(original);
    expect(data(await s.services.readReviewAttempt!(s.ctx, 'attempt-k1'))).toBeNull();
    expect(await s.services.readReviewQuestions!(s.ctx, { nodeId: 'k1', revision: s.base })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const rows = JSON.stringify([...s.journal.records(s.ctx.workspaceId, '@workspace', 'review_question'), ...s.journal.records(s.ctx.workspaceId, '@workspace', 'review_attempt')]);
    for (const text of [s.questions[0]!.prompt, s.questions[0]!.standardAnswer, s.questions[0]!.hints[0], 'Private submitted answer k1', 'Private rubric k1']) expect(rows).not.toContain(text);
    expect(s.journal.record(s.ctx.workspaceId, '@workspace', 'review_attempt', 'attempt-k1')?.value).toMatchObject({ state: 'expired', attempt: null });
    expect(s.journal.records(s.ctx.workspaceId, s.ctx.actorId, 'review_exposure').map((row) => row.value)).toEqual([expect.objectContaining({ nodeRef: expect.objectContaining({ objectId: 'k2' }) })]);
    await expectReviewPresent(s, 'k2');
    for (const receipt of s.receipts.filter((item) => item.attemptId === 'attempt-k1')) {
      expect(data(await s.services.readReviewOperation!(s.ctx, receipt.operationId))).toMatchObject({ state: 'applied', receipt, retryAllowed: false, absenceIsFinal: false });
      expect(await s.send(`/api/learning/attempts/${receipt.operationId}?projection=receipt`)).toEqual(receipt);
    }
    for (const path of ['/api/learning/attempts/attempt-k1', `/api/learning/reviews?nodeId=k1&revision=${s.base}`]) {
      const response = await s.request(path); expect(response.ok).toBe(false);
      expect(JSON.stringify(response)).not.toContain(s.questions[0]!.prompt); expect(JSON.stringify(response)).not.toContain('Private submitted answer k1');
    }
    const inspection = await s.send<OperationInspection>(`/api/governance/operations/delete/${encodeURIComponent(plan.id)}`);
    expect(inspection).toMatchObject({ id: plan.id, readOnly: true, result: { physicalDeletionComplete: false, reportAvailable: true } });
    const html = renderToStaticMarkup(createElement(OperationSummary, { data: inspection }));
    const resultHtml = renderToStaticMarkup(createElement(DataControls, { state: flow.getSnapshot(), onApprove: vi.fn(), onCommit: vi.fn(), onVerify: vi.fn(), onRevoke: vi.fn(), onCancel: vi.fn(), onContinue: vi.fn() }));
    for (const text of [html, resultHtml]) {
      for (const part of ['审核题、作答与答案暴露记录', '最小原操作回执', '物理清除未核验', 'SQLite', '备份']) expect(text).toContain(part);
      expect(text).not.toContain('全部完成'); expect(text).not.toContain('Private submitted answer k1');
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(s.git.publish).not.toHaveBeenCalled();
    expect(s.transport.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('rejects an old approval without the new layer and rejects a changed full-plan hash', async () => {
    const s = await setup(); const { plan } = await s.flow();
    // Seed a pre-upgrade plan only; its approval is issued by the real shared authority.
    const legacy: DeletePlan = { ...plan, id: 'fixture-legacy-plan', layers: plan.layers.filter((layer) => layer.name !== 'review_private_state') };
    legacy.contentHash = await hashDeletePlan(legacy);
    expect(s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'delete_plan', legacy.id, legacy, null)).toBe(true);
    const oldApproval = await s.send<Approval>('/api/workspace/approvals/governance', { purpose: 'delete', planId: legacy.id, operationId: 'legacy-approval-operation', confirmed: true });
    expect(oldApproval.contentHash).toBe(legacy.contentHash); expect(oldApproval.contentHash).not.toBe(plan.contentHash);
    expect(await s.request('/api/governance/delete/execute', post({ action: 'execute', plan, approval: oldApproval }))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await s.services.executeDelete(s.ctx, plan, oldApproval)).toMatchObject({ ok: false });
    const approval = await s.send<Approval>('/api/workspace/approvals/governance', { purpose: 'delete', planId: plan.id, operationId: 'current-approval-operation', confirmed: true });
    const changed = { ...plan, layers: legacy.layers }; changed.contentHash = await hashDeletePlan(changed);
    expect(await s.request('/api/governance/delete/execute', post({ action: 'execute', plan: changed, approval }))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await s.services.executeDelete(s.ctx, changed, approval)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expectReviewPresent(s);
    expect(data(await s.services.readDeleteReport!(s.ctx, plan.id))).toBeNull();
  });

  it('rejects approval for another selected scope without cleaning either scope', async () => {
    const s = await setup(); const first = await s.preview(['k1']); const second = await s.preview(['k2']);
    const approval = await s.send<Approval>('/api/workspace/approvals/governance', { purpose: 'delete', planId: first.plan.id, operationId: 'scope-approval', confirmed: true });
    expect(await s.request('/api/governance/delete/execute', post({ action: 'execute', plan: second.plan, approval }))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await s.services.executeDelete(s.ctx, second.plan, approval)).toMatchObject({ ok: false });
    await expectReviewPresent(s); await expectReviewPresent(s, 'k2');
  });

  it.each(['actor', 'workspace'] as const)('rejects cross-%s execution and withholds the original plan/report', async (identity) => {
    const s = await setup(); const { flow, plan } = await s.flow(); await flow.approve();
    const workspace = data(await s.services.workspace(s.ctx));
    const token = s.sessions.issue({ actorId: identity === 'actor' ? 'other-actor' : s.ctx.actorId,
      workspace: identity === 'workspace' ? { ...workspace, id: 'other-workspace' } : workspace, scopes: Object.values(SCOPES) });
    const headers = { ...s.headers, Authorization: `Bearer ${token}` };
    const foreign = data(s.sessions.context(new Request('http://localhost', { headers })));
    expect(await s.services.executeDelete(foreign, plan, flow.getSnapshot().approval!)).toMatchObject({ ok: false,
      error: { code: identity === 'workspace' ? 'VALIDATION' : 'CONFLICT' } });
    const response = await s.app.request('/api/governance/delete/execute', { ...post({ action: 'execute', plan, approval: flow.getSnapshot().approval }), headers });
    // This transport exposes one workspace snapshot, so foreign HTTP reads fail before execution.
    expect(response.status).toBe(identity === 'workspace' ? 502 : 403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: identity === 'workspace' ? 'UPSTREAM' : 'FORBIDDEN' } });
    await expectReviewPresent(s);
    for (const suffix of ['', '/report']) {
      const read = await s.app.request(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}${suffix}`, { headers });
      expect(await read.json()).toMatchObject({ ok: true, data: null });
    }
    await flow.commit(); expect(flow.getSnapshot().stage).toBe('succeeded');
    const receipt = await s.app.request('/api/learning/attempts/submit-k1?projection=receipt', { headers });
    expect((await receipt.json()).ok).toBe(false);
    expect(await (await s.app.request(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}/report`, { headers })).json()).toMatchObject({ ok: true, data: null });
  });

  it('recovers a lost response and SQLite reopen by original planId without another deletion or Git restore bypass', async () => {
    const s = await setup(true); const { flow, plan } = await s.flow(); await flow.approve();
    const originalRequest = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const response = await originalRequest(path, init);
      if (path === '/api/governance/delete/execute') { expect(response.ok).toBe(true); throw Error('Lost actual execution response'); }
      return response;
    });
    await flow.commit(); expect(flow.getSnapshot().stage).toBe('unknown');
    const originalPrepared = flow.getSnapshot().prepared;
    const report = data(await s.services.readDeleteReport!(s.ctx, plan.id));
    s.reopen();
    expect(await s.send(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}/report`)).toEqual(report);
    const inspection = await s.send<OperationInspection>(`/api/governance/operations/delete/${encodeURIComponent(plan.id)}`);
    expect(inspection).toMatchObject({ id: plan.id, readOnly: true, result: { report: { planId: plan.id }, layers: expect.arrayContaining([expect.objectContaining({ name: 'review_private_state', state: 'done' })]), physicalDeletionComplete: false } });
    expect(data(await s.services.readReviewAttempt!(s.ctx, 'attempt-k1'))).toBeNull();
    expect(await s.send('/api/learning/attempts/submit-k1?projection=receipt')).toEqual(s.receipts.find((receipt) => receipt.operationId === 'submit-k1'));
    await flow.verify(); expect(flow.getSnapshot()).toMatchObject({ stage: 'succeeded', prepared: originalPrepared });
    expect(s.request.mock.calls.filter(([path]) => path === '/api/governance/delete/execute')).toHaveLength(1);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/workspace/approvals/governance')).toHaveLength(1);
    expect(data(await s.services.snapshot(s.ctx, s.base)).nodes.map((node) => node.id)).not.toContain('k1');
    expect(await s.request('/api/governance/rollback', post({ action: 'preview', operationId: 'cannot-restore-deleted-review', nodeId: 'k1', baseRevision: s.base, historicalRevision: s.base, reason: 'No barrier bypass' }))).toMatchObject({ ok: false });
    expect(await s.request('/api/governance/export', post({ action: 'preview', baseRevision: s.base, objectIds: ['k1'] }))).toMatchObject({ ok: false });
    expect(s.git.publish).not.toHaveBeenCalled(); expect(s.journal.blocked(s.ctx.workspaceId)).toContain('k1');
  });

  it('keeps a real report read failure unknown and preserves the original operation without blind retries', async () => {
    const s = await setup(); const { flow, plan } = await s.flow(); await flow.approve();
    const request = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const response = await request(path, init);
      if (path === '/api/governance/delete/execute') throw Error('Lost response');
      return response;
    });
    await flow.commit(); const prepared = flow.getSnapshot().prepared;
    const read = s.journal.record.bind(s.journal);
    const fault = vi.spyOn(s.journal, 'record').mockImplementation((...args) => {
      if (args[2] === 'delete_report' && args[3] === plan.id) throw Error('Injected SQLite read failure');
      return read(...args);
    });
    await flow.verify();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'unknown', prepared, result: null });
    expect(flow.invalidate()).toBe(false);
    await flow.approve(); await flow.commit();
    expect(s.request.mock.calls.filter(([path]) => path === '/api/governance/delete/execute')).toHaveLength(1);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/workspace/approvals/governance')).toHaveLength(1);
    fault.mockRestore(); await flow.verify(); expect(flow.getSnapshot().stage).toBe('succeeded');
  });
});
