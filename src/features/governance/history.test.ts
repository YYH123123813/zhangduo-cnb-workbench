import { describe, expect, it, vi } from 'vitest';
import type { EvidenceRecord } from '../../contracts/domain';
import { unavailable, type RequestContext } from '../../contracts/api';
import { ctx, fixture, node, now, ok, snapshot, structuredUse } from './fixtures.test-support';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoryList } from './views';

const record: EvidenceRecord = { id: 'record-1', workspaceId: ctx.workspaceId, taskId: 'task-1', kind: 'use', nodeRefs: [{ workspaceId: ctx.workspaceId, objectId: 'node-1', revision: 'fixture-old' }], relationRefs: ['edge-1'], decision: 'adopt', answer: 'Original answer', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'self_reported', recordedAt: now };
describe('G05 historical version warnings', () => {
  it('keeps original task-condition checks visible without promoting them to a current judgment', async () => {
    const use = structuredUse(); use.useContext!.task.conditionChecks = [{ nodeRef: { workspaceId: ctx.workspaceId, objectId: 'checked-node', revision: 'a'.repeat(40) }, conditionId: 'original-check', status: 'not_satisfied', confirmedBy: ctx.actorId }];
    const { app } = fixture({ listEvidence: vi.fn(async () => ok([use])) });
    const data = (await (await app.request('/api/governance/history')).json()).data;
    expect(data.entries[0].record.useContext.task.conditionChecks).toEqual(use.useContext!.task.conditionChecks);
    const html = renderToStaticMarkup(createElement(HistoryList, { data })); expect(html).toContain('original-check'); expect(html).toContain('当时不满足');
  });
  it('rejects a foreign original task-condition reference and restricts a deleted one', async () => {
    const use = structuredUse(); use.useContext!.task.conditionChecks = [{ nodeRef: { workspaceId: 'foreign', objectId: 'checked-node', revision: 'a'.repeat(40) }, conditionId: 'condition-1', status: 'unknown' }];
    const foreign = fixture({ listEvidence: vi.fn(async () => ok([use])) }); expect((await foreign.app.request('/api/governance/history')).status).toBe(403);
    use.useContext!.task.conditionChecks[0]!.nodeRef.workspaceId = ctx.workspaceId;
    const blocked = fixture({ listEvidence: vi.fn(async () => ok([use])), snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['checked-node'] }))) });
    const response = await blocked.app.request('/api/governance/history'); const text = await response.text();
    expect(JSON.parse(text).data.entries[0]).toMatchObject({ record: null, restricted: true }); expect(text).not.toContain('Original task question');
  });
  it('keeps the structured original task, conditions, paths and decision without substituting current content', async () => {
    const use = structuredUse(); const original = structuredClone(use);
    const { app } = fixture({ listEvidence: vi.fn(async () => ok([use])) });
    const data = (await (await app.request('/api/governance/history')).json()).data;
    expect(data.entries[0]).toMatchObject({ record: original, useContextStatus: 'recorded', nodes: [{ historicalConditions: use.useContext!.knowledge[0]!.conditions, historyAvailable: true }] });
    const html = renderToStaticMarkup(createElement(HistoryList, { data }));
    for (const text of ['Original task question', 'Original task boundary', 'Original retrieved path', 'Original decision reason', 'Original missing condition']) expect(html).toContain(text);
    expect(html).toContain('客户端预览记录'); expect(use).toEqual(original);
  });
  it.each(['nested-node', 'nested-relation'])('blocks structured history when %s appears only in the original path context', async (id) => {
    const use = structuredUse(); use.useContext!.paths[0]!.nodeIds.push('nested-node'); use.useContext!.paths[0]!.relationIds.push('nested-relation');
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ excludedIds: [id] }))), listEvidence: vi.fn(async () => ok([use])) });
    const response = await app.request('/api/governance/history'); const text = await response.text();
    expect(JSON.parse(text).data.entries[0]).toMatchObject({ record: null, restricted: true, useContextStatus: 'restricted' });
    expect(text).not.toContain('Original task question');
  });
  it('rejects foreign workspace embedded task context', async () => {
    const use = structuredUse(); use.useContext!.task.workspaceId = 'foreign';
    const { app } = fixture({ listEvidence: vi.fn(async () => ok([use])) });
    expect((await app.request('/api/governance/history')).status).toBe(403);
  });
  it('keeps legacy context missing and an outcome separate from its original use', async () => {
    const use = structuredUse();
    const outcome: EvidenceRecord = { ...record, id: 'outcome-1', kind: 'outcome', outcome: { useRecordId: use.id, status: 'failed', summary: 'Observed failure', failureReason: 'Changed task boundary', verification: 'self_reported' } };
    const { app } = fixture({ listEvidence: vi.fn(async () => ok([record, use, outcome])) });
    const data = (await (await app.request('/api/governance/history')).json()).data;
    expect(data.entries[0].useContextStatus).toBe('not_recorded'); expect(data.entries[1].record).toEqual(use);
    const html = renderToStaticMarkup(createElement(HistoryList, { data })); expect(html).toContain('Observed failure'); expect(html).toContain('Changed task boundary'); expect(html).toContain('use-1');
  });
  it('restricts a dependent outcome when the linked original use is blocked even without repeating its node refs', async () => {
    const use = structuredUse();
    const outcome: EvidenceRecord = { ...record, id: 'outcome-1', kind: 'outcome', nodeRefs: [], relationRefs: [], outcome: { useRecordId: use.id, status: 'failed', summary: 'PRIVATE_OUTCOME', failureReason: 'Original scope', verification: 'self_reported' } };
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['node-1'] }))), listEvidence: vi.fn(async () => ok([use, outcome])) });
    const text = await (await app.request('/api/governance/history')).text();
    expect(text).not.toContain('PRIVATE_OUTCOME'); expect(JSON.parse(text).data.entries[1].restricted).toBe(true);
  });
  it.each(['node-1', 'edge-1', 'record-1'])('restricts historical contents when %s is excluded without rewriting stored evidence', async (excludedId) => {
    const original = structuredClone(record);
    const reader = vi.fn(async (_ctx: RequestContext, revision?: string) => ok(snapshot({ ...(revision ? { revision } : {}), excludedIds: [excludedId], nodes: [node('node-1', { revision: revision ?? 'fixture-r1', conditions: [{ id: 'secret', text: 'BLOCKED_OLD_PREMISE', status: 'unknown', evidenceIds: [] }] })] })));
    const { app } = fixture({ snapshot: reader, listEvidence: vi.fn(async () => ok([record])) });
    const response = await app.request('/api/governance/history');
    const text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain(record.answer); expect(text).not.toContain('BLOCKED_OLD_PREMISE');
    expect(JSON.parse(text).data.entries[0]).toMatchObject({ restricted: true, record: null, summary: { id: record.id } });
    expect(reader.mock.calls.some(([, revision]) => !!revision)).toBe(false);
    expect(record).toEqual(original);
  });
  it('rechecks the current deletion barrier before returning a historical projection', async () => {
    let blocked = false;
    const reader = vi.fn(async (_ctx: RequestContext, revision?: string) => {
      if (revision) blocked = true;
      return ok(snapshot({ ...(revision ? { revision, nodes: [node('node-1', { revision })] } : {}), excludedIds: blocked ? ['node-1'] : [] }));
    });
    const { app } = fixture({ snapshot: reader, listEvidence: vi.fn(async () => ok([record])) });
    const text = await (await app.request('/api/governance/history')).text();
    expect(text).not.toContain(record.answer); expect(JSON.parse(text).data.entries[0].restricted).toBe(true);
  });
  it('keeps the original record and does not invent historical conditions', async () => {
    const original = structuredClone(record);
    const { app } = fixture({ listEvidence: vi.fn(async () => ok([record])) });
    const result = await (await app.request('/api/governance/history?nodeId=node-1')).json();
    expect(result.data.entries[0].record).toEqual(original);
    expect(result.data.entries[0].nodes[0]).toMatchObject({ state: 'changed', historicalConditions: null, historyAvailable: false });
    expect(record).toEqual(original);
  });
  it('flags excluded knowledge and withdrawn relations instead of presenting a current answer', async () => {
    const snap = snapshot({ excludedIds: ['node-1', 'edge-1'] });
    const { app } = fixture({ snapshot: vi.fn(async (_ctx: RequestContext, revision?: string) => revision ? unavailable<never>() : ok(snap)), listEvidence: vi.fn(async () => ok([record])) });
    const result = await (await app.request('/api/governance/history')).json();
    expect(result.data.entries[0].nodes[0].state).toBe('excluded');
    expect(result.data.entries[0].relations[0].state).toBe('excluded');
    expect(result.data.entries[0].usableAsCurrentConclusion).toBe(false);
  });
  it('uses current conditions only for an exact matching version', async () => {
    const exact = { ...record, nodeRefs: [{ ...record.nodeRefs[0]!, revision: 'fixture-r1' }] };
    const { app } = fixture({ listEvidence: vi.fn(async () => ok([exact])) });
    const result = await (await app.request('/api/governance/history')).json();
    expect(result.data.entries[0].nodes[0]).toMatchObject({ state: 'unchanged', historyAvailable: true, historicalConditions: snapshot().nodes[0]!.conditions });
  });
  it('rejects denied or cross-workspace records without returning their body', async () => {
    const { app } = fixture({ listEvidence: vi.fn(async () => ok([{ ...record, workspaceId: 'foreign' }])) });
    const response = await app.request('/api/governance/history');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(record.answer);
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/history')).status).toBe(403);
  });
  it('loads original conditions at the pinned historical revision', async () => {
    const conditions = [{ id: 'old-condition', text: 'Original version condition', status: 'unknown' as const, evidenceIds: [] }];
    const reader = vi.fn(async (_ctx: RequestContext, revision?: string) => ok(revision ? snapshot({ revision, nodes: [node('node-1', { revision, conditions })] }) : snapshot()));
    const { app } = fixture({ snapshot: reader, listEvidence: vi.fn(async () => ok([record])) });
    const data = (await (await app.request('/api/governance/history')).json()).data;
    expect(reader).toHaveBeenCalledWith(ctx, 'fixture-old');
    expect(data.entries[0].nodes[0]).toMatchObject({ historyAvailable: true, historicalConditions: conditions, state: 'changed' });
    expect(data.entries[0].record.answer).toBe(record.answer);
  });
});
