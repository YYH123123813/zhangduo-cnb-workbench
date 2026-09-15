import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../contracts/api';
import { unavailable } from '../../contracts/api';
import { ctx, fixture, node, ok, snapshot } from './fixtures.test-support';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComparisonResult } from './version-view';

describe('G01 read-only historical and current conflict comparison', () => {
  it('reads pinned original content and current changes without rebasing or saving a draft', async () => {
    const original = node('node-1', { revision: 'fixture-old', humanStatement: 'Original scope', boundaries: ['Original boundary'] });
    const reader = vi.fn(async (_ctx: RequestContext, revision?: string) => ok(revision ? snapshot({ revision, nodes: [original] }) : snapshot()));
    const { app, services } = fixture({ snapshot: reader });
    const response = await app.request('/api/governance/nodes/node-1/compare?revision=fixture-old');
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ state: 'available', readOnly: true, referenceRevision: 'fixture-old', currentSnapshotRevision: 'fixture-r1', original, changedFields: expect.arrayContaining(['humanStatement', 'boundaries']) });
    expect(reader).toHaveBeenCalledWith(ctx, 'fixture-old'); expect(services.saveDraft).not.toHaveBeenCalled(); expect(services.commit).not.toHaveBeenCalled();
  });
  it('never returns historical contents after a deletion barrier appears during the read', async () => {
    const { app } = fixture({ snapshot: vi.fn(async (_ctx: RequestContext, revision?: string) => ok(snapshot({ ...(revision ? { revision, nodes: [node('node-1', { revision, humanStatement: 'BLOCKED_ORIGINAL_BODY' })] } : {}), excludedIds: revision ? [] : ['node-1'] }))) });
    const response = await app.request('/api/governance/nodes/node-1/compare?revision=fixture-old');
    expect(response.status).toBe(200);
    const text = await response.text(); expect(text).not.toContain('BLOCKED_ORIGINAL_BODY');
    expect(JSON.parse(text).data).toMatchObject({ state: 'restricted', original: null, current: null });
  });
  it('keeps unreadable old versions explicit and rejects unauthorized comparisons', async () => {
    const { app } = fixture({ snapshot: vi.fn(async (_ctx: RequestContext, revision?: string) => revision ? unavailable<never>() : ok(snapshot())) });
    const result = await (await app.request('/api/governance/nodes/node-1/compare?revision=fixture-old')).json();
    expect(result.data).toMatchObject({ state: 'unavailable', original: null, current: { id: 'node-1' } });
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/nodes/node-1/compare?revision=fixture-old')).status).toBe(403);
  });
  it('renders an escaped, labelled read-only comparison without a write command', () => {
    const html = renderToStaticMarkup(createElement(ComparisonResult, { value: { nodeId: 'node-1', referenceRevision: 'old', currentSnapshotRevision: 'current', state: 'available', readOnly: true,
      original: node('node-1', { humanStatement: '<script>private</script>' }), current: node(), changedFields: ['humanStatement'] } }));
    expect(html).toContain('原版本与当前版本差异'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<button');
  });
});
