import { afterEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { ApprovalAuthority } from './approvals';
import { OperationJournal } from './journal';
import { createServices } from './services';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createApp } from '../server/app';
import { SCOPES } from '../contracts/scopes';
import type { DemoExportRequest } from '../contracts/demo-export';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function request(operationId = 'demo-export-1'): DemoExportRequest {
  return {
    operationId,
    baseRevision: 'a'.repeat(40),
    destination: 'local_download',
    items: [{ nodeId: 'k1', publicTitle: '公开标题', publicStatement: '公开陈述', publicConditions: ['公开前提'], publicSourceLabels: ['公开来源'] }],
    modelDeclaration: 'not_used',
    confirmed: true,
  };
}

describe('DemoExportStore', () => {
  it('registers an Authority approval and returns an idempotent local-only receipt', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const approval = await s.services.approveDemoExport!(s.ctx, request());
    expect(approval).toMatchObject({ ok: true, data: { purpose: 'demo_export', actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId, objectIds: ['k1'], baseRevision: s.base } });
    if (!approval.ok) throw new Error('Expected demo approval');
    const receipt = await s.services.executeDemoExport!(s.ctx, { ...request(), approval: approval.data });
    expect(receipt).toMatchObject({ ok: true, data: { operationId: 'demo-export-1', approvalId: approval.data.id, destination: 'local_download', contentHash: approval.data.contentHash, published: false } });
    if (!receipt.ok) throw new Error('Expected demo receipt');
    expect(receipt.data.authorizationBinding).toMatchObject({ purpose: 'demo_export', operationId: 'demo-export-1', actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId, contentHash: receipt.data.contentHash });
    expect(receipt.data.files.map((file) => file.path)).toEqual(['demo/knowledge.json', 'manifest.json']);
    expect(await s.services.executeDemoExport!(s.ctx, { ...request(), approval: approval.data })).toEqual(receipt);
    expect((await s.services.readDemoExport!(s.ctx, 'demo-export-1'))).toMatchObject({ ok: true, data: { status: 'executed', receipt: receipt.data } });
  });

  it('rejects a changed request under the original operation ID and never regenerates an approval', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const original = request();
    expect((await s.services.approveDemoExport!(s.ctx, original)).ok).toBe(true);
    const changed = { ...original, items: [{ ...original.items[0]!, publicStatement: '改变后的公开陈述' }] };
    expect(await s.services.approveDemoExport!(s.ctx, changed)).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    expect(await s.services.readDemoExport!(s.ctx, original.operationId)).toMatchObject({ ok: true, data: { status: 'approved' } });
  });

  it('rejects blocked objects before reading them into a public copy', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    s.journal.block(s.ctx.workspaceId, ['k1'], 'delete-plan-1');
    expect(await s.services.approveDemoExport!(s.ctx, request())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'preserved' } });
    expect(s.journal.records(s.ctx.workspaceId, '@workspace', 'approval_registration:demo_export')).toHaveLength(0);
  });

  it('keeps approval and receipt recovery durable across SQLite restart', async () => {
    mkdirSync('.local', { recursive: true });
    const directory = mkdtempSync(resolve('.local/demo-export-fixture-'));
    const file = join(directory, 'state.sqlite');
    const s = await platformFixture(file);
    try {
      const approval = await s.services.approveDemoExport!(s.ctx, request());
      if (!approval.ok) throw new Error('Expected demo approval');
      const receipt = await s.services.executeDemoExport!(s.ctx, { ...request(), approval: approval.data });
      if (!receipt.ok) throw new Error('Expected demo receipt');
      s.journal.close();
      const reopened = new OperationJournal(file, { fixture: true });
      try {
        const services = createServices({ ...s.options, journal: reopened, approvalAuthority: new ApprovalAuthority(s.sessions, reopened) });
        expect(await services.readDemoExport!(s.ctx, request().operationId)).toEqual({ ok: true, data: { operationId: request().operationId, actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId, status: 'executed', approval: approval.data, requestHash: receipt.data.requestHash, receipt: receipt.data, absenceIsFinal: false } });
      } finally { reopened.close(); }
    } finally { try { s.journal.close(); } catch { /* Closed before the restart assertion. */ } rmSync(directory, { recursive: true, force: true }); }
  });

  it('requires both export and knowledge read scopes and does not expose another actor payload', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const approval = await s.services.approveDemoExport!(s.ctx, request());
    if (!approval.ok) throw new Error('Expected demo approval');
    const workspace = await s.services.workspace(s.ctx);
    if (!workspace.ok) throw new Error('Expected workspace');
    const restrictedToken = s.sessions.issue({ actorId: s.ctx.actorId, workspace: workspace.data, scopes: ['data:export'] });
    const restrictedContext = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${restrictedToken}` } }));
    if (!restrictedContext.ok) throw new Error('Expected restricted context');
    expect(await s.services.readDemoExport!(restrictedContext.data, request().operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const otherToken = s.sessions.issue({ actorId: 'other-actor', workspace: workspace.data, scopes: Object.values(SCOPES) });
    const otherContext = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${otherToken}` } }));
    if (!otherContext.ok) throw new Error('Expected other context');
    expect(await s.services.readDemoExport!(otherContext.data, request().operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('blocks persisted demo files after the selected object enters the deletion barrier', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const approval = await s.services.approveDemoExport!(s.ctx, request());
    if (!approval.ok) throw new Error('Expected demo approval');
    const receipt = await s.services.executeDemoExport!(s.ctx, { ...request(), approval: approval.data });
    if (!receipt.ok) throw new Error('Expected demo receipt');

    s.journal.block(s.ctx.workspaceId, ['k1'], 'delete-demo-1');

    expect(await s.services.readDemoExport!(s.ctx, request().operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'preserved', nextAction: 'read_delete_report' } });
    expect(await s.services.readOperationRecovery!(s.ctx, { kind: 'demo_export', operationId: request().operationId })).toMatchObject({ ok: true, data: { stage: 'executed', readOnly: true, absenceIsFinal: false } });
  });

  it('fails closed when a persisted receipt loses its actor or approval binding', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const approval = await s.services.approveDemoExport!(s.ctx, request());
    if (!approval.ok) throw new Error('Expected demo approval');
    const receipt = await s.services.executeDemoExport!(s.ctx, { ...request(), approval: approval.data });
    if (!receipt.ok) throw new Error('Expected demo receipt');

    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'demo_export_receipt', request().operationId, {
      receipt: { ...receipt.data, actorId: 'other-actor', authorizationBinding: { ...receipt.data.authorizationBinding, actorId: 'other-actor' } },
    }, 1);

    expect(await s.services.readDemoExport!(s.ctx, request().operationId)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', nextAction: 'read_demo_export' } });
  });

  it('is available through the shared HTTP routes, including the original operation readback', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    const app = createApp(s.services);
    const approvedResponse = await app.request('/api/workspace/approvals/demo-export', { method: 'POST', headers: s.headers, body: JSON.stringify(request()) });
    expect(approvedResponse.status).toBe(200);
    const approved = await approvedResponse.json();
    expect(approved.data.purpose).toBe('demo_export');
    const executionResponse = await app.request('/api/workspace/demo-exports', { method: 'POST', headers: s.headers, body: JSON.stringify({ ...request(), approval: approved.data }) });
    expect(executionResponse.status).toBe(200);
    const receipt = await executionResponse.json();
    expect(receipt).toMatchObject({ ok: true, data: { operationId: request().operationId, contentHash: approved.data.contentHash, destination: 'local_download', published: false } });
    const readback = await app.request(`/api/workspace/demo-exports/${request().operationId}`, { headers: s.headers });
    expect(readback.status).toBe(200);
    expect(await readback.json()).toMatchObject({ ok: true, data: { status: 'executed', receipt: receipt.data } });
  });
});
