import { TaskConditionCheckSchema, type KnowledgeNode, type Relation, type TaskContext } from '../../contracts/domain';

export interface ConditionAssessment { id: string; text: string; status: 'satisfied' | 'not_satisfied' | 'unknown' }
export function assessConditions(node: KnowledgeNode, task: TaskContext): ConditionAssessment[] {
  return node.conditions.map((condition) => {
    const matches = (task.conditionChecks ?? []).filter((check) => check.nodeRef.workspaceId === node.workspaceId &&
      check.nodeRef.objectId === node.id && check.nodeRef.revision === node.revision && check.conditionId === condition.id);
    const check = matches.length === 1 ? TaskConditionCheckSchema.safeParse(matches[0]) : null;
    return { id: condition.id, text: condition.text,
      status: condition.status === 'rejected' ? 'not_satisfied' : check?.success ? check.data.status : 'unknown' };
  });
}

export function missingFor(node: KnowledgeNode, task: TaskContext): string[] {
  return assessConditions(node, task).filter((c) => c.status !== 'satisfied')
    .map((c) => c.status === 'not_satisfied' ? `条件不满足（${node.id} / ${c.id}）：${c.text}` : c.text);
}
export function propagatePremises(reasons: Map<string, string[]>, relations: Relation[]): void {
  // A bounded fixed point propagates gaps, never truth, through dependency cycles.
  for (let pass = 0; pass < reasons.size; pass++) {
    let changed = false;
    for (const edge of relations) {
      if (edge.type !== 'depends_on' || edge.state !== 'confirmed') continue;
      const own = reasons.get(edge.source.objectId); const premise = reasons.get(edge.target.objectId);
      if (!own || !premise?.length) continue;
      const reason = `前提 ${edge.target.objectId} 的适用性或依据尚未通过检查。`;
      if (!own.includes(reason)) { own.push(reason); changed = true; }
    }
    if (!changed) break;
  }
}
export function applicability(nodes: KnowledgeNode[], relations: Relation[], task: TaskContext): Map<string, string[]> {
  const reasons = new Map(nodes.map((n) => [n.id, [...missingFor(n, task), ...n.boundaries.map((b) => `适用边界待核对：${b}`)]]));
  propagatePremises(reasons, relations);
  return reasons;
}
