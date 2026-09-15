import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/app';
import type { Approval, RetrievalRequest, Settings } from '../../contracts/domain';
import { canonicalJson, hashModelInput } from '../../contracts/hash';
import type { Services } from '../../contracts/ports';
import type { AnswerPreview } from './api';
import { failure } from './api';
import { context, fixtureServices, node, request, snapshot } from './test-support';

const assisted = { ...request, task: { ...request.task, mode: 'assisted' as const } };
function setup() {
  const issued = Object.freeze({ ...context, scopes: ['knowledge:read', 'model:answer', 'settings:read', 'workspace:read'] });
  let current = snapshot();
  let enabled = true;
  const registered = new Map<string, Approval>(); const used = new Set<string>();
  const transport = vi.fn<() => ReturnType<Services['complete']>>(async () => ({ ok: true as const, data: { value: { claims: [{
    nodeRef: { workspaceId: 'w1', objectId: 'n1', revision: 'fixture-r1' }, sourceId: 's-n1', quote: 'Cache immutable data.', text: 'Cache immutable data.',
  }] }, modelId: 'fixture-model', generatedAt: new Date().toISOString() } }));
  const approveModel = vi.fn<NonNullable<Services['approveModel']>>(async (ctx, input) => {
    expect(ctx).toBe(issued);
    if (!enabled) return failure('FORBIDDEN', 'AI disabled', 'continue_without_ai');
    const approval: Approval = { id: crypto.randomUUID(), workspaceId: ctx.workspaceId, actorId: ctx.actorId, purpose: 'model_input',
      objectIds: input.objectIds, baseRevision: input.baseRevision, contentHash: await hashModelInput(input.input),
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    registered.set(approval.id, structuredClone(approval)); return { ok: true, data: approval };
  });
  const complete = vi.fn<Services['complete']>(async (ctx, input) => {
    expect(ctx).toBe(issued);
    const saved = registered.get(input.approval.id);
    if (!saved || canonicalJson(saved) !== canonicalJson(input.approval) || saved.contentHash !== await hashModelInput(input)) return failure('FORBIDDEN', 'Unregistered or revoked approval', 'approve_model_input');
    if (used.has(saved.id)) return failure('CONFLICT', 'Already used', 'preview_model_scope');
    used.add(saved.id); return transport();
  });
  const services = fixtureServices({
    context: async () => ({ ok: true, data: issued }), snapshot: async (ctx) => { expect(ctx).toBe(issued); return { ok: true, data: structuredClone(current) }; },
    settings: async () => ({ ok: true, data: { aiAnswer: enabled, aiExtraction: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } satisfies Settings }),
    approveModel, complete, revokeApproval: async (ctx, id) => { expect(ctx).toBe(issued); registered.delete(id); return { ok: true, data: { revoked: true } }; },
  });
  const app = createApp(services);
  const post = (path: string, body: unknown, signal?: AbortSignal) => app.request(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  }));
  async function preview(query: RetrievalRequest = assisted): Promise<AnswerPreview> {
    const response = await post('/api/retrieval/answer/preview', { request: query });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json(); expect(body.ok).toBe(true); return body.data;
  }
  async function approve(): Promise<Approval> {
    const prepared = await preview();
    const response = await post('/api/workspace/approvals/model', { input: prepared.input, objectIds: prepared.objectIds, baseRevision: prepared.baseRevision, confirmed: true });
    expect(response.status).toBe(200); return (await response.json()).data;
  }
  return { app, post, preview, approve, transport, services, registered,
    set current(value: typeof current) { current = value; }, set enabled(value: boolean) { enabled = value; } };
}

describe('R09/R10 approved answer HTTP flow, synthetic platform authority', () => {
  it('previews exact content without approval or sending, then uses the shared approval API', async () => {
    const f = setup(); const preview = await f.preview();
    expect(preview.contentHash).toBe(await hashModelInput(preview.input));
    expect(preview.objectIds).toEqual(['n1']); expect(preview.input.sourceIds).toEqual(['s-n1']);
    expect(f.services.approveModel).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    const approval = await f.approve();
    const response = await f.post('/api/retrieval/answer', { request: assisted, approval });
    expect(response.status).toBe(200);
    expect((await response.json()).data.answer.citations[0].nodeRef.revision).toBe('fixture-r1');
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it('rejects edited questions and conditions before complete', async () => {
    const f = setup(); const approval = await f.approve();
    for (const changed of [{ ...assisted, query: 'cache changed' }, { ...assisted, task: { ...assisted.task, constraints: [{ id: 'new', text: 'New condition', confirmedBy: 'u1' }] } }]) {
      const response = await f.post('/api/retrieval/answer', { request: changed, approval }); expect(response.status).toBe(403);
    }
    expect(f.services.complete).not.toHaveBeenCalled();
  });
  it('does not accept a browser-supplied result or approval without a trusted registration', async () => {
    const f = setup(); const approval = await f.approve();
    expect((await f.post('/api/retrieval/answer', { request: assisted, approval, result: { answer: 'FAKE' } })).status).toBe(422);
    expect((await f.post('/api/retrieval/answer', { request: assisted, approval: { ...approval, id: 'forged' } })).status).toBe(403);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('honors revocation through the shared endpoint and never replays a used approval', async () => {
    const f = setup(); const revoked = await f.approve();
    expect((await f.post(`/api/workspace/approvals/${revoked.id}/revoke`, {})).status).toBe(200);
    expect((await f.post('/api/retrieval/answer', { request: assisted, approval: revoked })).status).toBe(403);
    const approval = await f.approve();
    expect((await f.post('/api/retrieval/answer', { request: assisted, approval })).status).toBe(200);
    expect((await f.post('/api/retrieval/answer', { request: assisted, approval })).status).toBe(409);
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it('rejects changed versions and removed bodies without model transmission', async () => {
    for (const current of [snapshot([node('n1', { revision: 'fixture-r2' })], { revision: 'fixture-r2' }), snapshot([], { excludedIds: ['n1'] })]) {
      const f = setup(); const approval = await f.approve(); f.current = current;
      expect((await f.post('/api/retrieval/answer', { request: assisted, approval })).status).not.toBe(200);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it('keeps AI-off originals and denies independent preview without any send', async () => {
    const f = setup(); const approval = await f.approve(); f.enabled = false;
    expect((await f.post('/api/retrieval/answer/preview', { request: assisted })).status).toBe(403);
    const direct = await f.post('/api/retrieval/answer', { request: assisted, approval });
    expect(direct.status).toBe(200); expect((await direct.json()).data.answer).toBeNull();
    f.enabled = true;
    expect((await f.post('/api/retrieval/answer/preview', { request })).status).toBe(403);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('preserves possible transmission state when cancelled during final identity recheck', async () => {
    const f = setup(); const approval = await f.approve(); const controller = new AbortController();
    const identity = f.services.context;
    f.services.context = async (req) => { if (f.transport.mock.calls.length) controller.abort(); return identity(req); };
    const response = await f.post('/api/retrieval/answer', { request: assisted, approval }, controller.signal);
    expect(response.status).toBe(409); const body = await response.json();
    expect(body.error.message).toContain('可能已发送'); expect(body.error.dataState).toBe('unknown');
    expect(JSON.stringify(body)).not.toContain('Cache immutable data.');
  });
  it('keeps unknown model outcomes machine-readable and never automatically sends twice', async () => {
    const f = setup(); const approval = await f.approve();
    f.transport.mockResolvedValueOnce({ ok: false, error: { code: 'UNKNOWN_RESULT', message: 'PRIVATE_PROVIDER_TRACE', nextAction: 'read_operation', retryable: false, dataState: 'unknown' } });
    const response = await f.post('/api/retrieval/answer', { request: assisted, approval });
    expect(response.status).toBe(409); const body = await response.json();
    expect(body.error).toMatchObject({ code: 'UNKNOWN_RESULT', dataState: 'unknown', retryable: false });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PROVIDER_TRACE'); expect(f.transport).toHaveBeenCalledOnce();
  });
  it('discards the answer when model permissions disappear during the final session check', async () => {
    const f = setup(); const approval = await f.approve(); const identity = f.services.context;
    f.services.context = async (req) => {
      const result = await identity(req);
      return result.ok && f.transport.mock.calls.length ? { ok: true, data: { ...result.data, scopes: ['knowledge:read'] } } : result;
    };
    const response = await f.post('/api/retrieval/answer', { request: assisted, approval });
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('Cache immutable data.');
  });
});
