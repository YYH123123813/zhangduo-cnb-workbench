import { describe, expect, it, vi } from 'vitest';
import { conversation, ctx, fixture, post } from './fixtures.test-support';
import { hashConversation } from '../../contracts/hash';
import type { Approval, Conversation } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { failure } from './result';

async function input() {
  const value: Conversation = { ...conversation, origin: 'paste', sourceAlreadyPersisted: false, state: 'preview', issueNumber: undefined, issueUrl: undefined };
  value.contentHash = await hashConversation(value);
  const approval: Approval = { id: 'fixture-issued-approval', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'save_conversation', objectIds: [value.id], contentHash: value.contentHash, baseRevision: 'new', approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
  return { conversation: value, approval, confirmed: true };
}
describe('C08 saved, unknown and recoverable capture', () => {
  it('requires a matching read-back receipt and reuses the exact object/operation IDs on duplicates', async () => {
    const request = await input();
    let stored: Conversation | undefined; let creates = 0;
    const saveConversation = vi.fn<Services['saveConversation']>(async (_ctx, value) => {
      if (!stored) { creates++; stored = { ...value, issueNumber: 10, issueUrl: 'https://cnb.cool/fixture/repo/-/issues/10', sourceAlreadyPersisted: true, state: 'saved' }; }
      return { ok: true, data: stored };
    });
    const readConversation = vi.fn<Services['readConversation']>(async () => stored ? { ok: true, data: stored } : failure('UNKNOWN_RESULT', 'unverified'));
    const { app } = fixture({ saveConversation, readConversation });
    const responses = await Promise.all([post(app, '/api/capture/save', request), post(app, '/api/capture/save', request)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(creates).toBe(1);
    expect(readConversation).toHaveBeenCalled();
    expect(saveConversation.mock.calls.every(([, value, approval]) => value.id === request.conversation.id && approval.id === request.approval.id)).toBe(true);
    expect((await (await app.request(`/api/capture/${request.conversation.id}`)).json()).data.state).toBe('saved');
  });
  it('never retries or returns saved for timeout, failed readback or a changed remote body', async () => {
    const request = await input();
    const saveConversation = vi.fn<Services['saveConversation']>(async () => failure('UNKNOWN_RESULT', 'unknown', 'read_back', 'unknown'));
    const { app } = fixture({ saveConversation });
    const response = await post(app, '/api/capture/save', request);
    expect(response.status).toBe(409);
    expect((await response.json()).error.dataState).toBe('unknown');
    expect(saveConversation).toHaveBeenCalledOnce();
    const saved = { ...request.conversation, state: 'saved' as const, sourceAlreadyPersisted: true, issueNumber: 10 };
    const mismatch = fixture({ saveConversation: async () => ({ ok: true, data: saved }), readConversation: async () => ({ ok: true, data: { ...saved, segments: [{ id: 's', role: 'source', text: 'changed' }] } }) });
    expect((await post(mismatch.app, '/api/capture/save', request)).status).toBe(409);
  });
  it('refuses cancelled, forged, changed, expired and unauthorized save requests before a write', async () => {
    const request = await input(); const saveConversation = vi.fn();
    const { app } = fixture({ saveConversation });
    for (const change of [ { confirmed: false }, { approval: { ...request.approval, actorId: 'other' } }, { approval: { ...request.approval, expiresAt: '2020-01-01T00:00:00Z' } }, { conversation: { ...request.conversation, segments: [{ id: 's', role: 'source', text: 'edited' }] } } ]) {
      expect((await post(app, '/api/capture/save', { ...request, ...change })).status).toBeGreaterThanOrEqual(400);
    }
    const denied = fixture({ context: async () => ({ ok: true, data: { ...ctx, scopes: [] } }), saveConversation });
    expect((await post(denied.app, '/api/capture/save', request)).status).toBe(403);
    expect(saveConversation).not.toHaveBeenCalled();
  });
  it('delegates revocation and reports a revoked platform approval without a success receipt', async () => {
    const request = await input(); let revoked = false;
    const { app } = fixture({ revokeApproval: async () => { revoked = true; return { ok: true, data: { revoked: true } }; }, saveConversation: async () => revoked ? failure('FORBIDDEN', 'revoked') : failure('NOT_CONFIGURED', 'off') });
    expect((await post(app, `/api/capture/approvals/${request.approval.id}/revoke`, {})).status).toBe(200);
    expect((await post(app, '/api/capture/save', request)).status).toBe(403);
  });
  it('reads unknown operation state without creating another conversation and preserves privacy on exceptions', async () => {
    const saveConversation = vi.fn();
    const { app } = fixture({ saveConversation, readConversation: async () => failure('UNKNOWN_RESULT', 'still unknown', 'read_back', 'unknown') });
    expect((await app.request('/api/capture/c1')).status).toBe(409);
    expect(saveConversation).not.toHaveBeenCalled();
    const throwing = fixture({ saveConversation: async () => { throw new Error('private-secret'); } });
    const response = await post(throwing.app, '/api/capture/save', await input());
    expect(response.status).toBe(409); expect(await response.text()).not.toContain('private-secret');
  });
});
