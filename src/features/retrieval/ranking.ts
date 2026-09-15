import type { KnowledgeNode, TaskContext } from '../../contracts/domain';
import { missingFor } from './conditions';
import { compareId, type Seed } from './recall';

export const evidenceLabels = { supported: '来源支持', partial: '部分支持', unverified: '尚未核实', disputed: '存在争议' } as const;
const evidenceOrder = { supported: 0, partial: 1, unverified: 2, disputed: 3 } as const;
export function supportingSources(node: KnowledgeNode) {
  return node.sources.filter((s) => s.kind !== 'ai_inference' && s.support === 'supports' &&
    s.excerpt.trim() && s.supportedClaim === node.humanStatement);
}
export function sourceGaps(node: KnowledgeNode): string[] {
  const reasons: string[] = [];
  if (node.evidenceStatus !== 'supported') reasons.push(`来源状态：${evidenceLabels[node.evidenceStatus]}。`);
  if (!supportingSources(node).length) reasons.push('缺少与当前陈述一致的直接支持来源；人的确认不等于来源支持。');
  return reasons;
}
export function orderSeeds(seeds: Seed[], task: TaskContext): Seed[] {
  const tier = (n: KnowledgeNode) => Number(n.lifecycle !== 'active' || missingFor(n, task).length > 0 || n.boundaries.length > 0 || sourceGaps(n).length > 0);
  return [...seeds].sort((a, b) => tier(a.node) - tier(b.node) || evidenceOrder[a.node.evidenceStatus] - evidenceOrder[b.node.evidenceStatus] || b.score - a.score || compareId(a.node.id, b.node.id));
}
export function nodeOrder(seeds: Seed[]) {
  const scores = new Map(seeds.map((s) => [s.node.id, s.score]));
  return (a: KnowledgeNode, b: KnowledgeNode) => evidenceOrder[a.evidenceStatus] - evidenceOrder[b.evidenceStatus] || (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || compareId(a.id, b.id) || compareId(a.revision, b.revision);
}
