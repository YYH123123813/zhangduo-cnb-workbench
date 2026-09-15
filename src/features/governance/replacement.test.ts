import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, json, node, ok, relation, snapshot } from './fixtures.test-support';

const input = { action: 'preview', operationId: 'replace-1', baseRevision: 'fixture-r1', oldNodeId: 'node-1', replacementNodeId: 'node-2', relationId: 'supersedes-1', reason: 'Use the revised conclusion', evidenceIds: ['source-1'] };
describe('G04 explicit replacement', () => {
  it('preserves the old statement and does not adjudicate the replacement evidence', async () => {
    const { app, services } = fixture();
    const data = (await (await app.request('/api/governance/replace', json('POST', input))).json()).data;
    expect(data.changes.nodes[0]).toMatchObject({ humanStatement: node().humanStatement, lifecycle: 'superseded', evidenceStatus: 'supported' });
    expect(data.changes.relations[0]).toMatchObject({ type: 'supersedes', source: { objectId: 'node-2' }, target: { objectId: 'node-1' } });
    expect(data.before.nodes[0]).toEqual(node());
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('rejects a replacement cycle or self replacement', async () => {
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ relations: [relation('prior', 'node-1', 'node-2', { type: 'supersedes' })] }))) });
    for (const value of [input, { ...input, replacementNodeId: 'node-1' }]) expect((await app.request('/api/governance/replace', json('POST', value))).status).toBe(422);
  });
  it('refuses stale versions, unknown endpoints and missing evidence', async () => {
    const { app } = fixture();
    expect((await app.request('/api/governance/replace', json('POST', { ...input, baseRevision: 'old' }))).status).toBe(409);
    for (const value of [{ ...input, replacementNodeId: 'missing' }, { ...input, evidenceIds: [] }]) expect((await app.request('/api/governance/replace', json('POST', value))).status).toBe(422);
  });
  it('cancels or denies permissions before any write', async () => {
    const { app, services } = fixture();
    expect((await app.request('/api/governance/replace', json('POST', { action: 'cancel' }))).status).toBe(200);
    expect(services.snapshot).not.toHaveBeenCalled();
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/replace', json('POST', input))).status).toBe(403);
  });
});
