import { afterEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { hashSettings, hashChangeSet } from '../contracts/hash';
import { createServices } from './services';
import type { OperationJournal } from './journal';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup() { const s = await platformFixture(); journals.push(s.journal); return s; }

describe('W11 governance settings and approval constraints', () => {
  it('defaults to all privacy switches off and exposes an independent settings revision', async () => {
    const s = await setup();
    expect(await s.services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 0, settings: { aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } } });
  });
  it('uses atomic version comparison even when the Git base stays unchanged', async () => {
    const s = await setup(); const state = await s.services.settingsState!(s.ctx);
    if (!state.ok) throw new Error('Expected settings');
    const oldHash = await hashSettings(s.ctx.workspaceId, s.base, state.data.settings);
    const target = { ...state.data.settings, aiAnswer: true };
    const input = { purpose: 'settings' as const, settings: target, baseRevision: s.base, expectedSettingsHash: oldHash, expectedSettingsRevision: 0, confirmed: true as const };
    const first = await s.services.approveGovernance!(s.ctx, input), second = await s.services.approveGovernance!(s.ctx, { ...input, settings: { ...target, aiReview: true } });
    if (!first.ok || !second.ok) throw new Error('Expected approvals');
    expect((await s.services.saveSettings(s.ctx, target, first.data)).ok).toBe(true);
    expect(await s.services.saveSettings(s.ctx, { ...target, aiReview: true }, second.data)).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    expect(await s.services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 1, settings: { aiAnswer: true, aiReview: false } } });
    expect((await s.services.saveSettings(s.ctx, target, first.data)).ok).toBe(true);
    expect(await s.services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 1 } });
  });
  it('rejects revoked, foreign and unconfirmed governance requests without changing settings', async () => {
    const s = await setup(); const current = await s.services.settings(s.ctx); if (!current.ok) throw new Error('Expected settings');
    const input = { purpose: 'settings' as const, settings: { ...current.data, aiAnswer: true }, baseRevision: s.base, expectedSettingsHash: await hashSettings(s.ctx.workspaceId, s.base, current.data), expectedSettingsRevision: 0, confirmed: true as const };
    const approved = await s.services.approveGovernance!(s.ctx, input); if (!approved.ok) throw new Error('Expected approval');
    s.authority.revoke(s.ctx, approved.data.id);
    expect((await s.services.saveSettings(s.ctx, input.settings, approved.data)).ok).toBe(false);
    expect((await s.services.approveGovernance!({ ...s.ctx }, input)).ok).toBe(false);
    expect((await s.services.approveGovernance!(s.ctx, { ...input, confirmed: false } as never)).ok).toBe(false);
    expect(await s.services.settings(s.ctx)).toEqual(current);
  });
});

describe('W11 durable deletion barrier and selected export', () => {
  it('never adds derived index files to the independently approved formal export', async () => {
    const s = await setup();
    const approval = await s.services.approveGovernance!(s.ctx, { purpose: 'export', objectIds: ['k1'], baseRevision: s.base, confirmed: true });
    if (!approval.ok) throw Error('Expected export approval');
    const exported = await s.services.exportData(s.ctx, ['k1'], approval.data);
    expect(exported.ok).toBe(true); if (!exported.ok) return;
    expect(exported.data.files.map((file) => file.path)).toHaveLength(3);
    expect(exported.data.files.some((file) => file.path.startsWith('knowledge-index/'))).toBe(false);
  });
  it('persists a stable preview without executing and returns null for an unexecuted report', async () => {
    const s = await setup();
    const plan = await s.services.previewDelete(s.ctx, ['k1']);
    if (!plan.ok) throw new Error('Expected deletion preview');
    expect(await s.services.previewDelete(s.ctx, ['k1'])).toEqual(plan);
    expect(await s.services.readDeletePlan!(s.ctx, plan.data.id)).toEqual(plan);
    expect(await s.services.readDeleteReport!(s.ctx, plan.data.id)).toEqual({ ok: true, data: null });
    expect(await s.services.snapshot(s.ctx)).toMatchObject({ ok: true, data: { nodes: [expect.objectContaining({ id: 'k1' })], excludedIds: [] } });
  });
  it('blocks current and historical retrieval, preserves unknown layer states and reads back without reexecuting', async () => {
    const s = await setup(); const plan = await s.services.previewDelete(s.ctx, ['k1']);
    if (!plan.ok) throw new Error('Expected plan');
    const approval = await s.services.approveGovernance!(s.ctx, { purpose: 'delete', planId: plan.data.id, confirmed: true });
    if (!approval.ok) throw new Error('Expected delete approval');
    const report = await s.services.executeDelete(s.ctx, plan.data, approval.data);
    expect(report).toMatchObject({ ok: true, data: { retrievalBlocked: true, layers: expect.arrayContaining([{ name: 'application', state: 'done', detail: expect.any(String) }, { name: 'git_history', state: 'unknown', detail: expect.any(String) }]) } });
    expect(await createServices(s.options).readDeleteReport!(s.ctx, plan.data.id)).toEqual(report);
    expect(await s.services.executeDelete(s.ctx, plan.data, approval.data)).toEqual(report);
    for (const revision of [undefined, s.base]) expect(await s.services.snapshot(s.ctx, revision)).toMatchObject({ ok: true, data: { nodes: [], excludedIds: ['k1'] } });
    expect(await createServices({ ...s.options, approvalAuthority: undefined }).snapshot(s.ctx)).toMatchObject({ ok: true, data: { nodes: [], excludedIds: ['k1'] } });
    expect(s.initial.nodes).toHaveLength(1);
    expect(s.git.publish).not.toHaveBeenCalled();
    const changes = { id: 'try-restore', workspaceId: s.ctx.workspaceId, baseRevision: s.base, nodes: [{ ...s.node, revision: s.base }], relations: [], withdrawnIds: [], reason: 'Restore', contentHash: 'pending' };
    changes.contentHash = await hashChangeSet(changes);
    const restore = await s.services.approveKnowledge!(s.ctx, { changes, confirmed: true });
    if (!restore.ok) throw new Error('Expected content approval');
    expect(await s.services.commit(s.ctx, changes, restore.data)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('rejects altered or revoked plans without creating a barrier', async () => {
    const s = await setup(); const plan = await s.services.previewDelete(s.ctx, ['k1']); if (!plan.ok) throw new Error('Expected plan');
    const approval = await s.services.approveGovernance!(s.ctx, { purpose: 'delete', planId: plan.data.id, confirmed: true }); if (!approval.ok) throw new Error('Expected approval');
    const changed = { ...plan.data, layers: [] };
    expect((await s.services.executeDelete(s.ctx, changed, approval.data)).ok).toBe(false);
    s.authority.revoke(s.ctx, approval.data.id);
    expect((await s.services.executeDelete(s.ctx, plan.data, approval.data)).ok).toBe(false);
    expect(s.journal.blocked(s.ctx.workspaceId)).toEqual([]);
  });
  it('exports only approved formal objects and refuses deleted or unselected private data', async () => {
    const s = await setup();
    const approval = await s.services.approveGovernance!(s.ctx, { purpose: 'export', objectIds: ['k1'], baseRevision: s.base, confirmed: true });
    if (!approval.ok) throw new Error('Expected export approval');
    const result = await s.services.exportData(s.ctx, ['k1'], approval.data);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.files.some((file) => file.path.startsWith('knowledge/') && file.content.includes('Original fixture conclusion'))).toBe(true);
    expect(result.data.files.every((file) => !file.path.startsWith('issues/') && !file.path.includes('..'))).toBe(true);
    expect((await s.services.exportData(s.ctx, ['c1'], approval.data)).ok).toBe(false);
    s.journal.block(s.ctx.workspaceId, ['k1'], 'fixture-deletion');
    expect((await s.services.exportData(s.ctx, ['k1'], approval.data)).ok).toBe(false);
  });
});
