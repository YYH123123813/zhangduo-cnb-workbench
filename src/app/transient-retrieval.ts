import { TaskContextSchema, type RetrievalResult, type TaskContext } from '../contracts/domain';
import type { WorkspaceSession } from '../contracts/session';

export const sessionKey = (session: WorkspaceSession | null) => session ? JSON.stringify([session.actorId, session.workspace.id, session.workspace.slug, session.workspace.mode, session.workspace.visibility, [...session.scopes].sort()]) : 'unconfigured';
export class TransientRetrieval {
  private identity: WorkspaceSession | null = null;
  private task?: TaskContext;
  private result?: RetrievalResult;
  private expiresAt = 0;
  constructor(private readonly now = Date.now) {}
  bind(session: WorkspaceSession | null) {
    if (sessionKey(session) !== sessionKey(this.identity) || !session) { this.task = undefined; this.result = undefined; this.expiresAt = 0; }
    this.identity = session ? structuredClone(session) : null;
  }
  accept(task: TaskContext, result: RetrievalResult): boolean {
    try {
      const parsed = TaskContextSchema.safeParse(task);
      if (!parsed.success || !this.identity || !this.identity.scopes.includes('knowledge:read') || task.workspaceId !== this.identity.workspace.id) return false;
      const nodes = [...result.groups.eligible, ...result.groups.conditional, ...result.groups.conflicts];
      if (nodes.some((node) => node.workspaceId !== task.workspaceId || result.groups.excludedIds.includes(node.id))
        || result.answer?.citations.some((citation) => citation.nodeRef.workspaceId !== task.workspaceId) || !result.queryId || !result.snapshotRevision
        || JSON.stringify({ task, result }).length > 1_000_000) return false;
      this.task = structuredClone(task); this.result = structuredClone(result); this.expiresAt = this.now() + 30 * 60_000;
      return true;
    } catch { return false; }
  }
  invalidate() { this.result = undefined; }
  private expire() { if (this.now() >= this.expiresAt) { this.task = undefined; this.result = undefined; } }
  taskFor(id?: string) {
    this.expire(); return this.task && (!id || id === this.task.id) ? structuredClone(this.task) : undefined;
  }
  forLearning(params: Readonly<Record<string, string>>) {
    this.expire();
    if (!this.task || !this.result || (params.taskId && params.taskId !== this.task.id) || (params.queryId && params.queryId !== this.result.queryId)) return undefined;
    const nodes = [...this.result.groups.eligible, ...this.result.groups.conditional, ...this.result.groups.conflicts];
    if (params.nodeId && !nodes.some((node) => node.id === params.nodeId && (!params.revision || params.revision === node.revision))) return undefined;
    if (!params.nodeId && params.revision && params.revision !== this.result.snapshotRevision) return undefined;
    return structuredClone({ task: this.task, result: this.result });
  }
}
