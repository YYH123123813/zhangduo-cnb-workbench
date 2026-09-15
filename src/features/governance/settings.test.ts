import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { hashSettings } from '../../contracts/hash';
import { ctx, fixture, json, ok, snapshot } from './fixtures.test-support';

const settings: Settings = { aiExtraction: true, aiAnswer: true, aiReview: true, saveQueryHistory: false, reviewReminders: false };
async function request() { return { action: 'preview', baseRevision: 'fixture-r1', expectedSettingsHash: await hashSettings(ctx.workspaceId, 'fixture-r1', settings), patch: { aiAnswer: false } }; }
describe('G11 AI and privacy settings', () => {
  it('reads independent toggles and previews a single change without saving', async () => {
    const { app, services } = fixture({ settings: vi.fn(async () => ok(settings)) });
    const data = (await (await app.request('/api/governance/settings')).json()).data;
    expect(data.settings).toEqual(settings);
    const result = (await (await app.request('/api/governance/settings', json('PATCH', await request()))).json()).data;
    expect(result.settings).toEqual({ ...settings, aiAnswer: false });
    expect(result.changedKeys).toEqual(['aiAnswer']);
    expect(services.saveSettings).not.toHaveBeenCalled();
  });
  it('saves approved settings through Services and verifies readback without changing knowledge', async () => {
    let current = { ...settings };
    const next = { ...settings, aiAnswer: false };
    const saveSettings = vi.fn<Services['saveSettings']>(async (_ctx, value) => { current = value; return ok(value); });
    const { app, services } = fixture({ settings: vi.fn(async () => ok(current)), saveSettings });
    const base = await request();
    const input = { action: 'execute', baseRevision: base.baseRevision, expectedSettingsHash: base.expectedSettingsHash, settings: next,
      approval: { id: 'settings-consent', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'settings', objectIds: [ctx.workspaceId], contentHash: await hashSettings(ctx.workspaceId, base.baseRevision, next), baseRevision: base.baseRevision, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } };
    const data = (await (await app.request('/api/governance/settings', json('PATCH', input))).json()).data;
    expect(data).toMatchObject({ settings: next, verified: true });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(services.commit).not.toHaveBeenCalled();
    expect(services.complete).not.toHaveBeenCalled();
    expect((await services.snapshot(ctx))).toEqual(ok(snapshot()));
  });
  it('rejects obsolete settings, invalid fields, stale snapshots and cancellation without saving', async () => {
    const { app, services } = fixture({ settings: vi.fn(async () => ok(settings)) });
    for (const input of [{ ...await request(), expectedSettingsHash: 'old' }, { ...await request(), baseRevision: 'old' }]) expect((await app.request('/api/governance/settings', json('PATCH', input))).status).toBe(409);
    expect((await app.request('/api/governance/settings', json('PATCH', { ...await request(), patch: { aiAnswer: 'false' } }))).status).toBe(422);
    expect((await app.request('/api/governance/settings', json('PATCH', { action: 'cancel' }))).status).toBe(200);
    expect(services.saveSettings).not.toHaveBeenCalled();
  });
  it('denies missing settings permissions before reading', async () => {
    const { app, services } = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await app.request('/api/governance/settings')).status).toBe(403);
    expect(services.settings).not.toHaveBeenCalled();
  });
});
