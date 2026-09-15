import { describe, expect, it, vi } from 'vitest';
import { runQuery } from './query';
import { context, fixtureServices, node, request, snapshot } from './test-support';

describe('R03 seed recall', () => {
  it('merges and deduplicates semantic and Git hits but never uses vector text as knowledge', async () => {
    const semanticQuery = vi.fn(async () => ({ ok: true as const, data: [
      { objectId: 'n1', score: 0.8, text: 'OLD PRIVATE VECTOR' },
      { objectId: 'n2', score: 0.9, text: 'INJECTED ANSWER' },
      { objectId: 'n1', score: 0.7, text: 'duplicate' },
    ] }));
    const result = await runQuery(context, request, fixtureServices({ semanticQuery, snapshot: async () => ({ ok: true, data: snapshot([node(), node('n2', { title: 'Other', question: 'Other', humanStatement: 'Actual Git statement.' })]) }) }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.eligible.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    expect(result.data.paths.find((p) => p.seedId === 'n1')?.reason).toMatch(/Git.*CNB|CNB.*Git/);
    expect(JSON.stringify(result.data)).not.toMatch(/OLD PRIVATE|INJECTED/);
    expect(result.data.coverage).toBe('partial');
    expect(semanticQuery).toHaveBeenCalledWith(context, 'cache');
  });
  it('degrades a thrown semantic failure without leaking errors or losing Git hits', async () => {
    const result = await runQuery(context, request, fixtureServices({ semanticQuery: async () => { throw new Error('secret-token'); } }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.eligible).toHaveLength(1);
    expect(result.data.coverage).toBe('unavailable');
    expect(result.data.warnings.join()).toMatch(/语义/);
    expect(JSON.stringify(result.data)).not.toContain('secret-token');
  });
  it('fails closed on permission revocation instead of silently downgrading', async () => {
    const result = await runQuery(context, request, fixtureServices({ semanticQuery: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'Revoked', nextAction: 'sign_in', retryable: false, dataState: 'not_written' } }) }));
    expect(result.ok).toBe(false);
  });
  it('discards an in-flight result after cancellation', async () => {
    const controller = new AbortController();
    const result = await runQuery(context, request, fixtureServices({ semanticQuery: async () => { controller.abort(); return { ok: true, data: [] }; } }), controller.signal);
    expect(result.ok).toBe(false);
  });
});
