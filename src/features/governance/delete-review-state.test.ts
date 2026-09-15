import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DeleteReport } from '../../contracts/domain';
import { hashDeletePlan } from '../../contracts/hash';
import { ctx, fixture, json, ok, snapshot } from './fixtures.test-support';
import { deleteApproval, deletePlan } from './delete.fixtures.test-support';
import { checkedDeleteReport, displayLayers, previewDeletion, readDeletion } from './deletion';
import type { DataState } from './data-flow';
import { DataControls, LayerTable } from './views';

const reviewLayer = {
  name: 'review_private_state', supported: true, capability: 'supported' as const, reversible: false,
  consequence: 'Clears private reviewed questions, attempts and exposure records referencing the selected knowledge. Minimal original receipts remain. SQLite pages, WAL, import source files and backup copies are not proven erased.',
};
const layerLabel = '审核题、作答与答案暴露记录';
function expectConsequences(text: string) {
  for (const part of ['关联审核题', '作答正文', '答案暴露记录', '最小原操作回执', '导入源文件', 'SQLite', 'WAL', '备份', '物理清除未核验']) expect(text).toContain(part);
}
async function setup(report: DeleteReport | null = null) {
  const original = await deletePlan();
  const plan = await deletePlan({ layers: [...original.layers, reviewLayer] });
  const s = fixture({ previewDelete: vi.fn(async () => ok(plan)), readDeletePlan: vi.fn(async () => ok(plan)), readDeleteReport: vi.fn(async () => ok(report)) });
  return { ...s, plan };
}

describe('review_private_state consumer projection (not browser acceptance)', () => {
  it('localizes the new layer without changing the full registered plan or its hash', async () => {
    const s = await setup();
    const before = structuredClone(s.plan);
    const view = await previewDeletion(s.services, ctx, snapshot(), { objectIds: s.plan.objectIds, baseRevision: s.plan.baseRevision });
    const layer = view.layers.find((item) => item.name === reviewLayer.name)!;
    expect(layer.label).toBe(layerLabel);
    expectConsequences(layer.consequence);
    expect(layer).toMatchObject({ capability: 'supported', reversible: false });
    expect(view.plan).toEqual(before);
    expect(await hashDeletePlan(view.plan)).toBe(before.contentHash);
    expect(s.services.executeDelete).not.toHaveBeenCalled();
  });

  it.each(['ready', 'approved', 'unknown'] as const)('keeps the full layer scope next to confirmation in %s state', async (stage) => {
    const s = await setup();
    const preview = await previewDeletion(s.services, ctx, snapshot(), { objectIds: s.plan.objectIds, baseRevision: s.plan.baseRevision });
    const state: DataState = { stage, prepared: { kind: 'delete', operationId: 'original-registration', workspaceId: ctx.workspaceId, preview }, approval: stage === 'ready' ? null : deleteApproval(s.plan), result: null, error: null };
    const html = renderToStaticMarkup(createElement(DataControls, { state, onApprove: vi.fn(), onCommit: vi.fn(), onVerify: vi.fn(), onRevoke: vi.fn(), onCancel: vi.fn(), onContinue: vi.fn() }));
    expect(html).toContain(layerLabel);
    expectConsequences(html);
    for (const layer of displayLayers(s.plan)) expect(html).toContain(layer.label);
    expect(html).toContain(s.plan.id); expect(html).toContain(s.plan.contentHash); expect(html).toContain('node-1');
    if (stage === 'unknown') {
      expect(html).toContain('执行结果未知'); expect(html).toContain('核验原操作');
      expect(html).not.toContain('执行已批准'); expect(html).not.toContain('继续处理下一项');
    }
  });

  it('keeps the original plan layers unknown when the original report is absent', async () => {
    const s = await setup();
    const result = await readDeletion(s.services, ctx, snapshot({ excludedIds: ['node-1'] }), { objectIds: ['node-1'], planId: s.plan.id });
    expect(result).toMatchObject({ planId: s.plan.id, reportAvailable: false, report: null, physicalDeletionComplete: false });
    expect(result.layers.map((layer) => layer.name)).toEqual(displayLayers(s.plan).map((layer) => layer.name));
    const layer = result.layers.find((item) => item.name === reviewLayer.name)!;
    expect(layer).toMatchObject({ label: layerLabel, state: 'unknown' });
    expectConsequences(renderToStaticMarkup(createElement(LayerTable, { layers: result.layers })));
    expect(s.services.executeDelete).not.toHaveBeenCalled();
  });

  it.each(['done', 'failed', 'unknown', 'unsupported', 'pending'] as const)('preserves %s row evidence separately from the Chinese cleanup scope', async (state) => {
    const report: DeleteReport = { planId: 'delete-plan-1', retrievalBlocked: true, layers: [{ name: reviewLayer.name, state, detail: 'Original platform readback detail' }] };
    const s = await setup(report);
    const result = await readDeletion(s.services, ctx, snapshot({ excludedIds: ['node-1'] }), { objectIds: ['node-1'], planId: s.plan.id });
    expect(result.layers.find((layer) => layer.name === reviewLayer.name)).toMatchObject({ label: layerLabel, state });
    expect(result.physicalDeletionComplete).toBe(false);
    const html = renderToStaticMarkup(createElement(LayerTable, { layers: result.layers }));
    expectConsequences(html); expect(html).toContain('Original platform readback detail');
    expect(s.services.executeDelete).not.toHaveBeenCalled();
  });

  it('does not infer review cleanup from an application-only report', async () => {
    const s = await setup();
    const report = checkedDeleteReport(s.plan, { planId: s.plan.id, retrievalBlocked: true, layers: [{ name: 'application', state: 'done', detail: 'Barrier only' }] });
    expect(report.layers.find((layer) => layer.name === reviewLayer.name)).toMatchObject({ state: 'pending' });
    expect(report.layers.every((layer) => layer.state === 'done')).toBe(false);
  });

  it('returns a readback error without executing or substituting a new plan', async () => {
    const s = await setup();
    vi.mocked(s.services.readDeleteReport!).mockResolvedValue({ ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Readback unavailable', dataState: 'unknown', retryable: false, nextAction: 'read_delete_report' } });
    const response = await s.app.request('/api/governance/delete/verify', json('POST', { action: 'verify', objectIds: ['node-1'], planId: s.plan.id }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    expect(s.services.readDeletePlan).toHaveBeenCalledWith(ctx, s.plan.id);
    expect(s.services.executeDelete).not.toHaveBeenCalled(); expect(s.services.previewDelete).not.toHaveBeenCalled();
  });
});
