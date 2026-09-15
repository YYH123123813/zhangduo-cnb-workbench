import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import type { ApiResponse, RequestContext } from '../../contracts/api';
import { CONTRACT_VERSION, type ChangeSet, type EvidenceRecord, type Relation, type RetrievalResult, type TaskContext } from '../../contracts/domain';
import { hashChangeSet } from '../../contracts/hash';
import type { UsePreview } from './use';
import type { UseRecordDraft } from './history';
import { success } from './errors';

type PlatformFixture = Awaited<ReturnType<typeof platformFixture>>;
type Preview = UsePreview & { draft: UseRecordDraft; handoffTrust: 'client_preview_only' };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

async function setup() {
  const fixture = await platformFixture(); cleanup.push(() => fixture.journal.close());
  const premise = { ...structuredClone(fixture.node), id: 'premise', title: 'Local prerequisite',
    humanStatement: 'A local copy is required.', conditions: [{ id: 'local-copy', text: 'A local copy exists', status: 'unknown' as const, evidenceIds: [] }],
  };
  const relation: Relation = { id: 'requires', workspaceId: fixture.ctx.workspaceId,
    source: { workspaceId: fixture.ctx.workspaceId, objectId: 'k1', revision: '@snapshot' },
    target: { workspaceId: fixture.ctx.workspaceId, objectId: 'premise', revision: '@snapshot' },
    type: 'depends_on', state: 'confirmed', rationale: 'Fixture prerequisite', evidenceIds: ['fixture-source'],
    proposedBy: fixture.ctx.actorId, confirmedBy: fixture.ctx.actorId, confirmedAt: fixture.node.updatedAt, updatedAt: fixture.node.updatedAt,
  };
  fixture.documents.set(fixture.base, { ...fixture.initial, nodes: [fixture.node, premise], relations: [relation] });
  const transport = fixture.transport.getMockImplementation()!;
  fixture.transport.mockImplementation(async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => new URL(String(input)).pathname.endsWith('/knowledge/base/query')
    ? Response.json({ message: 'Synthetic semantic outage' }, { status: 503 }) : transport(input, init));
  const writes = vi.spyOn(fixture.services, 'appendEvidence');
  const model = vi.spyOn(fixture.services, 'complete');
  const task: TaskContext = { id: 'fallback-task', workspaceId: fixture.ctx.workspaceId, question: 'Fixture claim',
    constraints: [{ id: 'offline', text: 'No network', confirmedBy: fixture.ctx.actorId }], mode: 'assisted',
    sourceIssueNumber: 7, updatedAt: fixture.node.updatedAt,
  };
  const app = createApp(fixture.services);
  const query = async () => {
    const response = await app.request('/api/retrieval/query', { method: 'POST', headers: fixture.headers,
      body: JSON.stringify({ task, query: task.question, confirmedOnly: true }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as ApiResponse<RetrievalResult>;
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  };
  const preview = (retrieval: RetrievalResult) => app.request('/api/learning/use', { method: 'POST', headers: fixture.headers,
    body: JSON.stringify({ action: 'preview_retrieved', task, retrieval, nodeId: 'k1', decision: 'adopt', reason: 'I will verify the local prerequisite and incomplete coverage.' }),
  });
  return { ...fixture, app, query, preview, writes, model, task };
}

async function readPreview(fixture: Awaited<ReturnType<typeof setup>>, retrieval: RetrievalResult) {
  const response = await fixture.preview(retrieval);
  expect(response.status).toBe(200);
  const result = await response.json() as ApiResponse<Preview>;
  if (!result.ok) throw new Error(result.error.code);
  expect(result.meta).toMatchObject({ mode: 'fixture', contractVersion: CONTRACT_VERSION });
  return result.data;
}

// Preserve legacy-record coverage separately from the actual 1.14 SQLite persistence tests.
function stubHistoricalRecord(fixture: PlatformFixture, record: EvidenceRecord) {
  vi.spyOn(fixture.services, 'listEvidence').mockImplementation(async (ctx: RequestContext) => {
    const access = await fixture.services.workspace(ctx);
    return access.ok ? success([structuredClone(record)]) : access;
  });
  fixture.services.readEvidence = vi.fn<NonNullable<PlatformFixture['services']['readEvidence']>>(async (ctx: RequestContext, id: string) => {
    const access = await fixture.services.workspace(ctx);
    return access.ok ? success(id === record.id ? structuredClone(record) : null) : access;
  });
}

async function blockKnowledge(fixture: PlatformFixture) {
  const plan = await fixture.services.previewDelete(fixture.ctx, ['k1']);
  if (!plan.ok) throw new Error(plan.error.code);
  const approval = await fixture.services.approveGovernance!(fixture.ctx, { purpose: 'delete', planId: plan.data.id, confirmed: true });
  if (!approval.ok) throw new Error(approval.error.code);
  const result = await fixture.services.executeDelete(fixture.ctx, plan.data, approval.data);
  if (!result.ok) throw new Error(result.error.code);
  expect(result.data).toMatchObject({ retrievalBlocked: true, layers: expect.arrayContaining([
    expect.objectContaining({ name: 'application', state: 'done' }), expect.objectContaining({ state: 'unknown' }),
  ]) });
  return { plan: plan.data, report: result.data };
}

describe('Learning with shared application and platform Services (synthetic transport, not G3/G4 acceptance)', () => {
  it('previews actual retrieval API Git fallback without re-querying or granting evidence trust', async () => {
    const fixture = await setup(); const retrieved = await fixture.query();
    expect(retrieved).toMatchObject({ coverage: 'unavailable', answer: null, snapshotRevision: fixture.base });
    expect(retrieved.groups.conditional.map((node) => node.id)).toContain('k1');
    expect(retrieved.paths.flatMap((path) => path.relationIds)).toContain('requires');
    const queryCount = fixture.transport.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith('/knowledge/base/query')).length;
    expect(queryCount).toBeGreaterThan(0);
    const preview = await readPreview(fixture, retrieved);
    expect(preview).toMatchObject({ persistence: 'not_saved', handoffTrust: 'client_preview_only',
      missingConditions: expect.arrayContaining(['A local copy exists']),
      warnings: expect.arrayContaining([...retrieved.warnings, expect.stringContaining('检索完整性尚未确认')]),
      draft: { taskSnapshot: fixture.task, snapshotRevision: fixture.base,
        retrievalContext: { coverage: 'unavailable', queryId: retrieved.queryId },
        record: { kind: 'use', answerVisible: true, result: 'unverified' }, indexing: 'excluded',
      },
    });
    expect(preview.draft.paths.flatMap((path) => path.relationIds)).toContain('requires');
    expect(fixture.transport.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith('/knowledge/base/query'))).toHaveLength(queryCount);
    expect(fixture.writes).not.toHaveBeenCalled(); expect(fixture.model).not.toHaveBeenCalled();
    expect(fixture.git.publish).not.toHaveBeenCalled();
  });

  it('keeps old conditions explainable after a shared Git premise change, without accepting the old query', async () => {
    const fixture = await setup(); const retrieved = await fixture.query();
    const preview = await readPreview(fixture, retrieved); const frozen = structuredClone(preview.draft);
    stubHistoricalRecord(fixture, preview.draft.record);
    const changes: ChangeSet = { id: 'change-premise', workspaceId: fixture.ctx.workspaceId, baseRevision: fixture.base,
      nodes: [{ ...retrieved.groups.conditional.find((node) => node.id === 'premise')!, humanStatement: 'The local prerequisite no longer holds.',
        conditions: [{ id: 'local-copy', text: 'A local copy exists', status: 'rejected', evidenceIds: [] }],
      }], relations: [], withdrawnIds: [], reason: 'Synthetic changed premise', contentHash: 'pending',
    };
    changes.contentHash = await hashChangeSet(changes);
    const approval = await fixture.services.approveKnowledge!(fixture.ctx, { changes, confirmed: true });
    if (!approval.ok) throw new Error(approval.error.code);
    const committed = await fixture.services.commit(fixture.ctx, changes, approval.data);
    if (!committed.ok) throw new Error(committed.error.code);
    expect(committed.data.indexing).toBe('pending');
    const outdated = await fixture.preview(retrieved);
    expect(outdated.status).toBe(409); expect(await outdated.json()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const fresh = await fixture.query();
    expect(fresh.snapshotRevision).toBe(committed.data.revision);
    expect(fresh.groups.eligible).toEqual([]);
    expect(fresh.paths.flatMap((path) => path.relationIds)).not.toContain('requires');
    const history = await fixture.app.request(`/api/learning/records/${preview.draft.record.id}/knowledge?nodeId=k1`, { headers: fixture.headers });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ ok: true, data: { snapshotRevision: fixture.base, contextState: 'not_recorded', applicability: 'not_assessed', knowledge: { humanStatement: fixture.node.humanStatement } } });
    expect(preview.draft).toEqual(frozen);
    expect(preview.draft.knowledge.find((node) => node.id === 'premise')?.conditions[0]?.status).toBe('unknown');
    expect(fixture.writes).not.toHaveBeenCalled(); expect(fixture.model).not.toHaveBeenCalled();
  });

  it('honors the provided W11 barrier in old retrieval previews and historical learning reads', async () => {
    const fixture = await setup(); const retrieved = await fixture.query();
    const preview = await readPreview(fixture, retrieved); stubHistoricalRecord(fixture, preview.draft.record);
    const historyUrl = `/api/learning/records/${preview.draft.record.id}/knowledge?nodeId=k1`;
    expect((await fixture.app.request(historyUrl, { headers: fixture.headers })).status).toBe(200);
    const { plan, report } = await blockKnowledge(fixture);
    expect(await fixture.services.readDeleteReport!(fixture.ctx, plan.id)).toEqual(success(report));
    expect(await fixture.services.snapshot(fixture.ctx, fixture.base)).toMatchObject({ ok: true, data: { excludedIds: expect.arrayContaining(['k1']) } });
    const stale = await fixture.preview(retrieved); expect(stale.status).toBe(409);
    expect(await stale.text()).not.toContain(fixture.node.humanStatement);
    const history = await fixture.app.request(historyUrl, { headers: fixture.headers });
    expect(history.status).toBe(403); expect(await history.text()).not.toContain(fixture.node.humanStatement);
    const current = await fixture.app.request('/api/learning/context', { headers: fixture.headers });
    expect(current.status).toBe(200); expect((await current.json()).data.nodes.map((node: { id: string }) => node.id)).not.toContain('k1');
    expect(fixture.writes).not.toHaveBeenCalled(); expect(fixture.model).not.toHaveBeenCalled(); expect(fixture.git.publish).not.toHaveBeenCalled();
  });

  it('rechecks the real deletion barrier when a historical response was read before the block', async () => {
    const fixture = await setup(); const preview = await readPreview(fixture, await fixture.query());
    stubHistoricalRecord(fixture, preview.draft.record);
    const snapshot = fixture.services.snapshot;
    let blocked = false;
    vi.spyOn(fixture.services, 'snapshot').mockImplementation(async (ctx: RequestContext, revision?: string) => {
      const result = await snapshot(ctx, revision);
      if (revision === fixture.base && !blocked) { blocked = true; await blockKnowledge(fixture); }
      return result;
    });
    const history = await fixture.app.request(`/api/learning/records/${preview.draft.record.id}/knowledge?nodeId=k1`, { headers: fixture.headers });
    expect(blocked).toBe(true); expect(history.status).toBe(403);
    expect(await history.text()).not.toContain(fixture.node.humanStatement);
    expect(fixture.writes).not.toHaveBeenCalled(); expect(fixture.model).not.toHaveBeenCalled();
  });
});
