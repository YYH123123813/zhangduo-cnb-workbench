import { describe, expect, it } from 'vitest';
import { expandGraph } from './graph';
import { node, relation } from './test-support';
import type { Seed } from './recall';

const seed = (id = 'n1'): Seed => ({ node: node(id), score: 1, reason: 'Git 正文匹配' });
describe('R05 bounded graph expansion', () => {
  it('follows premises, reverse supporting evidence and replacements with explicit stored directions', () => {
    const nodes = ['n1', 'premise', 'supporter', 'replacement', 'dependent'].map((id) => node(id));
    const relations = [relation('dep', 'n1', 'premise'), relation('support', 'supporter', 'n1', 'supports'), relation('new', 'replacement', 'n1', 'supersedes'), relation('reverse', 'dependent', 'n1')];
    const result = expandGraph(nodes, relations, [seed()]);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['n1', 'premise', 'replacement', 'supporter']);
    expect(result.paths.find((p) => p.relationIds.includes('new'))?.reason).toContain('replacement supersedes n1');
  });
  it('checks conflicts symmetrically without rewriting stored edges', () => {
    const edge = relation('conflict', 'n2', 'n1', 'contradicts');
    const result = expandGraph([node(), node('n2')], [edge], [seed()]);
    expect(result.nodes).toHaveLength(2);
    expect(result.relations[0]?.source.objectId).toBe('n2');
    expect(edge.source.objectId).toBe('n2');
  });
  it('does not follow proposed, withdrawn, foreign, inaccessible or stale-version neighbors', () => {
    const current = node(); const other = node('n2');
    for (const patch of [{ state: 'proposed' as const }, { state: 'withdrawn' as const }, { workspaceId: 'foreign' }, { target: { workspaceId: 'w1', objectId: 'n2', revision: 'fixture-old' } }]) {
      expect(expandGraph([current, other], [relation('edge', 'n1', 'n2', 'depends_on', patch)], [seed()]).nodes).toHaveLength(1);
    }
    const result = expandGraph([current], [relation('edge', 'n1', 'secret')], [seed()]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('stops cycles, clamps depth to two and bounds a display to fifteen nodes', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`));
    const edges = nodes.slice(1).map((n, i) => relation(`e${i}`, `n${i}`, n.id));
    edges.push(relation('cycle', 'n2', 'n0'));
    const chain = expandGraph(nodes, edges, [seed('n0')], { maxDepth: 100 });
    expect(chain.nodes.map((n) => n.id)).toEqual(['n0', 'n1', 'n2']);
    expect(chain.paths.every((p) => p.relationIds.length <= 2)).toBe(true);
    const star = expandGraph(nodes, nodes.slice(1).map((n) => relation(`e-${n.id}`, 'n0', n.id)), [seed('n0')], { maxDepth: 1, maxNodes: 15 });
    expect(star.nodes).toHaveLength(15); expect(star.truncated).toBe(true);
  });
});
