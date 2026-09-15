import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerRoutes } from './server';
import { NodeDetails, TextPaths } from './views';
import { knowledgeLinks, safeSourceUrl } from './client-state';
import { context, fixtureServices, node, relation, snapshot } from './test-support';
import type { NodeDetail } from './api';

describe('R11 detail API and accessible text views', () => {
  const data = snapshot([node(), node('n2'), node('secret', { workspaceId: 'other' })], { relations: [relation('edge', 'n1', 'n2'), relation('hidden', 'n1', 'secret')] });
  function app() { const a = new Hono(); registerRoutes(a, fixtureServices({ snapshot: async () => ({ ok: true, data }) })); return a; }
  it('returns pinned originals and complete accessible relationship metadata', async () => {
    const response = await app().request('/api/retrieval/nodes/n1?revision=fixture-r1&snapshotRevision=fixture-r1');
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.data.node.humanStatement).toBe('Cache immutable data.');
    expect(body.data.relations.map((r: { relation: { id: string } }) => r.relation.id)).toEqual(['edge']);
    expect(body.data.paths[0].relationIds).toContain('edge');
    expect(JSON.stringify(body)).not.toContain('secret');
  });
  it('does not silently substitute current knowledge for a historical reference', async () => {
    expect((await app().request('/api/retrieval/nodes/n1?revision=fixture-old')).status).toBe(409);
    expect((await app().request('/api/retrieval/nodes/n1?snapshotRevision=fixture-old')).status).toBe(409);
    expect((await app().request('/api/retrieval/nodes/secret')).status).toBe(403);
    expect((await app().request('/api/retrieval/nodes/missing')).status).toBe(403);
  });
  it('rejects cancelled and unauthorized reads without exposing details', async () => {
    const a = new Hono(); const services = fixtureServices({ context: async () => ({ ok: true, data: { ...context, scopes: [] } }) }); registerRoutes(a, services);
    expect((await a.request('/api/retrieval/nodes/n1')).status).toBe(403);
    const controller = new AbortController(); controller.abort();
    expect((await app().request(new Request('http://localhost/api/retrieval/nodes/n1', { signal: controller.signal }))).status).toBe(409);
  });
  it('renders semantic buttons, long titles and escaped untrusted source content without a graph', async () => {
    const response = await app().request('/api/retrieval/nodes/n1');
    const detail = (await response.json()).data as NodeDetail;
    detail.node.title = 'LongTitle'.repeat(50);
    detail.node.humanStatement = '<script>alert("private")</script>';
    const html = renderToStaticMarkup(createElement(NodeDetails, { detail, taskId: 'task-1', onSelect: () => {} }));
    expect(html).toContain('LongTitle'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('来源'); expect(html).toContain('fixture-r1'); expect(html).toContain('depends_on');
    expect(html).toContain('type="button"');
    const paths = renderToStaticMarkup(createElement(TextPaths, { paths: detail.paths, nodes: [detail.node, ...detail.neighbors], selectedId: 'n1', onSelect: () => {} }));
    expect(paths).toContain('aria-pressed="true"'); expect(paths).toContain('edge');
  });
  it('never places private text in cross-window links or unsafe source URLs in anchors', () => {
    const links = knowledgeLinks('t / 1', node());
    expect(links.learning).toBe('#learning?taskId=t+%2F+1&nodeId=n1&revision=fixture-r1');
    expect(JSON.stringify(links)).not.toContain('Cache');
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeSourceUrl('https://name:password@example.com')).toBeNull();
    expect(safeSourceUrl('https://example.com/issue/12')).toBe('https://example.com/issue/12');
  });
  it('provides a direct source action when an authorized original Issue URL exists', async () => {
    const detail = (await (await app().request('/api/retrieval/nodes/n1')).json()).data as NodeDetail;
    detail.node.sources[0] = { ...detail.node.sources[0]!, kind: 'conversation', url: 'https://example.com/issues/12' };
    const html = renderToStaticMarkup(createElement(NodeDetails, { detail, taskId: 'task-1', onSelect: () => {} }));
    expect(html).toContain('href="https://example.com/issues/12"'); expect(html).toContain('打开原 Issue / 来源');
  });
  it('does not hand stale or edited-query results to learning while keeping the original-version revision link', async () => {
    const detail = (await (await app().request('/api/retrieval/nodes/n1')).json()).data as NodeDetail;
    const html = renderToStaticMarkup(createElement(NodeDetails, { detail, taskId: 'task-1', canRecordUse: false, onSelect: () => {} }));
    expect(html).not.toContain('#learning'); expect(html).toContain('#governance?nodeId=n1');
    expect(html).toContain('采用记录待本次检索确认');
  });
});
