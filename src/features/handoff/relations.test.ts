import { describe, expect, it } from 'vitest';
import type { Relation } from '../../contracts/domain';
import { relationEvidence, validateRelations } from './relations';
import { node, relation, snapshot } from './testing/knowledge';
describe('H06 formal relation validation', () => {
  it('allows a cold start without any relations', () => { expect(validateRelations([], node, snapshot).ok).toBe(true); });
  it('validates both explicitly chosen directions without auto-creating reverse edges', () => {
    expect(validateRelations([relation()], node, snapshot).ok).toBe(true);
    const reverse = relation(); [reverse.source, reverse.target] = [reverse.target, reverse.source];
    expect(validateRelations([reverse], node, snapshot).ok).toBe(true);
  });
  it('rejects missing evidence, duplicate edges and unsupported relation types', () => {
    expect(validateRelations([{ ...relation(), evidenceIds: [] }], node, snapshot).ok).toBe(false);
    expect(validateRelations([{ ...relation(), evidenceIds: ['forged'] }], node, snapshot).ok).toBe(false);
    expect(validateRelations([relation(), { ...relation(), id: 'second-id' }], node, snapshot).ok).toBe(false);
    expect(validateRelations([{ ...relation(), type: 'similar' as Relation['type'] }], node, snapshot).ok).toBe(false);
  });
  it('rejects foreign, dangling, excluded and stale target references', () => {
    for (const target of [{ ...relation().target, workspaceId: 'foreign' }, { ...relation().target, objectId: 'missing' }, { ...relation().target, revision: 'fixture-old' }]) {
      expect(validateRelations([{ ...relation(), target }], node, snapshot).ok).toBe(false);
    }
    expect(validateRelations([relation()], node, { ...snapshot, excludedIds: ['node-2'] }).ok).toBe(false);
  });
  it('does not allow a proposed edge to masquerade as confirmed', () => {
    expect(validateRelations([{ ...relation(), state: 'proposed' }], node, snapshot).ok).toBe(false);
  });
  it('rejects an evidence ID that resolves to different source provenance across relation endpoints', () => {
    const altered = structuredClone(snapshot);
    altered.nodes[0]!.sources[0]!.excerpt = '不同现场中的另一句原文';
    expect(validateRelations([relation()], node, altered)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const evidence = relationEvidence([...node.sources, ...altered.nodes[0]!.sources]);
    expect(evidence.ambiguousIds).toEqual(['source-1']); expect(evidence.sources).toEqual([]);
  });
  it('allows shared source provenance with different per-claim judgments but excludes ambiguous choices', () => {
    const source = node.sources[0]!;
    const unique = { ...source, id: 'unique-source' };
    const evidence = relationEvidence([source, { ...source, support: 'partial', supportedClaim: '另一条有边界的主张', limitation: '只支持部分' }]);
    expect(evidence.ambiguousIds).toEqual([]); expect(evidence.sources).toHaveLength(1);
    const altered = structuredClone(snapshot);
    altered.nodes[0]!.sources = [{ ...source, url: 'https://example.org/different-source' }, unique];
    expect(validateRelations([{ ...relation(), evidenceIds: [unique.id] }], node, altered).ok).toBe(true);
    expect(relationEvidence([...node.sources, ...altered.nodes[0]!.sources])).toMatchObject({ sources: [unique], ambiguousIds: ['source-1'] });
  });
});
