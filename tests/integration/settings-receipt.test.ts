import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platformFixture } from './platform-fixture';
import { createApp } from '../../src/server/app';
import { hashSettings } from '../../src/contracts/hash';
import { SettingsReceiptSchema } from '../../src/contracts/governance';
import { OperationJournal } from '../../src/platform/journal';
import { ApprovalAuthority } from '../../src/platform/approvals';
import { createServices } from '../../src/platform/services';
import type { RequestContext } from '../../src/contracts/api';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup() { const s = await platformFixture(); journals.push(s.journal); return s; }
async function approve(s: Awaited<ReturnType<typeof platformFixture>>, ctx = s.ctx, enabled = true) {
  const state = await s.services.settingsState!(ctx); if (!state.ok) throw new Error('Expected settings');
  const settings = { ...state.data.settings, aiAnswer: enabled };
  const result = await s.services.approveGovernance!(ctx, { purpose: 'settings', settings, baseRevision: s.base,
    expectedSettingsHash: await hashSettings(ctx.workspaceId, s.base, state.data.settings), expectedSettingsRevision: state.data.revision, confirmed: true });
  if (!result.ok) throw new Error('Expected settings approval');
  return { approval: result.data, settings };
}
function contextFor(s: Awaited<ReturnType<typeof platformFixture>>, actorId: string, workspaceId = s.ctx.workspaceId, scopes: readonly string[] = s.ctx.scopes): RequestContext {
  const token = s.sessions.issue({ actorId, workspace: { id: workspaceId, slug: 'fixture/platform', mode: 'fixture', visibility: 'private' }, scopes });
  const context = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
  if (!context.ok) throw new Error('Expected trusted session'); return context.data;
}

describe('W6-REQ-005 original settings operation receipts', () => {
  it('does not attribute a matching target from another session to an operation that never executed', async () => {
    const s = await setup();
    const a = await approve(s), b = await approve(s, contextFor(s, s.ctx.actorId));
    expect((await s.services.saveSettings(s.ctx, b.settings, b.approval)).ok).toBe(true);
    expect(await s.services.readSettingsReceipt!(s.ctx, a.approval.id)).toEqual({ ok: true, data: null });
    const receipt = await s.services.readSettingsReceipt!(s.ctx, b.approval.id);
    expect(receipt).toEqual({ ok: true, data: { approvalId: b.approval.id, workspaceId: s.ctx.workspaceId, actorId: s.ctx.actorId,
      contentHash: b.approval.contentHash, baseRevision: s.base, previousRevision: 0, revision: 1, settings: b.settings, outcome: 'saved' } });
    if (!receipt.ok) throw new Error('Expected receipt'); expect(SettingsReceiptSchema.safeParse(receipt.data).success).toBe(true);
    expect(await s.services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 1, settings: a.settings } });
  });
  it('preserves a completed fact after later revisions, approval revocation and expiry with zero write/read-remote operations', async () => {
    const s = await setup(); const first = await approve(s);
    await s.services.saveSettings(s.ctx, first.settings, first.approval);
    const expected = await s.services.readSettingsReceipt!(s.ctx, first.approval.id);
    const second = await approve(s, s.ctx, false); await s.services.saveSettings(s.ctx, second.settings, second.approval);
    s.authority.revoke(s.ctx, first.approval.id);
    const afterExpiry = createServices({ ...s.options, approvalAuthority: new ApprovalAuthority(s.sessions, s.journal, () => Date.parse(first.approval.expiresAt) + 1) });
    const save = vi.spyOn(afterExpiry, 'saveSettings'); s.transport.mockClear();
    const app = createApp(afterExpiry);
    const response = await app.request(`/api/workspace/settings/receipts/${encodeURIComponent(first.approval.id)}`, { headers: s.headers });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject(expected);
    expect(await afterExpiry.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 2, settings: { aiAnswer: false } } });
    expect(save).not.toHaveBeenCalled(); expect(s.transport).not.toHaveBeenCalled();
  });
  it('denies cross-actor, cross-workspace, forged and insufficient-scope reads, without disclosing settings', async () => {
    const s = await setup(); const operation = await approve(s); await s.services.saveSettings(s.ctx, operation.settings, operation.approval);
    for (const context of [contextFor(s, 'other-actor'), contextFor(s, s.ctx.actorId, 'other-workspace'), contextFor(s, s.ctx.actorId, s.ctx.workspaceId, ['workspace:read']), { ...s.ctx }]) {
      const result = await s.services.readSettingsReceipt!(context, operation.approval.id);
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(JSON.stringify(result)).not.toContain('aiAnswer');
    }
    expect(await s.services.readSettingsReceipt!(s.ctx, 'not-registered')).toEqual({ ok: true, data: null });
  });
  it('reads only a verified legacy v1.5 receipt and rejects altered target values', async () => {
    const s = await setup(); const operation = await approve(s); await s.services.saveSettings(s.ctx, operation.settings, operation.approval);
    const expected = await s.services.readSettingsReceipt!(s.ctx, operation.approval.id);
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'settings_receipt', operation.approval.id, { settings: operation.settings, revision: 1 }, 1);
    expect(await s.services.readSettingsReceipt!(s.ctx, operation.approval.id)).toEqual(expected);
    expect(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'settings_receipt', operation.approval.id)!.version).toBe(2);
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'settings_receipt', operation.approval.id, { settings: { ...operation.settings, aiAnswer: false }, revision: 1 }, 2);
    expect(await s.services.readSettingsReceipt!(s.ctx, operation.approval.id)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });
  it('recovers exactly the original operation after response loss and a SQLite close/reopen', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/settings-receipt-fixture-'));
    const file = join(directory, 'state.sqlite'); const s = await platformFixture(file);
    try {
      const operation = await approve(s); await s.services.saveSettings(s.ctx, operation.settings, operation.approval);
      s.journal.close(); const reopened = new OperationJournal(file, { fixture: true });
      try {
        const services = createServices({ ...s.options, journal: reopened, approvalAuthority: new ApprovalAuthority(s.sessions, reopened) });
        expect(await services.readSettingsReceipt!(s.ctx, operation.approval.id)).toMatchObject({ ok: true, data: { approvalId: operation.approval.id, contentHash: operation.approval.contentHash, revision: 1, outcome: 'saved' } });
        expect((await services.saveSettings(s.ctx, operation.settings, operation.approval)).ok).toBe(true);
        expect(await services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 1 } });
      } finally { reopened.close(); }
    } finally { try { s.journal.close(); } catch { /* Closed before the restart check. */ } rmSync(directory, { recursive: true, force: true }); }
  });
});
