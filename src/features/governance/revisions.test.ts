import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, json, node, ok, snapshot } from './fixtures.test-support';

const edit = { action: 'preview', operationId: 'edit-1', baseRevision: 'fixture-r1', nodeRevision: 'fixture-r1', reason: 'A prerequisite changed', patch: { humanStatement: 'Revalidate before cache reuse.' } };

describe('G01 revision drafts', () => {
  it('previews a schema-valid edit without overwriting the source or persisting', async () => {
    const original = snapshot();
    const { app, services } = fixture({ snapshot: vi.fn(async () => ok(original)) });
    const res = await app.request('/api/governance/nodes/node-1', json('PATCH', edit));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.mode).toBe('fixture');
    expect(body.data.before.nodes[0]).toEqual(node());
    expect(body.data.changes).toMatchObject({ baseRevision: 'fixture-r1', reason: edit.reason });
    expect(body.data.changes.nodes[0]).toMatchObject({ humanStatement: edit.patch.humanStatement, authorship: 'human_edited', confirmation: 'draft', revision: 'fixture-r1' });
    expect(original.nodes[0]).toEqual(node());
    expect(services.commit).not.toHaveBeenCalled();
    expect(services.saveDraft).not.toHaveBeenCalled();
  });
  it('rejects empty reasons, schema changes and client identity overrides', async () => {
    const { app } = fixture();
    for (const invalid of [{ ...edit, reason: ' ' }, { ...edit, patch: { id: 'other' } }, { ...edit, workspaceId: 'other' }]) {
      expect((await app.request('/api/governance/nodes/node-1', json('PATCH', invalid))).status).toBe(422);
    }
  });
  it('cancels without reading or writing knowledge', async () => {
    const { app, services } = fixture();
    const body = await (await app.request('/api/governance/nodes/node-1', json('PATCH', { action: 'cancel' }))).json();
    expect(body.data.state).toBe('cancelled');
    expect(services.snapshot).not.toHaveBeenCalled();
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('denies missing permissions before loading private data', async () => {
    const { app, services } = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await app.request('/api/governance/nodes/node-1', json('PATCH', edit))).status).toBe(403);
    expect(services.snapshot).not.toHaveBeenCalled();
  });
  it('retains the draft and rejects changed HEAD or node revision', async () => {
    const { app } = fixture();
    for (const stale of [{ ...edit, baseRevision: 'fixture-old' }, { ...edit, nodeRevision: 'fixture-old' }]) {
      const res = await app.request('/api/governance/nodes/node-1', json('PATCH', stale));
      expect(res.status).toBe(409);
      expect((await res.json()).error.dataState).toBe('preserved');
    }
  });
  it('rejects a foreign workspace snapshot', async () => {
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ workspaceId: 'other' }))) });
    expect((await app.request('/api/governance/nodes/node-1', json('PATCH', edit))).status).toBe(403);
  });
  it('does not inherit source support for a newly edited claim', async () => {
    const { app } = fixture();
    const result = await (await app.request('/api/governance/nodes/node-1', json('PATCH', edit))).json();
    expect(result.data.changes.nodes[0].evidenceStatus).toBe('unverified');
  });
  it('does not turn accepted AI wording into human authorship on metadata-only edits', async () => {
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ nodes: [node('node-1', { authorship: 'ai_accepted' })] }))) });
    const result = await (await app.request('/api/governance/nodes/node-1', json('PATCH', { ...edit, patch: { lifecycle: 'needs_review' } }))).json();
    expect(result.data.changes.nodes[0].authorship).toBe('ai_accepted');
  });
});
