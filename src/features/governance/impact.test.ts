import { describe, expect, it, vi } from 'vitest';
import { unavailable } from '../../contracts/api';
import { ctx, fixture, json, node, now, ok, relation, snapshot } from './fixtures.test-support';

const request = { action: 'preview', objectIds: ['node-1'], baseRevision: 'fixture-r1', budget: 100 };
describe('G02 impact inspection', () => {
  it('keeps authorized graph impact with an explicit gap when evidence storage is unavailable', async () => {
    const { app } = fixture({ listEvidence: vi.fn(async () => unavailable<never>()) });
    const response = await app.request('/api/governance/impact', json('POST', request));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ directNodeIds: ['node-2'], coverage: 'partial', graphCoverage: 'current', historyCoverage: 'unavailable', evidenceRefs: [] });
  });
  it('does not request forbidden history while inspecting a permitted graph', async () => {
    const { app, services } = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: ['knowledge:read'] })) });
    const response = await app.request('/api/governance/impact', json('POST', request));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ coverage: 'partial', historyCoverage: 'not_authorized', directNodeIds: ['node-2'] });
    expect(services.listEvidence).not.toHaveBeenCalled();
  });
  it('does not expose references to blocked historical records or seed a blocked node', async () => {
    const evidence = { id: 'blocked-record', workspaceId: ctx.workspaceId, taskId: 'secret-task-id', kind: 'use' as const, nodeRefs: [{ workspaceId: ctx.workspaceId, objectId: 'node-2', revision: 'fixture-r1' }], relationRefs: [], answer: 'PRIVATE ANSWER', answerVisible: true, hintLevel: 0 as const, selfConfidence: 'skipped' as const, result: 'unverified' as const, recordedAt: now };
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['blocked-record'] }))), listEvidence: vi.fn(async () => ok([evidence])) });
    const text = await (await app.request('/api/governance/impact', json('POST', request))).text();
    expect(text).not.toContain('secret-task-id'); expect(JSON.parse(text).data.evidenceRefs).toEqual([]);
    const blocked = fixture({ snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['node-1'] }))) });
    expect((await blocked.app.request('/api/governance/impact', json('POST', request))).status).toBe(403);
  });
  it('finds dependents and historical references without treating multi-hop paths as proof', async () => {
    const evidence = { id: 'e1', workspaceId: ctx.workspaceId, taskId: 't1', kind: 'use' as const, nodeRefs: [{ workspaceId: ctx.workspaceId, objectId: 'node-3', revision: 'fixture-old' }], relationRefs: [], answer: 'PRIVATE ANSWER', answerVisible: true, hintLevel: 0 as const, selfConfidence: 'skipped' as const, result: 'unverified' as const, recordedAt: now };
    const { app } = fixture({
      snapshot: vi.fn(async () => ok(snapshot({ nodes: [node(), node('node-2'), node('node-3')], relations: [relation(), relation('edge-2', 'node-3', 'node-2'), relation('cycle', 'node-1', 'node-3')] }))),
      listEvidence: vi.fn(async () => ok([evidence])),
    });
    const result = await (await app.request('/api/governance/impact', json('POST', request))).json();
    expect(result.data.directNodeIds).toEqual(['node-2']);
    expect(result.data.indirectNodeIds).toEqual(['node-3']);
    expect(result.data.evidenceRefs[0]).toMatchObject({ id: 'e1', taskId: 't1' });
    expect(result.data.coverage).toBe('current');
    expect(result.data.isProof).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE ANSWER');
  });
  it('reports an incomplete inspection when the budget runs out', async () => {
    const { app } = fixture();
    const result = await (await app.request('/api/governance/impact', json('POST', { ...request, budget: 1 }))).json();
    expect(result.data.coverage).toBe('partial');
    expect(result.data.budgetExhausted).toBe(true);
  });
  it('does not traverse withdrawn, proposed, excluded or stale-version edges', async () => {
    for (const edge of [relation('edge-1', 'node-2', 'node-1', { state: 'withdrawn' }), relation('edge-1', 'node-2', 'node-1', { state: 'proposed' }), relation('edge-1', 'node-2', 'node-1', { target: { workspaceId: ctx.workspaceId, objectId: 'node-1', revision: 'old' } })]) {
      const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ relations: [edge] }))) });
      const result = await (await app.request('/api/governance/impact', json('POST', request))).json();
      expect(result.data.directNodeIds).toEqual([]);
    }
  });
  it('cancels without loading data, and fails closed on denied evidence access', async () => {
    const { app, services } = fixture();
    await app.request('/api/governance/impact', json('POST', { action: 'cancel' }));
    expect(services.snapshot).not.toHaveBeenCalled();
    const denied = fixture({ listEvidence: vi.fn(async () => ({ ok: false as const, error: { code: 'FORBIDDEN' as const, message: 'Denied', dataState: 'not_written' as const, retryable: false, nextAction: 'request_scope' } })) });
    expect((await denied.app.request('/api/governance/impact', json('POST', request))).status).toBe(403);
  });
  it('rejects a stale basis and unknown object ids', async () => {
    const { app } = fixture();
    expect((await app.request('/api/governance/impact', json('POST', { ...request, baseRevision: 'old' }))).status).toBe(409);
    expect((await app.request('/api/governance/impact', json('POST', { ...request, objectIds: ['foreign'] }))).status).toBe(422);
  });
});
