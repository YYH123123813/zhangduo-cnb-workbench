import { afterEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { CONTRACT_VERSION } from '../contracts/domain';
import type { Result, RequestContext } from '../contracts/api';
import { DemoExportReceiptSchema } from '../contracts/demo-export';
import { EvidenceReceiptSchema } from '../contracts/evidence';
import { GovernanceOperationReceiptSchema } from '../contracts/governance-operation';
import { HandoffOperationReceiptSchema } from '../contracts/handoff-operation';
import { TaskReceiptSchema } from '../contracts/task-record';
import { ApprovalAuthority } from './approvals';
import { OperationJournal } from './journal';
import { createServices } from './services';
import { platformFixture } from '../../tests/integration/platform-fixture';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));

function data<T>(result: Result<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}

function timestamp(offset = 0) { return new Date(Date.now() + offset).toISOString(); }
const hash = (letter: string) => letter.repeat(64);

function register(s: Awaited<ReturnType<typeof platformFixture>>, input: {
  operationId: string;
  purpose: 'save_conversation' | 'model_input' | 'save_evidence' | 'demo_export';
  objectIds: string[];
  contentHash?: string;
  baseRevision?: string;
  modelPurpose?: 'extract' | 'answer' | 'review';
}) {
  const approval = s.authority.registerOperation(s.ctx, {
    purpose: input.purpose,
    objectIds: input.objectIds,
    contentHash: input.contentHash ?? hash('b'),
    baseRevision: input.baseRevision ?? s.base,
  }, {
    operationId: input.operationId,
    requestHash: hash('c'),
    ...(input.modelPurpose ? { modelPurpose: input.modelPurpose } : {}),
  });
  return data(approval);
}

function otherContext(s: Awaited<ReturnType<typeof platformFixture>>): RequestContext {
  const workspace = { id: s.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private' as const, mode: 'fixture' as const };
  const token = s.sessions.issue({ actorId: 'other-actor', workspace, scopes: [...s.ctx.scopes] });
  return data(s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
}

describe('OperationRecoveryStore', () => {
  it('returns a non-final absence without disclosing payload or claiming a retry', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const result = data(await s.services.readOperationRecovery!(s.ctx, { kind: 'task', operationId: 'missing-task-operation' }));
    expect(result).toMatchObject({ kind: 'task', operationId: 'missing-task-operation', stage: 'not_registered', readOnly: true, absenceIsFinal: false,
      actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId, approvalId: null, recordId: null, requestHash: null, contentHash: null, objectIds: [] });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('recovers capture by the registered operation ID and maps in-flight to sending', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const captureId = 'capture-operation-A', conversationId = 'conversation-A', contentHash = hash('d');
    register(s, { operationId: captureId, purpose: 'save_conversation', objectIds: [conversationId], contentHash, baseRevision: 'new' });
    expect(s.journal.claim({ workspaceId: s.ctx.workspaceId, objectId: conversationId, actorId: s.ctx.actorId, contentHash, state: 'inflight' })).toBe(true);
    expect(data(await s.services.readOperationRecovery!(s.ctx, { kind: 'capture', operationId: captureId }))).toMatchObject({ operationId: captureId, stage: 'sending', objectIds: [conversationId], contentHash });
  });

  it.each(['approved', 'sending', 'done', 'discarded', 'not_sent'] as const)('recovers model %s using approval.id as the durable operation key', async (state) => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const operationId = `model-operation-${state}`, approval = register(s, { operationId, purpose: 'model_input', modelPurpose: 'extract', objectIds: ['segment-1'], contentHash: hash('e') });
    s.journal.putRecord(s.ctx.workspaceId, '@workspace', 'model_operation', approval.id, {
      actorId: s.ctx.actorId, contentHash: approval.contentHash, purpose: 'extract', state: state === 'approved' ? 'sending' : state,
      date: '2026-09-09', expiresAt: Date.now() + 60_000,
    }, null);
    const result = data(await s.services.readOperationRecovery!(s.ctx, { kind: 'model', operationId, modelPurpose: 'extract' }));
    expect(result).toMatchObject({ operationId, purpose: 'extract', approvalId: approval.id, objectIds: ['segment-1'], contentHash: approval.contentHash,
      stage: state === 'approved' ? 'sending' : state });
  });

  it('recovers evidence and demo export receipts without returning their private payloads', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const evidenceOperationId = 'evidence-operation-A', evidenceContentHash = hash('f');
    const evidenceApproval = register(s, { operationId: evidenceOperationId, purpose: 'save_evidence', objectIds: ['evidence-A'], contentHash: evidenceContentHash });
    const evidenceReceipt = EvidenceReceiptSchema.parse({ operationId: evidenceOperationId, approvalId: evidenceApproval.id, recordId: 'evidence-A', workspaceId: s.ctx.workspaceId,
      actorId: s.ctx.actorId, contentHash: evidenceContentHash, baseRevision: s.base, recordedAt: timestamp(), storedAt: timestamp(), retention: 'until_deleted', outcome: 'saved' });
    s.journal.putRecord(s.ctx.workspaceId, '@workspace', 'evidence_receipt', evidenceOperationId, evidenceReceipt, null);
    expect(data(await s.services.readOperationRecovery!(s.ctx, { kind: 'evidence', operationId: evidenceOperationId }))).toMatchObject({ stage: 'saved', recordId: 'evidence-A', contentHash: evidenceContentHash, baseRevision: s.base });

    const exportOperationId = 'demo-export-operation-A', exportApproval = register(s, { operationId: exportOperationId, purpose: 'demo_export', objectIds: ['k1'], contentHash: hash('a') });
    const exportReceipt = DemoExportReceiptSchema.parse({ operationId: exportOperationId, approvalId: exportApproval.id, actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId,
      baseRevision: s.base, objectIds: ['k1'], requestHash: hash('c'), contentHash: hash('a'), destination: 'local_download',
      files: [{ path: 'manifest.json', content: '{"public":true}' }], limitations: ['local only'], published: false,
      authorizationBinding: { purpose: 'demo_export', destination: 'local_download', operationId: exportOperationId, actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId,
        baseRevision: s.base, objectIds: ['k1'], requestHash: hash('c'), contentHash: hash('a') } });
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'demo_export_receipt', exportOperationId, { receipt: exportReceipt }, null);
    const recovered = data(await s.services.readOperationRecovery!(s.ctx, { kind: 'demo_export', operationId: exportOperationId }));
    expect(recovered).toMatchObject({ stage: 'executed', recordId: null, objectIds: ['k1'], contentHash: hash('a'), baseRevision: s.base });
    expect(JSON.stringify(recovered)).not.toContain('public');
  });

  it('recovers task, handoff, and governance receipt metadata after SQLite restart', async () => {
    mkdirSync('.local/fixture', { recursive: true });
    const directory = mkdtempSync(resolve('.local/fixture/operation-recovery-')), file = join(directory, 'state.sqlite');
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const s = await platformFixture(file);
    const taskReceipt = TaskReceiptSchema.parse({ operationId: 'task-operation-A', taskId: 'task-A', workspaceId: s.ctx.workspaceId, actorId: s.ctx.actorId,
      requestHash: hash('a'), contentHash: hash('b'), previousRevision: 0, revision: 1, storedAt: timestamp(), expiresAt: timestamp(86_400_000), retentionDays: 30, outcome: 'saved' });
    const handoffReceipt = HandoffOperationReceiptSchema.parse({ operationId: 'handoff-operation-A', workspaceId: s.ctx.workspaceId, actorId: s.ctx.actorId,
      draftId: 'draft-A', draftRevision: 1, draftContentHash: hash('c'), conversationId: 'conversation-A', conversationHash: hash('d'), baseRevision: s.base,
      changeSetHash: hash('e'), requestHash: hash('f'), contentHash: hash('a'), revision: 1, storedAt: timestamp(), expiresAt: timestamp(86_400_000), retentionDays: 30, outcome: 'saved' });
    const governanceReceipt = GovernanceOperationReceiptSchema.parse({ operationId: 'governance-operation-A', kind: 'delete', actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId,
      baseRevision: s.base, contentHash: hash('b'), requestHash: hash('c'), outcome: 'saved', savedAt: timestamp() });
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'task_receipt', taskReceipt.operationId, taskReceipt, null);
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'handoff_operation_receipt', handoffReceipt.operationId, handoffReceipt, null);
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'governance_operation_receipt', governanceReceipt.operationId, governanceReceipt, null);
    s.journal.close();

    const reopened = new OperationJournal(file, { fixture: true }); cleanup.push(() => reopened.close());
    const services = createServices({ ...s.options, journal: reopened, approvalAuthority: new ApprovalAuthority(s.sessions, reopened) });
    expect(data(await services.readOperationRecovery!(s.ctx, { kind: 'task', operationId: taskReceipt.operationId }))).toMatchObject({ stage: 'saved', recordId: 'task-A', requestHash: hash('a') });
    expect(data(await services.readOperationRecovery!(s.ctx, { kind: 'handoff', operationId: handoffReceipt.operationId }))).toMatchObject({ stage: 'saved', recordId: 'draft-A', baseRevision: s.base });
    expect(data(await services.readOperationRecovery!(s.ctx, { kind: 'governance', operationId: governanceReceipt.operationId }))).toMatchObject({ stage: 'saved', purpose: 'delete', baseRevision: s.base });
  });

  it('does not return another actor\'s registration or any operation payload', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const operationId = 'cross-actor-operation-A';
    register(s, { operationId, purpose: 'save_conversation', objectIds: ['conversation-private'], contentHash: hash('d'), baseRevision: 'new' });
    const result = await s.services.readOperationRecovery!(otherContext(s), { kind: 'capture', operationId });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(result)).not.toContain('conversation-private');
    expect(JSON.stringify(result)).not.toContain(hash('d'));
  });

  it('serves no-store metadata over HTTP and rejects missing or repeated model query parameters', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const { createApp } = await import('../server/app');
    const app = createApp(s.services);
    const absent = await app.request('/api/workspace/operation-recovery/task/missing-task', { headers: s.headers });
    expect(absent.status).toBe(200);
    expect(absent.headers.get('Cache-Control')).toBe('no-store');
    expect((await absent.json() as { meta: { contractVersion: string } }).meta.contractVersion).toBe(CONTRACT_VERSION);
    expect((await app.request('/api/workspace/operation-recovery/model/model-A', { headers: s.headers })).status).toBe(422);
    expect((await app.request('/api/workspace/operation-recovery/task/task-A?modelPurpose=extract', { headers: s.headers })).status).toBe(422);
    expect((await app.request('/api/workspace/operation-recovery/model/model-A?modelPurpose=extract&modelPurpose=answer', { headers: s.headers })).status).toBe(422);
    expect((await app.request('/api/workspace/operation-recovery/task/task-A?private=body', { headers: s.headers })).status).toBe(422);
  });
});
