import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { compareRelationAblation } from './ablation.test-support';
import { runQuery } from './query';
import { registerRoutes } from './server';
import { context, fixtureServices, node, relation, request, snapshot } from './test-support';

describe('R13 relation ablation and revision regressions', () => {
  const originalRevision = 'a'.repeat(40); const nextRevision = 'b'.repeat(40);
  const condition = { id: 'stable', text: 'Input is immutable', status: 'unknown' as const, evidenceIds: [] };
  const premise = node('premise', { revision: originalRevision, title: 'Input stability', question: 'Does it change?', humanStatement: 'Input is immutable', conditions: [condition] });
  const edge = relation('premise-edge', 'n1', 'premise', 'depends_on', {
    source: { workspaceId: 'w1', objectId: 'n1', revision: originalRevision }, target: { workspaceId: 'w1', objectId: 'premise', revision: originalRevision },
  });
  const data = snapshot([node('n1', { revision: originalRevision }), premise], { revision: originalRevision, relations: [edge] });
  const vector = [{ objectId: 'n1', score: 0.98, text: 'OLD_VECTOR_ONLY' }];

  it('finds a low-similarity premise only through the graph and changes applicability', async () => {
    const report = await compareRelationAblation(data, request, vector);
    expect(report.withRelations.groups.conditional.map((n) => n.id).sort()).toEqual(['n1', 'premise']);
    expect(report.withoutRelations.groups.eligible.map((n) => n.id)).toEqual(['n1']);
    expect(report.withRelations.paths.some((p) => p.nodeIds.includes('premise') && p.relationIds.includes('premise-edge'))).toBe(true);
    expect(report.withRelations.snapshotRevision).toBe(report.withoutRelations.snapshotRevision);
    expect(data.relations).toHaveLength(1);
  });
  it('makes the same query conditional after a versioned premise change while old output remains explainable', async () => {
    const input = { ...request, task: { ...request.task, conditionChecks: [{ nodeRef: edge.target, conditionId: 'stable', status: 'satisfied' as const, confirmedBy: 'u1' }] } };
    const historical = (await compareRelationAblation(data, input, vector)).withRelations;
    const before = JSON.stringify(historical);
    const changed = snapshot([data.nodes[0]!, { ...premise, revision: nextRevision, conditions: [{ ...condition, status: 'rejected' as const }] }], {
      revision: nextRevision, relations: [{ ...edge, target: { ...edge.target, revision: nextRevision } }],
    });
    expect(await runQuery(context, input, fixtureServices({ snapshot: async () => ({ ok: true, data: changed }) }))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const result = (await compareRelationAblation(changed, { ...input, task: { ...input.task, conditionChecks: [] } }, vector)).withRelations;
    expect(historical.groups.eligible.map((n) => n.id).sort()).toEqual(['n1', 'premise']);
    expect(result.groups.eligible).toHaveLength(0);
    expect(result.snapshotRevision).toBe(nextRevision); expect(JSON.stringify(historical)).toBe(before);
  });
  it('withdraws a mistaken conflict edge without reintroducing old vector text', async () => {
    const other = node('other', { title: 'Different technique', question: 'Alternative?', humanStatement: 'Different premise' });
    const before = snapshot([node(), other], { relations: [relation('wrong', 'n1', 'other', 'contradicts')] });
    const after = snapshot(before.nodes, { revision: 'fixture-r2', relations: [relation('wrong', 'n1', 'other', 'contradicts', { state: 'withdrawn' })] });
    expect((await compareRelationAblation(before, request, vector)).withRelations.groups.conflicts).toHaveLength(2);
    const result = (await compareRelationAblation(after, request, vector)).withRelations;
    expect(result.groups.eligible.map((n) => n.id)).toEqual(['n1']); expect(result.paths.flatMap((p) => p.relationIds)).not.toContain('wrong');
    expect(JSON.stringify(result)).not.toContain('OLD_VECTOR_ONLY');
  });
  it('blocks deleted objects despite stale vectors and only allows an explicit new restored snapshot', async () => {
    const removed = snapshot([node()], { revision: 'fixture-r2', excludedIds: ['n1'] });
    expect((await compareRelationAblation(removed, request, vector)).withRelations.groups.eligible).toHaveLength(0);
    const restored = snapshot([node('n1', { revision: 'fixture-r3' })], { revision: 'fixture-r3' });
    const result = (await compareRelationAblation(restored, request, vector)).withRelations;
    expect(result.groups.eligible[0]?.revision).toBe('fixture-r3');
    expect(removed.excludedIds).toEqual(['n1']);
  });
  it('does not expose ablation as a client option or bypass read permission/cancellation', async () => {
    const a = new Hono(); registerRoutes(a, fixtureServices());
    const response = await a.request('/api/retrieval/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, withoutRelations: true }) });
    expect(response.status).toBe(422);
    const controller = new AbortController(); controller.abort();
    expect((await runQuery(context, request, fixtureServices(), controller.signal)).ok).toBe(false);
    expect((await runQuery({ ...context, scopes: [] }, request, fixtureServices())).ok).toBe(false);
  });
});
