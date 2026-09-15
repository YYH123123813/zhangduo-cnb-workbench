import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, post } from './fixtures.test-support';
import { initialTaskDraft } from './task';
import { hashConversation } from '../../contracts/hash';
import { checkApprovalBinding } from './approval';
import type { Services } from '../../contracts/ports';

export const previewInput = {
  conversationId: 'new-capture-1', task: { ...initialTaskDraft('task-1'), question: '如何避免重复请求？' },
  source: { origin: 'paste' }, segments: [{ id: 'selected-1', role: 'user', text: '只选中的原文\r\n下一行' }],
  personalInfoReviewed: false, scopeConfirmed: true,
};
describe('C07 controlled preview and approval binding', () => {
  it('hashes only the chosen normalized content and returns a proposal, never an issued approval', async () => {
    const saveConversation = vi.fn(); const complete = vi.fn();
    const { app } = fixture({ saveConversation, complete });
    const response = await post(app, '/api/capture/preview', previewInput);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.conversation.segments[0].text).toBe('只选中的原文\n下一行');
    expect(body.data.conversation.contentHash).toBe(await hashConversation(body.data.conversation));
    expect(body.data.approvalRequest).toEqual({ purpose: 'save_conversation', objectIds: ['new-capture-1'], contentHash: body.data.conversation.contentHash, baseRevision: 'new' });
    expect(body.data.approvalRequest.approvedAt).toBeUndefined();
    expect(saveConversation).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it('rejects unconfirmed scope, identity forgery, retained secrets and no permission', async () => {
    const { app } = fixture();
    for (const body of [{ ...previewInput, scopeConfirmed: false }, { ...previewInput, workspaceId: 'other' }, { ...previewInput, segments: [{ id: 's', role: 'source', text: 'CNB_TOKEN=fixture-secret' }] }]) {
      expect((await post(app, '/api/capture/preview', body)).status).toBe(422);
    }
    const denied = fixture({ context: async () => ({ ok: true, data: { ...ctx, scopes: [] } }) });
    expect((await post(denied.app, '/api/capture/preview', previewInput)).status).toBe(403);
  });
  it('binds actor, workspace, purpose, object IDs, hash and version; refuses expiry or future approval', () => {
    const expected = { purpose: 'save_conversation' as const, objectIds: ['c1'], contentHash: 'hash', baseRevision: 'new' };
    const approval = { ...expected, id: 'a1', actorId: ctx.actorId, workspaceId: ctx.workspaceId, approvedAt: '2026-09-05T04:00:00.000Z', expiresAt: '2026-09-05T04:10:00.000Z' };
    expect(checkApprovalBinding(approval, expected, ctx, Date.parse('2026-09-05T04:01:00Z')).ok).toBe(true);
    for (const change of [{ actorId: 'other' }, { workspaceId: 'other' }, { purpose: 'model_input' }, { objectIds: ['other'] }, { contentHash: 'edited' }, { baseRevision: 'old' }, { expiresAt: '2026-09-05T04:00:00Z' }, { approvedAt: '2026-09-05T04:02:00Z' }]) {
      expect(checkApprovalBinding({ ...approval, ...change }, expected, ctx, Date.parse('2026-09-05T04:01:00Z')).ok).toBe(false);
    }
  });
  it('issues approval only through the optional trusted Services authority after explicit confirmation', async () => {
    const approveConversation = vi.fn<NonNullable<Services['approveConversation']>>(async (_ctx, input) => ({ ok: true as const, data: { id: 'registered-approval', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'save_conversation' as const, objectIds: [input.conversation.id], contentHash: input.conversation.contentHash, baseRevision: 'new', approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() } }));
    const { app } = fixture({ approveConversation });
    const prepared = await (await post(app, '/api/capture/preview', previewInput)).json();
    const request = { conversation: prepared.data.conversation, baseRevision: 'new', confirmed: true };
    expect((await post(app, '/api/capture/approve', { ...request, confirmed: false })).status).toBe(422);
    expect(approveConversation).not.toHaveBeenCalled();
    expect((await post(app, '/api/capture/approve', request)).status).toBe(200);
    expect(approveConversation).toHaveBeenCalledOnce();
  });
  it('does not fabricate approval when the shared authority is absent', async () => {
    const { app } = fixture();
    const prepared = await (await post(app, '/api/capture/preview', previewInput)).json();
    const response = await post(app, '/api/capture/approve', { conversation: prepared.data.conversation, baseRevision: 'new', confirmed: true });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('NOT_CONFIGURED');
  });
});
