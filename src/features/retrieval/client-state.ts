import { TaskConditionCheckSchema, type KnowledgeNode, type RetrievalResult, type TaskContext, type TaskConditionCheck } from '../../contracts/domain';
import type { ApiError } from '../../contracts/api';
import type { LeaveGuard } from '../../contracts/navigation';
import { canonicalJson } from '../../contracts/hash';
import type { NodeDetail } from './api';

type QueryDraft = Pick<TaskContext, 'question' | 'constraints' | 'conditionChecks'>;
export function queryLeaveState(current: QueryDraft, submitted: QueryDraft, operation: 'clean' | 'blocked', pendingCondition = false): ReturnType<LeaveGuard['getState']> {
  if (operation === 'blocked') return 'blocked';
  if (pendingCondition) return 'dirty';
  const projection = (draft: QueryDraft) => ({ question: draft.question.trim(), constraints: draft.constraints.map((c) => ({ id: c.id, text: c.text.trim(), confirmedBy: c.confirmedBy ?? null })),
    conditionChecks: draft.conditionChecks ?? [] });
  return canonicalJson(projection(current)) === canonicalJson(projection(submitted)) ? 'clean' : 'dirty';
}
export function canRecordDetail(result: RetrievalResult | null, detail: NodeDetail, stale: boolean): boolean {
  return Boolean(result && !stale && !detail.history && result.snapshotRevision === detail.snapshotRevision && !result.groups.excludedIds.includes(detail.node.id) &&
    [...result.groups.eligible, ...result.groups.conditional, ...result.groups.conflicts].some((n) =>
      n.id === detail.node.id && n.revision === detail.node.revision && n.workspaceId === detail.node.workspaceId));
}

export function sameTaskIdentity(current: { id: string; workspaceId?: string }, next: TaskContext): boolean {
  return current.id === next.id && current.workspaceId === next.workspaceId;
}

export function queryTask(task: TaskContext | undefined, id: string, workspaceId: string, question: string,
  constraints: TaskContext['constraints'], updatedAt: string, conditionChecks = task?.conditionChecks): TaskContext {
  // Reading existing knowledge is assistance even when model generation is disabled.
  return { ...(task ?? { id, workspaceId }), question: question.trim(), mode: 'assisted', updatedAt,
    ...(conditionChecks ? { conditionChecks: structuredClone(conditionChecks) } : {}),
    constraints: constraints.filter((c) => c.text.trim()).map((c) => ({ ...c, text: c.text.trim() })) };
}

export function updateConditionCheck(checks: TaskConditionCheck[], node: KnowledgeNode, conditionId: string,
  status: TaskConditionCheck['status'], actorId: string): TaskConditionCheck[] | null {
  if (!node.conditions.some((condition) => condition.id === conditionId)) return null;
  const check = TaskConditionCheckSchema.safeParse({ nodeRef: { workspaceId: node.workspaceId, objectId: node.id, revision: node.revision },
    conditionId, status, ...(status === 'unknown' ? {} : { confirmedBy: actorId }) });
  if (!check.success) return null;
  const others = checks.filter((item) => item.nodeRef.workspaceId !== node.workspaceId || item.nodeRef.objectId !== node.id || item.conditionId !== conditionId);
  return others.length >= 200 ? null : structuredClone([...others, check.data]);
}

export function knowledgeLinks(taskId: string, node: KnowledgeNode) {
  return {
    learning: `#learning?${new URLSearchParams({ taskId, nodeId: node.id, revision: node.revision })}`,
    governance: `#governance?${new URLSearchParams({ nodeId: node.id, revision: node.revision })}`,
    handoff: `#handoff?${new URLSearchParams({ conversationId: node.conversationId })}`,
  };
}
export function safeSourceUrl(value?: string): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function latestRead() {
  let current: AbortController | null = null;
  return {
    start() { current?.abort(); current = new AbortController(); return current.signal; },
    cancel() { current?.abort(); current = null; },
    active(signal: AbortSignal) { return current?.signal === signal && !signal.aborted; },
  };
}
export function contentReads() {
  const query = latestRead(); const detail = latestRead(); const graph = latestRead(); const answer = latestRead();
  const cancel = () => { query.cancel(); detail.cancel(); graph.cancel(); answer.cancel(); };
  return { query, detail, graph, answer, cancel, reject(error: ApiError) {
    if (!['UNAUTHORIZED', 'FORBIDDEN', 'NOT_CONFIGURED'].includes(error.code)) return false;
    cancel(); return true;
  } };
}

export async function modelFailure(error: ApiError, recheckKnowledge: () => Promise<void>, onReadFailure: (error: ApiError) => void) {
  if (error.code === 'FORBIDDEN' || error.code === 'NOT_CONFIGURED') await recheckKnowledge();
  else onReadFailure(error);
}
