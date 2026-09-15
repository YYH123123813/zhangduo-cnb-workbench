import { describe, expect, it } from 'vitest';
import { runQuery } from './query';
import { context, fixtureServices, node, relation, request, snapshot } from './test-support';
import type { KnowledgeSnapshot } from '../../contracts/domain';

async function query(data: KnowledgeSnapshot) {
  const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data }) }));
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}
describe('R07 conflict and replacement gates', () => {
  it('exposes a low-similarity conflict and never arbitrates a winner', async () => {
    const result = await query(snapshot([node(), node('opposite', { title: 'Mutable inputs', question: 'Mutation?', humanStatement: 'Data changes' })], { relations: [relation('conflict', 'opposite', 'n1', 'contradicts')] }));
    expect(result.groups.eligible).toEqual([]);
    expect(result.groups.conflicts.map((n) => n.id).sort()).toEqual(['n1', 'opposite']);
    expect(result.answer).toBeNull(); expect(result.warnings.join()).toContain('冲突');
  });
  it('keeps a replaced original visible but not eligible, without overwriting it', async () => {
    const data = snapshot([node(), node('new')], { relations: [relation('replace', 'new', 'n1', 'supersedes')] });
    const result = await query(data);
    expect(result.groups.eligible.map((n) => n.id)).toEqual(['new']);
    expect(result.groups.conditional.map((n) => n.id)).toEqual(['n1']);
    expect(result.missingConditions.join()).toContain('替代');
    expect(data.nodes[0]?.lifecycle).toBe('active');
  });
  it('reports stale or inaccessible relationship endpoints without exposing them', async () => {
    const result = await query(snapshot([node()], { relations: [relation('edge', 'n1', 'PRIVATE_ID')] }));
    expect(result.groups.eligible).toEqual([]);
    expect(result.missingConditions.join()).toContain('关系');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ID');
  });
  it('makes overflow and undisplayed conflict visible instead of top-k hiding it', async () => {
    const nodes = Array.from({ length: 75 }, (_, i) => node(`n${String(i).padStart(3, '0')}`));
    const result = await query(snapshot(nodes, { relations: [relation('late', 'n000', 'n074', 'contradicts')] }));
    expect(result.groups.eligible).toEqual([]);
    expect(result.warnings.join()).toMatch(/预算|上限/);
    expect(result.groups.conflicts.map((n) => n.id)).toContain('n000');
    expect(result.missingConditions.join()).toContain('冲突');
  });
  it('does not use withdrawn edges, and flags circular dependency as unproven', async () => {
    const data = snapshot([node(), node('n2')], { relations: [relation('a', 'n1', 'n2'), relation('b', 'n2', 'n1')] });
    expect((await query(data)).groups.eligible).toEqual([]);
    data.relations = [relation('rejected', 'n1', 'n2', 'contradicts', { state: 'withdrawn' })];
    expect((await query(data)).groups.conflicts).toEqual([]);
  });
});
