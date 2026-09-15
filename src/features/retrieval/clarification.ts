import type { RetrievalResult, TaskContext } from '../../contracts/domain';
import { assessConditions } from './conditions';
import { sourceGaps } from './ranking';

export function clarificationFor(result: RetrievalResult, task: TaskContext, skipped = false): { nodeId: string; id: string; text: string } | null {
  if (skipped) return null;
  const gaps = new Set(result.missingConditions);
  for (const node of result.groups.conditional) {
    if (node.lifecycle !== 'active' || node.boundaries.length || sourceGaps(node).length) continue;
    const conditions = assessConditions(node, task);
    if (conditions.some((c) => c.status === 'not_satisfied')) continue;
    const condition = conditions.find((c) => c.status === 'unknown' && gaps.has(c.text));
    if (condition) return { nodeId: node.id, id: condition.id, text: condition.text };
  }
  return null;
}
