import type { Result } from './api';
import { TaskContextSchema, type KnowledgeSnapshot, type TaskContext } from './domain';

// Call with the actor and snapshot obtained from the trusted Services context, after authorization.
export function validateTaskContext(input: unknown, snapshot: KnowledgeSnapshot, actorId: string): Result<TaskContext> {
  const reject = (code: 'VALIDATION' | 'FORBIDDEN' | 'CONFLICT', message: string): Result<TaskContext> => ({ ok: false,
    error: { code, message, retryable: false, dataState: 'preserved', nextAction: 'review_task_conditions' } });
  const parsed = TaskContextSchema.safeParse(input);
  if (!parsed.success) return reject('VALIDATION', 'Task conditions require unique fixed-version bindings and explicit attribution');
  const task = parsed.data;
  if (task.workspaceId !== snapshot.workspaceId || task.constraints.some((condition) => condition.confirmedBy && condition.confirmedBy !== actorId))
    return reject('FORBIDDEN', 'Task workspace or premise attribution differs from the current identity');
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node])), excluded = new Set(snapshot.excludedIds);
  for (const check of task.conditionChecks ?? []) {
    if (check.nodeRef.workspaceId !== task.workspaceId || (check.confirmedBy && check.confirmedBy !== actorId)) return reject('FORBIDDEN', 'A task check cannot impersonate another actor or workspace');
    const node = nodes.get(check.nodeRef.objectId);
    if (!node || node.workspaceId !== task.workspaceId || node.confirmation !== 'confirmed' || excluded.has(node.id)) return reject('FORBIDDEN', 'The checked condition is not available in this workspace');
    if (node.revision !== check.nodeRef.revision || !node.conditions.some((condition) => condition.id === check.conditionId))
      return reject('CONFLICT', 'The exact node version or condition changed; previous task checks cannot be reused');
  }
  return { ok: true, data: task };
}
