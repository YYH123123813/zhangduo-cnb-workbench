import { Graph, layout, type GraphLabel, type NodeLabel, type EdgeLabel } from '@dagrejs/dagre';
import type { LocalGraphData } from './api';
import { compareId } from './recall';

export interface GraphLayout {
  engine: 'dagre'; width: number; height: number;
  nodes: { id: string; x: number; y: number; width: number; height: number }[];
  edges: { id: string; x: number; y: number; points: { x: number; y: number }[] }[];
}
export function layoutGraph(data: LocalGraphData, runLayout: typeof layout = layout): GraphLayout | null {
  if (!data.nodes.length || data.nodes.length > 15 || data.relations.length > 200 || new Set(data.nodes.map((n) => n.id)).size !== data.nodes.length) return null;
  try {
    const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
    graph.setGraph({ rankdir: 'TB', ranksep: 64, nodesep: 30, marginx: 18, marginy: 18 });
    const nodes = [...data.nodes].sort((a, b) => compareId(a.id, b.id));
    for (const n of nodes) graph.setNode(n.id, { width: 220, height: 80 });
    const relations = [...data.relations].sort((a, b) => compareId(a.id, b.id));
    for (const r of relations) {
      if (!graph.hasNode(r.source.objectId) || !graph.hasNode(r.target.objectId)) return null;
      graph.setEdge(r.source.objectId, r.target.objectId, { width: 110, height: 20, labelpos: 'c' }, r.id);
    }
    runLayout(graph);
    const output: GraphLayout = { engine: 'dagre', width: graph.graph().width!, height: graph.graph().height!,
      nodes: nodes.map((n) => { const p = graph.node(n.id); return { id: n.id, x: p.x! - p.width / 2, y: p.y! - p.height / 2, width: p.width, height: p.height }; }),
      edges: relations.map((r) => { const p = graph.edge({ v: r.source.objectId, w: r.target.objectId, name: r.id }); return { id: r.id, x: p.x!, y: p.y!, points: p.points ?? [] }; }),
    };
    if (![output.width, output.height].every((n) => Number.isFinite(n) && n > 0) || output.width > 20000 || output.height > 20000 ||
      output.nodes.some((n) => ![n.x, n.y, n.width, n.height].every(Number.isFinite)) ||
      output.edges.some((e) => ![e.x, e.y].every(Number.isFinite) || e.points.length < 2 || e.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return null;
    return output;
  } catch { return null; }
}
