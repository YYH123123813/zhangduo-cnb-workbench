import { describe, expect, it, vi } from 'vitest';
import { conversation, ctx, fixture, post } from './fixtures.test-support';
import { hashConversation, hashModelInput } from '../../contracts/hash';
import type { Services } from '../../contracts/ports';
import type { ModelScope } from './model-input';

async function setup() {
  const value = { ...conversation, segments: [{ id: 'selected', role: 'user' as const, text: '重复请求需要稳定ID。' }, { id: 'excluded', role: 'source' as const, text: 'UNSELECTED_PRIVATE_FIXTURE' }] };
  value.contentHash = await hashConversation(value);
  const complete = vi.fn(); const saveCandidates = vi.fn();
  const approveModel = vi.fn<NonNullable<Services['approveModel']>>(async (_ctx, input) => ({ ok: true, data: { id: 'fixture-issued-model-approval', workspaceId: ctx.workspaceId, actorId: ctx.actorId, purpose: 'model_input', objectIds: input.objectIds, baseRevision: input.baseRevision, contentHash: await hashModelInput(input.input), approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } }));
  const { app, services } = fixture({ approveModel, complete, saveCandidates,
    readConversation: async () => ({ ok: true, data: value }), readCandidates: async () => ({ ok: true, data: [] }),
    workspace: async () => ({ ok: true, data: { id: ctx.workspaceId, slug: 'fixture/workspace', mode: 'fixture', visibility: 'private' } }),
    settings: async () => ({ ok: true, data: { aiExtraction: true, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } }),
  });
  const scope: ModelScope = { task: { id: value.taskId, workspaceId: ctx.workspaceId, question: '如何避免重复？', constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() }, segmentIds: ['selected'], scopeConfirmed: true };
  const preview = await (await post(app, `/api/capture/${value.id}/model-preview`, scope)).json();
  const request = { ...scope, expectedInputHash: preview.data.approvalRequest.contentHash, expectedConversationHash: value.contentHash, retentionDays: 7, confirmed: true };
  return { app, services, value, request, approveModel, complete, saveCandidates };
}
describe('C09 shared 1.6 model approval bridge', () => {
  it('forwards the original registration ID into the complete shared model approval request', async () => {
    const s = await setup();
    const response = await post(s.app, `/api/capture/${s.value.id}/model-approve`, { ...s.request, operationId: 'original-extract-registration' });
    expect(response.status).toBe(200);
    expect(s.approveModel.mock.calls[0]![1]).toMatchObject({ operationId: 'original-extract-registration', conversationId: s.value.id, confirmed: true });
    expect(s.approveModel.mock.calls[0]![1]).not.toHaveProperty('expectedInputHash');
  });
  it('issues only through Services.approveModel using the recomputed selected input and original trusted context', async () => {
    const s = await setup();
    const response = await post(s.app, `/api/capture/${s.value.id}/model-approve`, s.request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { purpose: 'model_input', objectIds: ['selected'], contentHash: s.request.expectedInputHash, baseRevision: s.value.contentHash }, meta: { mode: 'fixture' } });
    expect(s.approveModel).toHaveBeenCalledOnce();
    const [identity, input] = s.approveModel.mock.calls[0]!;
    expect(identity).toBe(ctx); expect(input).toMatchObject({ conversationId: s.value.id, objectIds: ['selected'], confirmed: true, input: { purpose: 'extract', sourceIds: ['selected'] } });
    expect(input.input.text).not.toContain('UNSELECTED_PRIVATE_FIXTURE');
    expect(s.complete).not.toHaveBeenCalled(); expect(s.saveCandidates).not.toHaveBeenCalled();
  });
  it('refuses absent confirmation or displayed hashes before requesting a platform approval', async () => {
    const s = await setup();
    for (const change of [{ confirmed: false }, { retentionDays: undefined }, { retentionDays: 30 }, { expectedInputHash: undefined }, { expectedConversationHash: undefined }, { input: { text: 'UNTRUSTED_OVERRIDE' } }]) {
      expect((await post(s.app, `/api/capture/${s.value.id}/model-approve`, { ...s.request, ...change })).status).toBe(422);
    }
    expect(s.approveModel).not.toHaveBeenCalled();
  });
  it('rejects a changed displayed hash, task or source revision instead of silently approving new text', async () => {
    const s = await setup();
    for (const change of [{ expectedInputHash: 'stale' }, { expectedConversationHash: 'stale' }, { task: { ...s.request.task, question: 'changed question' } }]) {
      expect((await post(s.app, `/api/capture/${s.value.id}/model-approve`, { ...s.request, ...change })).status).toBe(409);
    }
    expect(s.approveModel).not.toHaveBeenCalled();
  });
  it('keeps missing or unconfigured approval ports explicit without a model call', async () => {
    const s = await setup(); delete s.services.approveModel;
    expect((await post(s.app, `/api/capture/${s.value.id}/model-approve`, s.request)).status).toBe(503);
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('refuses disabled AI, foreign tasks and missing candidate write scope before approval', async () => {
    const s = await setup();
    expect((await post(s.app, `/api/capture/${s.value.id}/model-approve`, { ...s.request, task: { ...s.request.task, workspaceId: 'foreign' } })).status).toBe(403);
    s.services.context = async () => ({ ok: true, data: { ...ctx, scopes: ctx.scopes.filter((scope) => scope !== 'candidate:write') } });
    expect((await post(s.app, `/api/capture/${s.value.id}/model-approve`, s.request)).status).toBe(403);
    s.services.context = async () => ({ ok: true, data: ctx });
    s.services.settings = async () => ({ ok: true, data: { aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } });
    expect((await post(s.app, `/api/capture/${s.value.id}/model-approve`, s.request)).status).toBe(403);
    expect(s.approveModel).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });
  it('does not accept a bad scope or expired receipt from the approval service', async () => {
    for (const change of [{ objectIds: ['excluded'] }, { expiresAt: '2020-01-01T00:00:00Z' }]) {
      const s = await setup(); const original = s.approveModel.getMockImplementation()!;
      s.approveModel.mockImplementation(async (...args) => { const result = await original(...args); return result.ok ? { ok: true, data: { ...result.data, ...change } } : result; });
      expect((await post(s.app, `/api/capture/${s.value.id}/model-approve`, s.request)).status).toBe(403);
      expect(s.complete).not.toHaveBeenCalled();
    }
  });
  it('advertises the bridge only when the optional method and send permissions are present', async () => {
    const s = await setup();
    expect(await (await s.app.request('/api/capture/status')).json()).toMatchObject({ data: { modelApproval: 'available' } });
    for (const missing of ['conversation:read', 'candidate:read', 'candidate:write', 'model:extract', 'settings:read']) {
      s.services.context = async () => ({ ok: true, data: { ...ctx, scopes: ctx.scopes.filter((scope) => scope !== missing) } });
      expect(await (await s.app.request('/api/capture/status')).json()).toMatchObject({ data: { modelApproval: 'not_configured' } });
    }
    s.services.context = async () => ({ ok: true, data: ctx });
    delete s.services.approveModel;
    expect(await (await s.app.request('/api/capture/status')).json()).toMatchObject({ data: { modelApproval: 'not_configured' } });
  });
  it('reports thrown registration as unknown, not as proof that approval was never issued', async () => {
    const s = await setup(); s.approveModel.mockRejectedValueOnce(new Error('lost registry response'));
    const response = await post(s.app, `/api/capture/${s.value.id}/model-approve`, s.request);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(s.complete).not.toHaveBeenCalled();
  });
});
