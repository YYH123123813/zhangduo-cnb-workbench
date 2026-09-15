import type { ApiResponse, Result } from '../contracts/api';
import type { AppRoute } from '../contracts/navigation';
import type { WorkspaceSession } from '../contracts/session';
import { RecoveryAnchorInputSchema, RecoveryAnchorReadSchema, RecoveryAnchorSchema, type RecoveryAnchor, type RecoveryAnchorInput, type RecoveryAnchorRead } from '../contracts/recovery-anchor';
import { sessionKey } from './transient-retrieval';

export interface RecoveryDelivery { sessionKey: string; value: RecoveryAnchorRead }
export function hasRecoveryIntent(route: AppRoute): boolean {
  return ['retrieval', 'learning'].includes(route.page) && /^[a-f0-9]{64}$/.test(route.params.recoveryId ?? '');
}
export function recoveryForRoute(delivery: RecoveryDelivery | null, session: WorkspaceSession | null, verified: boolean, route: AppRoute): RecoveryAnchorRead | null {
  if (!delivery || !verified || !session || !hasRecoveryIntent(route) || delivery.sessionKey !== sessionKey(session)) return null;
  const value = delivery.value;
  return value.identity.id === route.params.recoveryId && value.identity.feature === route.page && belongs(value.identity, session) ? value : null;
}

const unknown = <T>(): Result<T> => ({ ok: false, error: { code: 'UNKNOWN_RESULT', message: '原操作身份未能核验，未自动重试。', retryable: false, dataState: 'unknown', nextAction: 'read_original_operation' } });
function belongs(identity: RecoveryAnchor, session: WorkspaceSession) {
  return identity.actorId === session.actorId && identity.workspaceId === session.workspace.id && Date.parse(identity.expiresAt) > Date.now();
}

export async function retainRecoveryIdentity(session: WorkspaceSession, input: RecoveryAnchorInput, transport: typeof fetch = fetch): Promise<Result<RecoveryAnchor>> {
  const parsed = RecoveryAnchorInputSchema.safeParse(input); if (!parsed.success) return unknown();
  try {
    const response = await transport('/api/workspace/recovery-identities', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...parsed.data, actorId: session.actorId, workspaceId: session.workspace.id }) });
    const body = await response.json() as ApiResponse<unknown>;
    if (!body.ok || body.meta?.mode !== session.workspace.mode) return unknown();
    const anchor = RecoveryAnchorSchema.safeParse(body.data);
    if (!anchor.success || !belongs(anchor.data, session) || anchor.data.feature !== input.feature
      || JSON.stringify(anchor.data.operation) !== JSON.stringify(parsed.data.operation)
      || JSON.stringify(anchor.data.binding) !== JSON.stringify(parsed.data.binding) || anchor.data.expiresAt !== input.expiresAt) return unknown();
    return { ok: true, data: anchor.data };
  } catch { return unknown(); }
}

export async function readRecoveryIdentity(session: WorkspaceSession, route: AppRoute, transport: typeof fetch = fetch, signal?: AbortSignal): Promise<Result<RecoveryAnchorRead | null>> {
  const id = route.params.recoveryId;
  if (!id || !/^[a-f0-9]{64}$/.test(id) || !['retrieval', 'learning'].includes(route.page)) return unknown();
  try {
    const response = await transport(`/api/workspace/recovery-identities/${id}`, { method: 'GET', signal });
    const body = await response.json() as ApiResponse<unknown>;
    if (!body.ok || body.meta?.mode !== session.workspace.mode) return unknown();
    const parsed = RecoveryAnchorReadSchema.nullable().safeParse(body.data); if (!parsed.success) return unknown();
    if (parsed.data && (!belongs(parsed.data.identity, session) || parsed.data.identity.id !== id || parsed.data.identity.feature !== route.page)) return unknown();
    return { ok: true, data: parsed.data };
  } catch { return unknown(); }
}
