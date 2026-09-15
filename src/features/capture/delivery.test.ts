import { describe, expect, it, vi } from 'vitest';
import { conversation, ctx, fixture, post } from './fixtures.test-support';
import { hashConversation } from '../../contracts/hash';
import type { Approval, Candidate, TaskContext } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { prepareModelInput } from './model-input';
import { extractCapture } from './delivery';
import { failure } from './result';
import type { CandidateState } from '../../contracts/candidates';

async function setup() {
  let current = { ...conversation, segments: [{ id: 's1', role: 'user' as const, text: '幂等键需要限定有效期。' }] };
  current.contentHash = await hashConversation(current);
  let candidates: Candidate[] = [];
  let batch: CandidateState = { conversationId: current.id, conversationHash: current.contentHash, revision: 0, state: 'missing', candidates, retentionDays: 7 };
  const proposed = { title: '幂等键', question: '重复请求如何处理？', claim: '幂等键需要限定有效期。', kind: 'method', whyKeep: '避免重复写入', uncertainties: ['有效期需要按任务设定'], spans: [{ segmentId: 's1', start: 0, end: current.segments[0]!.text.length, quote: current.segments[0]!.text }] };
  const complete = vi.fn<Services['complete']>(async () => ({ ok: true, data: { value: { candidates: [proposed] }, modelId: 'fixture-provider-actual-id', generatedAt: new Date().toISOString() } }));
  const saveCandidates = vi.fn<Services['saveCandidates']>(async (_ctx, _id, values, options) => { candidates = values; batch = { ...batch, state: 'available', revision: 1, candidates, modelApprovalId: options!.modelApproval.id, expiresAt: new Date(Date.now() + 86400000).toISOString() }; return { ok: true, data: values }; });
  const commit = vi.fn();
  const { app, services } = fixture({ readConversation: async () => ({ ok: true, data: current }), readCandidates: async () => ({ ok: true, data: candidates }), saveCandidates, complete, commit,
    readCandidateState: async () => ({ ok: true, data: structuredClone(batch) }), readModelOperation: async () => ({ ok: true, data: null }),
    workspace: async () => ({ ok: true, data: { id: ctx.workspaceId, slug: 'fixture/workspace', mode: 'fixture', visibility: 'private' } }),
    settings: async () => ({ ok: true, data: { aiExtraction: true, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } }),
  });
  const task: TaskContext = { id: current.taskId, workspaceId: ctx.workspaceId, question: '减少重复写入', constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() };
  const scope = { task, segmentIds: ['s1'], scopeConfirmed: true as const };
  const preview = await prepareModelInput(services, ctx, current.id, scope);
  if (!preview.ok) throw new Error('fixture model preview failed');
  const approval: Approval = { ...preview.data.approvalRequest, id: 'fixture-registered-model-approval', actorId: ctx.actorId, workspaceId: ctx.workspaceId, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
  return { app, services, complete, saveCandidates, commit, current, request: { ...scope, approval, retentionDays: 7 as const, confirmed: true as const }, change: async () => { current = { ...current, segments: [{ ...current.segments[0]!, text: '新的前提' }] }; current.contentHash = await hashConversation(current); } };
}
describe('C12 proposed candidates and handoff', () => {
  it('persists only validated proposed candidates, reads back and exposes the same conversation ID', async () => {
    const s = await setup();
    const response = await post(s.app, `/api/capture/${s.current.id}/extract`, s.request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.mode).toBe('fixture'); expect(body.data.state).toBe('saved');
    expect(body.data.conversationId).toBe(s.current.id);
    expect(body.data.handoffHref).toBe(`#handoff?conversationId=${s.current.id}`);
    expect(body.data.candidates[0]).toMatchObject({ state: 'proposed', modelId: 'fixture-provider-actual-id' });
    expect((await s.services.readCandidates(ctx, s.current.id))).toMatchObject({ ok: true, data: body.data.candidates });
    expect((await s.app.request(`/api/capture/${s.current.id}/candidates`)).status).toBe(200);
    expect(s.commit).not.toHaveBeenCalled();
    const repeat = await post(s.app, `/api/capture/${s.current.id}/extract`, s.request);
    expect((await repeat.json()).data.state).toBe('existing'); expect(s.complete).toHaveBeenCalledOnce();
  });
  it('keeps the saved conversation accessible after model failure or bad references', async () => {
    for (const invalid of [false, true]) {
      const s = await setup();
      s.complete.mockImplementation(async () => invalid ? { ok: true, data: { value: { candidates: [{ title: 'x' }] }, modelId: 'fixture', generatedAt: new Date().toISOString() } } : failure('UPSTREAM', 'model failed'));
      expect((await post(s.app, `/api/capture/${s.current.id}/extract`, s.request)).status).toBe(502);
      expect(s.saveCandidates).not.toHaveBeenCalled();
      expect((await s.app.request(`/api/capture/${s.current.id}`)).status).toBe(200);
    }
  });
  it('stops before candidate writes after cancellation or source changes while the model runs', async () => {
    for (const cancel of [true, false]) {
      const s = await setup(); const controller = new AbortController();
      const response = await s.complete(ctx, { purpose: 'extract', text: '', sourceIds: [], approval: s.request.approval }); s.complete.mockClear();
      s.complete.mockImplementation(async () => { if (cancel) controller.abort(); else await s.change(); return response; });
      expect((await extractCapture(s.services, ctx, s.current.id, s.request, controller.signal)).ok).toBe(false);
      expect(s.saveCandidates).not.toHaveBeenCalled();
    }
  });
  it('does not rerun a model when candidate persistence is unknown and readback can recover it', async () => {
    const s = await setup();
    const original = s.saveCandidates.getMockImplementation()!;
    s.saveCandidates.mockImplementation(async (...args) => { await original(...args); return failure('UNKNOWN_RESULT', 'candidate state unknown', 'read_candidates', 'unknown'); });
    const response = await post(s.app, `/api/capture/${s.current.id}/extract`, s.request);
    expect(response.status).toBe(409);
    expect((await response.json()).error.nextAction).toBe('read_candidates');
    expect((await s.app.request(`/api/capture/${s.current.id}/candidates`)).status).toBe(200);
    expect(s.complete).toHaveBeenCalledOnce();
  });
  it('returns truthful fixture status, refuses missing candidate scope and leaves AI off usable', async () => {
    const s = await setup();
    const status = await (await s.app.request('/api/capture/status')).json();
    expect(status.meta.mode).toBe('fixture'); expect(status.data.aiExtraction).toBe('enabled');
    const missingScope = { ...ctx, scopes: ctx.scopes.filter((p) => p !== 'candidate:write') };
    expect((await extractCapture(s.services, missingScope, s.current.id, s.request)).ok).toBe(false);
    s.services.settings = async () => ({ ok: true, data: { aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } });
    expect((await post(s.app, `/api/capture/${s.current.id}/extract`, s.request)).status).toBe(403);
    expect(s.complete).not.toHaveBeenCalled();
    expect((await s.app.request(`/api/capture/${s.current.id}`)).status).toBe(200);
  });
  it('rejects a concurrent extraction without issuing a second model request', async () => {
    const s = await setup(); const original = s.complete.getMockImplementation()!;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.complete.mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    const first = post(s.app, `/api/capture/${s.current.id}/extract`, s.request);
    try { await started; expect((await post(s.app, `/api/capture/${s.current.id}/extract`, s.request)).status).toBe(409); }
    finally { release(); }
    expect((await first).status).toBe(200); expect(s.complete).toHaveBeenCalledOnce(); expect(s.saveCandidates).toHaveBeenCalledOnce();
  });
  it('delivers a genuine empty model result without inventing candidates or formal knowledge', async () => {
    const s = await setup();
    s.complete.mockImplementation(async () => ({ ok: true, data: { value: { candidates: [] }, modelId: 'fixture-empty-model', generatedAt: new Date().toISOString() } }));
    const response = await post(s.app, `/api/capture/${s.current.id}/extract`, s.request);
    expect(response.status).toBe(200); expect((await response.json()).data).toMatchObject({ state: 'empty', candidates: [] });
    expect(s.saveCandidates.mock.calls[0]?.[2]).toEqual([]); expect(s.commit).not.toHaveBeenCalled();
  });
  it('treats an exception from complete as an unknown model operation, with no candidate write', async () => {
    const s = await setup();
    s.complete.mockRejectedValue(new Error('PRIVATE_PROVIDER_BODY'));
    const response = await post(s.app, `/api/capture/${s.current.id}/extract`, s.request);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', retryable: false } });
    expect(s.complete).toHaveBeenCalledOnce(); expect(s.saveCandidates).not.toHaveBeenCalled();
  });
  it('does not persist when approval expires while the model runs', async () => {
    const s = await setup(); const original = s.complete.getMockImplementation()!;
    const now = vi.spyOn(Date, 'now');
    s.complete.mockImplementation(async (...args) => { const value = await original(...args); now.mockReturnValue(Date.parse(s.request.approval.expiresAt) + 1); return value; });
    try {
      expect(await extractCapture(s.services, ctx, s.current.id, s.request)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'preserved' } });
      expect(s.saveCandidates).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });
  it('rejects a source revision that changes during the last candidate read', async () => {
    const s = await setup(); const read = s.services.readConversation; let reads = 0;
    s.services.readConversation = async (...args) => { if (++reads === 5) await s.change(); return read(...args); };
    expect(await extractCapture(s.services, ctx, s.current.id, s.request)).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    expect(s.complete).toHaveBeenCalledOnce(); expect(s.saveCandidates).not.toHaveBeenCalled();
  });
  it('honors AI being turned off during the final candidate read before persistence', async () => {
    const s = await setup(); const read = s.services.readConversation; let reads = 0;
    s.services.readConversation = async (...args) => {
      if (++reads === 5) s.services.settings = async () => ({ ok: true, data: { aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } });
      return read(...args);
    };
    expect(await extractCapture(s.services, ctx, s.current.id, s.request)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'preserved' } });
    expect(s.saveCandidates).not.toHaveBeenCalled();
  });
});
