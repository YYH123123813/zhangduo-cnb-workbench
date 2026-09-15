import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../app/api-client';
import type { ApiResponse } from '../../contracts/api';
import { unavailable } from '../../contracts/api';
import type { Approval, Candidate, Settings } from '../../contracts/domain';
import { canonicalJson, hashConversation, hashModelInput } from '../../contracts/hash';
import type { Services } from '../../contracts/ports';
import { conversation, ctx, fixture } from './fixtures.test-support';
import type { ModelPreview, ModelScope } from './model-input';
import { checkDeliveryReceipt, sendModelInput } from './model-send';
import { failure } from './result';
import type { CandidateState } from '../../contracts/candidates';

afterEach(() => { vi.restoreAllMocks(); });

async function setup() {
  const value = { ...conversation, segments: [{ id: 'selected', role: 'user' as const, text: '重复写入应使用稳定操作ID。' }, { id: 'excluded', role: 'source' as const, text: 'UNSELECTED_PRIVATE_FIXTURE' }] };
  value.contentHash = await hashConversation(value);
  let candidates: Candidate[] = [];
  let batch: CandidateState = { conversationId: value.id, conversationHash: value.contentHash, candidates: [], revision: 0, state: 'missing', retentionDays: 7 };
  const settings: Settings = { aiExtraction: true, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false };
  const approvals = new Map<string, Approval>(); const revoked = new Set<string>();
  const approveModel = vi.fn<NonNullable<Services['approveModel']>>(async (identity, input) => {
    if (identity !== ctx) return failure('FORBIDDEN', 'fixture trusted context lost');
    const approval: Approval = { id: crypto.randomUUID(), workspaceId: ctx.workspaceId, actorId: ctx.actorId, purpose: 'model_input', objectIds: input.objectIds, baseRevision: input.baseRevision, contentHash: await hashModelInput(input.input), approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    approvals.set(approval.id, approval); return { ok: true, data: approval };
  });
  const complete = vi.fn<Services['complete']>(async (identity, input) => {
    if (identity !== ctx || revoked.has(input.approval.id) || canonicalJson(approvals.get(input.approval.id)) !== canonicalJson(input.approval) || await hashModelInput(input) !== input.approval.contentHash) return failure('FORBIDDEN', 'fixture approval inactive');
    return { ok: true, data: { modelId: 'fixture-only-model', generatedAt: new Date().toISOString(), value: { candidates: [{ title: '稳定操作ID', question: '如何避免重复写入？', claim: '重复写入应使用稳定操作ID。', kind: 'method', whyKeep: '复用请求去重策略', uncertainties: ['仍需验证有效期'], spans: [{ segmentId: 'selected', start: 0, end: value.segments[0]!.text.length, quote: value.segments[0]!.text }] }] } } };
  });
  const saveCandidates = vi.fn<Services['saveCandidates']>(async (identity, id, input, options) => {
    if (identity !== ctx || id !== value.id) return failure('FORBIDDEN', 'fixture candidate scope mismatch');
    candidates = structuredClone(input); batch = { ...batch, candidates, state: 'available', revision: 1, modelApprovalId: options!.modelApproval.id, expiresAt: new Date(Date.now() + 86400000).toISOString() }; return { ok: true, data: structuredClone(candidates) };
  });
  const readCandidates = vi.fn<Services['readCandidates']>(async () => ({ ok: true, data: structuredClone(candidates) }));
  const readCandidateState = vi.fn<NonNullable<Services['readCandidateState']>>(async () => ({ ok: true, data: structuredClone(batch) }));
  const commit = vi.fn();
  const { app, services } = fixture({ approveModel, complete, saveCandidates, readCandidates, commit,
    readCandidateState, readModelOperation: async () => ({ ok: true, data: null }),
    readConversation: async () => ({ ok: true, data: structuredClone(value) }),
    settings: async () => ({ ok: true, data: { ...settings } }),
    revokeApproval: async (_ctx, id) => { revoked.add(id); return { ok: true, data: { revoked: true } }; },
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => app.request(input instanceof Request ? input : input.toString(), init));
  const request = vi.fn((path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => apiRequest(path, init));
  const scope: ModelScope = { task: { id: value.taskId, workspaceId: ctx.workspaceId, question: '如何避免重复写入？', constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() }, segmentIds: ['selected'], scopeConfirmed: true };
  const response = await apiRequest<ModelPreview>(`/api/capture/${value.id}/model-preview`, { method: 'POST', body: JSON.stringify(scope) });
  if (!response.ok) throw new Error('fixture preview failed');
  const controller = new AbortController(); const onSent = vi.fn();
  return { value, scope, preview: response.data, services, settings, approveModel, complete, saveCandidates, readCandidates, readCandidateState, commit, approvals, revoked, request, controller, onSent,
    send: () => sendModelInput(request, value, scope, response.data, controller.signal, onSent),
    read: () => apiRequest<unknown>(`/api/capture/${value.id}/candidates`),
  };
}

describe('C09/C12 client-to-HTTP model workflow (Services fixture, not G1/live)', () => {
  it('sends exactly the displayed input and reads proposed, unverified candidates back through the same HTTP API', async () => {
    const s = await setup();
    expect(s.approveModel).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled(); expect(s.saveCandidates).not.toHaveBeenCalled();
    const result = await s.send();
    expect(result).toMatchObject({ ok: true, data: { conversationId: s.value.id, conversationHash: s.value.contentHash, state: 'saved', handoffHref: `#handoff?conversationId=${s.value.id}`, candidates: [{ state: 'proposed', sources: [{ support: 'unverified' }] }] } });
    expect(s.approveModel).toHaveBeenCalledOnce(); expect(s.complete).toHaveBeenCalledOnce(); expect(s.saveCandidates).toHaveBeenCalledOnce();
    expect(s.complete.mock.calls[0]![0]).toBe(ctx);
    expect(s.complete.mock.calls[0]![1]).toMatchObject(s.preview.input);
    expect(JSON.stringify(s.approveModel.mock.calls)).not.toContain('UNSELECTED_PRIVATE_FIXTURE');
    expect(JSON.stringify(s.complete.mock.calls)).not.toContain('UNSELECTED_PRIVATE_FIXTURE');
    const read = await s.read();
    if (!read.ok || !result.ok) throw new Error('fixture delivery failed');
    expect(await checkDeliveryReceipt(read.data, s.value)).toMatchObject({ ok: true, data: { candidates: result.data.candidates, state: 'existing' } });
    expect(s.readCandidateState.mock.calls.length).toBeGreaterThanOrEqual(4); expect(s.complete).toHaveBeenCalledOnce(); expect(s.commit).not.toHaveBeenCalled();
  });
  it('refuses a source changed after preview without issuing approval or calling the model', async () => {
    const s = await setup(); s.value.segments[0]!.text = '新的未预览来源'; s.value.contentHash = await hashConversation(s.value);
    expect(await s.send()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.approveModel).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled(); expect(s.saveCandidates).not.toHaveBeenCalled();
  });
  it('revokes a late HTTP approval after stopping and never enters extraction', async () => {
    const s = await setup(); const normal = s.request.getMockImplementation()!;
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    s.request.mockImplementation(async (path, init) => { const result = await normal(path, init); if (path.endsWith('/model-approve')) { entered(); await gate; } return result; });
    const pending = s.send();
    try { await started; s.controller.abort(); } finally { release(); }
    expect(await pending).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.approvals.size).toBe(1); expect(s.revoked.size).toBe(1); expect(s.complete).not.toHaveBeenCalled(); expect(s.onSent).not.toHaveBeenCalled();
  });
  it('recovers lost extraction response by a read without issuing another model approval or write', async () => {
    const s = await setup(); const normal = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => { const response = await normal(path, init); if (path.endsWith('/extract')) throw new Error('fixture lost response'); return response; });
    expect(await s.send()).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    const read = await s.read(); if (!read.ok) throw new Error('fixture readback failed');
    expect(await checkDeliveryReceipt(read.data, s.value)).toMatchObject({ ok: true, data: { state: 'existing', candidates: [{ state: 'proposed' }] } });
    expect(s.approveModel).toHaveBeenCalledOnce(); expect(s.complete).toHaveBeenCalledOnce(); expect(s.saveCandidates).toHaveBeenCalledOnce();
  });
  it('does not call the model when candidate storage or the approval provider is unconfigured', async () => {
    const s = await setup(); s.services.readCandidateState = async () => unavailable();
    expect(await s.send()).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
    expect(s.complete).not.toHaveBeenCalled(); expect(s.saveCandidates).not.toHaveBeenCalled();
    s.services.approveModel = async () => unavailable();
    expect(await s.send()).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('checks the AI setting again if it changes while approval is returning', async () => {
    const s = await setup(); const normal = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => { const response = await normal(path, init); if (path.endsWith('/model-approve')) s.settings.aiExtraction = false; return response; });
    expect(await s.send()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.approveModel).toHaveBeenCalledOnce(); expect(s.complete).not.toHaveBeenCalled(); expect(s.saveCandidates).not.toHaveBeenCalled();
    expect(await s.read()).toMatchObject({ ok: true, data: { state: 'missing', conversationId: s.value.id } });
  });
});
