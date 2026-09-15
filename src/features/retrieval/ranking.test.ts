import { describe, expect, it, vi } from 'vitest';
import { runQuery } from './query';
import { context, fixtureServices, node, relation, request, snapshot } from './test-support';

describe('R08 deterministic ranking', () => {
  it('keeps conflict explanations deterministic when relation storage order changes', async () => {
    const nodes = [node('a'), node('b'), node('c')];
    const relations = [relation('z', 'a', 'b', 'contradicts'), relation('a', 'a', 'c', 'contradicts')];
    const outputs = [];
    for (const edges of [relations, [...relations].reverse()]) {
      const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot(nodes, { relations: edges }) }) }));
      if (!result.ok) throw new Error(result.error.code);
      outputs.push({ groups: result.data.groups, paths: result.data.paths, missing: result.data.missingConditions });
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });
  it('ranks eligibility before evidence before relevance and retains reasons', async () => {
    const nodes = [node('unverified', { evidenceStatus: 'unverified' }), node('partial', { evidenceStatus: 'partial' }), node('good', { title: 'Immutable records', question: 'When?', humanStatement: 'Use stable inputs.' })];
    const history = vi.fn();
    const result = await runQuery(context, request, fixtureServices({ listEvidence: history,
      snapshot: async () => ({ ok: true, data: snapshot(nodes) }),
      semanticQuery: async () => ({ ok: true, data: [{ objectId: 'good', score: 0.2, text: 'not evidence' }, { objectId: 'unverified', score: 1, text: 'not evidence' }] }),
    }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.eligible.map((n) => n.id)).toEqual(['good']);
    expect(result.data.groups.conditional.map((n) => n.id)).toEqual(['partial', 'unverified']);
    expect(result.data.paths.every((p) => p.reason.includes('排序'))).toBe(true);
    expect(history).not.toHaveBeenCalled();
  });
  it('does not promote a supported flag without an actual supporting source', async () => {
    const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot([node('n1', { sources: [] })]) }) }));
    expect(result.ok && result.data.groups.eligible.length).toBe(0);
    expect(result.ok && result.data.missingConditions.join()).toContain('来源');
  });
  it('does not use support for a different statement to qualify a node or its dependents', async () => {
    const unrelated = node('premise', { sources: [{ ...node('premise').sources[0]!, supportedClaim: 'A different claim.' }] });
    const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true,
      data: snapshot([node(), unrelated], { relations: [relation('requires', 'n1', 'premise')] }),
    }) }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.eligible).toEqual([]);
    expect(result.data.groups.conditional.map((n) => n.id).sort()).toEqual(['n1', 'premise']);
    expect(result.data.missingConditions.join()).toContain('来源');
    expect(result.data.missingConditions.join()).toContain('前提');
  });
  it('produces identical groups and paths when snapshot input order changes', async () => {
    const nodes = [node('z'), node('a'), node('m')];
    const output = [];
    for (const order of [nodes, [...nodes].reverse()]) {
      const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot(order) }) }));
      if (!result.ok) throw new Error(result.error.code);
      output.push({ groups: result.data.groups, paths: result.data.paths });
    }
    expect(output[0]).toEqual(output[1]);
  });
});
