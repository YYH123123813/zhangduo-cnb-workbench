import { describe, expect, it, vi } from 'vitest';
import type { SemanticQueryResult } from '../../contracts/retrieval';
import { runQuery } from './query';
import { context, fixtureServices, node, request, snapshot } from './test-support';

const status = (patch: Partial<SemanticQueryResult> = {}): SemanticQueryResult => ({
  hits: [{ objectId: 'n2', score: 0.9, text: 'UNTRUSTED_INDEX_BODY' }],
  snapshotRevision: 'fixture-r1', indexRevision: 'fixture-r1', coverage: 'current', ...patch,
});
const nodes = [node(), node('n2', { title: 'Other', question: 'Other', humanStatement: 'Current Git original.' })];

describe('1.6 semantic coverage adapter', () => {
  it('prefers status-aware recall, verifies coverage, and still reads originals from Git', async () => {
    const semanticQuery = vi.fn();
    const semanticQueryWithStatus = vi.fn(async () => ({ ok: true as const, data: status() }));
    const result = await runQuery(context, request, fixtureServices({ semanticQuery, semanticQueryWithStatus,
      snapshot: async () => ({ ok: true, data: snapshot(nodes) }) }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.coverage).toBe('current');
    expect(result.data.groups.eligible.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    expect(JSON.stringify(result.data)).not.toContain('UNTRUSTED_INDEX_BODY');
    expect(semanticQueryWithStatus).toHaveBeenCalledWith(context, 'cache');
    expect(semanticQuery).not.toHaveBeenCalled();
  });
  it.each([
    ['partial', null, 'partial'], ['stale', 'fixture-r0', 'stale'],
    ['current', null, 'partial'], ['current', 'fixture-r0', 'stale'],
  ] as const)('keeps coverage %s / index %s conservative', async (coverage, indexRevision, expected) => {
    const result = await runQuery(context, request, fixtureServices({ semanticQueryWithStatus: async () => ({ ok: true, data: status({ coverage, indexRevision }) }) }));
    expect(result.ok && result.data.coverage).toBe(expected);
  });
  it('does not promote unavailable hits or retry the legacy port', async () => {
    const semanticQuery = vi.fn();
    const result = await runQuery(context, request, fixtureServices({ semanticQuery,
      snapshot: async () => ({ ok: true, data: snapshot(nodes) }),
      semanticQueryWithStatus: async () => ({ ok: true, data: status({ coverage: 'unavailable' }) }) }));
    expect(result.ok && result.data.coverage).toBe('unavailable');
    expect(result.ok && result.data.groups.eligible.map((n) => n.id)).toEqual(['n1']);
    expect(semanticQuery).not.toHaveBeenCalled();
  });
  it('rejects a semantic snapshot that differs from the enclosing Git reads', async () => {
    const result = await runQuery(context, request, fixtureServices({ semanticQueryWithStatus: async () => ({ ok: true, data: status({ snapshotRevision: 'fixture-r2' }) }) }));
    expect(!result.ok && result.error.code).toBe('CONFLICT');
  });
  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'CONFLICT'] as const)('does not downgrade %s from the new port', async (code) => {
    const result = await runQuery(context, request, fixtureServices({ semanticQueryWithStatus: async () => ({ ok: false, error: {
      code, message: 'PRIVATE_UPSTREAM_ERROR', nextAction: 'retry', retryable: false, dataState: 'not_written',
    } }) }));
    expect(!result.ok && result.error.code).toBe(code);
  });
  it('drops malformed status metadata and falls back to Git without vector text', async () => {
    const result = await runQuery(context, request, fixtureServices({ semanticQueryWithStatus: async () => ({ ok: true,
      data: status({ coverage: 'UNTRUSTED_COVERAGE' as SemanticQueryResult['coverage'] }) }) }));
    expect(result.ok && result.data.coverage).toBe('unavailable');
    expect(JSON.stringify(result)).not.toMatch(/UNTRUSTED_INDEX_BODY|UNTRUSTED_COVERAGE/);
  });
  it('discards the status response after cancellation', async () => {
    const controller = new AbortController();
    const result = await runQuery(context, request, fixtureServices({ semanticQueryWithStatus: async () => {
      controller.abort(); return { ok: true, data: status() };
    } }), controller.signal);
    expect(result.ok).toBe(false);
  });
});
