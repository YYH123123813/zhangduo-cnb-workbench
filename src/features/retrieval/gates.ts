import type { KnowledgeNode, Relation } from '../../contracts/domain';
import type { Expansion } from './graph';
import { propagatePremises } from './conditions';
import { compareId } from './recall';

export function riskGates(expansion: Expansion, available: KnowledgeNode[], relations: Relation[], reasons: Map<string, string[]>, excludedIds: string[]) {
  const conflicts = new Set<string>(); const warnings: string[] = [];
  const nodes = new Map(available.map((n) => [n.id, n]));
  const excluded = new Set(excludedIds);
  const add = (id: string, reason: string) => { const list = reasons.get(id); if (list && !list.includes(reason)) list.push(reason); };
  const valid = relations.filter((r) => r.state === 'confirmed' && !excluded.has(r.id) &&
    nodes.get(r.source.objectId)?.workspaceId === r.workspaceId && nodes.get(r.target.objectId)?.workspaceId === r.workspaceId &&
    nodes.get(r.source.objectId)?.revision === r.source.revision && nodes.get(r.target.objectId)?.revision === r.target.revision)
    .sort((a, b) => compareId(a.id, b.id));
  // Inspect all incident safety edges before applying display or relevance limits.
  for (const edge of valid) {
    const source = edge.source.objectId; const target = edge.target.objectId;
    if (edge.type === 'contradicts') {
      for (const [id, other] of [[source, target], [target, source]] as const) {
        if (!reasons.has(id)) continue;
        conflicts.add(id);
        add(id, reasons.has(other) ? `与 ${other} 存在未解决冲突。` : '存在未展示的冲突节点；结果上限不能视为冲突已解决。');
      }
    }
    if (edge.type === 'supersedes') add(target, reasons.has(source) ? `已被 ${source} 的当前版本替代；原文仅供核对。` : '存在尚未展示的替代版本，原文不能作为当前结论。');
    if (edge.type === 'depends_on' && reasons.has(source) && !reasons.has(target)) add(source, '必要前提超出当前检查范围。');
  }
  for (const n of expansion.nodes) {
    if (n.lifecycle === 'needs_review') add(n.id, '知识正在等待复核。');
    if (n.lifecycle === 'superseded') add(n.id, '知识已被替代，仅保留原文。');
    if (n.evidenceStatus === 'disputed') { conflicts.add(n.id); add(n.id, '来源支持存在争议。'); }
  }
  for (const id of expansion.incompleteIds) add(id, '关系版本失效、邻居不可读取或检查未覆盖，不能视为前提成立。');
  if (expansion.truncated) {
    warnings.push('关系检查达到节点、跳数或边预算上限，未检查部分仍是缺口。');
    for (const id of reasons.keys()) add(id, '当前检查预算未覆盖全部必要关系。');
  }
  for (const type of ['depends_on', 'supersedes'] as const) {
    const adjacency = new Map<string, string[]>();
    for (const edge of valid) if (edge.type === type && reasons.has(edge.source.objectId) && reasons.has(edge.target.objectId)) {
      adjacency.set(edge.source.objectId, [...(adjacency.get(edge.source.objectId) ?? []), edge.target.objectId]);
    }
    for (const id of reasons.keys()) {
      const queue = [...(adjacency.get(id) ?? [])]; const seen = new Set<string>();
      while (queue.length) {
        const next = queue.pop()!;
        if (next === id) { add(id, type === 'depends_on' ? '存在循环依赖，路径不能自行证明前提。' : '存在循环替代，当前有效版本需要人工判断。'); break; }
        if (seen.has(next)) continue;
        seen.add(next); queue.push(...(adjacency.get(next) ?? []));
      }
    }
  }
  propagatePremises(reasons, valid);
  if (conflicts.size) warnings.push('存在未解决冲突，系统没有自动裁定哪一方正确。');
  return { conflicts, warnings };
}
