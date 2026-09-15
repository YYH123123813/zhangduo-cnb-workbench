import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import type { Result } from '../contracts/api';
import { ApprovalSchema, type ChangeSet, type EvidenceRecord } from '../contracts/domain';
import type { EvidenceApprovalRequest } from '../contracts/evidence';
import { createApp } from '../server/app';
import { canonicalJson, contentHash, hashChangeSet, hashEvidence } from '../contracts/hash';
import { createServices } from './services';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function data<T>(result: Result<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
async function setup(persistent = false, dependency = false) {
  let file = ':memory:';
  if (persistent) { mkdirSync('.local/fixture', { recursive: true }); const dir = mkdtempSync(resolve('.local/fixture/evidence-')); file = join(dir, 'state.sqlite'); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); }
  const f = await platformFixture(file); let journal = f.journal; cleanup.push(() => journal.close());
  let services = f.services;
  if (dependency) f.documents.set(f.base, { ...f.initial, nodes: [...f.initial.nodes, { ...f.node, id: 'k2' }], relations: [{
    id: 'requires-k2', workspaceId: f.ctx.workspaceId, source: { workspaceId: f.ctx.workspaceId, objectId: 'k1', revision: '@snapshot' },
    target: { workspaceId: f.ctx.workspaceId, objectId: 'k2', revision: '@snapshot' }, type: 'depends_on', rationale: 'Original dependency',
    evidenceIds: ['source-A'], state: 'confirmed', proposedBy: f.ctx.actorId, confirmedBy: f.ctx.actorId,
    confirmedAt: f.node.confirmedAt, updatedAt: f.node.updatedAt,
  }] });
  const snapshot = data(await services.snapshot(f.ctx)), node = snapshot.nodes[0]!;
  const { id, revision, title, humanStatement, conditions, boundaries, evidenceStatus } = node;
  const record: EvidenceRecord = { id: 'use-A', workspaceId: f.ctx.workspaceId, taskId: 'original-task', kind: 'use', nodeRefs: [{ workspaceId: f.ctx.workspaceId, objectId: id, revision }], relationRefs: [],
    decision: 'adopt', answer: '', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'unverified', recordedAt: new Date().toISOString(),
    useContext: { task: { id: 'original-task', workspaceId: f.ctx.workspaceId, question: 'Original private task', constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() },
      snapshotRevision: snapshot.revision, knowledge: [{ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus }], relations: [],
      paths: [{ seedId: id, nodeIds: [id], relationIds: [], reason: 'Selected formal text' }], reason: 'A limited user decision, not proof of mastery',
      retrievalContext: { queryId: null, coverage: 'unavailable', missingConditions: [], warnings: ['Index coverage was unavailable'], trust: 'client_preview_only' } },
  };
  const request: EvidenceApprovalRequest = { operationId: 'save-use-A', record, baseRevision: f.base, retention: 'until_deleted', confirmed: true };
  if (dependency) {
    record.relationRefs = snapshot.relations.map((edge) => edge.id);
    record.useContext!.knowledge = snapshot.nodes.map(({ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus }) => ({ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus }));
    record.useContext!.relations = snapshot.relations;
    record.useContext!.paths = [{ seedId: 'k1', nodeIds: ['k1', 'k2'], relationIds: ['requires-k2'], reason: 'Original dependency path' }];
  }
  return { ...f, file, record, request, services: () => services, reopen() { journal.close(); journal = new OperationJournal(file, { fixture: true });
    services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }); },
  };
}
function outcomeFor(record: EvidenceRecord): EvidenceRecord {
  return { id: 'outcome-A', workspaceId: record.workspaceId, taskId: record.taskId, kind: 'outcome', nodeRefs: record.nodeRefs, relationRefs: record.relationRefs,
    answer: '', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'self_reported', recordedAt: new Date().toISOString(),
    outcome: { useRecordId: record.id, status: 'failed', summary: 'A new constraint changed the outcome.', failureReason: 'A premise did not hold.', verification: 'self_reported' } };
}

describe('S05/S06 private structured evidence with actual SQLite and Services', () => {
  it('binds the full original task and knowledge context, saves once and reads the original receipt after restart', async () => {
    const f = await setup(true), services = f.services();
    const approval = data(await services.approveEvidence!(f.ctx, f.request));
    expect(approval).toMatchObject({ purpose: 'save_evidence', objectIds: [f.record.id], contentHash: await hashEvidence(f.record), baseRevision: f.base });
    expect(data(await services.listEvidence(f.ctx))).toEqual([]);
    const writes = await Promise.all([services.appendEvidence(f.ctx, f.record, approval), services.appendEvidence(f.ctx, f.record, approval)]);
    expect(data(writes[0]!)).toEqual(f.record); expect(writes[1]).toEqual(writes[0]);
    f.reopen(); expect(data(await f.services().readEvidence!(f.ctx, f.record.id))).toEqual(f.record);
    expect(data(await f.services().readEvidenceReceipt!(f.ctx, f.request.operationId))).toMatchObject({ operationId: f.request.operationId, approvalId: approval.id, recordId: f.record.id, contentHash: await hashEvidence(f.record), outcome: 'saved' });
    expect(data(await f.services().listEvidence(f.ctx, f.record.taskId))).toEqual([f.record]);
    expect(data(await f.services().readApprovalRegistration!(f.ctx, { operationId: f.request.operationId, purpose: 'save_evidence' }))).toMatchObject({ approval, requestHash: await contentHash(f.request) });
    expect(data(await f.services().audit(f.ctx)).filter((event) => event.action === 'evidence_saved')).toEqual([
      expect.objectContaining({ objectIds: [f.record.id], operation: { kind: 'evidence', id: f.request.operationId }, outcome: 'private_not_indexed' }),
    ]);
    expect(f.git.publish).not.toHaveBeenCalled();
  });
  it('rejects forged knowledge, paths, actor attribution, stale versions and untrusted learning uploads before approval', async () => {
    const f = await setup();
    const changes = [
      { ...f.record, useContext: { ...f.record.useContext!, knowledge: [{ ...f.record.useContext!.knowledge[0]!, humanStatement: 'Forged history' }] } },
      { ...f.record, useContext: { ...f.record.useContext!, paths: [{ seedId: 'k1', nodeIds: ['k1', 'missing'], relationIds: ['invented-edge'], reason: 'Fake path' }] } },
      { ...f.record, useContext: { ...f.record.useContext!, task: { ...f.record.useContext!.task, constraints: [{ id: 'c', text: 'Private premise', confirmedBy: 'another' }] } } },
      { ...f.record, nodeRefs: [{ ...f.record.nodeRefs[0]!, revision: 'b'.repeat(40) }] },
      { ...f.record, kind: 'recall' as const, useContext: undefined, answerVisible: false, result: 'met_rubric' as const },
    ];
    for (const record of changes) expect((await f.services().approveEvidence!(f.ctx, { ...f.request, record })).ok).toBe(false);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
  });
  it('keeps a separate self-reported outcome tied to the original use and its old version without rewriting it', async () => {
    const f = await setup(true), original = structuredClone(f.record);
    data(await f.services().appendEvidence(f.ctx, f.record, data(await f.services().approveEvidence!(f.ctx, f.request))));
    const changes: ChangeSet = { id: 'new-premise', workspaceId: f.ctx.workspaceId, baseRevision: f.base,
      nodes: [{ ...data(await f.services().snapshot(f.ctx)).nodes[0]!, humanStatement: 'A revised formal conclusion', updatedAt: new Date().toISOString() }],
      relations: [], withdrawnIds: [], reason: 'A new premise', contentHash: 'pending' };
    changes.contentHash = await hashChangeSet(changes);
    const receipt = data(await f.services().commit(f.ctx, changes, data(await f.services().approveKnowledge!(f.ctx, { changes, confirmed: true }))));
    expect(receipt.revision).not.toBe(f.base);
    const outcome = outcomeFor(original);
    const request = { ...f.request, operationId: 'save-outcome-A', record: outcome };
    data(await f.services().appendEvidence(f.ctx, outcome, data(await f.services().approveEvidence!(f.ctx, request))));
    f.reopen();
    expect(data(await f.services().readEvidence!(f.ctx, original.id))).toEqual(original);
    expect(data(await f.services().readEvidence!(f.ctx, outcome.id))).toEqual(outcome);
    expect((await f.services().approveEvidence!(f.ctx, { ...request, operationId: 'bad-outcome', record: { ...outcome, outcome: { ...outcome.outcome!, useRecordId: 'missing' } } })).ok).toBe(false);
  });
  it('rejects changed payloads and duplicate IDs with another operation; revoked approval cannot append but old receipts survive', async () => {
    const f = await setup(), approval = data(await f.services().approveEvidence!(f.ctx, f.request));
    expect((await f.services().appendEvidence(f.ctx, { ...f.record, useContext: { ...f.record.useContext!, reason: 'Not approved' } }, approval)).ok).toBe(false);
    data(await f.services().appendEvidence(f.ctx, f.record, approval));
    const another = data(await f.services().approveEvidence!(f.ctx, { ...f.request, operationId: 'another-op' }));
    expect(await f.services().appendEvidence(f.ctx, f.record, another)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    data(await f.services().revokeApproval!(f.ctx, approval.id));
    expect((await f.services().appendEvidence(f.ctx, f.record, approval)).ok).toBe(false);
    expect(data(await f.services().readEvidenceReceipt!(f.ctx, f.request.operationId))).toMatchObject({ approvalId: approval.id });
    expect(data(await f.services().readEvidenceReceipt!(f.ctx, 'absent'))).toBeNull();
  });
  it('atomically rolls back payload and receipt, and enforces permissions before storage access', async () => {
    const f = await setup(), approval = data(await f.services().approveEvidence!(f.ctx, f.request));
    const put = f.journal.putRecord.bind(f.journal);
    vi.spyOn(f.journal, 'putRecord').mockImplementation((...args) => args[2] === 'evidence_receipt' ? false : put(...args));
    expect((await f.services().appendEvidence(f.ctx, f.record, approval)).ok).toBe(false);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    vi.restoreAllMocks(); const read = vi.spyOn(f.journal, 'records');
    expect((await f.services().listEvidence({ ...f.ctx })).ok).toBe(false); expect(read).not.toHaveBeenCalled();
  });
  it('blocks current and saved historical evidence after deletion, while retaining metadata receipts across restart', async () => {
    const f = await setup(true); data(await f.services().appendEvidence(f.ctx, f.record, data(await f.services().approveEvidence!(f.ctx, f.request))));
    const plan = data(await f.services().previewDelete(f.ctx, ['k1']));
    const approval = data(await f.services().approveGovernance!(f.ctx, { purpose: 'delete', operationId: 'delete-k1', planId: plan.id, confirmed: true }));
    data(await f.services().executeDelete(f.ctx, plan, approval)); f.reopen();
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    expect(await f.services().readEvidence!(f.ctx, f.record.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(data(await f.services().readEvidenceReceipt!(f.ctx, f.request.operationId))).toMatchObject({ outcome: 'saved' });
  });
  it('exports the exact selected evidence through governance HTTP and clears only its local payload after an approved plan', async () => {
    const f = await setup(true), services = f.services();
    data(await services.appendEvidence(f.ctx, f.record, data(await services.approveEvidence!(f.ctx, f.request))));
    const app = createApp(services), objectIds = ['k1', f.record.id];
    const approval = data(await services.approveGovernance!(f.ctx, { purpose: 'export', operationId: 'export-evidence', objectIds, baseRevision: f.base, confirmed: true }));
    const response = await app.request('/api/governance/export', { method: 'POST', headers: f.headers, body: JSON.stringify({ action: 'execute', objectIds, baseRevision: f.base, approval }) });
    const exported = data(await response.json() as Result<{ files: { path: string; content: string }[] }>);
    expect(exported.files.find((file) => file.path === 'evidence/1.json')?.content).toBe(canonicalJson(f.record));
    expect((await services.approveGovernance!(f.ctx, { purpose: 'export', operationId: 'incomplete-export', objectIds: [f.record.id], baseRevision: f.base, confirmed: true })).ok).toBe(false);
    const plan = data(await services.previewDelete(f.ctx, [f.record.id]));
    const deletion = data(await services.approveGovernance!(f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    expect(data(await services.executeDelete(f.ctx, plan, deletion)).layers).toContainEqual(expect.objectContaining({ name: 'private_state', state: 'done' }));
    expect(JSON.stringify(f.journal.record(f.ctx.workspaceId, '@workspace', 'evidence', f.record.id)?.value)).not.toContain('Original private task');
    f.reopen(); expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    expect(data(await f.services().snapshot(f.ctx)).nodes).toHaveLength(1);
    expect(data(await f.services().readEvidenceReceipt!(f.ctx, f.request.operationId))).toMatchObject({ outcome: 'saved' });
  });
  it('allows only one exact evidence operation from two independent SQLite connections', async () => {
    const f = await setup(true), journal = new OperationJournal(f.file, { fixture: true }); cleanup.push(() => journal.close());
    const second = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) });
    const other = { ...f.record, useContext: { ...f.record.useContext!, reason: 'A different decision from session B' } };
    const a = data(await f.services().approveEvidence!(f.ctx, f.request));
    const b = data(await second.approveEvidence!(f.ctx, { ...f.request, operationId: 'save-use-B', record: other }));
    const results = await Promise.all([f.services().appendEvidence(f.ctx, f.record, a), second.appendEvidence(f.ctx, other, b)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'CONFLICT' } });
    const receipts = await Promise.all(['save-use-A', 'save-use-B'].map((id) => f.services().readEvidenceReceipt!(f.ctx, id)));
    expect(receipts.filter((result) => data(result) !== null)).toHaveLength(1);
  });
  it('blocks an outcome when a dependency appears only in its original use context, including after restart', async () => {
    const f = await setup(true, true), services = f.services();
    data(await services.appendEvidence(f.ctx, f.record, data(await services.approveEvidence!(f.ctx, f.request))));
    const outcome = outcomeFor(f.record), request = { ...f.request, operationId: 'outcome-operation', record: outcome };
    const approval = data(await services.approveEvidence!(f.ctx, request));
    data(await services.appendEvidence(f.ctx, outcome, approval));
    const plan = data(await services.previewDelete(f.ctx, ['k2']));
    data(await services.executeDelete(f.ctx, plan, data(await services.approveGovernance!(f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }))));
    f.reopen();
    expect(await f.services().readEvidence!(f.ctx, outcome.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
    expect(await f.services().appendEvidence(f.ctx, outcome, approval)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(data(await f.services().readEvidenceReceipt!(f.ctx, request.operationId))).toMatchObject({ outcome: 'saved' });
  });
  it('retains the barrier and reports private cleanup failure without claiming the payload erased', async () => {
    const f = await setup(true), services = f.services();
    data(await services.appendEvidence(f.ctx, f.record, data(await services.approveEvidence!(f.ctx, f.request))));
    const plan = data(await services.previewDelete(f.ctx, [f.record.id]));
    const approval = data(await services.approveGovernance!(f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    const put = f.journal.putRecord.bind(f.journal);
    vi.spyOn(f.journal, 'putRecord').mockImplementation((...args) => args[2] === 'evidence' ? false : put(...args));
    const report = data(await services.executeDelete(f.ctx, plan, approval));
    expect(report).toMatchObject({ retrievalBlocked: true, layers: expect.arrayContaining([expect.objectContaining({ name: 'private_state', state: 'failed' })]) });
    expect(JSON.stringify(f.journal.record(f.ctx.workspaceId, '@workspace', 'evidence', f.record.id)?.value)).toContain('Original private task');
    vi.restoreAllMocks(); f.reopen();
    expect(data(await f.services().readDeleteReport!(f.ctx, plan.id))).toEqual(report);
    expect(data(await f.services().listEvidence(f.ctx))).toEqual([]);
  });
  it('does not export cached evidence when deletion starts during a slow export read', async () => {
    const f = await setup(), services = f.services();
    data(await services.appendEvidence(f.ctx, f.record, data(await services.approveEvidence!(f.ctx, f.request))));
    const ids = ['k1', f.record.id], approval = data(await services.approveGovernance!(f.ctx, { purpose: 'export', objectIds: ids, baseRevision: f.base, confirmed: true }));
    const records = f.journal.records.bind(f.journal);
    vi.spyOn(f.journal, 'records').mockImplementation((...args) => {
      const result = records(...args);
      if (args[2] === 'evidence') f.journal.block(f.ctx.workspaceId, [f.record.id], 'concurrent-approved-delete');
      return result;
    });
    expect((await services.exportData(f.ctx, ids, approval)).ok).toBe(false);
  });
  it('uses the public approval and readback routes without exposing payloads across actors or revoked sessions', async () => {
    const f = await setup(), services = f.services(), app = createApp(services);
    const approved = await app.request('/api/workspace/approvals/evidence', { method: 'POST', headers: f.headers, body: JSON.stringify(f.request) });
    expect(approved.headers.get('Cache-Control')).toBe('no-store');
    const approval = ApprovalSchema.parse(data(await approved.json()));
    data(await services.appendEvidence(f.ctx, f.record, approval));
    for (const path of [`/api/workspace/evidence/${f.record.id}`, `/api/workspace/evidence-receipts/${f.request.operationId}`, `/api/workspace/approval-registrations/save_evidence/${f.request.operationId}`]) {
      expect((await app.request(path, { headers: f.headers })).status).toBe(200);
      const token = f.sessions.issue({ actorId: 'other-actor', workspace: data(await services.workspace(f.ctx)), scopes: [...f.ctx.scopes] });
      expect((await app.request(path, { headers: { ...f.headers, Authorization: `Bearer ${token}` } })).status).toBe(403);
    }
    f.sessions.revoke(f.token); const records = vi.spyOn(f.journal, 'record');
    expect((await app.request(`/api/workspace/evidence/${f.record.id}`, { headers: f.headers })).status).toBe(401);
    expect(records).not.toHaveBeenCalled();
  });
  it('persists exact task condition checks, binds them to approval and rejects stale or forged confirmations', async () => {
    const f = await setup(true);
    const condition = { id: 'required-premise', text: 'A required premise', status: 'confirmed' as const, evidenceIds: [] };
    f.initial.nodes[0]!.conditions = [condition];
    f.record.useContext!.knowledge[0]!.conditions = [condition];
    f.record.decision = 'verify_later';
    const check = { nodeRef: f.record.nodeRefs[0]!, conditionId: condition.id, status: 'not_satisfied' as const, confirmedBy: f.ctx.actorId };
    f.record.useContext!.task.conditionChecks = [check];
    const services = f.services(), approval = data(await services.approveEvidence!(f.ctx, f.request));
    const altered = { ...f.record, useContext: { ...f.record.useContext!, task: { ...f.record.useContext!.task, conditionChecks: [{ ...check, status: 'satisfied' as const }] } } };
    expect((await services.appendEvidence(f.ctx, altered, approval)).ok).toBe(false);
    for (const changed of [{ ...check, confirmedBy: 'other-actor' }, { ...check, nodeRef: { ...check.nodeRef, revision: 'b'.repeat(40) } }, { ...check, conditionId: 'same-text-different-id' }]) {
      const record = { ...f.record, useContext: { ...f.record.useContext!, task: { ...f.record.useContext!.task, conditionChecks: [changed] } } };
      expect((await services.approveEvidence!(f.ctx, { ...f.request, operationId: 'invalid-check', record })).ok).toBe(false);
    }
    data(await services.appendEvidence(f.ctx, f.record, approval)); f.reopen();
    expect(data(await f.services().readEvidence!(f.ctx, f.record.id))?.useContext?.task.conditionChecks).toEqual([check]);
    expect(f.initial.nodes[0]!.conditions).toEqual([condition]);
  });
});
