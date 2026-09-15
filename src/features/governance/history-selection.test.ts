import { describe, expect, it, vi } from 'vitest';
import type { EvidenceRecord } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { unavailable } from '../../contracts/api';
import { ctx, fixture, ok, snapshot, structuredUse } from './fixtures.test-support';

function savedRecords() {
  const use = structuredUse();
  const outcome: EvidenceRecord = { id: 'outcome-1', workspaceId: ctx.workspaceId, taskId: use.taskId, kind: 'outcome', nodeRefs: use.nodeRefs, relationRefs: use.relationRefs,
    answer: 'Recorded failure', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'self_reported', recordedAt: use.recordedAt,
    outcome: { useRecordId: use.id, status: 'failed', summary: 'Observed failure', failureReason: 'Original premise no longer held', verification: 'self_reported' } };
  const readEvidence = vi.fn<NonNullable<Services['readEvidence']>>(async (_ctx, id) => ok([use, outcome].find((record) => record.id === id) ?? null));
  return { use, outcome, readEvidence };
}

describe('G01/G05 original use and outcome ID navigation', () => {
  it('reads only the selected evidence and linked original use through shared Services', async () => {
    const s = savedRecords(), { app, services } = fixture({ readEvidence: s.readEvidence });
    const response = await app.request('/api/governance/history?useId=use-1&evidenceId=outcome-1&taskId=task-1');
    expect(response.status).toBe(200);
    expect((await response.json()).data.entries.map((entry: { record: EvidenceRecord }) => entry.record)).toEqual([s.use, s.outcome]);
    expect(s.readEvidence).toHaveBeenCalledWith(ctx, 'use-1'); expect(s.readEvidence).toHaveBeenCalledWith(ctx, 'outcome-1');
    expect(services.listEvidence).not.toHaveBeenCalled(); expect(services.appendEvidence).not.toHaveBeenCalled(); expect(services.commit).not.toHaveBeenCalled();
  });
  it('resolves an outcome-only link to its original use without listing unrelated history', async () => {
    const s = savedRecords(), { app, services } = fixture({ readEvidence: s.readEvidence });
    const data = (await (await app.request('/api/governance/history?evidenceId=outcome-1')).json()).data;
    expect(data.entries.map((entry: { summary: { id: string } }) => entry.summary.id)).toEqual(['use-1', 'outcome-1']);
    expect(services.listEvidence).not.toHaveBeenCalled();
  });
  it.each(['wrong_task', 'wrong_use', 'wrong_id', 'foreign_workspace', 'wrong_context_task'] as const)('rejects %s without exposing either original body', async (scenario) => {
    const s = savedRecords();
    if (scenario === 'wrong_task') s.outcome.taskId = 'foreign-task';
    if (scenario === 'wrong_use') s.outcome.outcome!.useRecordId = 'other-use';
    if (scenario === 'foreign_workspace') s.outcome.workspaceId = 'foreign';
    if (scenario === 'wrong_context_task') s.use.useContext!.task.id = 'another-task';
    if (scenario === 'wrong_id') s.readEvidence.mockImplementation(async () => ok({ ...s.use, id: 'another-use' }));
    const { app } = fixture({ readEvidence: s.readEvidence });
    const response = await app.request('/api/governance/history?useId=use-1&evidenceId=outcome-1&taskId=task-1');
    expect(response.status).toBe(403); const text = await response.text();
    expect(text).not.toContain(s.use.answer); expect(text).not.toContain(s.outcome.answer);
  });
  it('does not accept an outcome in the original use ID position', async () => {
    const s = savedRecords(), { app } = fixture({ readEvidence: s.readEvidence });
    expect((await app.request('/api/governance/history?useId=outcome-1')).status).toBe(422);
  });
  it('keeps missing or unavailable exact readback distinct from an empty successful history', async () => {
    const missing = fixture({ readEvidence: vi.fn(async () => ok(null)) });
    expect((await missing.app.request('/api/governance/history?useId=missing')).status).toBe(409);
    const unavailableReader = fixture({ readEvidence: vi.fn(async () => unavailable<never>()) });
    expect((await unavailableReader.app.request('/api/governance/history?useId=use-1')).status).toBe(503);
    const absent = fixture(); expect((await absent.app.request('/api/governance/history?useId=use-1')).status).toBe(501);
    for (const s of [missing, unavailableReader, absent]) expect(s.services.listEvidence).not.toHaveBeenCalled();
  });
  it('rechecks deletion after the exact records are read and withholds both use and outcome', async () => {
    const s = savedRecords(); let reads = 0;
    const { app } = fixture({ readEvidence: s.readEvidence, snapshot: vi.fn(async (_ctx, revision) => revision ? unavailable<never>() : ok(snapshot({ excludedIds: ++reads > 1 ? ['node-1'] : [] }))) });
    const response = await app.request('/api/governance/history?useId=use-1&evidenceId=outcome-1');
    const text = await response.text(); expect(response.status, text).toBe(200); expect(JSON.parse(text).data.entries).toHaveLength(2);
    expect(JSON.parse(text).data.entries.every((entry: { restricted: boolean; record: unknown }) => entry.restricted && entry.record === null)).toBe(true);
    expect(text).not.toContain(s.use.answer); expect(text).not.toContain(s.outcome.answer);
  });
  it('filters task-only history using the shared task argument and rejects a mismatched response', async () => {
    const s = savedRecords(), selected = fixture({ listEvidence: vi.fn(async () => ok([s.use])) });
    expect((await selected.app.request('/api/governance/history?taskId=task-1')).status).toBe(200);
    expect(selected.services.listEvidence).toHaveBeenCalledWith(ctx, 'task-1');
    const wrong = fixture({ listEvidence: vi.fn(async () => ok([s.use])) });
    expect((await wrong.app.request('/api/governance/history?taskId=another-task')).status).toBe(403);
  });
  it.each(['useId=use-1&useId=use-2', 'body=private-text', 'taskId='])('rejects ambiguous or invalid query %s before any record read', async (query) => {
    const s = savedRecords(), { app, services } = fixture({ readEvidence: s.readEvidence });
    expect((await app.request(`/api/governance/history?${query}`)).status).toBe(422);
    expect(s.readEvidence).not.toHaveBeenCalled(); expect(services.listEvidence).not.toHaveBeenCalled();
  });
  it('checks evidence permission before reading a selected record', async () => {
    const s = savedRecords(), { app } = fixture({ readEvidence: s.readEvidence, context: vi.fn(async () => ok({ ...ctx, scopes: ['knowledge:read'] })) });
    expect((await app.request('/api/governance/history?useId=use-1')).status).toBe(403); expect(s.readEvidence).not.toHaveBeenCalled();
  });
});
