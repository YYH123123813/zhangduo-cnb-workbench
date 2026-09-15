import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { hashChangeSet, hashSettings } from '../../src/contracts/hash';
import type { Approval, ChangeSet, DeletePlan, DeleteReport, Settings } from '../../src/contracts/domain';
import type { DemoExportRequest } from '../../src/contracts/demo-export';
import { platformFixture } from './platform-fixture';
import type { OperationJournal } from '../../src/platform/journal';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));

async function responseData<T>(response: Response, label: string): Promise<T> {
  const body = await response.json() as { ok: boolean; data?: T; error?: unknown };
  expect(body.ok, `${label}: ${JSON.stringify(body)}`).toBe(true);
  if (!body.ok) throw new Error(`${label}: ${JSON.stringify(body)}`);
  return body.data as T;
}

describe('shared governance vertical integration', () => {
  it('keeps settings approval, atomic save, receipt readback and recovery metadata on the same operation', async () => {
    const s = await platformFixture();
    journals.push(s.journal);
    const app = createApp(s.services);
    const current = await responseData<{ settings: Settings; revision: number }>(
      await app.request('/api/workspace/settings', { headers: s.headers }), 'read settings',
    );
    const target = { ...current.settings, aiAnswer: true };
    const approval = await responseData<Approval>(await app.request('/api/workspace/approvals/governance', {
      method: 'POST', headers: s.headers,
      body: JSON.stringify({ purpose: 'settings', settings: target, baseRevision: s.base,
        expectedSettingsHash: await hashSettings(s.ctx.workspaceId, s.base, current.settings),
        expectedSettingsRevision: current.revision, operationId: 'settings-vertical-1', confirmed: true }),
    }), 'approve settings');
    expect(await s.services.saveSettings(s.ctx, target, approval)).toEqual({ ok: true, data: target });

    const receipt = await responseData<{ approvalId: string; revision: number; settings: Settings; outcome: 'saved' }>(
      await app.request(`/api/workspace/settings/receipts/${approval.id}`, { headers: s.headers }), 'read settings receipt',
    );
    expect(receipt).toMatchObject({ approvalId: approval.id, revision: 1, settings: target, outcome: 'saved' });
    expect((await s.services.saveSettings(s.ctx, target, approval)).ok).toBe(true);
    expect(await s.services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 1, settings: target } });
  });

  it('preserves the original revision while restoring exclusions and reading commit/delete state back', async () => {
    const s = await platformFixture();
    journals.push(s.journal);
    const app = createApp(s.services);
    s.initial.nodes[0]!.lifecycle = 'withdrawn';
    (s.initial as { excludedIds: string[] }).excludedIds = ['k1'];
    const changes: ChangeSet = {
      id: 'restore-vertical-1', workspaceId: s.ctx.workspaceId, baseRevision: s.base,
      nodes: [{ ...s.node, lifecycle: 'active', revision: s.base }], relations: [], withdrawnIds: [],
      reason: 'Restore the explicitly selected historical knowledge', contentHash: 'pending',
    };
    changes.contentHash = await hashChangeSet(changes);
    const approval = await s.services.approveKnowledge!(s.ctx, { changes, confirmed: true });
    expect(approval.ok).toBe(true);
    if (!approval.ok) throw new Error('Expected restore approval');
    const committed = await s.services.commit(s.ctx, changes, approval.data);
    expect(committed).toMatchObject({ ok: true, data: { changeSetId: changes.id, indexing: 'pending' } });
    const commit = await responseData<{ changeSetId: string; revision: string }>(
      await app.request(`/api/workspace/commits/${changes.id}`, { headers: s.headers }), 'read commit receipt',
    );
    expect(commit.changeSetId).toBe(changes.id);
    expect(await s.services.snapshot(s.ctx)).toMatchObject({ ok: true, data: { excludedIds: [], nodes: [expect.objectContaining({ lifecycle: 'active' })] } });
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { excludedIds: ['k1'], nodes: [expect.objectContaining({ lifecycle: 'withdrawn' })] } });

    const planResult = await s.services.previewDelete(s.ctx, ['k1']);
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error('Expected delete plan');
    const plan = planResult.data;
    const deleteApproval = await responseData<Approval>(await app.request('/api/workspace/approvals/governance', {
      method: 'POST', headers: s.headers,
      body: JSON.stringify({ purpose: 'delete', planId: plan.id, operationId: 'delete-vertical-1', confirmed: true }),
    }), 'approve delete');
    const report = await s.services.executeDelete(s.ctx, plan, deleteApproval);
    expect(report).toMatchObject({ ok: true, data: { planId: plan.id, retrievalBlocked: true } });
    expect(await responseData<DeletePlan>(await app.request(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}`, { headers: s.headers }), 'read delete plan')).toEqual(plan);
    const readReport = await responseData<DeleteReport>(await app.request(`/api/workspace/delete-plans/${encodeURIComponent(plan.id)}/report`, { headers: s.headers }), 'read delete report');
    expect(readReport).toEqual(report.ok ? report.data : undefined);
    expect(readReport.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'application', state: 'done' }),
      expect.objectContaining({ name: 'git_history', state: 'unknown' }),
    ]));
    const blockedSnapshot = await s.services.snapshot(s.ctx);
    expect(blockedSnapshot).toMatchObject({ ok: true, data: { nodes: [], excludedIds: ['k1'] } });
  });

  it('keeps demo export approval, local-only execution and original-operation readback separate from ordinary export', async () => {
    const s = await platformFixture();
    journals.push(s.journal);
    const app = createApp(s.services);
    const input: DemoExportRequest = {
      operationId: 'demo-vertical-1', baseRevision: s.base, destination: 'local_download',
      items: [{ nodeId: 'k1', publicTitle: '公开标题', publicStatement: '公开陈述', publicConditions: ['公开前提'], publicSourceLabels: ['公开来源'] }],
      modelDeclaration: 'not_used', confirmed: true,
    };
    const approval = await responseData<Approval>(await app.request('/api/workspace/approvals/demo-export', {
      method: 'POST', headers: s.headers, body: JSON.stringify(input),
    }), 'approve demo export');
    const receipt = await responseData<{ operationId: string; approvalId: string; published: false; files: { path: string; content: string }[] }>(await app.request('/api/workspace/demo-exports', {
      method: 'POST', headers: s.headers, body: JSON.stringify({ ...input, approval }),
    }), 'execute demo export');
    expect(receipt).toMatchObject({ operationId: input.operationId, approvalId: approval.id, published: false });
    expect(receipt.files.map((file) => file.path)).toEqual(['demo/knowledge.json', 'manifest.json']);
    const recovered = await responseData<{ status: string; receipt: unknown }>(await app.request(`/api/workspace/demo-exports/${input.operationId}`, { headers: s.headers }), 'read demo export');
    expect(recovered).toMatchObject({ status: 'executed', receipt });
    const recovery = await responseData<{ kind: string; operationId: string; stage: string; readOnly: true; absenceIsFinal: false }>(await app.request(`/api/workspace/operation-recovery/demo_export/${input.operationId}`, { headers: s.headers }), 'read operation recovery');
    expect(recovery).toMatchObject({ kind: 'demo_export', operationId: input.operationId, stage: 'executed', readOnly: true, absenceIsFinal: false });
    expect(receipt.files.every((file) => !file.content.includes(s.ctx.workspaceId))).toBe(true);
  });
});
