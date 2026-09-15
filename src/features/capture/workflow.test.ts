import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import { apiRequest } from '../../app/api-client';
import type { Approval, Conversation } from '../../contracts/domain';
import { hashConversation } from '../../contracts/hash';
import { ctx, fixture, post } from './fixtures.test-support';
import type { PreviewInput } from './preview';
import { CaptureSaveFlow } from './save-flow';
import { failure } from './result';
import { parseText } from './parse';
import { prepareContent } from './redaction';
import { scanSegments } from './privacy';

afterEach(() => { vi.restoreAllMocks(); });

function setup() {
  const approvals = new Map<string, Approval>(); const revoked = new Set<string>();
  const stored = new Map<string, Conversation>(); let creates = 0;
  const complete = vi.fn();
  const { app } = fixture({
    approveConversation: async (_ctx, input) => {
      if (_ctx !== ctx) return failure('FORBIDDEN', 'fixture trusted context identity lost');
      const approval: Approval = { id: crypto.randomUUID(), actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'save_conversation', objectIds: [input.conversation.id], contentHash: await hashConversation(input.conversation), baseRevision: input.baseRevision, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
      approvals.set(approval.id, approval); return { ok: true, data: approval };
    },
    revokeApproval: async (_ctx, id) => { revoked.add(id); return { ok: true, data: { revoked: true } }; },
    saveConversation: async (_ctx, input, approval) => {
      if (revoked.has(approval.id) || !approvals.has(approval.id)) return failure('FORBIDDEN', 'fixture approval not active');
      if (!stored.has(input.id)) { creates++; stored.set(input.id, { ...input, sourceAlreadyPersisted: true, state: 'saved', issueNumber: creates + 100 }); }
      return { ok: true, data: stored.get(input.id)! };
    },
    readConversation: async (_ctx, id) => stored.has(id) ? { ok: true, data: stored.get(id)! } : failure('UNKNOWN_RESULT', 'fixture read not resolved', 'read_back', 'unknown'),
    readCandidates: async () => ({ ok: true, data: [] }),
    settings: async () => ({ ok: true, data: { aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } }),
    complete,
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => app.request(input instanceof Request ? input : input.toString(), init));
  const request = vi.fn((path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => apiRequest(path, init));
  const flow = new CaptureSaveFlow(request);
  const input: PreviewInput = { conversationId: 'fixture-new-capture', task: { id: 'fixture-task', question: '避免重复请求', constraints: [], intent: 'archive' }, source: { origin: 'paste' }, segments: [{ id: 'selected', role: 'user', text: '幂等键需要限定有效期。' }], personalInfoReviewed: false, scopeConfirmed: true };
  return { app, flow, request, input, approvals, revoked, stored, complete, creates: () => creates };
}
describe('C08/C12 client-to-API fixture workflow (not G1/live acceptance)', () => {
  it('preserves unknown approval registration through the HTTP error boundary', async () => {
    const { app } = fixture({ approveConversation: async () => { throw new Error('lost registry response'); } });
    const s = setup(); await s.flow.prepare(s.input);
    const response = await post(app, '/api/capture/approve', { conversation: s.flow.getSnapshot().preview!.conversation, baseRevision: 'new', confirmed: true });
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
  });
  it('carries only selected redacted source through preview, issued approval, write and readback', async () => {
    const s = setup();
    const parsed = parseText('user: CNB_TOKEN=fixture-secret\nassistant: UNSELECTED_PRIVATE_FIXTURE', 'source');
    if (!parsed.ok) throw new Error('fixture parse failed');
    const selected = [parsed.data.segments[0]!]; const scan = scanSegments(selected);
    if (!scan.ok) throw new Error('fixture scan failed');
    const masked = prepareContent(selected, scan.data.findings.map((f) => f.id), true);
    if (!masked.ok) throw new Error('fixture redaction failed');
    await s.flow.prepare({ ...s.input, segments: masked.data });
    expect(s.flow.getSnapshot().phase).toBe('ready');
    expect(s.creates()).toBe(0); expect(s.approvals.size).toBe(0);
    await s.flow.save();
    expect(s.flow.getSnapshot()).toMatchObject({ phase: 'saved', mode: 'fixture' });
    expect(s.creates()).toBe(1); expect(s.complete).not.toHaveBeenCalled();
    const body = JSON.stringify([...s.stored.values()]);
    const requests = JSON.stringify(s.request.mock.calls);
    expect(body).not.toContain('fixture-secret'); expect(body).not.toContain('UNSELECTED_PRIVATE_FIXTURE');
    expect(requests).not.toContain('fixture-secret'); expect(requests).not.toContain('UNSELECTED_PRIVATE_FIXTURE');
    expect(s.flow.getSnapshot().saved?.segments.map((part) => part.id)).toEqual(selected.map((part) => part.id));
  });
  it('recovers a lost HTTP save response through GET without a second approval or write', async () => {
    const s = setup(); const normal = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => { const response = await normal(path, init); if (path === '/api/capture/save') throw new Error('fixture lost HTTP response'); return response; });
    await s.flow.prepare(s.input); await s.flow.save();
    expect(s.flow.getSnapshot().phase).toBe('unknown'); expect(s.creates()).toBe(1);
    await s.flow.save(); await s.flow.readBack();
    expect(s.flow.getSnapshot().phase).toBe('saved'); expect(s.approvals.size).toBe(1); expect(s.creates()).toBe(1);
  });
  it('revokes a real fixture API approval received after local cancellation before any write', async () => {
    const s = setup(); await s.flow.prepare(s.input); const normal = s.request.getMockImplementation()!;
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    s.request.mockImplementation(async (path, init) => { const result = await normal(path, init); if (path === '/api/capture/approve') { entered(); await gate; } return result; });
    const pending = s.flow.save();
    try { await started; await s.flow.cancel(); } finally { release(); }
    await pending;
    expect(s.approvals.size).toBe(1); expect(s.revoked.size).toBe(1); expect(s.creates()).toBe(0); expect(s.flow.getSnapshot().saved).toBeNull();
  });
  it('keeps saved source and manual handoff data available with AI disabled', async () => {
    const s = setup(); await s.flow.prepare(s.input); await s.flow.save();
    const state = s.flow.getSnapshot();
    const model = await post(s.app, `/api/capture/${s.input.conversationId}/model-preview`, { task: state.preview!.task, segmentIds: ['selected'], scopeConfirmed: true });
    expect(model.status).toBe(403);
    const response = await s.app.request(`/api/capture/${s.input.conversationId}/candidates`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { conversationId: s.input.conversationId, state: 'unverified', handoffHref: `#handoff?conversationId=${s.input.conversationId}` }, meta: { mode: 'fixture' } });
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('keeps manual mask literals and excluded source out of every HTTP save request and stored receipt', async () => {
    const s = setup();
    const literal = '内部项目代号A97';
    const parsed = parseText(`user: ${literal}使用稳定ID；${literal}仍需测试。\nassistant: UNSELECTED_PRIVATE_FIXTURE`, 'manual-source');
    if (!parsed.ok) throw new Error('fixture parse failed');
    const selected = [parsed.data.segments[0]!];
    const masked = prepareContent(selected, [], false, [{ id: 'page-local-mask', segmentId: selected[0]!.id, text: literal }]);
    if (!masked.ok) throw new Error('fixture manual mask failed');
    await s.flow.prepare({ ...s.input, segments: masked.data });
    expect(s.flow.getSnapshot().phase).toBe('ready'); expect(s.approvals.size).toBe(0); expect(s.creates()).toBe(0);
    await s.flow.save();
    expect(s.flow.getSnapshot().phase).toBe('saved');
    for (const text of [JSON.stringify(s.request.mock.calls), JSON.stringify([...s.stored.values()])]) {
      expect(text).not.toContain(literal); expect(text).not.toContain('page-local-mask'); expect(text).not.toContain('UNSELECTED_PRIVATE_FIXTURE');
      expect(text).toContain('[已遮盖]');
    }
    expect(s.flow.getSnapshot().saved?.segments).toEqual(masked.data);
    expect(selected[0]!.text).toContain(literal); expect(s.complete).not.toHaveBeenCalled();
  });
});
