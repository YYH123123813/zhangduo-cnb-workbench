import { Hono } from 'hono';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { registerRoutes } from './server';
import { layoutGraph } from './layout';
import { currentGraph, graphRequestKey, GraphCanvas, GraphNodeList } from './graph-view';
import { context, fixtureServices, node, relation, snapshot } from './test-support';
import type { LocalGraphData } from './api';

describe('R12 shared local graph views', () => {
  const data = snapshot([node(), node('n2'), node('n3')], { relations: [relation('e1', 'n1', 'n2'), relation('e2', 'n2', 'n3')] });
  function app() { const a = new Hono(); registerRoutes(a, fixtureServices({ snapshot: async () => ({ ok: true, data }) })); return a; }
  it('serves one hop by default and shares the same pinned subgraph for all three views', async () => {
    const response = await app().request('/api/retrieval/graph/n1');
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.data.depth).toBe(1); expect(body.data.nodes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2']);
    expect(body.data.snapshotRevision).toBe('fixture-r1');
    const second = await app().request('/api/retrieval/graph/n1?depth=2');
    expect((await second.json()).data.nodes).toHaveLength(3);
  });
  it('enforces version, depth and permission boundaries', async () => {
    expect((await app().request('/api/retrieval/graph/n1?depth=3')).status).toBe(422);
    expect((await app().request('/api/retrieval/graph/n1?revision=old')).status).toBe(409);
    const a = new Hono(); registerRoutes(a, fixtureServices({ context: async () => ({ ok: true, data: { ...context, scopes: [] } }) }));
    expect((await a.request('/api/retrieval/graph/n1')).status).toBe(403);
  });
  it('caps returned edges as well as traversal when many parallel relations join the same nodes', async () => {
    const data = snapshot([node(), node('n2')], { relations: Array.from({ length: 250 }, (_, i) => relation(`edge-${i}`, 'n1', 'n2')) });
    const a = new Hono(); registerRoutes(a, fixtureServices({ snapshot: async () => ({ ok: true, data }) }));
    const response = await a.request('/api/retrieval/graph/n1');
    expect(response.status).toBe(200); const graph = (await response.json()).data as LocalGraphData;
    expect(graph.nodes).toHaveLength(2); expect(graph.relations.length).toBeLessThanOrEqual(100);
    expect(graph.truncated).toBe(true); expect(graph.warnings.length).toBeGreaterThan(0);
    expect(new Set(graph.paths.flatMap((p) => p.relationIds))).toEqual(new Set(graph.relations.map((r) => r.id)));
  });
  it('provides an equivalent text path for every rendered cyclic edge', async () => {
    const data = snapshot([node(), node('n2')], { relations: [
      relation('self', 'n1', 'n1'), relation('there', 'n1', 'n2'), relation('back', 'n2', 'n1'),
    ] });
    const a = new Hono(); registerRoutes(a, fixtureServices({ snapshot: async () => ({ ok: true, data }) }));
    const graph = (await (await a.request('/api/retrieval/graph/n1?depth=2')).json()).data as LocalGraphData;
    expect(graph.relations).toHaveLength(3);
    expect(new Set(graph.paths.flatMap((p) => p.relationIds))).toEqual(new Set(graph.relations.map((r) => r.id)));
    expect(graph.paths.every((p) => p.nodeIds.length === p.relationIds.length + 1)).toBe(true);
    const detail = (await (await a.request('/api/retrieval/nodes/n1')).json()).data as { paths: LocalGraphData['paths'] };
    expect(detail.paths.every((p) => p.nodeIds.length === p.relationIds.length + 1)).toBe(true);
  });
  it('uses the installed Dagre engine and produces finite, non-overlapping stable boxes', async () => {
    const graph = (await (await app().request('/api/retrieval/graph/n1?depth=2')).json()).data as LocalGraphData;
    const layout = layoutGraph(graph); expect(layout).not.toBeNull(); if (!layout) return;
    expect(layout.engine).toBe('dagre'); expect(layout.width).toBeGreaterThan(0);
    expect(layout.nodes.every((n) => [n.x, n.y, n.width, n.height].every(Number.isFinite))).toBe(true);
    for (const a of layout.nodes) for (const b of layout.nodes) if (a.id !== b.id) {
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(layoutGraph({ ...graph, nodes: [...graph.nodes].reverse(), relations: [...graph.relations].reverse() })).toEqual(layout);
    expect(layoutGraph(graph, () => { throw new Error('layout failed'); })).toBeNull();
  });
  it('keeps native keyboard selections equivalent and falls back to the same node list', async () => {
    const graph = (await (await app().request('/api/retrieval/graph/n1')).json()).data as LocalGraphData;
    graph.nodes[0]!.title = 'VeryLongTitle'.repeat(80);
    const props = { graph, selectedId: 'n1', onSelect: () => {} };
    const html = renderToStaticMarkup(createElement(GraphCanvas, { ...props, layout: layoutGraph(graph), zoom: 1 }));
    expect(html).toContain('<svg'); expect(html).toContain('aria-pressed="true"'); expect(html).toContain('VeryLongTitle');
    const fallback = renderToStaticMarkup(createElement(GraphCanvas, { ...props, layout: null, zoom: 1 }));
    expect(fallback).toContain('布局不可用'); expect(fallback).toContain('aria-pressed="true"');
    const list = renderToStaticMarkup(createElement(GraphNodeList, props));
    expect(list).toContain('n1'); expect(list).toContain('n2');
  });
  it('hides the previous graph synchronously when center, versions, depth or refresh change', async () => {
    const graph = (await (await app().request('/api/retrieval/graph/n1')).json()).data as LocalGraphData;
    const center = { id: 'n1', revision: 'fixture-r1', title: 'cache n1' };
    const key = graphRequestKey(center, 'fixture-r1', 1, 0)!; const stored = { key, data: graph };
    expect(currentGraph(stored, key)).toBe(graph);
    for (const next of [graphRequestKey(null, 'fixture-r1', 1, 0),
      graphRequestKey({ ...center, id: 'n2' }, 'fixture-r1', 1, 0),
      graphRequestKey({ ...center, revision: 'fixture-r2' }, 'fixture-r1', 1, 0),
      graphRequestKey(center, 'fixture-r2', 1, 0), graphRequestKey(center, 'fixture-r1', 2, 0), graphRequestKey(center, 'fixture-r1', 1, 1),
    ]) expect(currentGraph(stored, next)).toBeNull();
  });
});
