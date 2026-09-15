import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from './server';
import { buildUseDraft } from './history';
import { buildOutcomeEvidence, buildUseEvidence } from './application-record';
import { context, fixtureServices, snapshot, useInput } from './testing/fixtures';
import { success } from './errors';
import type { EvidenceRecord, TaskConditionCheck } from '../../contracts/domain';

const fixed = { ...snapshot, revision: 'a'.repeat(40), nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'a'.repeat(40) })) };
const selection = { ...useInput, snapshotRevision: fixed.revision, nodeRefs: [{ ...useInput.nodeRefs[0]!, revision: fixed.revision }] };
function setup(records: EvidenceRecord[] = []) {
  const services = fixtureServices({ snapshot: vi.fn(async () => success(structuredClone(fixed))),
    readEvidence: vi.fn(async (_ctx, id) => success(records.find((record) => record.id === id) ?? null)) });
  const app = new Hono(); registerRoutes(app, services);
  const preview = (conditionChecks: TaskConditionCheck[], actor = context.actorId) => app.request('/api/learning/use', { method: 'POST', body: JSON.stringify({ action: 'preview',
    selection: { ...selection, task: { ...selection.task, constraints: [{ id: 'c', text: 'Local only', confirmedBy: actor }], conditionChecks } } }) });
  return { app, services, preview };
}
function original() {
  const draft = buildUseDraft(selection, fixed, 'use-original', useInput.task.updatedAt);
  if (!draft.ok) throw new Error(draft.error.message);
  const record = buildUseEvidence(draft.data, fixed); if (!record.ok) throw new Error(record.error.message);
  return record.data;
}

describe('1.15 original task checks and exact evidence route selection', () => {
  it('distinguishes application storage wiring from the unconnected trusted review path without claiming a save', async () => {
    const f = setup(), response = await f.app.request('/api/learning/status');
    expect(await response.json()).toMatchObject({ ok: true, data: { applicationStorage: 'shared_services', trustedReview: 'not_connected', persistence: 'not_checked' } });
    expect(f.services.appendEvidence).not.toHaveBeenCalled(); expect(f.services.listEvidence).not.toHaveBeenCalled();
  });
  it('rejects impersonated premise attribution before exposing a save preview', async () => {
    const f = setup();
    const check: TaskConditionCheck = { nodeRef: selection.nodeRefs[0]!, conditionId: 'local-copy', status: 'satisfied', confirmedBy: 'another-actor' };
    expect((await f.preview([check])).status).toBe(403);
    expect((await f.preview([], 'another-actor')).status).toBe(403);
    expect(f.services.appendEvidence).not.toHaveBeenCalled();
  });
  it('rejects old node versions and same-text but different condition IDs', async () => {
    const f = setup();
    for (const change of [{ nodeRef: { ...selection.nodeRefs[0]!, revision: 'b'.repeat(40) } }, { conditionId: 'same-text-other-id' }]) {
      expect((await f.preview([{ nodeRef: selection.nodeRefs[0]!, conditionId: 'local-copy', status: 'unknown', ...change }])).status).toBe(409);
    }
  });
  it.each(['satisfied', 'not_satisfied', 'unknown'] as const)('keeps the exact %s check in the approved payload', async (status) => {
    const f = setup(), check: TaskConditionCheck = { nodeRef: selection.nodeRefs[0]!, conditionId: 'local-copy', status,
      ...(status === 'unknown' ? {} : { confirmedBy: context.actorId }) };
    const response = await f.preview([check]); expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data.storage.record.useContext.task.conditionChecks).toEqual([check]);
    expect(result.data.storage.record.answer).toBe('');
  });
  it('reads a selected outcome and its original use through shared readers, not an unrelated current task list', async () => {
    const use = original(), outcome = buildOutcomeEvidence({ useRecordId: use.id, status: 'failed', summary: 'Failure', failureReason: 'An unmet premise' }, use, context, 'outcome-1', '2026-09-05T02:00:00Z');
    if (!outcome.ok) throw new Error(outcome.error.message);
    const f = setup([use, outcome.data]);
    const response = await f.app.request(`/api/learning/records?useId=${use.id}&evidenceId=outcome-1&taskId=${use.taskId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.records.map((view: { record: EvidenceRecord }) => view.record)).toEqual([use, outcome.data]);
    expect(f.services.listEvidence).not.toHaveBeenCalled();
  });
  it('does not return any bodies for a different task, use/outcome pairing or duplicate route parameter', async () => {
    const use = original(), other = { ...use, id: 'other-use' };
    const outcome = buildOutcomeEvidence({ useRecordId: use.id, status: 'failed', summary: 'PRIVATE FAILURE', failureReason: 'PRIVATE REASON' }, use, context, 'outcome-1', '2026-09-05T02:00:00Z');
    if (!outcome.ok) throw new Error(outcome.error.message);
    const f = setup([use, other, outcome.data]);
    for (const query of ['useId=use-original&taskId=wrong-task', 'useId=other-use&evidenceId=outcome-1', 'useId=use-original&useId=other-use']) {
      const response = await f.app.request(`/api/learning/records?${query}`);
      expect(response.status).toBeGreaterThanOrEqual(400); expect(await response.text()).not.toContain('PRIVATE');
    }
  });
});
