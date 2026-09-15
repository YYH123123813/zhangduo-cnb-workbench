import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import { OperationJournal } from '../../platform/journal';
import { ApprovalAuthority } from '../../platform/approvals';
import type { Result } from '../../contracts/api';
import type { Approval, ChangeSet, EvidenceRecord, RetrievalResult, TaskContext } from '../../contracts/domain';
import type { EvidenceApprovalRequest } from '../../contracts/evidence';
import { contentHash, hashEvidence } from '../../contracts/hash';
import { EvidenceSaveFlow, type EvidenceTransport } from './evidence-save-flow';
import type { EvidenceStoragePreview } from './application-api';
import { savedOutcomeLinks } from './links';
import { parseRoute } from '../../app/routing';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function data<T>(result: Result<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.data; }
type StoragePreview = EvidenceStoragePreview;

async function setup(persistent = false) {
  if (persistent) mkdirSync('.local/fixture', { recursive: true });
  const directory = persistent ? mkdtempSync(resolve('.local/fixture/learning-evidence-')) : null;
  if (directory) cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = directory ? join(directory, 'state.sqlite') : ':memory:';
  const f = await platformFixture(file); let journal = f.journal, services = f.services, app = createApp(services);
  cleanup.push(() => journal.close());
  const task = { id: 'task-application', workspaceId: f.ctx.workspaceId, question: 'Can the original conclusion meet this task?',
    constraints: [{ id: 'limited', text: 'A stated task boundary', confirmedBy: f.ctx.actorId }], mode: 'assisted' as const, updatedAt: '2026-09-05T00:00:00Z' };
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: f.headers });
  const preview = async (decision: 'adopt' | 'reject' | 'verify_later' = 'adopt') => {
    const response = await post('/api/learning/use', { action: 'preview', selection: { task, snapshotRevision: f.base,
      nodeRefs: [{ workspaceId: f.ctx.workspaceId, objectId: 'k1', revision: f.base }], relationRefs: [], decision, reason: 'Only under the stated boundary' } });
    expect(response.status).toBe(200);
    const value = data(await response.json() as Result<{ storage: StoragePreview }>);
    expect(value.storage).toMatchObject({ actorId: f.ctx.actorId, baseRevision: f.base, record: { kind: 'use', useContext: { task } } });
    return value.storage;
  };
  const requestFor = (preview: StoragePreview): EvidenceApprovalRequest => ({ operationId: preview.operationId, record: preview.record,
    baseRevision: preview.baseRevision, retention: 'until_deleted', confirmed: true });
  const approve = async (request: EvidenceApprovalRequest) => data(await (await post('/api/workspace/approvals/evidence', request)).json() as Result<Approval>);
  const transport: EvidenceTransport = async (path, init) => (await app.request(path, { ...init, headers: f.headers })).json();
  return { ...f, file, task, post, get, preview, requestFor, approve, transport, services: () => services,
    reopen() { journal.close(); journal = new OperationJournal(file, { fixture: true }); services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }); app = createApp(services); } };
}

describe('1.14 learning HTTP with actual shared Services and private SQLite', () => {
  it('keeps the complete approved preview immutable while the save operation is in flight', async () => {
    const f = await setup(), preview = await f.preview(), flow = new EvidenceSaveFlow(preview, f.transport);
    const observations: { phase: string; busy: boolean }[] = [];
    flow.subscribe(() => observations.push({ phase: flow.state.phase, busy: flow.state.busy }));
    await flow.approve(true);
    expect(Reflect.set(flow.preview.record.useContext!, 'reason', 'UNAPPROVED REPLACEMENT')).toBe(false);
    expect(Reflect.set(flow.preview, 'baseRevision', 'b'.repeat(40))).toBe(false);
    await flow.save(); expect(flow.state.phase).toBe('saved');
    expect(observations.filter((state) => state.phase === 'saved').every((state) => !state.busy)).toBe(true);
    expect(data(await f.services().readEvidence!(f.ctx, preview.record.id))).toEqual(preview.record);
  });

  it('cold recovery matches the original registration, receipt and full record after reopening SQLite', async () => {
    const f = await setup(true), preview = await f.preview(), flow = new EvidenceSaveFlow(preview, f.transport);
    await flow.approve(true); await flow.save(); f.reopen();
    const { readEvidenceOperation } = await import('./evidence-recovery');
    const transport = vi.fn(f.transport);
    const recovered = data(await readEvidenceOperation(transport, f.ctx, preview.operationId));
    expect(recovered).toMatchObject({ status: 'saved', record: preview.record, receipt: { operationId: preview.operationId },
      operationRecovery: { kind: 'evidence', operationId: preview.operationId, stage: 'saved', recordId: preview.record.id, readOnly: true, absenceIsFinal: false } });
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('cold recovery cannot turn an approval and missing receipt into a saved or unwritten operation', async () => {
    const f = await setup(true), preview = await f.preview(); await f.approve(f.requestFor(preview)); f.reopen();
    const { readEvidenceOperation } = await import('./evidence-recovery');
    const transport = vi.fn(f.transport), recovered = data(await readEvidenceOperation(transport, f.ctx, preview.operationId));
    expect(recovered.status).toBe('unresolved'); expect(recovered.record).toBeNull(); expect(recovered.receipt).toBeNull();
    expect(recovered.operationRecovery).toMatchObject({ kind: 'evidence', operationId: preview.operationId, stage: 'approved', readOnly: true, absenceIsFinal: false });
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('cold recovery rejects another operation or a changed request hash instead of rendering the body', async () => {
    const f = await setup(), preview = await f.preview(), flow = new EvidenceSaveFlow(preview, f.transport);
    await flow.approve(true); await flow.save();
    const { readEvidenceOperation } = await import('./evidence-recovery');
    for (const mismatch of ['operation', 'requestHash']) {
      const transport: EvidenceTransport = async (path, init) => {
        const response = await f.transport(path, init);
        if (!response.ok) return response;
        if (mismatch === 'operation' && path.includes('evidence-receipts')) return { ok: true, data: { ...(response.data as object), operationId: 'somebody-else' } };
        if (mismatch === 'requestHash' && path.includes('approval-registrations')) return { ok: true, data: { ...(response.data as object), requestHash: 'f'.repeat(64) } };
        return response;
      };
      expect(await readEvidenceOperation(transport, f.ctx, preview.operationId)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    }
    expect(await readEvidenceOperation(f.transport, { ...f.ctx, actorId: 'another' }, preview.operationId)).toMatchObject({ ok: false });
  });

  it.each(['adopt', 'reject', 'verify_later'] as const)('saves %s through its exact approval and reads structured history after reopening SQLite', async (decision) => {
    const f = await setup(true), preview = await f.preview(decision), request = f.requestFor(preview);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    const approval = await f.approve(request);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    const response = await f.post('/api/learning/use', { action: 'execute', request, approval });
    expect(response.status).toBe(200);
    expect(data(await response.json())).toMatchObject({ persistence: 'saved', indexing: 'excluded', receipt: {
      operationId: request.operationId, recordId: request.record.id, approvalId: approval.id, contentHash: await hashEvidence(request.record) } });
    f.reopen();
    expect(data(await (await f.get(`/api/workspace/evidence/${request.record.id}`)).json())).toEqual(request.record);
    expect(data(await (await f.get(`/api/learning/records/${request.record.id}`)).json())).toMatchObject({ contextState: 'recorded', record: request.record });
    expect(data(await (await f.get(`/api/workspace/approval-registrations/save_evidence/${request.operationId}`)).json())).toMatchObject({ requestHash: await contentHash(request), approval });
    expect(data(await (await f.get('/api/learning/records?taskId=task-application')).json())).toMatchObject({ records: [{ contextState: 'recorded', record: { decision } }] });
    expect(f.git.publish).not.toHaveBeenCalled();
  });

  it('saves a separate failed outcome with original use context and an explicit outcome label', async () => {
    const f = await setup(true), use = await f.preview(), request = f.requestFor(use);
    data(await (await f.post('/api/learning/use', { action: 'execute', request, approval: await f.approve(request) })).json());
    const response = await f.post('/api/learning/outcomes', { action: 'preview', outcome: {
      useRecordId: use.record.id, status: 'failed', summary: 'The task result was unsuccessful', failureReason: 'The original boundary did not hold' } });
    expect(response.status).toBe(200);
    const outcome = data(await response.json() as Result<{ storage: StoragePreview }>).storage;
    expect(outcome).toMatchObject({ baseRevision: use.baseRevision, record: { kind: 'outcome', result: 'self_reported', outcome: { useRecordId: use.record.id, verification: 'self_reported' } } });
    const outcomeRequest = f.requestFor(outcome);
    data(await (await f.post('/api/learning/outcomes', { action: 'execute', request: outcomeRequest, approval: await f.approve(outcomeRequest) })).json());
    f.reopen();
    expect(data(await f.services().readEvidence!(f.ctx, use.record.id))).toEqual(use.record);
    expect(data(await (await f.get(`/api/learning/records/${outcome.record.id}`)).json())).toMatchObject({ contextState: 'linked_use', record: outcome.record });
  });

  it('keeps approval and saving separate, and cancels before approval with zero writes', async () => {
    const f = await setup(), preview = await f.preview(), transport = vi.fn(f.transport), flow = new EvidenceSaveFlow(preview, transport);
    await flow.cancel(); expect(flow.state.phase).toBe('cancelled'); expect(transport).not.toHaveBeenCalled();
    const next = new EvidenceSaveFlow(preview, transport);
    await next.approve(false); expect(transport).not.toHaveBeenCalled();
    await next.approve(true); expect(next.state.phase).toBe('approved'); expect(next.blocked).toBe(true);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    await next.cancel(); expect(next.state.phase).toBe('cancelled'); expect(next.blocked).toBe(false);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    expect(data(await f.services().readApprovalRegistration!(f.ctx, { operationId: preview.operationId, purpose: 'save_evidence' }))).toMatchObject({ status: 'revoked' });
  });

  it('recovers lost approval after SQLite reopen only by GET and still needs an explicit save', async () => {
    const f = await setup(true), preview = await f.preview(); let dropped = false;
    const transport = vi.fn<EvidenceTransport>(async (path, init) => {
      const result = await f.transport(path, init);
      if (!dropped && path === '/api/workspace/approvals/evidence') { dropped = true; throw new Error('Dropped approval response'); }
      return result;
    });
    const flow = new EvidenceSaveFlow(preview, transport);
    await flow.approve(true); expect(flow.state.phase).toBe('approval_unknown'); expect(flow.blocked).toBe(true);
    await flow.save(); expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    f.reopen(); transport.mockClear(); await flow.verify();
    expect(flow.state.phase).toBe('approved'); expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    await flow.save(); expect(flow.state.phase).toBe('saved'); expect(flow.state.receipt?.operationId).toBe(preview.operationId);
  });

  it('recovers a lost save after reopen without resending even after approval revocation', async () => {
    const f = await setup(true), preview = await f.preview(); let dropped = false;
    const transport = vi.fn<EvidenceTransport>(async (path, init) => {
      const result = await f.transport(path, init);
      if (!dropped && path === '/api/learning/use' && init?.method === 'POST') { dropped = true; throw new Error('Dropped save response'); }
      return result;
    });
    const flow = new EvidenceSaveFlow(preview, transport);
    await flow.approve(true); await flow.save(); expect(flow.state.phase).toBe('save_unknown');
    data(await f.services().revokeApproval!(f.ctx, flow.state.approval!.id)); f.reopen();
    transport.mockClear(); await flow.verify(); expect(flow.state.phase).toBe('saved'); expect(flow.blocked).toBe(false);
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(data(await f.services().listEvidence(f.ctx))).toHaveLength(1);
  });

  it('does not treat a matching receipt as saved until the original record is read back', async () => {
    const f = await setup(true), preview = await f.preview(); let dropped = false;
    const transport = vi.fn<EvidenceTransport>(async (path, init) => {
      const result = await f.transport(path, init);
      if (!dropped && path === '/api/learning/use' && init?.method === 'POST') { dropped = true; throw new Error('Dropped save response'); }
      if (path === `/api/workspace/evidence/${encodeURIComponent(preview.record.id)}` && result.ok && result.data) {
        const record = result.data as EvidenceRecord;
        return { ok: true as const, data: { ...record, useContext: { ...record.useContext!, reason: 'Different unapproved payload' } } };
      }
      return result;
    });
    const flow = new EvidenceSaveFlow(preview, transport); await flow.approve(true); await flow.save();
    expect(flow.state.phase).toBe('save_unknown');
    await flow.verify();
    expect(flow.state.phase).toBe('save_unknown'); expect(flow.blocked).toBe(true);
    expect(transport.mock.calls.some(([path]) => path === `/api/workspace/evidence/${encodeURIComponent(preview.record.id)}`)).toBe(true);
  });

  it('does not report execute success when the platform readback differs from the approved record', async () => {
    const f = await setup(), preview = await f.preview(), request = f.requestFor(preview), approval = await f.approve(request);
    const services = f.services(), readEvidence = services.readEvidence;
    if (!readEvidence) throw new Error('Fixture must expose readEvidence');
    services.readEvidence = async (ctx, id) => {
      const result = await readEvidence(ctx, id);
      if (!result.ok || !result.data) return result;
      return { ok: true as const, data: { ...result.data, useContext: { ...result.data.useContext!, reason: 'Different unapproved payload' } } };
    };
    const response = await f.post('/api/learning/use', { action: 'execute', request, approval });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(data(await services.readEvidenceReceipt!(f.ctx, request.operationId))).toMatchObject({ operationId: request.operationId });
  });

  it('does not claim another operation with identical content when the original append never arrived', async () => {
    const f = await setup(), preview = await f.preview();
    const transport: EvidenceTransport = async (path, init) => {
      if (path === '/api/learning/use' && init?.method === 'POST') throw new Error('Request did not arrive');
      return f.transport(path, init);
    };
    const flow = new EvidenceSaveFlow(preview, transport); await flow.approve(true); await flow.save();
    const other = { ...f.requestFor(preview), operationId: 'other-save-operation' };
    data(await f.services().appendEvidence(f.ctx, other.record, await f.approve(other)));
    await flow.verify(); expect(flow.state.phase).toBe('save_unknown'); expect(flow.blocked).toBe(true);
    expect(flow.state.receipt).toBeNull();
  });

  it('keeps not_registered and late approval unresolved after a cancellation request', async () => {
    const f = await setup(), preview = await f.preview();
    const transport: EvidenceTransport = async (path, init) => {
      if (path === '/api/workspace/approvals/evidence') throw new Error('Approval still pending');
      return f.transport(path, init);
    };
    const flow = new EvidenceSaveFlow(preview, transport);
    await flow.approve(true); await flow.cancel(); await flow.verify();
    expect(flow.state.phase).toBe('approval_unknown'); expect(flow.blocked).toBe(true);
    await f.approve(f.requestFor(preview)); await flow.verify();
    expect(flow.state.phase).toBe('approved'); expect(flow.state.cancelRequested).toBe(true);
    await flow.save(); expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    await flow.cancel(); expect(flow.state.phase).toBe('cancelled');
  });

  it('retains the exact receipt but denies saved bodies after source deletion and session revocation', async () => {
    const f = await setup(true), preview = await f.preview(), flow = new EvidenceSaveFlow(preview, f.transport);
    await flow.approve(true); await flow.save(); expect(flow.state.phase).toBe('saved');
    const plan = data(await f.services().previewDelete(f.ctx, ['k1']));
    const approval = data(await f.services().approveGovernance!(f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    data(await f.services().executeDelete(f.ctx, plan, approval)); f.reopen();
    expect((await f.get(`/api/learning/records/${preview.record.id}`)).status).toBe(403);
    expect(data(await (await f.get(`/api/workspace/evidence-receipts/${preview.operationId}`)).json())).toMatchObject({ outcome: 'saved' });
    f.sessions.revoke(f.token);
    expect((await f.get(`/api/workspace/evidence-receipts/${preview.operationId}`)).status).toBe(401);
  });

  it.each(['revoked', 'expired', 'changed_payload'] as const)('rejects a %s approval at the learning HTTP boundary with no new evidence', async (caseName) => {
    // The authority captures its clock at construction; install the test clock before setup.
    if (caseName === 'expired') vi.useFakeTimers({ toFake: ['Date'] });
    const f = await setup(), preview = await f.preview(), request = f.requestFor(preview), approval = await f.approve(request);
    if (caseName === 'revoked') data(await f.services().revokeApproval!(f.ctx, approval.id));
    if (caseName === 'expired') vi.setSystemTime(Date.parse(approval.expiresAt) + 1);
    if (caseName === 'changed_payload') request.record.useContext!.reason = 'Not in the approved payload';
    const result = await f.post('/api/learning/use', { action: 'execute', request, approval });
    expect(result.status).toBe(403); expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    expect(data(await f.services().readEvidenceReceipt!(f.ctx, request.operationId))).toBeNull();
  });

  it('isolates two sessions and SQLite connections racing to save the same content under different operations', async () => {
    const f = await setup(true), preview = await f.preview(), first = f.requestFor(preview), second = { ...first, operationId: 'second-session-operation' };
    const journal = new OperationJournal(f.file, { fixture: true }); cleanup.push(() => journal.close());
    const peer = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }), app = createApp(peer);
    const token = f.sessions.issue({ actorId: f.ctx.actorId, workspace: data(await peer.workspace(f.ctx)), scopes: [...f.ctx.scopes] });
    const firstApproval = await f.approve(first);
    const secondApproval = data(await (await app.request('/api/workspace/approvals/evidence', { method: 'POST', headers: { ...f.headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(second) })).json() as Result<Approval>);
    const responses = await Promise.all([f.post('/api/learning/use', { action: 'execute', request: first, approval: firstApproval }),
      app.request('/api/learning/use', { method: 'POST', headers: { ...f.headers, Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'execute', request: second, approval: secondApproval }) })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses[0]!.status === 200 ? first : second, loser = winner === first ? second : first;
    expect(data(await f.services().listEvidence(f.ctx))).toHaveLength(1);
    expect(data(await peer.readEvidenceReceipt!(f.ctx, winner.operationId))).toMatchObject({ operationId: winner.operationId });
    expect(data(await peer.readEvidenceReceipt!(f.ctx, loser.operationId))).toBeNull();
  });

  it('hands an actually saved failure to governance, reruns the same question and preserves the old use after restart', async () => {
    const f = await setup(true);
    const condition = { id: 'local-copy', text: 'A local copy exists', status: 'confirmed' as const, evidenceIds: ['premise-source'], confirmedBy: f.ctx.actorId };
    f.documents.set(f.base, { ...f.initial, nodes: [{ ...f.node, conditions: [condition] }] });
    const originalTask: TaskContext = { ...f.task, question: f.node.title, conditionChecks: [{ nodeRef: { workspaceId: f.ctx.workspaceId, objectId: 'k1', revision: f.base },
      conditionId: condition.id, status: 'satisfied', confirmedBy: f.ctx.actorId }] };
    data(await (await f.post('/api/workspace/tasks', { operationId: 'save-original-task', task: originalTask, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true })).json());
    const query = (task: TaskContext) => f.post('/api/retrieval/query', { task, query: task.question, confirmedOnly: true });
    const retrieval = data(await (await query(originalTask)).json() as Result<RetrievalResult>);
    const use = data(await (await f.post('/api/learning/use', { action: 'preview_retrieved', task: originalTask, retrieval, nodeId: 'k1', decision: 'adopt', reason: 'Apply only with the stated local copy and coverage limits' })).json() as Result<{ storage: StoragePreview }>).storage;
    const flow = new EvidenceSaveFlow(use, f.transport); await flow.approve(true); await flow.save(); expect(flow.state.phase).toBe('saved');
    const original = structuredClone(use.record);
    const outcome = data(await (await f.post('/api/learning/outcomes', { action: 'preview', outcome: { useRecordId: original.id, status: 'failed', summary: 'The task failed', failureReason: 'The local copy premise needs revision' } })).json() as Result<{ storage: StoragePreview }>).storage;
    const outcomeFlow = new EvidenceSaveFlow(outcome, f.transport); await outcomeFlow.approve(true); await outcomeFlow.save(); expect(outcomeFlow.state.phase).toBe('saved');
    const route = parseRoute(savedOutcomeLinks(outcome.record)[0]!.href); expect(route.page).toBe('governance');
    expect(route.params).toMatchObject({ useId: original.id, evidenceId: outcome.record.id, taskId: originalTask.id, revision: f.base });
    const historyQuery = new URLSearchParams({ nodeId: 'k1', useId: original.id, evidenceId: outcome.record.id, taskId: originalTask.id });
    const history = data(await (await f.get(`/api/governance/history?${historyQuery}`)).json() as Result<{ entries: { record: EvidenceRecord }[] }>);
    expect(history.entries.map((entry) => entry.record.id)).toEqual(expect.arrayContaining([original.id, outcome.record.id]));
    const revised = data(await (await f.transport('/api/governance/nodes/k1', { method: 'PATCH', body: JSON.stringify({ action: 'preview', operationId: 'revise-failed-premise', baseRevision: f.base, nodeRevision: f.base,
      reason: outcome.record.outcome!.failureReason, patch: { conditions: [{ ...condition, text: 'The copy must also be current', status: 'unknown', confirmedBy: undefined }] } }) })) as Result<{ changes: Omit<ChangeSet, 'contentHash'> }>);
    const prepared = data(await (await f.post('/api/governance/changes/prepare', { action: 'prepare', changes: revised.changes })).json() as Result<{ changes: ChangeSet }>);
    const approval = data(await (await f.post('/api/workspace/approvals/knowledge', { changes: prepared.changes, confirmed: true })).json() as Result<Approval>);
    const committed = data(await (await f.post('/api/governance/changes/commit', { action: 'commit', changes: prepared.changes, approval })).json() as Result<{ receipt: { revision: string } }>);
    f.reopen();
    const taskState = data(await (await f.get(`/api/workspace/tasks/${originalTask.id}`)).json() as Result<{ task: TaskContext }>);
    expect(taskState.task).toEqual(originalTask); expect((await query(taskState.task)).status).toBe(409);
    const rechecked: TaskContext = { ...taskState.task, conditionChecks: [{ nodeRef: { ...originalTask.conditionChecks![0]!.nodeRef, revision: committed.receipt.revision }, conditionId: condition.id, status: 'unknown' }] };
    const rerun = data(await (await query(rechecked)).json() as Result<RetrievalResult>);
    expect(rerun.snapshotRevision).toBe(committed.receipt.revision); expect(rerun.groups.eligible).toEqual([]);
    expect(rerun.missingConditions.join(' ')).toContain('The copy must also be current');
    expect(data(await f.services().readEvidence!(f.ctx, original.id))).toEqual(original);
    expect(data(await f.services().readEvidence!(f.ctx, outcome.record.id))).toEqual(outcome.record);
  });
});
