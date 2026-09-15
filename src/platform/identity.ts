import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RequestContext, Result } from '../contracts/api';
import type { Workspace } from '../contracts/domain';
import { failure } from './result';
import { canonicalJson } from '../contracts/hash';
import { SESSION_BINDING_HEADER, sessionBindingPayload } from '../contracts/session';

interface Binding { actorId: string; workspace: Workspace; scopes: readonly string[] }
interface Session { binding: Binding; expiresAt: number; revoked: boolean }
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

// Only trusted server bootstrap may issue a session; no public identity-minting route.
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly contexts = new WeakMap<RequestContext, Session>();

  constructor(private readonly now: () => number = Date.now, private readonly connectionGuard?: () => Result<true>) {}

  private connected(): Result<true> {
    const result = this.connectionGuard?.() ?? { ok: true as const, data: true as const };
    if (!result.ok) this.revokeAll();
    return result;
  }

  issue(binding: Binding, ttlMs = 3_600_000): string {
    if (!binding.actorId || !binding.workspace.id || binding.workspace.mode === 'unconfigured' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000) throw new Error('Invalid trusted session configuration');
    for (const [key, session] of this.sessions) if (session.revoked || session.expiresAt <= this.now()) this.sessions.delete(key);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(tokenHash(token), { binding: structuredClone(binding), expiresAt: this.now() + ttlMs, revoked: false });
    return token;
  }

  revoke(token: string): void {
    const session = this.sessions.get(tokenHash(token));
    if (session) session.revoked = true;
  }

  revokeAll(): void {
    for (const session of this.sessions.values()) session.revoked = true;
    this.sessions.clear();
  }

  context(request: Request): Result<RequestContext> {
    const connected = this.connected(); if (!connected.ok) return connected;
    if (request.signal.aborted) return failure('FORBIDDEN', 'Request cancelled', 'none');
    const cookies = (request.headers.get('Cookie') || '').split(';').map((item) => item.trim()).filter((item) => item.startsWith('zhangduo_session='));
    const authorization = request.headers.get('Authorization');
    if (cookies.length > 1 || (cookies.length && authorization)) return failure('UNAUTHORIZED', 'Ambiguous session credentials', 'sign_in');
    const token = cookies[0]?.slice('zhangduo_session='.length) || (authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return failure('UNAUTHORIZED', 'A trusted session is required', 'sign_in');
    const session = this.sessions.get(tokenHash(token));
    if (!session || session.revoked || session.expiresAt <= this.now()) return failure('UNAUTHORIZED', 'Session expired or revoked', 'sign_in');
    const { actorId, workspace, scopes } = session.binding;
    const expectedBinding = request.headers.get(SESSION_BINDING_HEADER);
    if (expectedBinding !== null && (!/^[a-f0-9]{64}$/.test(expectedBinding)
      || expectedBinding !== createHash('sha256').update(canonicalJson(sessionBindingPayload(session.binding))).digest('hex'))) {
      return failure('FORBIDDEN', 'The page belongs to a different workspace session', 'verify_workspace_session');
    }
    if ((request.headers.has('X-Workspace') && request.headers.get('X-Workspace') !== workspace.id)
      || (request.headers.has('X-Actor') && request.headers.get('X-Actor') !== actorId)) return failure('FORBIDDEN', 'Identity or workspace mismatch', 'select_authorized_workspace');
    const context: RequestContext = Object.freeze({ requestId: randomUUID(), actorId, workspaceId: workspace.id, mode: workspace.mode, scopes: Object.freeze([...scopes]) });
    this.contexts.set(context, session);
    return { ok: true, data: context };
  }

  authorize(ctx: RequestContext, scope: string): Result<Workspace> {
    const connected = this.connected(); if (!connected.ok) return connected;
    const session = this.contexts.get(ctx);
    if (!session) return failure('FORBIDDEN', 'Untrusted request context', 'sign_in');
    if (session.revoked || session.expiresAt <= this.now()) return failure('UNAUTHORIZED', 'Session expired or revoked', 'sign_in');
    if (!session.binding.scopes.includes(scope)) return failure('FORBIDDEN', 'Required permission is missing', 'request_minimum_scope');
    return { ok: true, data: structuredClone(session.binding.workspace) };
  }
}
