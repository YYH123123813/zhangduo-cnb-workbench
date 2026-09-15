import { describe, expect, it, vi } from 'vitest';
import { runQuery } from './query';
import { context, fixtureServices, node, request, snapshot } from './test-support';

describe('R04 snapshot eligibility', () => {
  it('preserves sorted, unique platform exclusions without restoring deleted bodies', async () => {
    const result = await runQuery(context, request, fixtureServices({
      snapshot: async () => ({ ok: true, data: snapshot([node(), node('draft', { confirmation: 'draft' }), node('withdrawn', { lifecycle: 'withdrawn' })], {
        excludedIds: ['z-deleted', 'k1', 'draft', 'k1'],
      }) }),
      semanticQuery: async () => ({ ok: true, data: [{ objectId: 'k1', score: 1, text: 'DELETED_PRIVATE_BODY' }] }),
    }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.excludedIds).toEqual(['draft', 'k1', 'withdrawn', 'z-deleted']);
    expect(result.data.groups.eligible.map((n) => n.id)).toEqual(['n1']);
    expect(JSON.stringify(result.data)).not.toContain('DELETED_PRIVATE_BODY');
  });
  it('reports a same-revision deletion when the platform removes its body during recall', async () => {
    const read = vi.fn<ReturnType<typeof fixtureServices>['snapshot']>()
      .mockResolvedValueOnce({ ok: true, data: snapshot() })
      .mockResolvedValue({ ok: true, data: snapshot([], { excludedIds: ['n1'] }) });
    const result = await runQuery(context, request, fixtureServices({ snapshot: read }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups).toEqual({ eligible: [], conditional: [], conflicts: [], excludedIds: ['n1'] });
    expect(result.data.paths).toEqual([]);
    expect(JSON.stringify(result.data)).not.toContain('Cache immutable data.');
  });
  it('filters blocked, withdrawn, draft and cross-workspace vector hits even when confirmedOnly is false', async () => {
    const nodes = [node(), node('blocked'), node('withdrawn', { lifecycle: 'withdrawn' }), node('draft', { confirmation: 'draft' }), node('foreign', { workspaceId: 'other', title: 'PRIVATE_TITLE' })];
    const result = await runQuery(context, { ...request, confirmedOnly: false }, fixtureServices({
      snapshot: async () => ({ ok: true, data: snapshot(nodes, { excludedIds: ['blocked'] }) }),
      semanticQuery: async () => ({ ok: true, data: nodes.map((n) => ({ objectId: n.id, score: 1, text: 'OLD_TEXT' })) }),
    }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.eligible.map((n) => n.id)).toEqual(['n1']);
    expect(result.data.groups.excludedIds).toEqual(['blocked', 'draft', 'withdrawn']);
    expect(JSON.stringify(result.data)).not.toMatch(/foreign|PRIVATE_TITLE|OLD_TEXT/);
  });
  it('refuses to mix snapshots if Git changed during semantic recall', async () => {
    const read = vi.fn<ReturnType<typeof fixtureServices>['snapshot']>()
      .mockResolvedValueOnce({ ok: true, data: snapshot() })
      .mockResolvedValue({ ok: true, data: snapshot([node('n1', { revision: 'fixture-r2' })], { revision: 'fixture-r2' }) });
    const result = await runQuery(context, request, fixtureServices({ snapshot: read }));
    expect(!result.ok && result.error.code).toBe('CONFLICT');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('applies a new exclusion list even when the Git revision is unchanged', async () => {
    const read = vi.fn<ReturnType<typeof fixtureServices>['snapshot']>()
      .mockResolvedValueOnce({ ok: true, data: snapshot() })
      .mockResolvedValue({ ok: true, data: snapshot([node()], { excludedIds: ['n1'] }) });
    const result = await runQuery(context, request, fixtureServices({ snapshot: read }));
    expect(result.ok && result.data.groups.eligible).toEqual([]);
  });
  it('honors permission loss on the second snapshot read', async () => {
    const read = vi.fn<ReturnType<typeof fixtureServices>['snapshot']>()
      .mockResolvedValueOnce({ ok: true, data: snapshot() })
      .mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'Revoked', nextAction: 'sign_in', retryable: false, dataState: 'not_written' } });
    const result = await runQuery(context, request, fixtureServices({ snapshot: read }));
    expect(!result.ok && result.error.code).toBe('FORBIDDEN');
  });
  it('rejects ambiguous duplicate object IDs and invalid runtime records', async () => {
    for (const data of [snapshot([node(), node()]), snapshot([node('n1', { confirmedBy: undefined })])]) {
      const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data }) }));
      expect(!result.ok && result.error.code).toBe('UPSTREAM');
    }
  });
});
