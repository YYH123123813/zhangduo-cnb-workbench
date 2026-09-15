import { Hono } from 'hono';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeSnapshot } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { registerRoutes } from './server';
import { NodeDetails } from './views';
import type { NodeDetail } from './api';
import { context, fixtureServices, node, relation, snapshot } from './test-support';

// Synthetic immutable-looking revisions exercise the shared 1.3.0 port, not live Git.
const oldRevision = 'a'.repeat(40); const currentRevision = 'b'.repeat(40);
const endpoint = `/api/retrieval/nodes/n1/history?revision=${oldRevision}`;
const historical = snapshot([
  node('n1', { revision: oldRevision, humanStatement: 'Old original statement.' }),
  node('n2', { revision: oldRevision }),
  node('hidden', { revision: oldRevision, humanStatement: 'BLOCKED_HISTORICAL_TEXT' }),
], { revision: oldRevision, relations: [
  relation('edge', 'n1', 'n2', 'depends_on', { source: { ...relation('edge', 'n1', 'n2').source, revision: oldRevision }, target: { ...relation('edge', 'n1', 'n2').target, revision: oldRevision } }),
  relation('blocked-edge', 'n1', 'hidden', 'depends_on', { source: { ...relation('x', 'n1', 'hidden').source, revision: oldRevision }, target: { ...relation('x', 'n1', 'hidden').target, revision: oldRevision } }),
] });
const current = snapshot([node('n1', { revision: currentRevision }), node('n2', { revision: currentRevision })], { revision: currentRevision });
function appFor(services: Services) { const app = new Hono(); registerRoutes(app, services); return app; }
function reader(now: KnowledgeSnapshot = current) {
  return vi.fn<Services['snapshot']>(async (_ctx, revision) => ({ ok: true, data: revision === oldRevision ? historical : now }));
}

describe('R11 explicit history through shared snapshot 1.3.0', () => {
  it('consumes the shared 40/64-character fixed-version contract without mixing node and collection revisions', async () => {
    const nodeRevision = 'c'.repeat(64), collectionRevision = 'd'.repeat(64);
    const historical = snapshot([node('n1', { revision: nodeRevision })], { revision: collectionRevision });
    const read = vi.fn<Services['snapshot']>(async (_ctx, revision) => ({ ok: true, data: revision === collectionRevision ? historical : current }));
    const app = appFor(fixtureServices({ snapshot: read }));
    const response = await app.request(`/api/retrieval/nodes/n1/history?revision=${nodeRevision}&snapshotRevision=${collectionRevision}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ node: { revision: nodeRevision }, snapshotRevision: collectionRevision });
    expect(read.mock.calls.map(([, revision]) => revision)).toEqual([undefined, collectionRevision, undefined]);
    read.mockClear();
    for (const invalid of ['c'.repeat(63), 'c'.repeat(65), 'C'.repeat(64), 'HEAD']) {
      expect((await app.request(`/api/retrieval/nodes/n1/history?revision=${invalid}`)).status).toBe(422);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('reads the exact requested version and labels every historical relationship read-only', async () => {
    const read = reader(); const services = fixtureServices({ snapshot: read });
    const response = await appFor(services).request(endpoint);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json(); const detail = body.data as NodeDetail;
    expect(detail.node.humanStatement).toBe('Old original statement.'); expect(detail.snapshotRevision).toBe(oldRevision);
    expect(detail.history).toEqual({ currentSnapshotRevision: currentRevision, currentNodeRevision: currentRevision });
    expect(detail.relations.map((r) => r.relation.id)).toEqual(['edge']);
    expect(detail.relations.every((r) => !r.usable)).toBe(true);
    expect(detail.paths[0]?.relationIds).toEqual(['edge']);
    expect(JSON.stringify(body)).not.toContain('BLOCKED_HISTORICAL_TEXT');
    expect(JSON.stringify(body)).not.toContain('blocked-edge');
    expect(read.mock.calls.map(([, revision]) => revision)).toEqual([undefined, oldRevision, undefined]);
    expect(services.complete).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(NodeDetails, { detail, taskId: 't1', onSelect: () => {} }));
    expect(html).toContain('引用版本'); expect(html).not.toContain('#learning');
  });
  it('keeps current-detail behavior strict and rejects symbolic or shortened history revisions', async () => {
    const read = reader(); const app = appFor(fixtureServices({ snapshot: read }));
    expect((await app.request(`/api/retrieval/nodes/n1?revision=${oldRevision}`)).status).toBe(409);
    read.mockClear();
    for (const revision of ['main', '@snapshot', '2026-09-05', oldRevision.slice(0, 7), '']) {
      expect((await app.request(`/api/retrieval/nodes/n1/history?revision=${encodeURIComponent(revision)}`)).status).toBe(422);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects a platform fixture that ignores the requested revision', async () => {
    const services = fixtureServices({ snapshot: async () => ({ ok: true, data: current }) });
    const response = await appFor(services).request(endpoint);
    expect(response.status).toBe(409); expect(await response.text()).not.toContain('Cache immutable data.');
  });
  it('pins node and collection versions separately for unchanged nodes under contract 1.4.0', async () => {
    const collectionRevision = 'd'.repeat(40);
    const read = vi.fn<Services['snapshot']>(async (_ctx, revision) => ({ ok: true,
      data: revision === collectionRevision ? { ...historical, revision: collectionRevision } : current,
    }));
    const app = appFor(fixtureServices({ snapshot: read }));
    const response = await app.request(`${endpoint}&snapshotRevision=${collectionRevision}`);
    expect(response.status).toBe(200); const detail = (await response.json()).data as NodeDetail;
    expect(detail.node.revision).toBe(oldRevision); expect(detail.snapshotRevision).toBe(collectionRevision);
    expect(read.mock.calls.map(([, revision]) => revision)).toEqual([undefined, collectionRevision, undefined]);
    expect((await app.request(`/api/retrieval/nodes/n1/history?revision=${currentRevision}&snapshotRevision=${collectionRevision}`)).status).toBe(409);
    expect((await app.request(`${endpoint}&snapshotRevision=main`)).status).toBe(422);
  });
  it('never reads blocked or withdrawn history even when the old snapshot is available', async () => {
    for (const now of [snapshot(current.nodes, { ...current, excludedIds: ['n1'] }),
      snapshot([node('n1', { revision: currentRevision, lifecycle: 'withdrawn' })], { revision: currentRevision })]) {
      const read = reader(now); const response = await appFor(fixtureServices({ snapshot: read })).request(endpoint);
      expect(response.status).toBe(403); expect(read).toHaveBeenCalledTimes(1);
      expect(await response.text()).not.toContain('Old original statement.');
    }
  });
  it('honors deletions and permission loss while historical content is being read', async () => {
    for (const outcome of ['excluded', 'forbidden', 'changed'] as const) {
      let calls = 0;
      const read: Services['snapshot'] = async (_ctx, revision) => {
        if (revision) return { ok: true, data: historical };
        if (++calls === 1) return { ok: true, data: current };
        if (outcome === 'forbidden') return { ok: false, error: { code: 'FORBIDDEN', message: 'private ACL', nextAction: 'sign_in', retryable: false, dataState: 'not_written' } };
        return { ok: true, data: { ...current, ...(outcome === 'excluded' ? { excludedIds: ['n1'] } : { revision: 'c'.repeat(40) }) } };
      };
      const response = await appFor(fixtureServices({ snapshot: read })).request(endpoint);
      expect(response.status).toBe(outcome === 'changed' ? 409 : 403);
      expect(await response.text()).not.toMatch(/Old original statement|BLOCKED_HISTORICAL_TEXT|private ACL/);
    }
  });
  it('excludes currently blocked relations and cancels before further history reads', async () => {
    const blocked = await appFor(fixtureServices({ snapshot: reader({ ...current, excludedIds: ['edge'] }) })).request(endpoint);
    expect(blocked.status).toBe(200); expect((await blocked.json()).data.relations).toEqual([]);
    const controller = new AbortController();
    const read = vi.fn<Services['snapshot']>(async () => { controller.abort(); return { ok: true, data: current }; });
    const cancelled = await appFor(fixtureServices({ snapshot: read })).request(new Request(`http://localhost${endpoint}`, { signal: controller.signal }));
    expect(cancelled.status).toBe(409); expect(read).toHaveBeenCalledTimes(1);
    const denied = fixtureServices({ context: async () => ({ ok: true, data: { ...context, scopes: [] } }) });
    expect((await appFor(denied).request(endpoint)).status).toBe(403); expect(denied.snapshot).not.toHaveBeenCalled();
  });
});
