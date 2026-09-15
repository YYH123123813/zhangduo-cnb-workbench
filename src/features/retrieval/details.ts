import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import type { KnowledgeSnapshot } from '../../contracts/domain';
import { failure, type LocalGraphData, type NodeDetail } from './api';
import { authorizedView, readSnapshot } from './snapshot';
import { compareId } from './recall';
import { expandGraph } from './graph';

export async function readNodeDetail(ctx: RequestContext, services: Services, id: string, revision?: string, snapshotRevision?: string): Promise<Result<NodeDetail>> {
  const saved = await readSnapshot(ctx, services); if (!saved.ok) return saved;
  return describeNodeDetail(ctx, saved.data, id, revision, snapshotRevision);
}

export function describeNodeDetail(ctx: RequestContext, snapshot: KnowledgeSnapshot, id: string, revision?: string, snapshotRevision?: string): Result<NodeDetail> {
  const visible = authorizedView(snapshot, ctx).nodes;
  const byId = new Map(visible.map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) return failure('FORBIDDEN', '当前范围内没有可读取的正式知识。', 'check_permissions');
  if ((revision && revision !== node.revision) || (snapshotRevision && snapshotRevision !== snapshot.revision)) return failure('CONFLICT', '请求的版本不再是当前版本，未替换历史引用。', 'refresh_snapshot');
  const excluded = new Set(snapshot.excludedIds);
  const relations: NodeDetail['relations'] = [];
  const neighbors = new Map<string, NodeDetail['neighbors'][number]>();
  let omitted = false;
  for (const edge of [...snapshot.relations].sort((a, b) => compareId(a.id, b.id))) {
    if (edge.workspaceId !== ctx.workspaceId || (edge.source.objectId !== id && edge.target.objectId !== id)) continue;
    const source = byId.get(edge.source.objectId); const target = byId.get(edge.target.objectId);
    if (excluded.has(edge.id) || !source || !target) { omitted = true; continue; }
    const current = source.revision === edge.source.revision && target.revision === edge.target.revision;
    const usable = current && edge.state === 'confirmed';
    relations.push({ relation: edge, usable, reason: !current ? '端点版本已变化，不参与当前检索。' : !usable ? `关系状态 ${edge.state}，不参与当前检索。` : '已确认且端点版本一致；关系不等于逻辑证明。' });
    for (const n of [source, target]) if (n.id !== id) neighbors.set(n.id, { id: n.id, title: n.title, revision: n.revision });
  }
  const warnings = omitted ? ['部分关系因检索排除、状态或读取范围未展示，不代表不存在相关关系。'] : [];
  if (node.lifecycle !== 'active') warnings.push(`当前知识状态为 ${node.lifecycle}，原文不等于当前可采用结论。`);
  const paths = relations.filter((entry) => entry.usable).map(({ relation: r }) => ({ seedId: id, relationIds: [r.id],
    nodeIds: [id, r.source.objectId === id ? r.target.objectId : r.source.objectId],
    reason: `${r.source.objectId} ${r.type} ${r.target.objectId}；依据：${r.rationale}；路径不等于逻辑证明。` }));
  return { ok: true, data: { node, snapshotRevision: snapshot.revision, neighbors: [...neighbors.values()], relations, paths, warnings } };
}

export async function readLocalGraph(ctx: RequestContext, services: Services, id: string, depth: number, revision?: string, snapshotRevision?: string): Promise<Result<LocalGraphData>> {
  const saved = await readSnapshot(ctx, services); if (!saved.ok) return saved;
  const snapshot = saved.data; const nodes = authorizedView(snapshot, ctx).nodes;
  const root = nodes.find((n) => n.id === id);
  if (!root) return failure('FORBIDDEN', '当前范围内没有可读取的正式知识。', 'check_permissions');
  if ((revision && root.revision !== revision) || (snapshotRevision && snapshot.revision !== snapshotRevision)) return failure('CONFLICT', '局部图版本已变化。', 'refresh_snapshot');
  const graph = expandGraph(nodes, snapshot.relations, [{ node: root, score: 1, reason: '当前选定的正式知识' }], { maxDepth: depth, maxNodes: 15, maxEdges: 100, excludedIds: snapshot.excludedIds });
  const selected = new Map(graph.nodes.map((n) => [n.id, n]));
  const connected = snapshot.relations.filter((r) => r.state === 'confirmed' && r.workspaceId === ctx.workspaceId && !snapshot.excludedIds.includes(r.id) &&
    selected.get(r.source.objectId)?.revision === r.source.revision && selected.get(r.target.objectId)?.revision === r.target.revision).sort((a, b) => compareId(a.id, b.id));
  // Keep every traversed path, then fill the remaining display budget with incident edges.
  const kept = new Map(graph.relations.map((r) => [r.id, r]));
  for (const r of connected) if (kept.size < 100 && !kept.has(r.id)) kept.set(r.id, r);
  const relations = [...kept.values()].sort((a, b) => compareId(a.id, b.id));
  const represented = new Set(graph.paths.flatMap((p) => p.relationIds));
  const paths = [...graph.paths, ...relations.filter((r) => !represented.has(r.id)).map((r) => ({
    seedId: r.source.objectId, nodeIds: [r.source.objectId, r.target.objectId], relationIds: [r.id],
    reason: `${r.source.objectId} ${r.type} ${r.target.objectId}；依据：${r.rationale}；局部关系或循环不等于逻辑证明。`,
  }))];
  const truncated = graph.truncated || connected.length > relations.length;
  const warnings = truncated || graph.incompleteIds.length ? ['局部图范围有限，存在未展示或未通过版本检查的关系；不能据此认为检查完整。'] : [];
  return { ok: true, data: { rootId: root.id, depth, snapshotRevision: snapshot.revision, nodes: graph.nodes, relations,
    paths, truncated, warnings } };
}
