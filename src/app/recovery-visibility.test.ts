import { describe, expect, it } from 'vitest';
import type { AppRoute } from '../contracts/navigation';
import type { RecoveryAnchorRead } from '../contracts/recovery-anchor';
import type { WorkspaceSession } from '../contracts/session';
import { hasRecoveryIntent, recoveryForRoute } from './recovery-client';
import { sessionKey, TransientRetrieval } from './transient-retrieval';
import { PageOutlet } from './App';

const session: WorkspaceSession = { actorId: 'actor-A', workspace: { id: 'workspace-A', slug: 'fixture/recovery', mode: 'fixture', visibility: 'private' }, scopes: ['workspace:read', 'task:read'] };
const route: AppRoute = { page: 'learning', params: { recoveryId: 'a'.repeat(64) } };
const value: RecoveryAnchorRead = { identity: { id: route.params.recoveryId!, actorId: session.actorId, workspaceId: session.workspace.id,
  feature: 'learning', operation: { kind: 'task', operationId: 'original-task-save' }, binding: { requestHash: 'b'.repeat(64) },
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), readOnly: true },
  original: null, binding: 'unknown', readOnly: true, retryAllowed: false };
const delivery = { sessionKey: sessionKey(session), value };

describe('shared recovery first-render identity and route isolation', () => {
  it('preserves navigation intent for first-null recovery without treating it as trusted identity', () => {
    expect(hasRecoveryIntent(route)).toBe(true);
    expect(hasRecoveryIntent({ page: 'retrieval', params: { recoveryId: 'a'.repeat(64) } })).toBe(true);
    expect(hasRecoveryIntent({ page: 'retrieval', params: {} })).toBe(false);
    expect(hasRecoveryIntent({ page: 'learning', params: { recoveryId: 'not-a-hash' } })).toBe(false);
    const props = { route: { ...route, page: 'retrieval' as const }, exchange: new TransientRetrieval(), onResult: () => {}, onInvalidateResult: () => {} };
    const waiting = PageOutlet({ ...props, recoveryIdentity: null });
    expect(typeof waiting?.type === 'function' && waiting.type.name).toBe('RecoveryAwaiting');
    const restored = PageOutlet({ ...props, recoveryIdentity: { ...value, identity: { ...value.identity, feature: 'retrieval' } } });
    expect(restored?.props.recoveryRequested).toBe(true);
    const ordinary = PageOutlet({ ...props, route: { page: 'retrieval', params: {} }, recoveryIdentity: null });
    expect(ordinary?.props.recoveryRequested).toBe(false);
  });
  it('shows only the exact consented identity delivered for this verified session and recovery route', () => {
    expect(recoveryForRoute(delivery, session, true, route)).toBe(value);
    expect(recoveryForRoute(delivery, session, false, route)).toBeNull();
    expect(recoveryForRoute(delivery, null, true, route)).toBeNull();
    expect(recoveryForRoute(delivery, session, true, { page: 'learning', params: {} })).toBeNull();
    expect(recoveryForRoute(delivery, session, true, { page: 'learning', params: { recoveryId: 'c'.repeat(64) } })).toBeNull();
    expect(recoveryForRoute(delivery, session, true, { page: 'retrieval', params: route.params })).toBeNull();
  });
  it('hides old metadata immediately after actor, workspace, mode or permission changes, before effects clear state', () => {
    for (const changed of [{ ...session, actorId: 'actor-B' }, { ...session, workspace: { ...session.workspace, id: 'workspace-B' } },
      { ...session, workspace: { ...session.workspace, mode: 'live' as const } }, { ...session, scopes: ['workspace:read'] }]) {
      expect(recoveryForRoute(delivery, changed, true, route)).toBeNull();
    }
    expect(recoveryForRoute({ ...delivery, value: { ...value, identity: { ...value.identity, actorId: 'actor-B' } } }, session, true, route)).toBeNull();
    expect(recoveryForRoute({ ...delivery, value: { ...value, identity: { ...value.identity, expiresAt: '2026-01-01T00:00:00Z' } } }, session, true, route)).toBeNull();
  });
});
