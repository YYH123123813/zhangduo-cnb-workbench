import { describe, expect, it } from 'vitest';
import type { ApiResponse } from '../contracts/api';
import { canRenderPage, settleSession, type SessionState } from './session-state';

const current: SessionState = { hash: '#governance', value: { actorId: 'u1', workspace: { id: 'w1', slug: 'fixture/app', mode: 'fixture', visibility: 'private' }, scopes: ['knowledge:read'] }, message: 'Private workspace', verified: true };
const response = (code: 'UNAUTHORIZED' | 'UPSTREAM'): ApiResponse<unknown> => ({ ok: false, error: { code, message: 'Fixture error', retryable: false, dataState: 'preserved', nextAction: 'retry_read' }, meta: { requestId: 'r1', mode: 'fixture', contractVersion: '1.8.0' } });
describe('W12 session rechecks without accidental draft unloading', () => {
  it('preserves the same mounted identity on transport failure but disables transient handoff', () => {
    const state = settleSession(current, '#governance', null);
    expect(state.value).toEqual(current.value); expect(state.verified).toBe(false);
    expect(settleSession(current, '#governance', response('UPSTREAM')).value).toEqual(current.value);
  });
  it('does not reuse the old identity for a new route, a revoked session or mismatched data mode', () => {
    expect(settleSession(current, '#learning', null).value).toBeNull();
    expect(settleSession(current, '#governance', response('UNAUTHORIZED')).value).toBeNull();
    expect(settleSession(current, '#governance', { ok: true, data: current.value, meta: { requestId: 'r1', contractVersion: '1.8.0', mode: 'live' } }).value).toBeNull();
  });
  it('keeps a verified same-page instance mounted while the new route session is being rechecked', () => {
    expect(canRenderPage(current, '#governance?changeSetId=change-A', 'governance')).toBe(true);
    expect(canRenderPage(current, '#handoff?conversationId=conversation-A', 'handoff')).toBe(false);
    expect(canRenderPage({ ...current, verified: false }, '#governance?changeSetId=change-A', 'governance')).toBe(false);
  });
});
