import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/app';
import type { ApiResponse, RequestContext } from '../../contracts/api';
import { CONTRACT_VERSION, type KnowledgeSnapshot, type RetrievalResult } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import type { NodeDetail, LocalGraphData } from './api';
import { queryTask } from './client-state';
import { context, fixtureServices, node, relation, request, snapshot } from './test-support';

const firstRevision = 'a'.repeat(40); const nextRevision = 'b'.repeat(40);
function setup() {
  const issued = Object.freeze({ ...context, scopes: Object.freeze([...context.scopes]) });
  const premise = node('premise', { revision: firstRevision, title: 'Input stability', question: 'Input state?', humanStatement: 'Stable input.',
    conditions: [{ id: 'stable', text: 'Input is stable', status: 'unknown', evidenceIds: [] }],
  });
  const edge = relation('requires', 'n1', 'premise', 'depends_on', {
    source: { workspaceId: context.workspaceId, objectId: 'n1', revision: firstRevision },
    target: { workspaceId: context.workspaceId, objectId: 'premise', revision: firstRevision },
  });
  const initial = snapshot([node('n1', { revision: firstRevision }), premise], { revision: firstRevision, relations: [edge] });
  let current = structuredClone(initial);
  const read = vi.fn<Services['snapshot']>(async (ctx, revision) => {
    if (ctx !== issued) return { ok: false, error: { code: 'FORBIDDEN', message: 'Unregistered context', nextAction: 'sign_in', retryable: false, dataState: 'not_written' } };
    return { ok: true, data: structuredClone(revision === firstRevision ? initial : current) };
  });
  const semanticQuery = vi.fn<Services['semanticQuery']>(async (ctx) => {
    expect(ctx).toBe(issued);
    return { ok: true, data: [{ objectId: 'n1', score: 0.99, text: 'STALE_VECTOR_NOT_FACT' }] };
  });
  const write = vi.fn(async () => { throw new Error('Retrieval must not write'); });
  const services = fixtureServices({ context: async () => ({ ok: true, data: issued }), snapshot: read, semanticQuery,
    commit: write, appendEvidence: write, saveDraft: write,
  });
  const app = createApp(services);
  const task = queryTask(request.task, 'ignored', context.workspaceId, 'cache', [
    { id: 'stable', text: 'Input is stable', confirmedBy: context.actorId },
  ], request.task.updatedAt, [{ nodeRef: edge.target, conditionId: 'stable', status: 'satisfied', confirmedBy: context.actorId }]);
  const query = (conditionChecks = task.conditionChecks) => app.request('http://localhost/api/retrieval/query', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: { ...task, conditionChecks }, query: task.question, confirmedOnly: true }),
  });
  return { app, query, task, issued, read, write, services, initial, get current() { return current; }, set current(value: KnowledgeSnapshot) { current = value; } };
}

describe('R13 shared application composition, synthetic Services only', () => {
  it('withholds retrieval text when the published shared exposure recorder cannot verify persistence', async () => {
    const fixture = setup();
    const record = vi.fn<NonNullable<Services['recordReviewExposure']>>(async () => ({ ok: false, error: { code: 'UNKNOWN_RESULT',
      message: 'Exposure persistence is unknown', retryable: false, dataState: 'unknown', nextAction: 'read_review_operation' } }));
    fixture.services.recordReviewExposure = record;
    const response = await fixture.query();
    expect(response.status).toBe(409); expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toBe(fixture.issued);
    expect(record.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([{ workspaceId: 'w1', objectId: 'n1', revision: firstRevision }]));
    const body = await response.text(); expect(body).not.toMatch(/Cache immutable data|Stable input|STALE_VECTOR_NOT_FACT/);
    expect(body).toContain('UNKNOWN_RESULT');
  });
  it('preserves versioned retrieval, paths and history across a 1.4.0 premise change and deletion block', async () => {
    const fixture = setup();
    const firstResponse = await fixture.query(); expect(firstResponse.status).toBe(200);
    const before = await firstResponse.json() as ApiResponse<RetrievalResult>;
    expect(before.meta).toMatchObject({ mode: 'fixture', contractVersion: CONTRACT_VERSION });
    if (!before.ok) throw new Error(before.error.code);
    const archived = JSON.stringify(before.data);
    expect(before.data.groups.eligible.map((n) => n.id).sort()).toEqual(['n1', 'premise']);
    expect(before.data.paths.some((p) => p.relationIds.includes('requires'))).toBe(true);
    expect(fixture.task.mode).toBe('assisted');
    const detail = await fixture.app.request(`http://localhost/api/retrieval/nodes/n1?revision=${firstRevision}&snapshotRevision=${firstRevision}`);
    const graph = await fixture.app.request(`http://localhost/api/retrieval/graph/n1?revision=${firstRevision}&snapshotRevision=${firstRevision}`);
    expect(detail.status).toBe(200); expect(graph.status).toBe(200);
    const graphBody = await graph.json() as ApiResponse<LocalGraphData>;
    expect(graphBody.ok && graphBody.data.relations.map((r) => r.id)).toEqual(['requires']);

    fixture.current = { ...fixture.current, revision: nextRevision,
      nodes: fixture.current.nodes.map((n) => n.id === 'premise' ? { ...n, revision: nextRevision, conditions: n.conditions.map((c) => ({ ...c, status: 'rejected' as const })) } : n),
    };
    expect((await fixture.query()).status).toBe(409);
    const changed = await (await fixture.query([])).json() as ApiResponse<RetrievalResult>;
    if (!changed.ok) throw new Error(changed.error.code);
    expect(changed.data.snapshotRevision).toBe(nextRevision);
    expect(changed.data.groups.eligible).toEqual([]);
    expect(changed.data.groups.conditional[0]?.revision).toBe(firstRevision);
    expect(changed.data.paths.flatMap((p) => p.relationIds)).not.toContain('requires');
    const currentDetail = await (await fixture.app.request(`http://localhost/api/retrieval/nodes/n1?revision=${firstRevision}&snapshotRevision=${nextRevision}`)).json() as ApiResponse<NodeDetail>;
    expect(currentDetail.ok && currentDetail.data.relations[0]?.usable).toBe(false);
    const oldDetail = await fixture.app.request(`http://localhost/api/retrieval/nodes/n1/history?revision=${firstRevision}`);
    expect(oldDetail.status).toBe(200);
    expect((await oldDetail.json()).data.history.currentSnapshotRevision).toBe(nextRevision);

    fixture.current = { ...fixture.current, excludedIds: ['n1'] };
    const blocked = await (await fixture.query([])).json() as ApiResponse<RetrievalResult>;
    expect(blocked.ok && blocked.data.groups.eligible).toEqual([]);
    expect(JSON.stringify(blocked)).not.toMatch(/Cache immutable data|STALE_VECTOR_NOT_FACT/);
    expect((await fixture.app.request(`http://localhost/api/retrieval/nodes/n1/history?revision=${firstRevision}`)).status).toBe(403);
    expect(JSON.stringify(before.data)).toBe(archived);
    expect(fixture.write).not.toHaveBeenCalled(); expect(fixture.services.complete).not.toHaveBeenCalled();
    expect(fixture.read.mock.calls.every(([ctx]: [RequestContext, string?]) => ctx === fixture.issued)).toBe(true);
  });
  it('keeps shared origin controls ahead of retrieval reads', async () => {
    const fixture = setup();
    const response = await fixture.app.request('http://localhost/api/retrieval/query', { method: 'POST',
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(response.status).toBe(403); expect(fixture.read).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('keeps the model send route unavailable after shared application assembly', async () => {
    const fixture = setup();
    const response = await fixture.app.request('http://localhost/api/retrieval/answer', { method: 'POST', body: '{}' });
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('NOT_CONFIGURED');
    expect(fixture.services.complete).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
  });
});
