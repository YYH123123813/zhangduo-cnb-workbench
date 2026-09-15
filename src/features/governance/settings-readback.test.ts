import { describe, expect, it, vi } from 'vitest';
import { hashSettings } from '../../contracts/hash';
import type { SettingsReceipt } from '../../contracts/governance';
import { ctx, fixture, json, ok, snapshot } from './fixtures.test-support';

async function setup() {
  const settings = { aiExtraction: false, aiAnswer: true, aiReview: false, saveQueryHistory: false, reviewReminders: false };
  const receipt: SettingsReceipt = { approvalId: 'original-approval', workspaceId: ctx.workspaceId, actorId: ctx.actorId, contentHash: await hashSettings(ctx.workspaceId, 'fixture-r1', settings), baseRevision: 'fixture-r1', previousRevision: 0, revision: 1, settings, outcome: 'saved' };
  const input = { action: 'verify', approvalId: receipt.approvalId, contentHash: receipt.contentHash, baseRevision: receipt.baseRevision, expectedSettingsRevision: 0 };
  const readSettingsReceipt = vi.fn(async () => ok<SettingsReceipt | null>(receipt));
  const settingsState = vi.fn(async () => ok({ settings, revision: 1 }));
  const f = fixture({ readSettingsReceipt, settingsState });
  const verify = () => f.app.request('/api/governance/settings/verify', json('POST', input));
  return { ...f, settings, receipt, input, readSettingsReceipt, settingsState, verify };
}
describe('1.7.0 original settings operation readback', () => {
  it('checks the original approval, exact content hash and one-step version without a save', async () => {
    const s = await setup(); const response = await s.verify();
    expect(await response.json()).toMatchObject({ ok: true, data: { state: 'verified', receipt: s.receipt, currentMatchesSaved: true } });
    expect(s.readSettingsReceipt).toHaveBeenCalledWith(ctx, 'original-approval'); expect(s.services.saveSettings).not.toHaveBeenCalled();
  });
  it('keeps the saved result distinct from later settings and Git revisions', async () => {
    const s = await setup(); s.settingsState.mockResolvedValue(ok({ settings: { ...s.settings, aiAnswer: false }, revision: 2 }));
    vi.mocked(s.services.snapshot).mockResolvedValue(ok(snapshot({ revision: 'fixture-r2' })));
    expect(await (await s.verify()).json()).toMatchObject({ ok: true, data: { state: 'verified', receipt: { revision: 1 }, current: { settingsRevision: 2, baseRevision: 'fixture-r2' }, currentMatchesSaved: false } });
    expect(s.services.saveSettings).not.toHaveBeenCalled();
  });
  it('does not infer a completed operation from null even when current values happen to match', async () => {
    const s = await setup(); s.readSettingsReceipt.mockResolvedValue(ok(null));
    expect(await (await s.verify()).json()).toMatchObject({ ok: true, data: { state: 'not_recorded', receipt: null } });
    expect(s.settingsState).not.toHaveBeenCalled(); expect(s.services.saveSettings).not.toHaveBeenCalled();
  });
  it('rejects foreign, changed and inconsistent receipts rather than marking a saved operation', async () => {
    for (const patch of [{ actorId: 'another-actor' }, { approvalId: 'another-operation' }, { contentHash: 'changed' }, { settings: { aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } }, { revision: 3 }]) {
      const s = await setup(); s.readSettingsReceipt.mockResolvedValue(ok({ ...s.receipt, ...patch }));
      const response = await s.verify(); expect(response.status).toBeGreaterThanOrEqual(400); expect((await response.json()).ok).toBe(false);
      expect(s.services.saveSettings).not.toHaveBeenCalled();
    }
  });
  it('cancels readback without reading or writing and denies absent read scope', async () => {
    const s = await setup(); await s.app.request('/api/governance/settings/verify', json('POST', { action: 'cancel' }));
    expect(s.services.snapshot).not.toHaveBeenCalled(); expect(s.readSettingsReceipt).not.toHaveBeenCalled();
    vi.mocked(s.services.context).mockResolvedValue(ok({ ...ctx, scopes: ['knowledge:read'] }));
    expect((await s.verify()).status).toBe(403); expect(s.readSettingsReceipt).not.toHaveBeenCalled();
  });
});
