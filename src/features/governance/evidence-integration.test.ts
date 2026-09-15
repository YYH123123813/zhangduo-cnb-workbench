import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import { ApprovalAuthority } from '../../platform/approvals';
import { OperationJournal } from '../../platform/journal';
import { indexPath } from '../../platform/cnb/knowledge';
import type { Approval, EvidenceRecord, KnowledgeSnapshot, Relation, RetrievalResult, TaskContext } from '../../contracts/domain';
import { canonicalJson } from '../../contracts/hash';
import { ChangeFlow, type PreparedChange, type RequestApi } from './change-flow';
import { DataFlow, type DataAction } from './data-flow';
import type { ChangePreview } from './revisions';
import type { readHistoryNotices } from './history';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));
async function setup(withConditionCheck = false) {
  mkdirSync('.local/fixture', { recursive: true });
  const directory = mkdtempSync('.local/fixture/governance-evidence-'), file = join(directory, 'state.sqlite');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const s = await platformFixture(file); let journal = s.journal; cleanup.push(() => journal.close());
  s.node.evidenceStatus = 'supported'; s.node.sources = [{ id: 'source1', kind: 'user_observation', title: 'Controlled source', excerpt: 'Synthetic premise', support: 'supports', supportedClaim: s.node.humanStatement, limitation: 'Synthetic fixture only', accessedAt: '2026-09-05T00:00:00Z' }];
  const edge: Relation = { id: 'dependency', workspaceId: s.ctx.workspaceId, source: { workspaceId: s.ctx.workspaceId, objectId: 'k1', revision: '@snapshot' }, target: { workspaceId: s.ctx.workspaceId, objectId: 'k2', revision: '@snapshot' },
    type: 'depends_on', rationale: 'Original dependency', evidenceIds: ['source1'], state: 'confirmed', proposedBy: s.ctx.actorId, confirmedBy: s.ctx.actorId, confirmedAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };
  s.documents.set(s.base, { ...s.initial, nodes: [s.node, { ...s.node, id: 'k2', title: 'Prerequisite', humanStatement: 'Short stale interval is acceptable' },
    ...(withConditionCheck ? [{ ...s.node, id: 'k3', title: 'Task condition only', conditions: [{ id: 'task-check', text: 'Original task premise', status: 'unknown', evidenceIds: [] }] }] : [])], relations: [edge] });
  const transport = s.transport.getMockImplementation()!;
  s.transport.mockImplementation(async (...args) => new URL(String(args[0])).pathname.endsWith('/knowledge/base/query')
    ? Response.json([{ score: 0.95, chunk: 'STALE_VECTOR_BODY', metadata: { path: indexPath('k1') } }]) : transport(...args));
  let services = s.services, app = createApp(services);
  const request: RequestApi = async (path, init) => (await app.request(path, { ...init, headers: s.headers })).json();
  async function send<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const response = await request(path, body === undefined ? undefined : { method, body: JSON.stringify(body) });
    expect(response.ok, `${path}: ${JSON.stringify(response)}`).toBe(true); if (!response.ok) throw new Error('Expected controlled API success'); return response.data as T;
  }
  const task: TaskContext = { id: 'same-evidence-task', workspaceId: s.ctx.workspaceId, question: 'fixture', constraints: [], mode: 'assisted', updatedAt: '2026-09-05T00:00:00Z' };
  if (withConditionCheck) task.conditionChecks = [{ nodeRef: { workspaceId: s.ctx.workspaceId, objectId: 'k3', revision: s.base }, conditionId: 'task-check', status: 'not_satisfied', confirmedBy: s.ctx.actorId }];
  const query = () => send<RetrievalResult>('/api/retrieval/query', { task, query: 'fixture', confirmedOnly: true });
  const before = await query();
  const snapshot = (await send<{ snapshot: KnowledgeSnapshot }>('/api/governance/status')).snapshot;
  const usedNodes = snapshot.nodes.filter((node) => node.id !== 'k3');
  const path = before.paths.find((path) => path.relationIds.includes(edge.id)); expect(path).toBeDefined();
  const record: EvidenceRecord = { id: 'original-use', workspaceId: s.ctx.workspaceId, taskId: task.id, kind: 'use', nodeRefs: usedNodes.map((node) => ({ workspaceId: s.ctx.workspaceId, objectId: node.id, revision: node.revision })), relationRefs: [edge.id],
    decision: 'verify_later', answer: 'Original application explanation', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'unverified', recordedAt: '2026-09-05T00:00:00Z',
    useContext: { task, snapshotRevision: s.base, knowledge: usedNodes.map(({ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus }) => ({ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus })), relations: snapshot.relations,
      paths: [path!], reason: 'Preserve the original limited decision', retrievalContext: { queryId: before.queryId, coverage: before.coverage, missingConditions: before.missingConditions, warnings: before.warnings, trust: 'client_preview_only' } } };
  const approval = await send<Approval>('/api/workspace/approvals/evidence', { operationId: 'save-original-use', record, baseRevision: s.base, retention: 'until_deleted', confirmed: true });
  expect(await services.appendEvidence(s.ctx, record, approval)).toMatchObject({ ok: true, data: record });
  async function commit(preview: ChangePreview) {
    const flow = new ChangeFlow(request);
    flow.prepare(await send<PreparedChange>('/api/governance/changes/prepare', { action: 'prepare', changes: preview.changes, ...(preview.restoration ? { restoration: preview.restoration } : {}) }), s.ctx.actorId);
    await flow.approve(); await flow.commit(); expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded'); return flow.getSnapshot().result!;
  }
  return { ...s, record, before, request, send, query, commit, get services() { return services; },
    reopen: () => { journal.close(); journal = new OperationJournal(file, { fixture: true }); services = createServices({ ...s.options, journal, approvalAuthority: new ApprovalAuthority(s.sessions, journal) }); app = createApp(services); } };
}

describe('G02/G05/G07/G10/G14 with actual private evidence, governance and retrieval Services', () => {
  it('reads linked outcome and original use by exact IDs after SQLite reopen without new writes', async () => {
    const s = await setup();
    const record: EvidenceRecord = { id: 'original-outcome', workspaceId: s.ctx.workspaceId, taskId: s.record.taskId, kind: 'outcome', nodeRefs: s.record.nodeRefs, relationRefs: s.record.relationRefs,
      answer: 'Observed outcome', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'self_reported', recordedAt: s.record.recordedAt,
      outcome: { useRecordId: s.record.id, status: 'failed', summary: 'Task did not meet the expected result', failureReason: 'Synthetic changed premise', verification: 'self_reported' } };
    const approval = await s.send<Approval>('/api/workspace/approvals/evidence', { operationId: 'save-original-outcome', record, baseRevision: s.base, retention: 'until_deleted', confirmed: true });
    expect(await s.services.appendEvidence(s.ctx, record, approval)).toMatchObject({ ok: true });
    s.reopen();
    const query = new URLSearchParams({ useId: s.record.id, evidenceId: record.id, taskId: record.taskId });
    const history = await s.send<Awaited<ReturnType<typeof readHistoryNotices>>>(`/api/governance/history?${query}`);
    expect(history.entries.map((entry) => entry.record)).toEqual([s.record, record]);
    expect(await s.request(`/api/governance/history?${new URLSearchParams({ useId: s.record.id, evidenceId: record.id, taskId: 'another-task' })}`)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.git.publish).not.toHaveBeenCalled();
    const records = await s.services.listEvidence(s.ctx); expect(records.ok && records.data).toHaveLength(2);
  });
  it('requires explicit task-check dependencies for export and retains their deletion barrier after restart', async () => {
    const s = await setup(true), flow = new DataFlow(s.request);
    const objectIds = ['k1', 'k2', 'dependency', s.record.id];
    expect(await s.request('/api/governance/export', { method: 'POST', body: JSON.stringify({ action: 'preview', objectIds, baseRevision: s.base }) })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await s.send('/api/governance/history?nodeId=k3')).toMatchObject({ entries: [{ record: s.record }] });
    flow.prepare({ kind: 'export', workspaceId: s.ctx.workspaceId, preview: await s.send('/api/governance/export', { action: 'preview', objectIds: [...objectIds, 'k3'], baseRevision: s.base }) } as DataAction, s.ctx.actorId);
    await flow.approve(); await flow.commit(); expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
    const result = flow.getSnapshot().result!; if (result.kind !== 'export') throw new Error('Expected original task export');
    expect(result.value.files.find((file) => file.path === 'evidence/1.json')?.content).toBe(canonicalJson(s.record));
    flow.finish();
    flow.prepare({ kind: 'delete', workspaceId: s.ctx.workspaceId, preview: await s.send('/api/governance/delete/preview', { action: 'preview', objectIds: ['k3'], baseRevision: s.base }) } as DataAction, s.ctx.actorId);
    await flow.approve(); await flow.commit(); expect(flow.getSnapshot().stage).toBe('succeeded');
    s.reopen();
    expect(await s.send('/api/governance/history')).toMatchObject({ entries: [] });
    expect(await s.request(`/api/workspace/evidence/${s.record.id}`)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.request('/api/governance/export', { method: 'POST', body: JSON.stringify({ action: 'preview', objectIds: [...objectIds, 'k3'], baseRevision: s.base }) })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('keeps the original use and path through premise revision, relation withdrawal, restoration and SQLite restart', async () => {
    const s = await setup();
    expect(await s.send('/api/governance/impact', { action: 'preview', objectIds: ['k2'], baseRevision: s.base, budget: 100 })).toMatchObject({ historyCoverage: 'current', directNodeIds: ['k1'], evidenceRefs: [{ id: s.record.id, taskId: s.record.taskId }] });
    const revised = await s.commit(await s.send<ChangePreview>('/api/governance/nodes/k2', { action: 'preview', operationId: 'changed-premise', baseRevision: s.base, nodeRevision: s.base, reason: 'The required freshness changed', patch: { conditions: [{ id: 'freshness', text: 'Immediate update required', status: 'unknown', evidenceIds: [] }] } }, 'PATCH'));
    const after = await s.query(); expect(after.snapshotRevision).toBe(revised.receipt.revision);
    expect(after.paths.some((path) => path.relationIds.includes('dependency'))).toBe(false);
    const withdrawn = await s.commit(await s.send<ChangePreview>('/api/governance/relations/dependency', { action: 'preview', operationId: 'withdraw-dependency', baseRevision: revised.receipt.revision, reason: 'Withdraw the stale relationship', patch: { state: 'withdrawn' } }, 'PATCH'));
    expect((await s.query()).paths.some((path) => path.relationIds.includes('dependency'))).toBe(false);
    const restored = await s.commit(await s.send<ChangePreview>('/api/governance/rollback', { action: 'preview', operationId: 'restore-premise', nodeId: 'k2', baseRevision: withdrawn.receipt.revision, historicalRevision: s.base, reason: 'Review and restore original premise as a new version' }));
    expect(restored.receipt.revision).not.toBe(s.base); expect(restored.receipt.indexing).toBe('pending');
    s.reopen();
    const history = await s.send<Awaited<ReturnType<typeof readHistoryNotices>>>('/api/governance/history?nodeId=k2');
    expect(history.entries[0]).toMatchObject({ record: s.record, useContextStatus: 'recorded', relations: [{ id: 'dependency', historicalVersionAvailable: true, historicalRelation: { state: 'confirmed' } }] });
    expect(await s.send(`/api/workspace/evidence/${s.record.id}`)).toEqual(s.record);
    const exportFlow = new DataFlow(s.request);
    exportFlow.prepare({ kind: 'export', workspaceId: s.ctx.workspaceId, preview: await s.send('/api/governance/export', { action: 'preview', objectIds: ['k1', 'k2', 'dependency', s.record.id], baseRevision: restored.receipt.revision }) } as DataAction, s.ctx.actorId);
    await exportFlow.approve(); await exportFlow.commit(); expect(exportFlow.getSnapshot().stage, JSON.stringify(exportFlow.getSnapshot())).toBe('succeeded');
    const exportResult = exportFlow.getSnapshot().result!; if (exportResult.kind !== 'export') throw new Error('Expected selected history export');
    expect(exportResult.value.files.find((file) => file.path === 'evidence/1.json')?.content).toBe(canonicalJson(s.record));
    expect(JSON.parse(exportResult.value.files.find((file) => file.path === 'knowledge/snapshot.json')!.content).excludedIds).toContain('dependency');
    expect((await s.query()).snapshotRevision).toBe(restored.receipt.revision); expect(JSON.stringify(await s.query())).not.toContain('STALE_VECTOR_BODY');
    const deletion = new DataFlow(s.request);
    deletion.prepare({ kind: 'delete', workspaceId: s.ctx.workspaceId, preview: await s.send('/api/governance/delete/preview', { action: 'preview', objectIds: ['k1'], baseRevision: restored.receipt.revision }) } as DataAction, s.ctx.actorId);
    await deletion.approve(); await deletion.commit(); expect(deletion.getSnapshot().stage).toBe('succeeded');
    s.reopen();
    expect(await s.send('/api/governance/history')).toMatchObject({ entries: [] });
    expect(await s.request(`/api/workspace/evidence/${s.record.id}`)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.send('/api/workspace/evidence-receipts/save-original-use')).toMatchObject({ recordId: s.record.id, outcome: 'saved' });
    const deletedQuery = await s.query(); expect([...deletedQuery.groups.eligible, ...deletedQuery.groups.conditional, ...deletedQuery.groups.conflicts].map((node) => node.id)).not.toContain('k1');
  });
  it('exports the exact original structured use and deletes only its selected private payload with a layered report', async () => {
    const s = await setup(), flow = new DataFlow(s.request);
    expect(await s.send('/api/governance/audit')).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ action: 'evidence_saved', outcome: 'private_not_indexed' })]) });
    flow.prepare({ kind: 'export', workspaceId: s.ctx.workspaceId, preview: await s.send('/api/governance/export', { action: 'preview', objectIds: ['k1', 'k2', 'dependency', s.record.id], baseRevision: s.base }) } as DataAction, s.ctx.actorId);
    await flow.approve(); await flow.commit(); expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
    const exported = flow.getSnapshot().result!; if (exported.kind !== 'export') throw new Error('Expected export');
    expect(exported.value.files.find((file) => file.path === 'evidence/1.json')?.content).toBe(canonicalJson(s.record));
    flow.finish();
    flow.prepare({ kind: 'delete', workspaceId: s.ctx.workspaceId, preview: await s.send('/api/governance/delete/preview', { action: 'preview', objectIds: [s.record.id], baseRevision: s.base }) } as DataAction, s.ctx.actorId);
    await flow.approve(); await flow.commit(); expect(flow.getSnapshot()).toMatchObject({ stage: 'succeeded', result: { kind: 'delete', value: { physicalDeletionComplete: false, layers: expect.arrayContaining([expect.objectContaining({ name: 'private_state', state: 'done' })]) } } });
    s.reopen();
    expect(await s.send('/api/governance/history')).toMatchObject({ entries: [] });
    expect(await s.send('/api/governance/status')).toMatchObject({ snapshot: { nodes: [expect.objectContaining({ id: 'k1' }), expect.objectContaining({ id: 'k2' })] } });
    expect(await s.request('/api/governance/export', { method: 'POST', body: JSON.stringify({ action: 'preview', objectIds: ['k1', 'k2', 'dependency', s.record.id], baseRevision: s.base }) })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.git.publish).not.toHaveBeenCalled();
  });
});
