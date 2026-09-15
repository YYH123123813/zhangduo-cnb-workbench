import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, ok, snapshot } from './fixtures.test-support';
import { deletePlan } from './delete.fixtures.test-support';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { operationFromRoute } from './client-model';
import { Workspace } from './client';

describe('ID-only governance operation inspection', () => {
  it.each(['settings', 'export', 'delete'] as const)('inspects an original %s registration ID without its lost payload or a second registration', async (purpose) => {
    const { app, services } = fixture({ readApprovalRegistration: vi.fn(async () => ok({ purpose, operationId: 'original-registration', workspaceId: ctx.workspaceId, actorId: ctx.actorId, status: 'unknown' as const, approval: null, requestHash: null, absenceIsFinal: false as const })) });
    const response = await app.request(`/api/governance/operations/${purpose}_approval/original-registration`);
    expect(response.status).toBe(200); expect((await response.json()).data).toMatchObject({ id: 'original-registration', readOnly: true, contentVerified: false, originalPayloadAvailable: false, registration: { purpose, status: 'unknown' } });
    expect(services.readApprovalRegistration).toHaveBeenCalledWith(ctx, { purpose, operationId: 'original-registration' });
    expect(services.saveSettings).not.toHaveBeenCalled(); expect(services.executeDelete).not.toHaveBeenCalled(); expect(services.exportData).not.toHaveBeenCalled();
  });
  it('rejects an inner approval belonging to a foreign actor, workspace or purpose before reading a commit', async () => {
    for (const mismatch of [{ actorId: 'other' }, { workspaceId: 'other' }, { purpose: 'export' as const }]) {
      const { app, services } = fixture({ readKnowledgeApproval: vi.fn(async () => ok({ changeSetId: 'original', workspaceId: ctx.workspaceId, actorId: ctx.actorId, status: 'registered' as const, absenceIsFinal: false as const,
        approval: { id: 'approval', workspaceId: ctx.workspaceId, actorId: ctx.actorId, purpose: 'commit_knowledge' as const, objectIds: ['node-1'], contentHash: 'hash', baseRevision: 'fixture-r1', approvedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', ...mismatch } })),
        readCommit: vi.fn(async () => ok(null)) });
      expect((await app.request('/api/governance/operations/knowledge/original')).status).toBeGreaterThanOrEqual(400);
      expect(services.readCommit).not.toHaveBeenCalled();
    }
  });
  it('maps exact route IDs to a read-only inspector, locks editors, and rejects ambiguous IDs', () => {
    expect(operationFromRoute({ changeSetId: 'original' })).toEqual({ kind: 'knowledge', id: 'original' });
    expect(operationFromRoute({ approvalId: 'original' })).toEqual({ kind: 'settings', id: 'original' });
    expect(operationFromRoute({ planId: 'original' })).toEqual({ kind: 'delete', id: 'original' });
    expect(operationFromRoute({ planId: 'original', changeSetId: 'different' })).toBeUndefined();
    expect(operationFromRoute({ planId: 'bad id' })).toBeUndefined();
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snapshot(), actorId: ctx.actorId, scopes: ctx.scopes }, mode: 'fixture', routeParams: { changeSetId: 'original' } }));
    expect(html).toContain('aria-label="原操作核验"'); expect(html).toContain('value="original"');
    expect(html).toContain('<fieldset disabled="" aria-label="治理编辑区域">');
    expect(html).not.toContain('原变更已恢复');
  });
  it('reads the original knowledge metadata without claiming payload verification or enabling replay', async () => {
    const { app, services } = fixture({
      readKnowledgeApproval: vi.fn(async () => ok({ changeSetId: 'original', workspaceId: ctx.workspaceId, actorId: ctx.actorId, status: 'not_registered' as const, approval: null, absenceIsFinal: false as const })),
      readCommit: vi.fn(async () => ok({ changeSetId: 'original', revision: 'fixture-r2', commitUrl: 'https://example.invalid/fixture', indexing: 'pending' as const })),
    });
    const response = await app.request('/api/governance/operations/knowledge/original');
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ kind: 'knowledge', id: 'original', readOnly: true, originalPayloadAvailable: false, contentVerified: false, commit: { changeSetId: 'original' } });
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('keeps a missing settings receipt unknown instead of attributing current matching settings to it', async () => {
    const { app, services } = fixture({ readSettingsReceipt: vi.fn(async () => ok(null)) });
    const response = await app.request('/api/governance/operations/settings/original');
    expect(response.status).toBe(200); expect((await response.json()).data).toMatchObject({ state: 'not_recorded', receipt: null, absenceIsFinal: false });
    expect(services.saveSettings).not.toHaveBeenCalled(); expect(services.settings).not.toHaveBeenCalled();
  });

  it('reads an evidence save operation by its original operation ID without restoring private payload or writing again', async () => {
    const receipt = { operationId: 'evidence-save-1', approvalId: 'evidence-approval-1', recordId: 'use-1', workspaceId: ctx.workspaceId, actorId: ctx.actorId,
      contentHash: 'b'.repeat(64), baseRevision: 'a'.repeat(40), recordedAt: '2026-09-05T00:00:00Z', storedAt: '2026-09-05T00:00:01Z', retention: 'until_deleted' as const, outcome: 'saved' as const };
    const { app, services } = fixture({ readEvidenceReceipt: vi.fn(async () => ok(receipt)) });
    const response = await app.request('/api/governance/operations/evidence/evidence-save-1');
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ kind: 'evidence', id: 'evidence-save-1', readOnly: true, originalPayloadAvailable: false,
      receipt: { operationId: 'evidence-save-1', recordId: 'use-1', outcome: 'saved' } });
    expect(services.readEvidenceReceipt).toHaveBeenCalledWith(ctx, 'evidence-save-1');
  });

  it('rejects an evidence receipt that points at a different original operation', async () => {
    const receipt = { operationId: 'other-operation', approvalId: 'evidence-approval-1', recordId: 'use-1', workspaceId: ctx.workspaceId, actorId: ctx.actorId,
      contentHash: 'b'.repeat(64), baseRevision: 'a'.repeat(40), recordedAt: '2026-09-05T00:00:00Z', storedAt: '2026-09-05T00:00:01Z', retention: 'until_deleted' as const, outcome: 'saved' as const };
    const { app } = fixture({ readEvidenceReceipt: vi.fn(async () => ok(receipt)) });
    expect((await app.request('/api/governance/operations/evidence/evidence-save-1')).status).toBe(409);
  });
  it('derives deletion scope only from the original plan and keeps physical cleanup separate', async () => {
    const plan = await deletePlan();
    const { app, services } = fixture({ readDeletePlan: vi.fn(async () => ok(plan)), readDeleteReport: vi.fn(async () => ok({ planId: plan.id, retrievalBlocked: true, layers: [] })), snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['node-1'] }))) });
    const response = await app.request(`/api/governance/operations/delete/${plan.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: plan.id, kind: 'delete', readOnly: true, result: { reportAvailable: true, retrievalBlocked: true, physicalDeletionComplete: false } });
    expect(services.previewDelete).not.toHaveBeenCalled(); expect(services.executeDelete).not.toHaveBeenCalled();
  });
  it('rejects foreign identities, different operation IDs and missing scopes', async () => {
    for (const mismatch of [{ actorId: 'other' }, { changeSetId: 'other' }, { workspaceId: 'other' }]) {
      const { app } = fixture({ readKnowledgeApproval: vi.fn(async () => ok({ changeSetId: 'original', actorId: ctx.actorId, workspaceId: ctx.workspaceId, status: 'unknown' as const, approval: null, absenceIsFinal: false as const, ...mismatch })) });
      expect((await app.request('/api/governance/operations/knowledge/original')).status).toBeGreaterThanOrEqual(400);
    }
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/operations/settings/original')).status).toBe(403);
    expect(denied.services.saveSettings).not.toHaveBeenCalled();
  });
});
