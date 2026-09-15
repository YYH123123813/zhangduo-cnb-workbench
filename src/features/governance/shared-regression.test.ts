import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import type { OperationJournal } from '../../platform/journal';
import type { ModelTransport } from '../../platform/model';
import { indexPath } from '../../platform/cnb/knowledge';
import type { Approval, Relation, RetrievalRequest, RetrievalResult, Settings } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { ChangeFlow, type PreparedChange, type RequestApi } from './change-flow';
import { DataFlow, type DataAction, type SettingsData } from './data-flow';
import type { ChangePreview } from './revisions';

const journals = new Set<OperationJournal>();
const directories: string[] = [];
afterEach(() => { journals.forEach((journal) => journal.close()); journals.clear(); directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
async function setup(file?: string) {
  const s = await platformFixture(file); journals.add(s.journal);
  s.node.evidenceStatus = 'supported';
  s.node.sources.push({ id: 'source1', kind: 'user_observation', title: 'Synthetic observation', excerpt: 'Fixture premise', accessedAt: '2026-09-01T00:00:00Z', support: 'supports', supportedClaim: s.node.humanStatement, limitation: 'Synthetic only' });
  const connect = (services: Services) => {
    const app = createApp(services);
    const request: RequestApi = async (path, init) => (await app.request(path, { ...init, headers: s.headers })).json();
    async function send<T>(path: string, input?: unknown, method = 'POST'): Promise<T> {
      const response = await request(path, input === undefined ? undefined : { method, body: JSON.stringify(input) });
      expect(response.ok, `${path}: ${JSON.stringify(response)}`).toBe(true);
      if (!response.ok) throw new Error('Fixture API failed');
      return response.data as T;
    }
    return { request, send };
  };
  return { ...s, connect, ...connect(s.services) };
}

describe('governance integration with shared Services, controlled HTTP/Git/model transports', () => {
  it('retargets then withdraws the same relation through shared Services and changes public query paths without rewriting history', async () => {
    const s = await setup();
    const edge: Relation = { id: 'dependency-edge', workspaceId: s.ctx.workspaceId, source: { workspaceId: s.ctx.workspaceId, objectId: 'k1', revision: '@snapshot' }, target: { workspaceId: s.ctx.workspaceId, objectId: 'k2', revision: '@snapshot' },
      type: 'depends_on', rationale: 'Original synthetic prerequisite', evidenceIds: ['source1'], state: 'confirmed', proposedBy: s.ctx.actorId, confirmedBy: s.ctx.actorId, confirmedAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };
    s.documents.set(s.base, { ...s.initial, nodes: [s.node, { ...s.node, id: 'k2', title: 'Prerequisite B', question: 'B?', humanStatement: 'Condition B', sources: [] }, { ...s.node, id: 'k3', title: 'Prerequisite C', question: 'C?', humanStatement: 'Condition C', sources: [] }], relations: [edge] });
    const transport = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (...args) => new URL(String(args[0])).pathname.endsWith('/knowledge/base/query')
      ? Response.json([{ score: 0.9, chunk: 'STALE_VECTOR_BODY', metadata: { path: indexPath('k1') } }]) : transport(...args));
    const task = { id: 'retarget-same-task', workspaceId: s.ctx.workspaceId, question: 'fixture', constraints: [], mode: 'assisted', updatedAt: '2026-09-05T00:00:00Z' };
    const query = () => s.send<RetrievalResult>('/api/retrieval/query', { task, query: 'fixture', confirmedOnly: true });
    const before = await query();
    expect(before.paths.some((path) => path.relationIds.includes(edge.id) && path.nodeIds.includes('k2'))).toBe(true);
    expect(await s.send('/api/governance/impact', { action: 'preview', objectIds: ['k2'], baseRevision: s.base, budget: 100 })).toMatchObject({ directNodeIds: ['k1'], historyCoverage: 'current', evidenceRefs: [] });
    const flow = new ChangeFlow(s.request);
    const commit = async (preview: ChangePreview) => {
      flow.prepare(await s.send<PreparedChange>('/api/governance/changes/prepare', { action: 'prepare', changes: preview.changes }), s.ctx.actorId);
      await flow.approve(); await flow.commit(); expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
      const result = flow.getSnapshot().result!; flow.finish(); return result;
    };
    const changed = await commit(await s.send<ChangePreview>('/api/governance/relations/dependency-edge', { action: 'preview', operationId: 'retarget-edge', baseRevision: s.base, reason: 'Use the reviewed alternative prerequisite', patch: { targetId: 'k3', rationale: 'New synthetic prerequisite C', evidenceIds: ['source1'] } }, 'PATCH'));
    const after = await query();
    expect(after.paths.some((path) => path.relationIds.includes(edge.id) && path.nodeIds.includes('k3'))).toBe(true);
    expect(after.paths.some((path) => path.relationIds.includes(edge.id) && path.nodeIds.includes('k2'))).toBe(false);
    await commit(await s.send<ChangePreview>('/api/governance/relations/dependency-edge', { action: 'preview', operationId: 'withdraw-retargeted-edge', baseRevision: changed.receipt.revision, reason: 'Withdraw the incorrect relationship', patch: { state: 'withdrawn' } }, 'PATCH'));
    const withdrawn = await query(); expect(withdrawn.paths.some((path) => path.relationIds.includes(edge.id))).toBe(false);
    expect(JSON.stringify(withdrawn)).not.toContain('STALE_VECTOR_BODY');
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { relations: [expect.objectContaining({ id: edge.id, state: 'confirmed', target: expect.objectContaining({ objectId: 'k2' }) })] } });
    expect(s.git.publish).toHaveBeenCalledTimes(2);
  });
  it('recovers a lost knowledge registration through the shared GET after SQLite restart, then explicitly commits once', async () => {
    mkdirSync('.local', { recursive: true });
    const directory = mkdtempSync(resolve('.local/governance-closeout-fixture-')); directories.push(directory);
    const database = join(directory, 'approval.sqlite'); const s = await setup(database);
    const preview = await s.send<ChangePreview>('/api/governance/nodes/k1', { action: 'preview', operationId: 'original-registration', baseRevision: s.base, nodeRevision: s.base, reason: 'Explicit synthetic revision', patch: { humanStatement: 'New synthetic conclusion' } }, 'PATCH');
    const prepared = await s.send<PreparedChange>('/api/governance/changes/prepare', { action: 'prepare', changes: preview.changes });
    let approvalId = '';
    let request: RequestApi = async (path, init) => {
      const response = await s.request(path, init);
      if (path === '/api/workspace/approvals/knowledge') {
        expect(response.ok).toBe(true); if (response.ok) approvalId = (response.data as Approval).id;
        throw new Error('Lost after durable registration');
      }
      return response;
    };
    const flow = new ChangeFlow((path, init) => request(path, init)); flow.prepare(prepared, s.ctx.actorId); await flow.approve();
    expect(flow.getSnapshot().stage).toBe('approval_unknown');
    s.journal.close(); journals.delete(s.journal);
    const restarted = await setup(database); const afterRestart = vi.fn<RequestApi>(restarted.request); request = afterRestart;
    await flow.recoverApproval();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'approved', approval: { id: approvalId }, prepared });
    expect(afterRestart.mock.calls).toEqual([[`/api/workspace/approvals/knowledge/${prepared.changes.id}`, undefined]]);
    expect(restarted.git.publish).not.toHaveBeenCalled();
    await flow.commit();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'succeeded', result: { receipt: { changeSetId: prepared.changes.id } } });
    expect(restarted.git.publish).toHaveBeenCalledOnce();
    expect(afterRestart.mock.calls.some(([path, init]) => path.endsWith('/approvals/knowledge') && init?.method === 'POST')).toBe(false);
    expect(await afterRestart(`/api/governance/operations/knowledge/${prepared.changes.id}`)).toMatchObject({ ok: true, data: { id: prepared.changes.id, readOnly: true, contentVerified: false, registration: { approval: { id: approvalId } }, commit: { changeSetId: prepared.changes.id } } });
    expect(restarted.git.publish).toHaveBeenCalledOnce();
  });
  it('retains a lost actual governance registration without creating another approval or changing settings', async () => {
    const s = await setup();
    const current = await s.send<SettingsData>('/api/governance/settings');
    const preview = await s.send('/api/governance/settings', { action: 'preview', baseRevision: s.base, expectedSettingsHash: current.currentHash, expectedSettingsRevision: current.settingsRevision, patch: { aiAnswer: true } }, 'PATCH');
    const request = vi.fn<RequestApi>(async (path, init) => {
      const response = await s.request(path, init);
      if (path === '/api/workspace/approvals/governance') { expect(response.ok).toBe(true); throw new Error('Lost registered approval'); }
      return response;
    });
    const flow = new DataFlow(request); const prepared = { kind: 'settings', workspaceId: s.ctx.workspaceId, preview } as DataAction;
    flow.prepare(prepared, s.ctx.actorId); await flow.approve();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'approval_unknown', prepared, approval: null });
    expect(flow.invalidate()).toBe(false); expect(flow.finish()).toBe(false);
    await flow.approve(); await flow.commit(); await flow.verify(); await flow.revoke();
    expect(request).toHaveBeenCalledOnce();
    expect(await s.services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: current.settingsRevision, settings: current.settings } });
    expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('recovers the original unknown settings approval after closing and reopening the real SQLite adapter', async () => {
    mkdirSync('.local', { recursive: true });
    const directory = mkdtempSync(resolve('.local/governance-r2-fixture-')); directories.push(directory);
    const database = join(directory, 'settings.sqlite'); const s = await setup(database);
    const current = await s.send<SettingsData>('/api/governance/settings');
    const preview = await s.send('/api/governance/settings', { action: 'preview', baseRevision: s.base, expectedSettingsHash: current.currentHash, expectedSettingsRevision: current.settingsRevision, patch: { aiAnswer: true } }, 'PATCH');
    let request: RequestApi = async (path, init) => {
      const response = await s.request(path, init);
      if (path.endsWith('/settings') && init?.method === 'PATCH') throw new Error('Lost saved response');
      return response;
    };
    const flow = new DataFlow((path, init) => request(path, init));
    flow.prepare({ kind: 'settings', workspaceId: s.ctx.workspaceId, preview } as DataAction, s.ctx.actorId); await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('unknown'); const id = flow.getSnapshot().approval!.id;
    s.journal.close(); journals.delete(s.journal);
    const restarted = await setup(database); const nextRequest = vi.fn<RequestApi>(restarted.request); request = nextRequest;
    await flow.verify();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'succeeded', result: { kind: 'settings', receipt: { approvalId: id, revision: 1 }, value: { settingsRevision: 1, settings: { aiAnswer: true } } } });
    expect(nextRequest.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(restarted.git.publish).not.toHaveBeenCalled();
  });
  it('changes an eligible premise through registered approval and atomic commit, then restores via a new SHA for the same query', async () => {
    const s = await setup();
    s.node.conditions = [{ id: 'premise', text: 'Original fixture premise', status: 'confirmed', evidenceIds: ['source1'], confirmedBy: s.ctx.actorId }];
    const transport = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (input, init) => new URL(String(input)).pathname.endsWith('/knowledge/base/query')
      ? Response.json([{ score: 0.9, chunk: 'STALE_VECTOR_BODY_MUST_NOT_ESCAPE', metadata: { path: indexPath('k1') } }]) : transport(input, init));
    const input: RetrievalRequest = { task: { id: 'same-task', workspaceId: s.ctx.workspaceId, question: 'fixture', constraints: [{ id: 'premise', text: 'Original fixture premise', confirmedBy: s.ctx.actorId }],
      conditionChecks: [{ nodeRef: { workspaceId: s.ctx.workspaceId, objectId: 'k1', revision: s.base }, conditionId: 'premise', status: 'satisfied', confirmedBy: s.ctx.actorId }], mode: 'assisted', updatedAt: '2026-09-05T00:00:00Z' }, query: 'fixture', confirmedOnly: true };
    const originalTask = structuredClone(input.task);
    const query = (conditionChecks = input.task.conditionChecks) => s.send<RetrievalResult>('/api/retrieval/query', { ...input, task: { ...input.task, conditionChecks } });
    const before = await query(); expect(before.groups.eligible.map((node) => node.id)).toContain('k1');
    const flow = new ChangeFlow(s.request);
    async function commit(preview: ChangePreview) {
      const prepared = await s.send<PreparedChange>('/api/governance/changes/prepare', { action: 'prepare', changes: preview.changes, ...(preview.restoration ? { restoration: preview.restoration } : {}) });
      expect(flow.prepare(prepared, s.ctx.actorId)).toBe(true); await flow.approve(); await flow.commit();
      expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
      const result = flow.getSnapshot().result!; expect(flow.finish()).toBe(true); return result;
    }
    const revised = await commit(await s.send<ChangePreview>('/api/governance/nodes/k1', { action: 'preview', operationId: 'premise-edit', baseRevision: s.base, nodeRevision: s.base, reason: 'Revise the necessary premise', patch: { conditions: [{ id: 'premise', text: 'A different fixture premise', status: 'unknown', evidenceIds: [] }] } }, 'PATCH'));
    expect(await s.request('/api/retrieval/query', { method: 'POST', body: JSON.stringify(input) })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const after = await query([]); expect(after.groups.eligible.map((node) => node.id)).not.toContain('k1');
    expect(after.groups.conditional).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'k1', revision: revised.receipt.revision })]));
    expect(JSON.stringify(after)).not.toContain('STALE_VECTOR_BODY_MUST_NOT_ESCAPE'); expect(after.coverage).not.toBe('current');
    const restored = await commit(await s.send<ChangePreview>('/api/governance/rollback', { action: 'preview', operationId: 'premise-restore', nodeId: 'k1', baseRevision: revised.receipt.revision, historicalRevision: s.base, reason: 'Restore trusted historical premise' }));
    expect(restored.receipt.revision).not.toBe(s.base); expect(restored.receipt.indexing).toBe('pending');
    expect(await s.request('/api/retrieval/query', { method: 'POST', body: JSON.stringify(input) })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await query([])).groups.eligible.map((node) => node.id)).not.toContain('k1');
    const again = await query([{ ...originalTask.conditionChecks![0]!, nodeRef: { ...originalTask.conditionChecks![0]!.nodeRef, revision: restored.receipt.revision } }]);
    expect(again.groups.eligible.map((node) => node.id)).toContain('k1'); expect(input.task).toEqual(originalTask);
    expect(JSON.stringify(again)).not.toContain('STALE_VECTOR_BODY_MUST_NOT_ESCAPE');
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { nodes: [expect.objectContaining({ conditions: [expect.objectContaining({ text: 'Original fixture premise' })] })] } });
    expect(s.git.publish).toHaveBeenCalledTimes(2);
  });

  it('reads the same delete report after SQLite close/reopen and blocks historical export and restore without physical deletion', async () => {
    mkdirSync('.local', { recursive: true });
    const directory = mkdtempSync(resolve('.local/governance-r2-fixture-')); directories.push(directory);
    const database = join(directory, 'operations.sqlite');
    const s = await setup(database);
    const preview = await s.send<DataAction['preview']>('/api/governance/delete/preview', { action: 'preview', objectIds: ['k1'], baseRevision: s.base });
    const action = { kind: 'delete', workspaceId: s.ctx.workspaceId, preview } as DataAction;
    const flow = new DataFlow(s.request); flow.prepare(action, s.ctx.actorId); await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
    const plan = action.kind === 'delete' ? action.preview.plan : null; expect(plan).not.toBeNull();
    s.journal.close(); journals.delete(s.journal);
    const restarted = await setup(database);
    const verified = await restarted.send('/api/governance/delete/verify', { action: 'verify', objectIds: ['k1'], planId: plan!.id });
    expect(verified).toMatchObject({ reportAvailable: true, retrievalBlocked: true, physicalDeletionComplete: false, layers: expect.arrayContaining([expect.objectContaining({ name: 'application', state: 'done' }), expect.objectContaining({ name: 'git_history', state: 'unknown' })]) });
    expect(await restarted.services.snapshot(restarted.ctx, restarted.base)).toMatchObject({ ok: true, data: { nodes: [], excludedIds: ['k1'] } });
    const exportResult = await restarted.request('/api/governance/export', { method: 'POST', body: JSON.stringify({ action: 'preview', objectIds: ['k1'], baseRevision: restarted.base }) });
    expect(exportResult.ok).toBe(false);
    const restore = await restarted.request('/api/governance/rollback', { method: 'POST', body: JSON.stringify({ action: 'preview', operationId: 'must-not-restore-deleted', nodeId: 'k1', baseRevision: restarted.base, historicalRevision: restarted.base, reason: 'No deletion bypass' }) });
    expect(restore.ok).toBe(false); expect(restarted.git.publish).not.toHaveBeenCalled(); expect(s.git.publish).not.toHaveBeenCalled();
    expect(restarted.transport.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it.each(['extract', 'answer', 'review'] as const)('persists %s settings through governance HTTP and enforces shutdown on the shared model server', async (purpose) => {
    const s = await setup();
    const complete = vi.fn<ModelTransport['complete']>(async () => ({ ok: true, data: { value: { claims: [] }, modelId: 'fixture-model', generatedAt: new Date().toISOString() } }));
    const services = createServices({ ...s.options, model: { mode: 'fixture', complete } });
    const api = s.connect(services); const flow = new DataFlow(api.request);
    async function setAI(enabled: boolean) {
      const state = await api.send<SettingsData>('/api/governance/settings');
      const key: keyof Settings = { extract: 'aiExtraction', answer: 'aiAnswer', review: 'aiReview' }[purpose] as keyof Settings;
      const preview = await api.send('/api/governance/settings', { action: 'preview', baseRevision: s.base, expectedSettingsHash: state.currentHash, expectedSettingsRevision: state.settingsRevision, patch: { [key]: enabled } }, 'PATCH');
      flow.prepare({ kind: 'settings', workspaceId: s.ctx.workspaceId, preview } as DataAction, s.ctx.actorId); await flow.approve(); await flow.commit();
      expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded'); flow.finish();
    }
    let source = { sourceIds: ['source1'], objectIds: ['k1'], baseRevision: s.base, conversationId: undefined as string | undefined };
    if (purpose === 'extract') {
      const transport = s.transport.getMockImplementation()!;
      s.transport.mockImplementation(async (...args) => String(args[0]).endsWith('/issues/7')
        ? Response.json({ number: '7', title: 'Synthetic governance source', body: 'Only a controlled extraction fixture', created_at: '2026-09-05T00:00:00Z', invisible: true }) : transport(...args));
      const saved = await services.readIssue(s.ctx, 7);
      expect(saved.ok).toBe(true); if (!saved.ok) throw new Error('Expected controlled saved Issue');
      source = { sourceIds: [saved.data.segments[1]!.id], objectIds: [saved.data.segments[1]!.id], baseRevision: saved.data.contentHash, conversationId: saved.data.id };
    }
    const input = { purpose, text: 'Synthetic fixture question', sourceIds: source.sourceIds };
    const approve = async (): Promise<Approval> => {
      const result = await services.approveModel!(s.ctx, { input, objectIds: source.objectIds, baseRevision: source.baseRevision, ...(source.conversationId ? { conversationId: source.conversationId } : {}), confirmed: true });
      expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error('Model approval missing'); return result.data;
    };
    await setAI(true); const approved = await approve(); await setAI(false);
    expect(await services.complete(s.ctx, { ...input, approval: approved })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(complete).not.toHaveBeenCalled();
    await setAI(true); const inFlight = await approve();
    complete.mockImplementation(async () => { await setAI(false); return { ok: true, data: { value: { text: 'DISCARD_AFTER_SHUTDOWN' }, modelId: 'fixture-model', generatedAt: new Date().toISOString() } }; });
    const result = await services.complete(s.ctx, { ...input, approval: inFlight });
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('DISCARD_AFTER_SHUTDOWN'); expect(complete).toHaveBeenCalledOnce();
    expect(await services.readModelOperation!(s.ctx, inFlight.id)).toMatchObject({ ok: true, data: { approvalId: inFlight.id, purpose, state: 'discarded' } });
    expect(await services.snapshot(s.ctx)).toMatchObject({ ok: true, data: { revision: s.base, nodes: [expect.objectContaining({ id: 'k1' })] } });
    expect(s.git.publish).not.toHaveBeenCalled();
  });
});
