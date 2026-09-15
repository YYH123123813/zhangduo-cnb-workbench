import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../contracts/api';
import { restorePreview } from './restore';
import { ctx, fixture, json, node, ok, snapshot } from './fixtures.test-support';

const input = { action: 'preview' as const, operationId: 'restore-1', nodeId: 'node-1', baseRevision: 'fixture-r1', historicalRevision: 'fixture-old', reason: 'Restore the earlier condition' };
describe('G06 restoration boundary', () => {
  it('builds a new change from a trusted historical snapshot, keeping both inputs unchanged', () => {
    const head = snapshot();
    const old = snapshot({ revision: 'fixture-old', nodes: [node('node-1', { revision: 'fixture-old', humanStatement: 'Previous statement' })] });
    const before = structuredClone({ head, old });
    const preview = restorePreview(head, old, ctx, input);
    expect(preview.changes).toMatchObject({ baseRevision: 'fixture-r1', nodes: [{ revision: 'fixture-r1', humanStatement: 'Previous statement', confirmation: 'draft' }] });
    expect({ head, old }).toEqual(before);
  });
  it('rejects stale HEAD and foreign history, while previewing explicit exclusion restoration', () => {
    const old = snapshot({ revision: 'fixture-old' });
    expect(() => restorePreview(snapshot(), old, ctx, { ...input, baseRevision: 'changed' })).toThrow();
    expect(() => restorePreview(snapshot(), { ...old, workspaceId: 'foreign' }, ctx, input)).toThrow();
    expect(restorePreview(snapshot({ excludedIds: ['node-1'] }), old, ctx, input)).toMatchObject({ restoration: { nodeId: 'node-1', historicalRevision: 'fixture-old' } });
  });
  it('does not accept browser-supplied history or claim a restore when the history port is absent', async () => {
    const { app, services } = fixture();
    const unavailable = await app.request('/api/governance/rollback', json('POST', input));
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe('NOT_CONFIGURED');
    expect((await app.request('/api/governance/rollback', json('POST', { ...input, historicalNode: node() }))).status).toBe(422);
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('cancels without reading or writing', async () => {
    const { app, services } = fixture();
    const result = await (await app.request('/api/governance/rollback', json('POST', { action: 'cancel' }))).json();
    expect(result.data.state).toBe('cancelled');
    expect(services.snapshot).not.toHaveBeenCalled();
  });
  it('reads the exact historical version through Services before creating a restore preview', async () => {
    const historical = snapshot({ revision: 'fixture-old', nodes: [node('node-1', { revision: 'fixture-old', humanStatement: 'Historical statement' })] });
    const reader = vi.fn(async (_ctx: RequestContext, revision?: string) => ok(revision ? historical : snapshot()));
    const { app, services } = fixture({ snapshot: reader });
    const data = (await (await app.request('/api/governance/rollback', json('POST', input))).json()).data;
    expect(reader).toHaveBeenCalledWith(ctx, 'fixture-old');
    expect(data.changes.nodes[0].humanStatement).toBe('Historical statement');
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('requires trusted historical content again when preparing an excluded node for restoration', async () => {
    const historical = snapshot({ revision: 'fixture-old', nodes: [node('node-1', { revision: 'fixture-old', humanStatement: 'Historical statement' })] });
    const head = snapshot({ excludedIds: ['node-1'] });
    const { app } = fixture({ snapshot: vi.fn(async (_ctx, revision) => ok(revision ? historical : head)) });
    const preview = (await (await app.request('/api/governance/rollback', json('POST', input))).json()).data;
    expect((await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes: preview.changes }))).status).toBe(409);
    expect((await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes: preview.changes, restoration: preview.restoration }))).status).toBe(200);
    preview.changes.nodes[0].humanStatement = 'Unreviewed replacement';
    expect((await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes: preview.changes, restoration: preview.restoration }))).status).toBe(409);
  });
});
