import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platformFixture } from './platform-fixture';
import { createApp } from '../../src/server/app';
import { hashChangeSet, hashSettings } from '../../src/contracts/hash';
import { OperationJournal } from '../../src/platform/journal';
import { ApprovalAuthority } from '../../src/platform/approvals';
import { createServices } from '../../src/platform/services';
import { CONTRACT_VERSION, type ChangeSet } from '../../src/contracts/domain';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
describe('W11 shared governance routes and durable recovery', () => {
  it('registers governance approval through the shared API and binds the original settings revision', async () => {
    const s = await platformFixture(); journals.push(s.journal); const app = createApp(s.services);
    const state = await (await app.request('/api/workspace/settings', { headers: s.headers })).json();
    expect(state.data.revision).toBe(0);
    const response = await app.request('/api/workspace/approvals/governance', { method: 'POST', headers: s.headers, body: JSON.stringify({ purpose: 'settings', settings: { ...state.data.settings, aiAnswer: true }, baseRevision: s.base,
      expectedSettingsHash: await hashSettings(s.ctx.workspaceId, s.base, state.data.settings), expectedSettingsRevision: state.data.revision, confirmed: true }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, meta: { mode: 'fixture', contractVersion: CONTRACT_VERSION }, data: { purpose: 'settings', actorId: s.ctx.actorId, objectIds: [s.ctx.workspaceId] } });
    expect((await app.request('/api/workspace/settings')).status).toBe(401);
  });
  it('restores a Git withdrawal with a new commit while keeping the prior snapshot immutable', async () => {
    const s = await platformFixture(); journals.push(s.journal);
    s.initial.nodes[0]!.lifecycle = 'withdrawn';
    const initial = s.initial as { excludedIds: string[] }; initial.excludedIds = ['k1'];
    const changes: ChangeSet = { id: 'restore1', workspaceId: s.ctx.workspaceId, baseRevision: s.base, nodes: [{ ...s.node, lifecycle: 'active', revision: s.base }], relations: [], withdrawnIds: [], reason: 'Explicit historical restore', contentHash: 'pending' };
    changes.contentHash = await hashChangeSet(changes);
    const approval = await s.services.approveKnowledge!(s.ctx, { changes, confirmed: true });
    if (!approval.ok) throw new Error('Expected approval');
    const committed = await s.services.commit(s.ctx, changes, approval.data);
    expect(committed).toMatchObject({ ok: true, data: { indexing: 'pending' } });
    expect(await s.services.snapshot(s.ctx)).toMatchObject({ ok: true, data: { excludedIds: [], nodes: [expect.objectContaining({ lifecycle: 'active' })] } });
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { excludedIds: ['k1'], nodes: [expect.objectContaining({ lifecycle: 'withdrawn' })] } });
  });
  it('recovers the exact delete plan, report and barrier across a SQLite close/reopen', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/governance-fixture-')); const file = join(directory, 'state.sqlite');
    const s = await platformFixture(file);
    try {
      const plan = await s.services.previewDelete(s.ctx, ['k1']); if (!plan.ok) throw new Error('Expected plan');
      const approval = await s.services.approveGovernance!(s.ctx, { purpose: 'delete', planId: plan.data.id, confirmed: true }); if (!approval.ok) throw new Error('Expected approval');
      const report = await s.services.executeDelete(s.ctx, plan.data, approval.data);
      s.journal.close();
      const reopened = new OperationJournal(file, { fixture: true });
      try {
        const services = createServices({ ...s.options, journal: reopened, approvalAuthority: new ApprovalAuthority(s.sessions, reopened) });
        expect(await services.readDeletePlan!(s.ctx, plan.data.id)).toEqual(plan);
        expect(await services.readDeleteReport!(s.ctx, plan.data.id)).toEqual(report);
        expect(await services.snapshot(s.ctx)).toMatchObject({ ok: true, data: { nodes: [], excludedIds: ['k1'] } });
        const app = createApp(services);
        const response = await app.request(`/api/workspace/delete-plans/${encodeURIComponent(plan.data.id)}/report`, { headers: s.headers });
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject(report);
      } finally { reopened.close(); }
    } finally { try { s.journal.close(); } catch { /* Already closed for the restart test. */ } rmSync(directory, { recursive: true, force: true }); }
  });
});
