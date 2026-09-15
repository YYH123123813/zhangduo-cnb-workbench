import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import { ApprovalAuthority } from '../../platform/approvals';
import { OperationJournal } from '../../platform/journal';
import type { ModelTransport } from '../../platform/model';
import type { ApiResponse } from '../../contracts/api';
import type { Approval, ChangeSet, CommitReceipt, DeletePlan, EvidenceRecord, RetrievalRequest, RetrievalResult, Settings, TaskConditionCheck } from '../../contracts/domain';
import { EvidenceApprovalRequestSchema, type EvidenceApprovalRequest, type EvidenceReceipt } from '../../contracts/evidence';
import { contentHash, hashEvidence } from '../../contracts/hash';
import type { ModelOperationReceipt } from '../../contracts/model';
import type { ApprovalRegistrationState } from '../../contracts/approval';
import { TransientRetrieval } from '../../app/transient-retrieval';
import { createAnswerFlow, answerLeaveState, type AnswerCall } from './answer-client';
import type { AnswerPreview, NodeDetail } from './api';
import { latestRead } from './client-state';
import { node, relation, time } from './test-support';
import { readRecoveryIdentity, retainRecoveryIdentity } from '../../app/recovery-client';
import { parseRoute, routeHash } from '../../app/routing';
import { createRestoredAnswerFlow } from './restored-answer';

const journals = new Set<OperationJournal>(); const directories: string[] = [];
afterEach(() => { journals.forEach((journal) => journal.close()); journals.clear(); directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
type ChangePreview = { changes: Omit<ChangeSet, 'contentHash'>; restoration?: { nodeId: string; historicalRevision: string } };

async function setup(withGraph = false, file = ':memory:') {
  const f = await platformFixture(file); journals.add(f.journal);
  const k1 = node('k1', { workspaceId: f.ctx.workspaceId, revision: '@snapshot', title: '方案A', question: '方案A何时适用？', humanStatement: '允许短暂旧数据时可选方案A',
    confirmedBy: f.ctx.actorId });
  const k2 = node('k2', { workspaceId: f.ctx.workspaceId, revision: '@snapshot', title: '页面时效要求', question: '当前页面的前提', humanStatement: '当前页面允许短暂旧数据',
    conditions: [{ id: 'stale-allowed', text: '当前页面允许短暂旧数据', status: 'unknown', evidenceIds: [] }], confirmedBy: f.ctx.actorId });
  const edge = relation('requires', 'k1', 'k2', 'depends_on', { workspaceId: f.ctx.workspaceId, proposedBy: f.ctx.actorId, confirmedBy: f.ctx.actorId,
    source: { workspaceId: f.ctx.workspaceId, objectId: 'k1', revision: '@snapshot' }, target: { workspaceId: f.ctx.workspaceId, objectId: 'k2', revision: '@snapshot' } });
  f.documents.set(f.base, { ...f.initial, nodes: [k1, k2], relations: withGraph ? [edge] : [] });
  const model = vi.fn<ModelTransport['complete']>(async () => ({ ok: true, data: { value: { claims: [{
    nodeRef: { workspaceId: f.ctx.workspaceId, objectId: 'k1', revision: f.base }, sourceId: 's-k1', quote: k1.humanStatement, text: k1.humanStatement,
  }] }, modelId: 'fixture-answer-model', generatedAt: time } }));
  const options = { ...f.options, model: { mode: 'fixture' as const, complete: model } };
  let services = createServices(options), app = createApp(services), currentJournal = f.journal;
  const raw = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal) => app.request(`http://localhost${path}`, {
    method, headers: f.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
  async function json<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await raw(path, body, method); const result = await response.json() as ApiResponse<T>;
    expect(result.ok, `${path}: ${JSON.stringify(result)}`).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(result.meta.mode).toBe('fixture');
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  }
  const request: RetrievalRequest = { task: { id: 'original-task', workspaceId: f.ctx.workspaceId, question: '方案A', constraints: [], mode: 'assisted', updatedAt: time }, query: '方案A', confirmedOnly: true };
  async function enableModel(enabled: boolean) {
    const current = await json<{ settings: Settings; baseRevision: string; currentHash: string; settingsRevision: number }>('/api/governance/settings');
    const settings = { ...current.settings, aiAnswer: enabled };
    const approval = await json<Approval>('/api/workspace/approvals/governance', { purpose: 'settings', baseRevision: current.baseRevision, settings,
      expectedSettingsRevision: current.settingsRevision, expectedSettingsHash: current.currentHash, confirmed: true });
    await json('/api/governance/settings', { action: 'execute', settings, baseRevision: current.baseRevision, expectedSettingsHash: current.currentHash,
      expectedSettingsRevision: current.settingsRevision, approval }, 'PATCH');
  }
  async function commit(preview: ChangePreview) {
    const prepared = await json<{ changes: ChangeSet }>('/api/governance/changes/prepare', { action: 'prepare', changes: preview.changes,
      ...(preview.restoration ? { restoration: preview.restoration } : {}) });
    const approval = await json<Approval>('/api/workspace/approvals/knowledge', { changes: prepared.changes, confirmed: true });
    const result = await json<{ receipt: CommitReceipt; snapshotVerified: boolean }>('/api/governance/changes/commit', {
      action: 'commit', changes: prepared.changes, approval, ...(preview.restoration ? { restoration: preview.restoration } : {}),
    });
    expect(result.receipt.indexing).toBe('pending'); expect(result.snapshotVerified).toBe(false);
    const verified = await json<{ receipt: CommitReceipt; snapshotVerified: boolean }>('/api/governance/changes/verify', { action: 'verify', changes: prepared.changes });
    expect(verified.snapshotVerified).toBe(true); expect(verified.receipt).toEqual(result.receipt);
    return result.receipt;
  }
  return { ...f, get services() { return services; }, options, get app() { return app; }, raw, json, model, request, enableModel, commit,
    query: () => json<RetrievalResult>('/api/retrieval/query', request),
    reopen() {
      currentJournal.close(); journals.delete(currentJournal);
      currentJournal = new OperationJournal(file, { fixture: true }); journals.add(currentJournal);
      services = createServices({ ...options, journal: currentJournal, approvalAuthority: new ApprovalAuthority(f.sessions, currentJournal) });
      app = createApp(services);
    },
  };
}

function persistentFile() {
  mkdirSync('.local/fixture', { recursive: true }); const directory = mkdtempSync(resolve('.local/fixture/retrieval-evidence-'));
  directories.push(directory); return join(directory, 'state.sqlite');
}
type SharedFixture = Awaited<ReturnType<typeof setup>>;
type StoragePreview = Omit<EvidenceApprovalRequest, 'confirmed'> & { actorId: string; persistence: 'not_saved'; indexing: 'excluded' };
async function recoveryClient(f: SharedFixture) {
  await f.enableModel(true);
  const session = { actorId: f.ctx.actorId, workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private' as const, mode: 'fixture' as const }, scopes: [...f.ctx.scopes] };
  let headers = f.headers;
  const transport = vi.fn<typeof fetch>(async (path, init) => f.app.request(String(path), { ...init, headers: { ...headers, ...init?.headers } }));
  const call = vi.fn<AnswerCall>(async (path, init) => (await transport(path, init)).json());
  const retain = vi.fn((input: Parameters<typeof retainRecoveryIdentity>[1]) => retainRecoveryIdentity(session, input, transport));
  const flow = createAnswerFlow({ request: f.request, actorId: f.ctx.actorId, reader: latestRead(), call, retainOperationRecovery: retain,
    onState: vi.fn(), onResult: vi.fn(), onFailure: vi.fn() });
  return { session, transport, call, retain, flow, reconnect() {
    const token = f.sessions.issue({ actorId: session.actorId, workspace: session.workspace, scopes: session.scopes });
    headers = { ...f.headers, Authorization: `Bearer ${token}` };
  } };
}

describe('1.26 retrieval retention and remounted controller, real Services/SQLite/HTTP with synthetic external transports', () => {
  it('retains before an approval lands with a lost response, reopens SQLite and reconnects the original actor using only GET', async () => {
    const f = await setup(false, persistentFile()), c = await recoveryClient(f);
    await c.flow.preview();
    c.call.mockImplementation(async (path, init) => {
      const response = await c.transport(path, init);
      if (path === '/api/workspace/approvals/model') throw Error('approval response lost after persistence');
      return response.json();
    });
    await c.flow.approve(true, true);
    expect(c.flow.state.uncertain).toBe(true); expect(c.flow.state.retention?.status).toBe('saved');
    const anchor = c.flow.state.retention!.identity!;
    expect(anchor.operation.operationId).toBe(c.flow.state.registration!.operationId);
    c.flow.detach(); f.reopen(); f.sessions.revoke(f.token);
    const route = parseRoute(routeHash({ page: 'retrieval', params: { recoveryId: anchor.id } }));
    expect(await readRecoveryIdentity(c.session, route, c.transport)).toMatchObject({ ok: false });
    const denied = createRestoredAnswerFlow({ call: async (path, init) => (await c.transport(path, init)).json(), onState: vi.fn() });
    await denied.restore({ identity: anchor, original: null, binding: 'unknown', readOnly: true, retryAllowed: false });
    expect(denied.state.status).toBe('unauthorized'); denied.dispose();
    c.reconnect(); c.transport.mockClear();
    const original = await readRecoveryIdentity(c.session, route, c.transport);
    expect(original).toMatchObject({ ok: true, data: { binding: 'matched', original: { operationId: anchor.operation.operationId, stage: 'approved' } } });
    if (!original.ok || !original.data) throw Error('Missing original recovery identity');
    expect(original.data.original?.approvalId).not.toBe(anchor.operation.operationId);
    const restored = createRestoredAnswerFlow({ call: async (path, init) => (await c.transport(path, init)).json(), onState: vi.fn() });
    await restored.restore(original.data); await restored.inspect(); await restored.inspect();
    expect(restored.state.status).toBe('matched'); expect(restored.leaveState()).toBe('blocked');
    expect(c.transport.mock.calls.every(([, init]) => init?.method === 'GET' && !init.body)).toBe(true);
    expect(JSON.stringify(restored.state)).not.toContain(f.request.query); expect(f.model).not.toHaveBeenCalled(); restored.dispose();
  });
  it('recovers a completed model after the response is lost without invoking the model twice', async () => {
    const f = await setup(false, persistentFile()), c = await recoveryClient(f);
    await c.flow.preview(); await c.flow.approve(true, true);
    c.call.mockImplementation(async (path, init) => {
      const response = await c.transport(path, init);
      if (path === '/api/retrieval/answer') throw Error('model response lost');
      return response.json();
    });
    await c.flow.send(); expect(f.model).toHaveBeenCalledTimes(1); expect(c.flow.state.uncertain).toBe(true);
    const anchor = c.flow.state.retention!.identity!; c.flow.detach(); f.reopen(); c.transport.mockClear();
    const recovered = await readRecoveryIdentity(c.session, { page: 'retrieval', params: { recoveryId: anchor.id } }, c.transport);
    if (!recovered.ok || !recovered.data) throw Error('Missing recovered operation');
    const page = createRestoredAnswerFlow({ call: async (path, init) => (await c.transport(path, init)).json(), onState: vi.fn() });
    await page.restore(recovered.data); await page.inspect();
    expect(page.state.metadata?.stage).toBe('done'); expect(page.leaveState()).toBe('blocked');
    expect(f.model).toHaveBeenCalledTimes(1); expect(c.transport.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(JSON.stringify(page.state)).not.toContain('允许短暂旧数据时可选方案A'); page.dispose();
  });
  it('does not retain anything without the separate consent, even when model approval is confirmed', async () => {
    const f = await setup(), c = await recoveryClient(f);
    await c.flow.preview(); await c.flow.approve(true);
    expect(c.retain).not.toHaveBeenCalled(); expect(await f.services.listRecoveryAnchors!(f.ctx)).toEqual({ ok: true, data: [] });
    expect(c.transport.mock.calls.some(([path]) => path === '/api/workspace/recovery-identities')).toBe(false); c.flow.detach();
  });
  it('keeps a lost identity-save response unknown and only finds it later through the shared list', async () => {
    const f = await setup(false, persistentFile()), c = await recoveryClient(f);
    c.retain.mockImplementation((input) => retainRecoveryIdentity(c.session, input, async (path, init) => {
      await c.transport(path, init); throw Error('retention response lost after SQLite commit');
    }));
    await c.flow.preview(); await c.flow.approve(true, true); await c.flow.approve(true, true); await c.flow.send();
    expect(c.flow.state.retention?.status).toBe('unknown'); expect(c.retain).toHaveBeenCalledTimes(1);
    expect(c.transport.mock.calls.some(([path]) => path === '/api/workspace/approvals/model')).toBe(false);
    c.flow.detach(); f.reopen();
    const anchors = await f.services.listRecoveryAnchors!(f.ctx); if (!anchors.ok) throw Error('Missing retained list');
    expect(anchors.data).toHaveLength(1);
    const read = await f.services.readRecoveryAnchor!(f.ctx, anchors.data[0]!.id);
    expect(read).toMatchObject({ ok: true, data: { binding: 'unknown', original: { stage: 'not_registered' } } });
    expect(f.model).not.toHaveBeenCalled();
  });
  it('isolates equal-content different operations and never extends their retention on GET', async () => {
    const f = await setup(false, persistentFile()), first = await recoveryClient(f), second = await recoveryClient(f);
    await first.flow.preview(); await second.flow.preview(); await first.flow.approve(true, true); await second.flow.approve(true, true);
    const a = first.flow.state.retention!.identity!, b = second.flow.state.retention!.identity!;
    expect(a.binding).toEqual(b.binding); expect(a.operation.operationId).not.toBe(b.operation.operationId); expect(a.id).not.toBe(b.id);
    first.flow.detach(); second.flow.detach(); f.reopen();
    const read = await f.services.readRecoveryAnchor!(f.ctx, a.id);
    expect(read).toMatchObject({ ok: true, data: { identity: { expiresAt: a.expiresAt }, original: { operationId: a.operation.operationId } } });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Math.max(Date.parse(a.expiresAt), Date.parse(b.expiresAt)) + 1);
    try {
      // Stores capture the clock on construction; reopen against the advanced clock.
      f.reopen();
      expect(await f.services.readRecoveryAnchor!(f.ctx, a.id)).toEqual({ ok: true, data: null });
      expect(await f.services.listRecoveryAnchors!(f.ctx)).toEqual({ ok: true, data: [] });
      const replay = await f.services.saveRecoveryAnchor!(f.ctx, { ...first.retain.mock.calls[0]![0], actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId });
      expect(replay).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    } finally { now.mockRestore(); }
    expect(f.model).not.toHaveBeenCalled();
  });
  it('reads not_sent metadata after authoritative close and SQLite reopen without returning a body or unlocking from metadata', async () => {
    const f = await setup(false, persistentFile()), c = await recoveryClient(f);
    await c.flow.preview(); await c.flow.approve(true, true);
    const approval = c.flow.state.approval!, anchor = c.flow.state.retention!.identity!;
    expect(await f.services.closeModelOperation!(f.ctx, { approvalId: approval.id, purpose: 'answer', contentHash: approval.contentHash, baseRevision: approval.baseRevision, confirmed: true }))
      .toMatchObject({ ok: true, data: { state: 'not_sent' } });
    c.flow.detach(); f.reopen(); c.transport.mockClear();
    const read = await readRecoveryIdentity(c.session, { page: 'retrieval', params: { recoveryId: anchor.id } }, c.transport);
    if (!read.ok || !read.data) throw Error('Missing recovery identity');
    const flow = createRestoredAnswerFlow({ call: async (path, init) => (await c.transport(path, init)).json(), onState: vi.fn() });
    await flow.restore(read.data); expect(flow.state.metadata?.stage).toBe('not_sent'); expect(flow.leaveState()).toBe('blocked');
    expect(c.transport.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true); expect(f.model).not.toHaveBeenCalled(); flow.dispose();
  });
  it('rejects HTTP retention with wrong actor, workspace, purpose or binding without accepting another identity', async () => {
    const f = await setup(), c = await recoveryClient(f); await c.flow.preview(); await c.flow.approve(true, true);
    const original = { ...c.retain.mock.calls[0]![0], actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId };
    for (const changed of [
      { ...original, actorId: 'other-actor' }, { ...original, workspaceId: 'other-workspace' },
      { ...original, operation: { ...original.operation, modelPurpose: 'review' } },
      { ...original, binding: { ...original.binding, contentHash: 'f'.repeat(64) } },
      { ...original, binding: { ...original.binding, baseRevision: 'b'.repeat(40) } },
    ]) {
      const response = await f.raw('/api/workspace/recovery-identities', changed);
      expect((await response.json()).ok).toBe(false);
    }
    const list = await f.services.listRecoveryAnchors!(f.ctx);
    expect(list.ok && list.data.length).toBe(1); expect(f.model).not.toHaveBeenCalled(); c.flow.detach();
  });
});

async function previewRetrievedUse(f: SharedFixture, status: TaskConditionCheck['status'] = 'not_satisfied') {
  const task = { ...f.request.task, conditionChecks: [{ nodeRef: { workspaceId: f.ctx.workspaceId, objectId: 'k2', revision: f.base },
    conditionId: 'stale-allowed', status, ...(status === 'unknown' ? {} : { confirmedBy: f.ctx.actorId }) }] };
  const result = await f.json<RetrievalResult>('/api/retrieval/query', { ...f.request, task });
  const exchange = new TransientRetrieval();
  exchange.bind({ actorId: f.ctx.actorId, workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: [...f.ctx.scopes] });
  expect(exchange.accept(task, result)).toBe(true);
  const handoff = exchange.forLearning({ taskId: task.id, nodeId: 'k1', revision: f.base })!;
  const preview = await f.json<{ storage: StoragePreview | null; storageNotice: string | null; handoffTrust: string }>('/api/learning/use', {
    action: 'preview_retrieved', task: handoff.task, retrieval: handoff.result, nodeId: 'k1', decision: status === 'satisfied' ? 'adopt' : 'verify_later',
    reason: '原任务按明确的条件核验作出决定，来源与索引覆盖仍保留限制。',
  });
  expect(preview.storage, preview.storageNotice ?? 'missing storage preview').not.toBeNull();
  expect(preview.handoffTrust).toBe('client_preview_only');
  const storage = preview.storage!;
  const request = EvidenceApprovalRequestSchema.parse({ operationId: storage.operationId, record: storage.record,
    baseRevision: storage.baseRevision, retention: storage.retention, confirmed: true });
  expect(request.record.useContext).toMatchObject({ task, snapshotRevision: f.base, paths: result.paths,
    retrievalContext: { queryId: result.queryId, coverage: result.coverage, trust: 'client_preview_only' } });
  expect(request.record.useContext!.retrievalContext.missingConditions).toEqual(expect.arrayContaining(result.missingConditions));
  expect(request.record).toMatchObject({ kind: 'use', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'unverified' });
  return { request, task, result };
}

describe('R09/R13 actual shared Services and HTTP, only external transports are fixtures', () => {
  it('persists each original tri-state through learning preview/execute and reopens the same structured use, without promoting exposure', async () => {
    const f = await setup(true, persistentFile());
    for (const status of ['satisfied', 'not_satisfied', 'unknown'] as const) {
      const { request, task, result } = await previewRetrievedUse(f, status);
      expect(result.groups.eligible.map((node) => node.id).sort()).toEqual(status === 'satisfied' ? ['k1', 'k2'] : []);
      expect(await f.json(`/api/workspace/evidence/${request.record.id}`)).toBeNull();
      const approval = await f.json<Approval>('/api/workspace/approvals/evidence', request);
      expect(await f.json(`/api/workspace/evidence/${request.record.id}`)).toBeNull();
      const saved = await f.json<{ receipt: EvidenceReceipt; persistence: string }>('/api/learning/use', { action: 'execute', request, approval });
      expect(saved).toMatchObject({ persistence: 'saved', receipt: { operationId: request.operationId, recordId: request.record.id, approvalId: approval.id,
        contentHash: await hashEvidence(request.record), baseRevision: f.base } });
      f.reopen();
      const original = await f.json<{ contextState: string; record: EvidenceRecord }>(`/api/learning/records/${request.record.id}`);
      expect(original).toMatchObject({ contextState: 'recorded', record: request.record });
      expect(original.record.useContext!.task).toEqual(task);
      expect(original.record.useContext!.knowledge.map((node) => node.id).sort()).toEqual(['k1', 'k2']);
      expect(original.record.useContext!.relations[0]).toMatchObject({ id: 'requires', type: 'depends_on', target: { objectId: 'k2', revision: f.base } });
      const forged = { ...request, operationId: `${request.operationId}-unexposed`, record: { ...request.record, id: `${request.record.id}-unexposed`, answerVisible: false } };
      expect((await f.raw('/api/workspace/approvals/evidence', forged)).status).toBe(422);
    }
    const history = await f.json<{ records: unknown[] }>('/api/learning/records?taskId=original-task');
    expect(history.records).toHaveLength(3); expect(f.git.publish).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled();
  });

  it('reads back a lost learning execution by original operation after SQLite reopen without another append', async () => {
    const f = await setup(true, persistentFile()); const { request } = await previewRetrievedUse(f);
    const approval = await f.json<Approval>('/api/workspace/approvals/evidence', request);
    const append = vi.spyOn(f.services, 'appendEvidence');
    const lostResponse = await f.raw('/api/learning/use', { action: 'execute', request, approval });
    expect(lostResponse.status).toBe(200); expect(append).toHaveBeenCalledOnce();
    // The application never consumes the save response; only original IDs and hashes remain.
    f.reopen(); const reopenedAppend = vi.spyOn(f.services, 'appendEvidence');
    const registration = await f.json<ApprovalRegistrationState>(`/api/workspace/approval-registrations/save_evidence/${request.operationId}`);
    expect(registration).toMatchObject({ status: 'registered', requestHash: await contentHash(request), approval });
    const receipt = await f.json<EvidenceReceipt>(`/api/workspace/evidence-receipts/${request.operationId}`);
    expect(receipt).toMatchObject({ approvalId: approval.id, recordId: request.record.id, actorId: f.ctx.actorId,
      workspaceId: f.ctx.workspaceId, contentHash: await hashEvidence(request.record), baseRevision: f.base, outcome: 'saved' });
    expect(JSON.stringify(receipt)).not.toContain(f.request.task.question);
    expect(await f.json(`/api/learning/records/${request.record.id}`)).toMatchObject({ record: request.record });
    expect(await f.json(`/api/workspace/evidence-receipts/${request.operationId}-not-original`)).toBeNull();
    expect(reopenedAppend).not.toHaveBeenCalled(); expect(f.git.publish).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled();
  });

  it('uses one original learning operation across two SQLite connections and rejects another operation claiming its record', async () => {
    const file = persistentFile(), f = await setup(true, file), { request } = await previewRetrievedUse(f, 'unknown');
    const journal = new OperationJournal(file, { fixture: true }); journals.add(journal);
    const secondServices = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) });
    const secondApp = createApp(secondServices);
    const second = (path: string, body: unknown) => secondApp.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) });
    const registrationResponses = await Promise.all([f.raw('/api/workspace/approvals/evidence', request), second('/api/workspace/approvals/evidence', request)]);
    const approvals: Approval[] = [];
    for (const response of registrationResponses) {
      expect(response.status).toBe(200); const body = await response.json() as ApiResponse<Approval>;
      if (!body.ok) throw new Error(body.error.code); approvals.push(body.data);
    }
    expect(approvals[0]).toEqual(approvals[1]);
    const execute = { action: 'execute', request, approval: approvals[0] };
    const executions = await Promise.all([f.raw('/api/learning/use', execute), second('/api/learning/use', execute)]);
    const receipts: EvidenceReceipt[] = [];
    for (const response of executions) {
      expect(response.status).toBe(200); const body = await response.json() as ApiResponse<{ receipt: EvidenceReceipt }>;
      if (!body.ok) throw new Error(body.error.code); receipts.push(body.data.receipt);
    }
    expect(receipts[0]).toEqual(receipts[1]);
    const impostor = { ...request, operationId: `${request.operationId}-different-operation` };
    const differentApproval = await f.json<Approval>('/api/workspace/approvals/evidence', impostor);
    expect(differentApproval.id).not.toBe(approvals[0]!.id);
    const rejected = await second('/api/learning/use', { action: 'execute', request: impostor, approval: differentApproval });
    expect(rejected.status).toBe(409);
    expect(await f.json(`/api/workspace/evidence-receipts/${impostor.operationId}`)).toBeNull();
    f.reopen();
    expect(await f.json('/api/learning/records?taskId=original-task')).toMatchObject({ records: [{ record: request.record }] });
    expect(await f.json(`/api/workspace/evidence-receipts/${request.operationId}`)).toEqual(receipts[0]);
    expect(f.model).not.toHaveBeenCalled(); expect(f.git.publish).not.toHaveBeenCalled();
  });

  it('rejects learning history access before body reads when the current session lacks evidence scope', async () => {
    const f = await setup(true); const { request } = await previewRetrievedUse(f);
    const approval = await f.json<Approval>('/api/workspace/approvals/evidence', request);
    await f.json('/api/learning/use', { action: 'execute', request, approval });
    const read = vi.spyOn(f.services, 'readEvidence'), list = vi.spyOn(f.services, 'listEvidence');
    const token = f.sessions.issue({ actorId: f.ctx.actorId, workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' },
      scopes: ['knowledge:read'] });
    for (const path of [`/api/learning/records/${request.record.id}`, '/api/learning/records?taskId=original-task']) {
      const response = await f.app.request(path, { headers: { ...f.headers, Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(403); expect(await response.text()).not.toContain('当前页面允许短暂旧数据');
    }
    expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled();
  });

  it('keeps learning original use/outcome explainable through governance premise changes, edge withdrawal and restoration, but not deletion', async () => {
    const f = await setup(true, persistentFile()); const { request, task, result } = await previewRetrievedUse(f, 'satisfied');
    const approval = await f.json<Approval>('/api/workspace/approvals/evidence', request);
    await f.json('/api/learning/use', { action: 'execute', request, approval });
    const originalHash = await hashEvidence(request.record);
    const changedPreview = await f.json<ChangePreview>('/api/governance/nodes/k2', { action: 'preview', operationId: 'g4-change-premise',
      baseRevision: f.base, nodeRevision: f.base, reason: '关键前提已不成立', patch: { conditions: [{ id: 'stale-allowed', text: '当前页面允许短暂旧数据', status: 'rejected', evidenceIds: [] }] } }, 'PATCH');
    const changed = await f.commit(changedPreview);
    expect((await f.raw('/api/retrieval/query', { ...f.request, task })).status).toBe(409);
    const afterChange = await f.query(); expect(afterChange.snapshotRevision).toBe(changed.revision); expect(afterChange.groups.eligible).toEqual([]);
    expect(result.groups.eligible.map((node) => node.id).sort()).toEqual(['k1', 'k2']);
    const withdrawal = await f.commit(await f.json<ChangePreview>('/api/governance/relations/requires', { action: 'preview', operationId: 'g4-withdraw-relation',
      baseRevision: changed.revision, reason: '撤回已经过期的依赖', patch: { state: 'withdrawn' } }, 'PATCH'));
    expect((await f.query()).groups.eligible.map((node) => node.id)).toEqual(['k1']);
    f.reopen();
    expect(await f.json(`/api/learning/records/${request.record.id}`)).toMatchObject({ contextState: 'recorded', record: request.record });
    const notices = await f.json<{ entries: { record: EvidenceRecord; useContextStatus: string; relations: { historicalRelation: { state: string } }[] }[] }>('/api/governance/history?nodeId=k2');
    expect(notices.entries[0]).toMatchObject({ record: request.record, useContextStatus: 'recorded', relations: [{ historicalRelation: { state: 'confirmed' } }] });
    const outcomePreview = await f.json<{ storage: StoragePreview; originalUse: { record: EvidenceRecord } }>('/api/learning/outcomes', { action: 'preview', outcome: {
      useRecordId: request.record.id, status: 'failed', summary: '实际任务未达到预期', failureReason: '原先核验的页面时效前提不再成立',
    } });
    expect(outcomePreview.originalUse.record).toEqual(request.record);
    const outcome = EvidenceApprovalRequestSchema.parse({ operationId: outcomePreview.storage.operationId, record: outcomePreview.storage.record,
      baseRevision: outcomePreview.storage.baseRevision, retention: 'until_deleted', confirmed: true });
    expect(outcome.baseRevision).toBe(f.base); expect(outcome.record).toMatchObject({ kind: 'outcome', result: 'self_reported',
      outcome: { useRecordId: request.record.id, verification: 'self_reported' }, nodeRefs: request.record.nodeRefs, relationRefs: request.record.relationRefs });
    await f.json('/api/learning/outcomes', { action: 'execute', request: outcome, approval: await f.json<Approval>('/api/workspace/approvals/evidence', outcome) });
    const restoration = await f.commit(await f.json<ChangePreview>('/api/governance/rollback', { action: 'preview', operationId: 'g4-restore-premise',
      nodeId: 'k2', baseRevision: withdrawal.revision, historicalRevision: f.base, reason: '经人工复核恢复历史前提，但不自动恢复撤回的关系' }));
    f.reopen(); const restoredQuery = await f.query();
    expect(restoredQuery.snapshotRevision).toBe(restoration.revision); expect(restoredQuery.paths.flatMap((path) => path.relationIds)).not.toContain('requires');
    expect(restoration.revision).not.toBe(f.base);
    const archived = await f.json<{ record: EvidenceRecord }>(`/api/learning/records/${request.record.id}`);
    expect(await hashEvidence(archived.record)).toBe(originalHash);
    expect(await f.json(`/api/learning/records/${outcome.record.id}`)).toMatchObject({ contextState: 'linked_use', record: outcome.record });
    const plan = await f.json<{ plan: DeletePlan }>('/api/governance/delete/preview', { action: 'preview', objectIds: ['k2'], baseRevision: restoration.revision });
    const deletionApproval = await f.json<Approval>('/api/workspace/approvals/governance', { purpose: 'delete', planId: plan.plan.id, confirmed: true });
    await f.json('/api/governance/delete/execute', { action: 'execute', plan: plan.plan, approval: deletionApproval });
    f.reopen();
    for (const id of [request.record.id, outcome.record.id]) {
      const denied = await f.raw(`/api/learning/records/${id}`); expect(denied.status).toBe(403); expect(await denied.text()).not.toContain('当前页面允许短暂旧数据');
    }
    const deletedQuery = await f.query(); expect(deletedQuery.groups.excludedIds).toContain('k2'); expect(JSON.stringify(deletedQuery)).not.toContain('当前页面允许短暂旧数据');
    expect(await f.json(`/api/workspace/evidence-receipts/${request.operationId}`)).toMatchObject({ recordId: request.record.id, outcome: 'saved' });
    const blockedRestore = await f.raw('/api/governance/rollback', { action: 'preview', operationId: 'g4-blocked-restore', nodeId: 'k2',
      baseRevision: restoration.revision, historicalRevision: f.base, reason: '检查普通恢复不能解除删除屏障' });
    expect(blockedRestore.status).toBe(422);
    const blockedBody = await blockedRestore.json();
    expect(blockedBody).toMatchObject({ ok: false, error: { code: 'VALIDATION', nextAction: 'select_current_object' } });
    expect(JSON.stringify(blockedBody)).not.toContain('当前页面允许短暂旧数据');
    expect(f.model).not.toHaveBeenCalled(); expect(f.git.publish).toHaveBeenCalledTimes(3);
  });

  it('consumes 1.15 task checks through actual Services/HTTP and invalidates the original check after a source revision', async () => {
    const f = await setup(true); await f.enableModel(true);
    const original = structuredClone(f.request);
    const queryFor = (status: TaskConditionCheck['status']): RetrievalRequest => ({ ...f.request, task: { ...f.request.task, conditionChecks: [{
      nodeRef: { workspaceId: f.ctx.workspaceId, objectId: 'k2', revision: f.base }, conditionId: 'stale-allowed', status,
      ...(status === 'unknown' ? {} : { confirmedBy: f.ctx.actorId }),
    }] } });
    for (const status of ['not_satisfied', 'unknown', 'satisfied'] as const) {
      const request = queryFor(status); const result = await f.json<RetrievalResult>('/api/retrieval/query', request);
      expect(result.snapshotRevision).toBe(f.base);
      expect(result.groups.eligible.map((node) => node.id).sort()).toEqual(status === 'satisfied' ? ['k1', 'k2'] : []);
      expect(result.paths.some((path) => path.relationIds.includes('requires') && path.nodeIds.includes('k2'))).toBe(true);
      const preview = await f.raw('/api/retrieval/answer/preview', { request });
      expect(preview.status).toBe(status === 'satisfied' ? 200 : 422);
      if (status === 'satisfied') {
        const body = await preview.json() as ApiResponse<AnswerPreview>; if (!body.ok) throw new Error(body.error.code);
        expect(JSON.parse(body.data.input.text).conditionChecks).toEqual(request.task.conditionChecks);
      }
      if (status === 'not_satisfied') expect(result.missingConditions.join()).toContain('不满足');
    }
    const forged = queryFor('satisfied'); forged.task.conditionChecks![0]!.confirmedBy = 'different-actor';
    expect((await f.raw('/api/retrieval/query', forged)).status).toBe(403);
    const detail = await f.json<NodeDetail>(`/api/retrieval/nodes/k2?revision=${f.base}`);
    const sourceRevision = await f.json<ChangePreview>('/api/governance/nodes/k2', { action: 'preview', operationId: 'source-revision',
      baseRevision: f.base, nodeRevision: f.base, reason: '更新来源的限制说明', patch: { sources: detail.node.sources.map((source) => ({ ...source, limitation: '来源已更新，任务需要重新核验' })) } }, 'PATCH');
    const receipt = await f.commit(sourceRevision);
    expect((await f.raw('/api/retrieval/query', queryFor('satisfied'))).status).toBe(409);
    const changed = await f.query(); expect(changed.snapshotRevision).toBe(receipt.revision); expect(changed.groups.eligible).toEqual([]);
    expect(f.request).toEqual(original); expect(f.model).not.toHaveBeenCalled();
  });

  it('consumes the shared not_sent close proof after an attempted request with no transmission record', async () => {
    const f = await setup(); await f.enableModel(true);
    const call: AnswerCall = async (path, init) => {
      if (path === '/api/retrieval/answer') throw new Error('request delivery cannot be observed');
      return await (await f.app.request(`http://localhost${path}`, { ...init, headers: f.headers })).json();
    };
    const onResult = vi.fn();
    const flow = createAnswerFlow({ request: f.request, actorId: f.ctx.actorId, reader: latestRead(), call, onState: () => {}, onFailure: () => {}, onResult });
    await flow.preview(); await flow.approve(true); const approval = flow.state.approval!;
    await flow.send(); await flow.cancel(); await flow.inspect();
    expect(await f.json(`/api/workspace/model-operations/${approval.id}`)).toMatchObject({ approvalId: approval.id, state: 'not_sent',
      actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId, purpose: 'answer', contentHash: approval.contentHash, baseRevision: approval.baseRevision });
    expect(flow.state.receipt).toMatchObject({ approvalId: approval.id, state: 'not_sent' });
    expect(flow.state.uncertain).toBe(false); expect(answerLeaveState(flow.state)).toBe('clean');
    const late = await f.raw('/api/retrieval/answer', { request: f.request, approval });
    expect(late.status).toBe(403); await flow.inspect(); expect(answerLeaveState(flow.state)).toBe('clean');
    expect(f.model).not.toHaveBeenCalled(); expect(onResult).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'revoked'] as const)('consumes a durable not_sent proof after an actual %s preflight result', async (change) => {
    const f = await setup(); await f.enableModel(true);
    const call = vi.fn<AnswerCall>(async (path, init) => await (await f.app.request(`http://localhost${path}`, { ...init, headers: f.headers })).json());
    const onResult = vi.fn(); const onFailure = vi.fn();
    const flow = createAnswerFlow({ request: f.request, actorId: f.ctx.actorId, reader: latestRead(), call, onState: () => {}, onFailure, onResult });
    await flow.preview(); await flow.approve(true); const approval = flow.state.approval!;
    if (change === 'disabled') await f.enableModel(false);
    else await f.json(`/api/workspace/approvals/${approval.id}/revoke`, {});
    await flow.send(); await flow.cancel(); await flow.inspect();
    expect(flow.state.operation?.id).toBe(approval.id); expect(flow.state.approval).toBeNull();
    expect(flow.state.uncertain).toBe(false); expect(answerLeaveState(flow.state)).toBe('clean');
    expect(flow.state.receipt).toMatchObject({ approvalId: approval.id, state: 'not_sent' });
    expect(await f.json(`/api/workspace/model-operations/${approval.id}`)).toMatchObject({ approvalId: approval.id, state: 'not_sent' });
    expect(f.model).not.toHaveBeenCalled(); expect(f.git.publish).not.toHaveBeenCalled();
    if (change === 'disabled') {
      expect(onResult).toHaveBeenCalledOnce(); expect(onResult.mock.calls[0]![0].answer).toBeNull();
      expect(onFailure).not.toHaveBeenCalled();
    } else expect(onResult).not.toHaveBeenCalled();
    const originalSendCount = call.mock.calls.filter(([path]) => path === '/api/retrieval/answer').length;
    expect(originalSendCount).toBe(1); expect(call.mock.calls.filter(([path]) => path.includes('/operations/')).every(([, init]) => init?.method === 'GET' && init.body === undefined)).toBe(true);
  });
  it.each(['cited', 'rejected_citation'] as const)('verifies the original durable terminal receipt after an actual %s response', async (answer) => {
    const f = await setup(); await f.enableModel(true);
    if (answer === 'rejected_citation') f.model.mockResolvedValueOnce({ ok: true, data: { value: { claims: [{
      nodeRef: { workspaceId: f.ctx.workspaceId, objectId: 'k1', revision: f.base }, sourceId: 's-k1', quote: 'UNSUPPORTED_QUOTE', text: 'UNSUPPORTED_CLAIM',
    }] }, modelId: 'fixture-answer-model', generatedAt: time } });
    const call = vi.fn<AnswerCall>(async (path, init) => await (await f.app.request(`http://localhost${path}`, { ...init, headers: f.headers })).json());
    const onResult = vi.fn();
    const flow = createAnswerFlow({ request: f.request, actorId: f.ctx.actorId, reader: latestRead(), call, onState: () => {}, onFailure: () => {}, onResult });
    await flow.preview(); await flow.approve(true); const approval = flow.state.approval!;
    await flow.send();
    expect(flow.state.receipt).toMatchObject({ approvalId: approval.id, state: 'done', actorId: f.ctx.actorId,
      workspaceId: f.ctx.workspaceId, contentHash: approval.contentHash, baseRevision: approval.baseRevision });
    expect(answerLeaveState(flow.state)).toBe('clean'); expect(f.model).toHaveBeenCalledOnce(); expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0]![0].answer === null).toBe(answer === 'rejected_citation');
    expect(JSON.stringify(onResult.mock.calls)).not.toMatch(/UNSUPPORTED_QUOTE|UNSUPPORTED_CLAIM/);
    expect(call.mock.calls.map(([path]) => path)).toEqual(['/api/retrieval/answer/preview', '/api/workspace/approvals/model',
      '/api/retrieval/answer', `/api/workspace/approvals/${approval.id}/revoke`, `/api/retrieval/answer/operations/${approval.id}`,
      `/api/workspace/operation-recovery/model/${flow.state.registration!.operationId}?modelPurpose=answer`]);
    expect(JSON.stringify(flow.state.receipt)).not.toMatch(/允许短暂旧数据|claims|quote/);
  });
  it('recovers the original model receipt after losing a real platform answer response, without replay or body recovery', async () => {
    const f = await setup();
    expect((await f.raw('/api/retrieval/answer/preview', { request: f.request })).status).toBe(403); expect(f.model).not.toHaveBeenCalled();
    await f.enableModel(true);
    const call = vi.fn<AnswerCall>(async (path, init) => {
      const response = await f.app.request(`http://localhost${path}`, { ...init, headers: f.headers });
      if (path === '/api/retrieval/answer') { expect(response.status).toBe(200); throw new Error('Fixture lost response after execution'); }
      return await response.json() as ApiResponse<unknown>;
    });
    const onResult = vi.fn();
    const flow = createAnswerFlow({ request: f.request, actorId: f.ctx.actorId, reader: latestRead(), call, onState: () => {}, onFailure: () => {}, onResult });
    await flow.preview(); await flow.approve(true); const approval = flow.state.approval!; expect(approval).toBeTruthy();
    await flow.send(); expect(flow.state.uncertain).toBe(true); expect(f.model).toHaveBeenCalledOnce();
    await flow.cancel(); await f.enableModel(false); await flow.inspect();
    expect(flow.state.receipt).toMatchObject({ approvalId: approval.id, state: 'done', modelId: 'fixture-answer-model' });
    expect(answerLeaveState(flow.state)).toBe('clean'); expect(onResult).not.toHaveBeenCalled(); expect(f.model).toHaveBeenCalledOnce();
    const receipt = await f.json<ModelOperationReceipt>(`/api/workspace/model-operations/${approval.id}`);
    expect(receipt).toEqual(flow.state.receipt); expect(JSON.stringify(receipt)).not.toMatch(/允许短暂旧数据|claims|quote/);
    await f.enableModel(true);
    expect((await f.raw('/api/retrieval/answer', { request: f.request, approval })).status).toBe(403);
    expect(f.model).toHaveBeenCalledOnce();
  });

  it('consumes 1.22 answer recovery by the original operationId after SQLite reopen, keeps same-content operations separate, and never calls the model', async () => {
    mkdirSync('.local/fixture', { recursive: true }); const directory = mkdtempSync(resolve('.local/fixture/retrieval-operation-recovery-'));
    directories.push(directory); const file = join(directory, 'operations.sqlite');
    const f = await setup(false, file); await f.enableModel(true);
    const calls: string[] = [];
    const call = vi.fn<AnswerCall>(async (path, init) => {
      calls.push(path);
      const response = await f.app.request(`http://localhost${path}`, { ...init, headers: f.headers });
      if (path === '/api/retrieval/answer') { expect(response.status).toBe(200); throw new Error('response lost after persisted execution'); }
      return await response.json() as ApiResponse<unknown>;
    });
    const flow = createAnswerFlow({ request: f.request, actorId: f.ctx.actorId, reader: latestRead(), call, onState: () => {}, onFailure: () => {}, onResult: () => {} });
    await flow.preview(); await flow.approve(true); const approval = flow.state.approval!; const original = flow.state.registration!;
    await flow.send(); expect(flow.state.uncertain).toBe(true); expect(f.model).toHaveBeenCalledOnce();
    f.reopen();
    await flow.inspectRecovery(original.operationId);
    expect(flow.state.recovery).toMatchObject({ kind: 'model', operationId: original.operationId, approvalId: approval.id, purpose: 'answer', stage: 'done', readOnly: true, absenceIsFinal: false });
    expect(flow.state.receipt).toBeNull(); expect(flow.state.uncertain).toBe(true); expect(answerLeaveState(flow.state)).toBe('blocked');
    await flow.inspectRecovery(original.operationId);
    expect(calls.filter((path) => path === `/api/workspace/operation-recovery/model/${original.operationId}?modelPurpose=answer`)).toHaveLength(2);
    expect(f.model).toHaveBeenCalledOnce(); expect(JSON.stringify(flow.state.recovery)).not.toMatch(/允许短暂旧数据|claims|quote/);

    const preview = await f.json<AnswerPreview>('/api/retrieval/answer/preview', { request: f.request });
    const secondOperationId = `${original.operationId}-same-content`;
    const secondApproval = await f.json<Approval>('/api/workspace/approvals/model', { input: preview.input, objectIds: preview.objectIds,
      baseRevision: preview.baseRevision, operationId: secondOperationId, confirmed: true });
    const secondRecovery = await f.json<{ operationId: string; approvalId: string }>(`/api/workspace/operation-recovery/model/${secondOperationId}?modelPurpose=answer`);
    expect(secondRecovery.operationId).toBe(secondOperationId); expect(secondRecovery.approvalId).toBe(secondApproval.id);
    expect(secondRecovery.approvalId).not.toBe(approval.id); expect(flow.state.recovery?.operationId).toBe(original.operationId);
    expect(calls.some((path) => path.includes(`/operation-recovery/model/${approval.id}`))).toBe(false);
    expect(calls.some((path) => path === '/api/retrieval/answer')).toBe(true);
  });

  it('keeps HTTP recovery identity and purpose boundaries strict, and never downgrades a completed operation to not_sent', async () => {
    const f = await setup(); await f.enableModel(true);
    const preview = await f.json<AnswerPreview>('/api/retrieval/answer/preview', { request: f.request });
    const operationId = 'answer-operation-http-boundary';
    const approval = await f.json<Approval>('/api/workspace/approvals/model', { input: preview.input, objectIds: preview.objectIds,
      baseRevision: preview.baseRevision, operationId, confirmed: true });

    const approvalAsOperation = await f.raw(`/api/workspace/operation-recovery/model/${approval.id}?modelPurpose=answer`);
    expect(approvalAsOperation.status).toBe(200);
    expect(await approvalAsOperation.json() as ApiResponse<unknown>).toMatchObject({ ok: true, data: {
      operationId: approval.id, stage: 'not_registered', readOnly: true, absenceIsFinal: false,
    } });

    const wrongPurpose = await f.raw(`/api/workspace/operation-recovery/model/${operationId}?modelPurpose=extract`);
    expect(wrongPurpose.status).toBe(403);

    const otherToken = f.sessions.issue({ actorId: 'other-answer-reader',
      workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: [...f.ctx.scopes] });
    const wrongActor = await f.app.request(`http://localhost/api/workspace/operation-recovery/model/${operationId}?modelPurpose=answer`, {
      headers: { ...f.headers, Authorization: `Bearer ${otherToken}` },
    });
    expect(wrongActor.status).toBe(403);

    expect((await f.raw('/api/retrieval/answer', { request: f.request, approval })).status).toBe(200);
    expect(f.model).toHaveBeenCalledOnce();
    const completed = await f.json<ModelOperationReceipt>(`/api/workspace/model-operations/${approval.id}`);
    expect(completed.state).toBe('done');
    const close = await f.raw(`/api/workspace/model-operations/${approval.id}/close`, { purpose: 'answer', contentHash: approval.contentHash,
      baseRevision: approval.baseRevision, confirmed: true });
    const closeBody = await close.json() as ApiResponse<unknown>;
    expect(closeBody).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(await f.json<ModelOperationReceipt>(`/api/workspace/model-operations/${approval.id}`)).toMatchObject({ state: 'done' });
  });

  it('recovers and revokes a lost original registration through shared HTTP after SQLite reopen, without sending the model', async () => {
    mkdirSync('.local/fixture', { recursive: true }); const directory = mkdtempSync(resolve('.local/fixture/retrieval-registration-'));
    directories.push(directory); const file = join(directory, 'operations.sqlite');
    const f = await setup(false, file); await f.enableModel(true); let app = f.app;
    const call = vi.fn<AnswerCall>(async (path, init) => {
      const response = await app.request(`http://localhost${path}`, { ...init, headers: f.headers });
      const body = await response.json() as ApiResponse<unknown>;
      if (path === '/api/workspace/approvals/model' && body.ok) throw new Error('registration response lost after actual persistence');
      return body;
    });
    const onResult = vi.fn();
    const flow = createAnswerFlow({ request: f.request, actorId: f.ctx.actorId, reader: latestRead(), call, onState: () => {}, onFailure: () => {}, onResult });
    await flow.preview(); await flow.approve(true); const registration = flow.state.registration!;
    expect(registration.operationId).toBeTruthy(); expect(flow.state.approval).toBeNull(); expect(answerLeaveState(flow.state)).toBe('blocked');
    f.journal.close(); journals.delete(f.journal);
    const journal = new OperationJournal(file, { fixture: true }); journals.add(journal);
    app = createApp(createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }));
    await flow.invalidate(); await flow.inspectRegistration();
    expect(flow.state.registrationStatus).toBe('registered'); expect(flow.state.approval?.contentHash).toBe(registration.contentHash);
    expect(answerLeaveState(flow.state)).toBe('blocked'); await flow.send(); expect(f.model).not.toHaveBeenCalled();
    const recoveredId = flow.state.approval!.id; await flow.cancel(); expect(answerLeaveState(flow.state)).toBe('clean');
    const response = await app.request(`/api/workspace/approval-registrations/model_input/${registration.operationId}?modelPurpose=answer`, { headers: f.headers });
    expect(response.headers.get('cache-control')).toBe('no-store'); const receipt = await response.json() as ApiResponse<ApprovalRegistrationState>;
    expect(receipt).toMatchObject({ ok: true, data: { status: 'revoked', requestHash: registration.requestHash, approval: { id: recoveredId }, absenceIsFinal: false } });
    expect(JSON.stringify(receipt)).not.toMatch(/允许短暂旧数据|claims|quote/);
    expect(call.mock.calls.filter(([path]) => path === '/api/workspace/approvals/model')).toHaveLength(1);
    expect(f.model).not.toHaveBeenCalled(); expect(f.git.publish).not.toHaveBeenCalled(); expect(onResult).not.toHaveBeenCalled();
  });

  it('records a discarded terminal receipt when consent is revoked during a shared model call', async () => {
    const f = await setup(); await f.enableModel(true);
    const preview = await f.json<AnswerPreview>('/api/retrieval/answer/preview', { request: f.request });
    const approval = await f.json<Approval>('/api/workspace/approvals/model', { input: preview.input, objectIds: preview.objectIds, baseRevision: preview.baseRevision, confirmed: true });
    let complete!: () => void; let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; }); const released = new Promise<void>((resolve) => { complete = resolve; });
    const respond = f.model.getMockImplementation()!;
    f.model.mockImplementationOnce(async (...args) => { started(); await released; return respond(...args); });
    const sending = f.raw('/api/retrieval/answer', { request: f.request, approval }); await ready;
    await f.json(`/api/workspace/approvals/${approval.id}/revoke`, {}); complete();
    const result = await sending; expect(result.status).toBe(403); expect(await result.text()).not.toContain('允许短暂旧数据');
    expect(await f.json(`/api/retrieval/answer/operations/${approval.id}`)).toMatchObject({ state: 'discarded', approvalId: approval.id });
    expect(f.model).toHaveBeenCalledOnce();
  });

  it('demonstrates graph ablation and changes the same query through revision, edge withdrawal and a new-commit restore', async () => {
    const f = await setup(true); const withoutGraph = await setup(false);
    const baseline = await withoutGraph.query(); const before = await f.query();
    expect(baseline.snapshotRevision).toBe(before.snapshotRevision);
    expect(baseline.groups.eligible.map((n) => n.id)).toEqual(['k1']);
    expect(before.groups.eligible).toEqual([]); expect(before.groups.conditional.map((n) => n.id).sort()).toEqual(['k1', 'k2']);
    expect(before.paths.some((path) => path.relationIds.includes('requires') && path.nodeIds.includes('k2'))).toBe(true);
    expect(before.coverage).toBe('partial'); expect(before.answer).toBeNull();
    const exchange = new TransientRetrieval();
    exchange.bind({ actorId: f.ctx.actorId, workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: [...f.ctx.scopes] });
    expect(exchange.accept(f.request.task, before)).toBe(true);
    const frozen = exchange.forLearning({ taskId: f.request.task.id, nodeId: 'k1', revision: f.base })!;
    const archived = JSON.stringify(frozen);
    const preview = await f.json<ChangePreview>('/api/governance/nodes/k2', { action: 'preview', operationId: 'revise-premise', baseRevision: before.snapshotRevision,
      nodeRevision: f.base, reason: '当前任务不能接受短暂旧数据', patch: { conditions: [{ id: 'stale-allowed', text: '当前页面允许短暂旧数据', status: 'rejected', evidenceIds: [] }] } }, 'PATCH');
    const revision = await f.commit(preview); const changed = await f.query();
    expect(changed.snapshotRevision).toBe(revision.revision); expect(changed.groups.eligible).toEqual([]);
    expect(changed.paths.flatMap((path) => path.relationIds)).not.toContain('requires');
    const withdrawn = await f.json<ChangePreview>('/api/governance/relations/requires', { action: 'preview', operationId: 'withdraw-edge', baseRevision: revision.revision,
      reason: '撤回不再有效的前提关系', patch: { state: 'withdrawn' } }, 'PATCH');
    const withdrawal = await f.commit(withdrawn); const after = await f.query();
    expect(after.groups.eligible.map((n) => n.id)).toEqual(['k1']); expect(after.groups.excludedIds).toContain('requires');
    const historical = await f.json<NodeDetail>(`/api/retrieval/nodes/k2/history?revision=${f.base}`);
    expect(historical.node.conditions[0]?.status).toBe('unknown'); expect(historical.history?.currentNodeRevision).toBe(revision.revision);
    const restoration = await f.json<ChangePreview>('/api/governance/rollback', { action: 'preview', operationId: 'restore-premise', nodeId: 'k2', baseRevision: withdrawal.revision,
      historicalRevision: f.base, reason: '以新提交恢复原前提，关系仍需独立复核' });
    const restored = await f.commit(restoration); expect(restored.revision).not.toBe(f.base);
    const current = await f.json<NodeDetail>(`/api/retrieval/nodes/k2?revision=${restored.revision}`);
    expect(current.node.conditions[0]?.status).toBe('unknown'); expect((await f.query()).paths.flatMap((path) => path.relationIds)).not.toContain('requires');
    expect(JSON.stringify(frozen)).toBe(archived); expect(frozen.task).toEqual(f.request.task); expect(frozen.result.snapshotRevision).toBe(f.base);
    expect(f.model).not.toHaveBeenCalled(); expect(f.git.publish).toHaveBeenCalledTimes(3);
  });

  it('keeps removed object IDs and blocks current/history/graph/model reads after the actual SQLite journal is reopened', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/retrieval-platform-')); directories.push(directory); const file = join(directory, 'operations.sqlite');
    const f = await setup(true, file); await f.enableModel(true); const before = await f.query();
    const preview = await f.json<{ plan: DeletePlan }>('/api/governance/delete/preview', { action: 'preview', objectIds: ['k1'], baseRevision: before.snapshotRevision });
    const approval = await f.json<Approval>('/api/workspace/approvals/governance', { purpose: 'delete', planId: preview.plan.id, confirmed: true });
    await f.json('/api/governance/delete/execute', { action: 'execute', plan: preview.plan, approval });
    f.journal.close(); journals.delete(f.journal);
    const journal = new OperationJournal(file, { fixture: true }); journals.add(journal);
    const services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }); const app = createApp(services);
    const blocked = await app.request('/api/retrieval/query', { method: 'POST', headers: f.headers, body: JSON.stringify(f.request) });
    const body = await blocked.json() as ApiResponse<RetrievalResult>; expect(body.ok).toBe(true);
    if (!body.ok) throw new Error(body.error.code);
    expect(body.data.groups.excludedIds).toContain('k1'); expect(JSON.stringify(body)).not.toContain('允许短暂旧数据时可选方案A');
    for (const path of ['/api/retrieval/nodes/k1', '/api/retrieval/graph/k1', `/api/retrieval/nodes/k1/history?revision=${f.base}`]) {
      expect((await app.request(path, { headers: f.headers })).status).toBe(403);
    }
    const answer = await app.request('/api/retrieval/answer/preview', { method: 'POST', headers: f.headers, body: JSON.stringify({ request: f.request }) });
    expect(answer.status).not.toBe(200); expect(await answer.text()).not.toContain('允许短暂旧数据时可选方案A');
    const restored = await app.request('/api/governance/rollback', { method: 'POST', headers: f.headers, body: JSON.stringify({ action: 'preview', operationId: 'blocked-restore',
      nodeId: 'k1', baseRevision: f.base, historicalRevision: f.base, reason: '恢复不能绕过持久删除阻断' }) });
    expect(restored.status).not.toBe(200); expect(await restored.text()).not.toContain('允许短暂旧数据时可选方案A');
    const snapshot = await services.snapshot(f.ctx); if (!snapshot.ok) throw new Error(snapshot.error.code);
    expect(snapshot.data.nodes.map((n) => n.id)).not.toContain('k1'); expect(snapshot.data.excludedIds).toContain('k1'); expect(f.model).not.toHaveBeenCalled();
  });
});
