import { z } from 'zod';
import { Id, Mode } from './domain';
import { contentHash } from './hash';

export const WorkspaceSessionSchema = z.object({
  actorId: Id,
  workspace: z.object({ id: Id, slug: z.string().min(1).max(240), visibility: z.enum(['private', 'public']), mode: Mode }).strict(),
  scopes: z.array(z.string().min(1).max(80)).max(100),
}).strict();
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;

export const SESSION_BINDING_HEADER = 'X-Zhangduo-Session-Binding';
export function sessionBindingPayload(session: Pick<WorkspaceSession, 'actorId' | 'workspace'> & { scopes: readonly string[] }) {
  const { id, slug, visibility, mode } = session.workspace;
  return { actorId: session.actorId, workspace: { id, slug, visibility, mode }, scopes: [...session.scopes].sort() };
}
export const workspaceSessionBinding = (session: WorkspaceSession) => contentHash(sessionBindingPayload(session));
