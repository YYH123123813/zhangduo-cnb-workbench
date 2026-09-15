import type { KnowledgeNode, Relation, RetrievalResult } from '../../contracts/domain';
import { compareId, type Seed } from './recall';

export interface Expansion {
  nodes: KnowledgeNode[]; relations: Relation[]; paths: RetrievalResult['paths'];
  incompleteIds: string[]; truncated: boolean;
}
export interface ExpansionOptions { maxDepth?: number; maxNodes?: number; maxEdges?: number; excludedIds?: string[] }
export function nextFrom(edge: Relation, id: string): string | null {
  if (edge.type === 'depends_on') return edge.source.objectId === id ? edge.target.objectId : null;
  if (edge.type === 'contradicts') return edge.source.objectId === id ? edge.target.objectId : edge.target.objectId === id ? edge.source.objectId : null;
  return edge.target.objectId === id ? edge.source.objectId : null;
}

export function expandGraph(nodes: KnowledgeNode[], relations: Relation[], seeds: Seed[], options: ExpansionOptions = {}): Expansion {
  const maxDepth = Math.max(0, Math.min(2, options.maxDepth ?? 2));
  const maxNodes = Math.max(1, Math.min(60, options.maxNodes ?? 60));
  const maxEdges = Math.max(1, Math.min(400, options.maxEdges ?? 200));
  const workspaceId = seeds[0]?.node.workspaceId;
  const excluded = new Set(options.excludedIds ?? []);
  const available = new Map(nodes.filter((n) => n.workspaceId === workspaceId && n.confirmation === 'confirmed' && n.lifecycle !== 'withdrawn' && !excluded.has(n.id)).map((n) => [n.id, n]));
  const valid: Relation[] = [];
  const incomplete = new Set<string>();
  for (const edge of [...relations].sort((a, b) => compareId(a.id, b.id))) {
    if (edge.state !== 'confirmed' || edge.workspaceId !== workspaceId || excluded.has(edge.id)) continue;
    if (edge.source.workspaceId !== workspaceId || edge.target.workspaceId !== workspaceId) continue;
    const source = available.get(edge.source.objectId); const target = available.get(edge.target.objectId);
    if (!source || !target || source.revision !== edge.source.revision || target.revision !== edge.target.revision) {
      if (source) incomplete.add(source.id);
      if (target) incomplete.add(target.id);
      continue;
    }
    valid.push(edge);
  }
  const adjacency = new Map<string, Relation[]>();
  for (const edge of valid) for (const id of new Set([edge.source.objectId, edge.target.objectId])) {
    if (nextFrom(edge, id) !== null) adjacency.set(id, [...(adjacency.get(id) ?? []), edge]);
  }
  const selected = new Map<string, KnowledgeNode>();
  const selectedEdges = new Map<string, Relation>();
  const paths: RetrievalResult['paths'] = [];
  const queue: { id: string; depth: number; path: RetrievalResult['paths'][number] }[] = [];
  let truncated = false;
  for (const seed of seeds) {
    const node = available.get(seed.node.id);
    if (!node || selected.has(node.id)) continue;
    if (selected.size >= maxNodes) { truncated = true; continue; }
    const path = { seedId: node.id, nodeIds: [node.id], relationIds: [], reason: seed.reason };
    selected.set(node.id, node); paths.push(path); queue.push({ id: node.id, depth: 0, path });
  }
  let checks = 0;
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index]!;
    for (const edge of adjacency.get(item.id) ?? []) {
      const nextId = nextFrom(edge, item.id)!;
      if (item.depth >= maxDepth || ++checks > maxEdges) {
        if (!selected.has(nextId) || checks > maxEdges) { incomplete.add(item.id); truncated = true; }
        continue;
      }
      if (!selected.has(nextId) && selected.size >= maxNodes) { incomplete.add(item.id); truncated = true; continue; }
      selectedEdges.set(edge.id, edge);
      if (item.path.nodeIds.includes(nextId)) continue;
      const path = { seedId: item.path.seedId, nodeIds: [...item.path.nodeIds, nextId], relationIds: [...item.path.relationIds, edge.id],
        reason: `${item.path.reason} 路径：${edge.source.objectId} ${edge.type} ${edge.target.objectId}；关系依据：${edge.rationale}。路径不等于逻辑证明。` };
      if (paths.length < maxEdges + maxNodes) paths.push(path);
      else { truncated = true; incomplete.add(item.id); }
      if (!selected.has(nextId)) {
        selected.set(nextId, available.get(nextId)!);
        queue.push({ id: nextId, depth: item.depth + 1, path });
      }
    }
  }
  return { nodes: [...selected.values()], relations: [...selectedEdges.values()], paths,
    incompleteIds: [...incomplete].filter((id) => selected.has(id)).sort(compareId), truncated };
}
