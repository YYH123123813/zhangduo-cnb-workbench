import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import type { ApiResponse } from '../../contracts/api';
import type { Approval, Candidate, Conversation } from '../../contracts/domain';
import { hashSettings } from '../../contracts/hash';
import { createServices } from '../../platform/services';
import { OperationJournal } from '../../platform/journal';
import { ApprovalAuthority } from '../../platform/approvals';
import type { ModelTransport } from '../../platform/model';
import type { ModelPreview, ModelScope } from './model-input';
import type { CapturePreview } from './preview';
import type { DeliveryReceipt } from './delivery';
import { prepareContent } from './redaction';
import { scanSegments } from './privacy';
import { CaptureModelFlow } from './model-flow';
import { HashNavigation } from '../../app/routing';
import { readModelRecovery } from './model-recovery';
import { createApp } from '../../server/app';
import { CaptureSaveFlow } from './save-flow';
import type { PreviewInput } from './preview';
import { contentHash } from '../../contracts/hash';
import { ConversationApprovalRequestSchema } from '../../contracts/approval';
import { ModelApprovalRequestSchema } from '../../contracts/model';
import type { DraftSaveOptions, DraftState, ReviewProgress } from '../../contracts/handoff';
import { handoffHref, manualHandoffHref } from './links';
import { CaptureTaskFlow } from './task-storage';
import { taskDraftFromContext, taskForStorage, taskForStorageAtState } from './task';
import type { TaskContext } from '../../contracts/domain';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
async function setup(persistent = false) {
  let file = ':memory:';
  if (persistent) { mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/capture-platform-fixture-')); file = join(directory, 'state.sqlite'); cleanup.push(() => rmSync(directory, { recursive: true, force: true })); }
  const base = await platformFixture(file); let activeJournal = base.journal; cleanup.push(() => activeJournal.close());
  const remote = [{ number: '7', title: 'UNSELECTED_FIXTURE_TITLE', body: '重复请求保持稳定ID。\nCNB_TOKEN=fixture-private-value', invisible: true, created_at: new Date().toISOString() }];
  const original = base.transport.getMockImplementation()!; let loseWrite = false;
  base.transport.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/-/issues') && init?.method === 'POST') {
      const issue = { ...JSON.parse(String(init.body)), number: String(100 + remote.length), created_at: new Date().toISOString() }; remote.push(issue);
      if (loseWrite) throw new Error('Synthetic lost Issue response');
      return Response.json(issue, { status: 201 });
    }
    if (url.pathname.endsWith('/-/issues')) return Response.json(remote);
    const match = /\/-\/issues\/(\d+)$/.exec(url.pathname);
    if (match) { const issue = remote.find((row) => row.number === match[1]); return Response.json(issue ?? {}, { status: issue ? 200 : 404 }); }
    return original(input, init);
  });
  let empty = false;
  const complete = vi.fn<ModelTransport['complete']>(async (_ctx, input) => {
    const segment = JSON.parse(input.text).untrustedSegments[0];
    return { ok: true, data: { modelId: 'fixture-actual-transport', generatedAt: new Date().toISOString(), value: { candidates: empty ? [] : [{ title: '稳定操作ID', question: '如何避免重复？', claim: '重复操作保留稳定ID。', kind: 'method', whyKeep: '检查请求恢复', uncertainties: ['仍需验证有效期'], spans: [{ segmentId: segment.id, start: 0, end: segment.text.length, quote: segment.text }] }] } } };
  });
  const model: ModelTransport = { mode: 'fixture', complete };
  let services = createServices({ ...base.options, model });
  let app = createApp(services);
  async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<ApiResponse<T>> {
    const response = await app.request(path, { method, headers: base.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return response.json();
  }
  async function setAI(enabled: boolean) {
    const state = await services.settingsState!(base.ctx); if (!state.ok) throw new Error('Expected settings');
    const settings = { ...state.data.settings, aiExtraction: enabled };
    const approval = await services.approveGovernance!(base.ctx, { purpose: 'settings', settings, baseRevision: base.base, expectedSettingsHash: await hashSettings(base.ctx.workspaceId, base.base, state.data.settings), expectedSettingsRevision: state.data.revision, confirmed: true });
    if (!approval.ok) throw new Error('Expected setting approval'); expect((await services.saveSettings(base.ctx, settings, approval.data)).ok).toBe(true);
  }
  async function saveSource() {
    const selected = await call<Conversation>('/api/capture/issue', { issueNumber: 7, selected: true }); if (!selected.ok) throw new Error('Expected Issue');
    const segments = [selected.data.segments[1]!], scan = scanSegments(segments); if (!scan.ok) throw new Error('Expected scan');
    const masked = prepareContent(segments, scan.data.findings.map((finding) => finding.id), true); if (!masked.ok) throw new Error('Expected mask');
    const preview = await call<CapturePreview>('/api/capture/preview', { conversationId: 'fixture-selected-capture', task: { id: 'fixture-selected-task', question: '减少重复写入', constraints: [], intent: 'propose' }, source: { origin: 'cnb_issue', issueNumber: 7, sourceRevision: selected.data.contentHash }, segments: masked.data, personalInfoReviewed: true, scopeConfirmed: true });
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    const approval = await call<Approval>('/api/capture/approve', { conversation: preview.data.conversation, baseRevision: 'new', confirmed: true }); if (!approval.ok) throw new Error(JSON.stringify(approval.error));
    const saved = await call<Conversation>('/api/capture/save', { conversation: preview.data.conversation, approval: approval.data, confirmed: true });
    return { preview: preview.data, approval: approval.data, saved };
  }
  async function approveExtraction(value: CapturePreview) {
    const scope = { task: value.task, segmentIds: value.conversation.segments.map((segment) => segment.id), scopeConfirmed: true };
    const preview = await call<ModelPreview>(`/api/capture/${value.conversation.id}/model-preview`, scope); if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    const issued = await call<Approval>(`/api/capture/${value.conversation.id}/model-approve`, { ...scope, expectedInputHash: preview.data.approvalRequest.contentHash, expectedConversationHash: preview.data.approvalRequest.baseRevision, retentionDays: 7, confirmed: true });
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    return { ...scope, approval: issued.data, retentionDays: 7, confirmed: true };
  }
  return { base, remote, complete, call, setAI, saveSource, approveExtraction, services: () => services, empty: () => { empty = true; }, loseWrite: () => { loseWrite = true; },
    app: () => app,
    fork: () => {
      const journal = persistent ? new OperationJournal(file, { fixture: true }) : activeJournal;
      if (persistent) cleanup.push(() => journal.close());
      const other = createApp(createServices({ ...base.options, journal, approvalAuthority: new ApprovalAuthority(base.sessions, journal), model }));
      return async <T = DeliveryReceipt>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<ApiResponse<T>> =>
        (await other.request(path, { headers: base.headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
    },
    reopen: (now = Date.now) => { activeJournal.close(); activeJournal = new OperationJournal(file, { fixture: true }); services = createServices({ ...base.options, journal: activeJournal, approvalAuthority: new ApprovalAuthority(base.sessions, activeJournal, now), model }); app = createApp(services); },
  };
}

describe('C08/C10 actual shared Services with synthetic external transport (not live/G1)', () => {
  it('continues an explicitly recovered save after SQLite reopen and verifies a lost Issue response without repeating writes', async () => {
    const s = await setup(true);
    const input: PreviewInput = { conversationId: 'continued-original-save', task: { id: 'continued-task', question: 'Original question', constraints: [], intent: 'archive' }, source: { origin: 'paste' }, segments: [{ id: 'original-segment', role: 'user', text: 'Synthetic original source' }], personalInfoReviewed: true, scopeConfirmed: true };
    const transport = vi.fn(async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
      const response = await s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (path === '/api/capture/approve' && response.ok) throw Error('Synthetic lost original registration');
      return response;
    });
    const flow = new CaptureSaveFlow(transport); await flow.prepare(input); await flow.save();
    const identity = flow.getSnapshot().registrationIdentity!;
    s.reopen(); await flow.readApprovalRegistration();
    const approvalId = flow.getSnapshot().approvalId;
    expect(s.remote).toHaveLength(1); expect(flow.getSnapshot().sent).toBe(false);
    s.loseWrite(); await Promise.all([flow.continueOriginal(), flow.continueOriginal()]);
    expect(flow.getSnapshot()).toMatchObject({ phase: 'unknown', sent: true, approvalId, registrationIdentity: identity });
    s.reopen(); await flow.continueOriginal(); await flow.readBack();
    expect(flow.getSnapshot()).toMatchObject({ phase: 'saved', saved: { id: input.conversationId, issueNumber: 101 } });
    expect(transport.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
    expect(transport.mock.calls.filter(([path]) => path === '/api/capture/save')).toHaveLength(1);
    expect(s.remote).toHaveLength(2); expect(s.complete).not.toHaveBeenCalled();
  });
  it.each(['success', 'lost_permission', 'ai_disabled'])('continues the original model request after SQLite reopen with %s and no new registration', async (fault) => {
    const s = await setup(true), source = await s.saveSource(); await s.setAI(true);
    if (!source.saved.ok) throw Error('Expected saved fixture source');
    const conversation = source.saved.data, scope: ModelScope = { task: source.preview.task, segmentIds: conversation.segments.map((segment) => segment.id), scopeConfirmed: true };
    const preview = await s.call<ModelPreview>(`/api/capture/${conversation.id}/model-preview`, scope);
    if (!preview.ok) throw Error('Expected model preview');
    const transport = vi.fn(async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
      const response = await s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (path.endsWith('/model-approve') && response.ok) throw Error('Synthetic lost original registration');
      return response;
    });
    const flow = new CaptureModelFlow(transport, conversation); await flow.send(scope, preview.data);
    const identity = flow.getSnapshot().registrationIdentity!;
    s.reopen(); await flow.readApprovalRegistration();
    const approvalId = flow.getSnapshot().approval?.id;
    expect(s.complete).not.toHaveBeenCalled();
    if (fault === 'lost_permission') {
      const workspace = await s.services().workspace(s.base.ctx); if (!workspace.ok) throw Error('Expected workspace');
      s.base.headers.Authorization = `Bearer ${s.base.sessions.issue({ actorId: s.base.ctx.actorId, workspace: workspace.data, scopes: ['workspace:read'] })}`;
    }
    if (fault === 'ai_disabled') await s.setAI(false);
    await Promise.all([flow.continueOriginal(scope, preview.data), flow.continueOriginal(scope, preview.data)]);
    expect(flow.getSnapshot().registrationIdentity).toEqual(identity);
    expect(transport.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
    if (fault !== 'success') {
      expect(s.complete).not.toHaveBeenCalled(); expect(flow.getSnapshot().delivery).toBeNull();
      expect(flow.getLeaveState()).toBe('blocked');
    } else {
      expect(flow.getSnapshot()).toMatchObject({ phase: 'complete', approval: { id: approvalId }, delivery: { batch: { revision: 1, modelApprovalId: approvalId } } });
      s.reopen(); await flow.readBack(); await flow.continueOriginal(scope, preview.data);
      expect(flow.getSnapshot()).toMatchObject({ phase: 'complete', delivery: { batch: { revision: 1, modelApprovalId: approvalId } } });
      expect(s.complete).toHaveBeenCalledOnce();
      expect(transport.mock.calls.filter(([path]) => path.endsWith('/extract'))).toHaveLength(1);
    }
    expect(s.base.git.publish).not.toHaveBeenCalled();
  });
  it.each(['lost', 'malformed', 'unknown', 'expired', 'lost_permission'])('recovers a model registration after %s using shared HTTP and the exact original schema hash', async (fault) => {
    const s = await setup(true), source = await s.saveSource(); await s.setAI(true);
    if (!source.saved.ok) throw Error('Expected saved fixture source');
    const conversation = source.saved.data, scope: ModelScope = { task: source.preview.task, segmentIds: conversation.segments.map((segment) => segment.id), scopeConfirmed: true };
    const preview = await s.call<ModelPreview>(`/api/capture/${conversation.id}/model-preview`, scope);
    if (!preview.ok) throw Error('Expected model preview');
    let original: Approval | null = null;
    const transport = vi.fn(async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
      const result = await s.call<Approval>(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (path.endsWith('/model-approve') && result.ok) {
        original = result.data;
        if (fault === 'malformed') return { ...result, data: {} };
        if (fault === 'unknown') return { ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', nextAction: 'read_approval_state', message: 'Synthetic unknown', retryable: false }, meta: result.meta };
        throw Error('Synthetic lost model registration');
      }
      return result;
    });
    const flow = new CaptureModelFlow(transport, conversation);
    await flow.send(scope, preview.data); const identity = flow.getSnapshot().registrationIdentity!;
    expect(identity.requestHash).toBe(await contentHash(ModelApprovalRequestSchema.parse({ input: preview.data.input, objectIds: preview.data.approvalRequest.objectIds, baseRevision: conversation.contentHash, conversationId: conversation.id, operationId: identity.operationId, confirmed: true })));
    expect(identity.requestHash).not.toBe(await contentHash(JSON.parse(String(transport.mock.calls.find(([path]) => path.endsWith('/model-approve'))![1]!.body))));
    s.reopen(fault === 'expired' ? () => Date.now() + 3600000 : Date.now);
    if (fault === 'lost_permission') {
      const workspace = await s.services().workspace(s.base.ctx); if (!workspace.ok) throw Error('Expected fixture workspace');
      s.base.headers.Authorization = `Bearer ${s.base.sessions.issue({ actorId: s.base.ctx.actorId, workspace: workspace.data, scopes: ['workspace:read'] })}`;
    }
    const before = s.base.transport.mock.calls.length;
    await flow.readApprovalRegistration();
    expect(s.base.transport).toHaveBeenCalledTimes(before);
    if (fault === 'lost_permission') expect(flow.getSnapshot()).toMatchObject({ phase: 'unknown', registration: 'unknown', approval: null });
    else expect(flow.getSnapshot()).toMatchObject({ approval: original, registration: fault === 'expired' ? 'expired' : 'active', sent: false, delivery: null });
    expect(flow.getLeaveState()).toBe(fault === 'expired' ? 'clean' : 'blocked');
    expect(transport.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
    expect(transport.mock.calls.some(([path]) => path.endsWith('/extract') || path.endsWith('/revoke'))).toBe(false);
    expect(s.complete).not.toHaveBeenCalled(); expect(s.remote).toHaveLength(2);
    if (!['expired', 'lost_permission'].includes(fault)) {
      await flow.cancel(); expect(flow.getLeaveState()).toBe('clean');
      expect(await s.call(`/api/workspace/approval-registrations/model_input/${identity.operationId}?modelPurpose=extract`)).toMatchObject({ ok: true, data: { status: 'revoked', approval: original } });
    }
  });
  it.each(['lost', 'malformed', 'unknown'])('recovers the original save registration after a %s response and SQLite reopen, then explicitly revokes', async (fault) => {
    const s = await setup(true);
    const input: PreviewInput = { conversationId: 'registration-source', task: { id: 'registration-task', question: 'Original task', constraints: [], intent: 'archive' }, source: { origin: 'paste' }, segments: [{ id: 'selected', role: 'user', text: 'Synthetic selected source' }], personalInfoReviewed: true, scopeConfirmed: true };
    let original: Approval | null = null;
    const transport = vi.fn(async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
      const result = await s.call<Approval>(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (path === '/api/capture/approve' && result.ok) {
        original = result.data;
        if (fault === 'lost') throw Error('Synthetic lost approval response');
        if (fault === 'malformed') return { ...result, data: {} };
        return { ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', nextAction: 'read_approval_state', message: 'Synthetic unknown', retryable: false }, meta: result.meta };
      }
      return result;
    });
    const flow = new CaptureSaveFlow(transport); await flow.prepare(input); await flow.save();
    const identity = flow.getSnapshot().registrationIdentity!;
    const body = ConversationApprovalRequestSchema.parse(JSON.parse(String(transport.mock.calls.find(([path]) => path === '/api/capture/approve')![1]!.body)));
    expect(identity.requestHash).toBe(await contentHash(body));
    expect(flow.getSnapshot()).toMatchObject({ phase: 'unknown', approvalState: 'unknown', sent: false });
    s.reopen(); const before = s.base.transport.mock.calls.length;
    await flow.readApprovalRegistration(); await flow.save();
    expect(flow.getSnapshot()).toMatchObject({ approvalId: original!.id, approvalState: 'active', sent: false });
    expect(flow.getLeaveState()).toBe('blocked'); expect(s.base.transport).toHaveBeenCalledTimes(before);
    expect(transport.mock.calls.filter(([path]) => path === '/api/capture/approve')).toHaveLength(1);
    expect(s.remote).toHaveLength(1); expect(s.complete).not.toHaveBeenCalled();
    await flow.cancel();
    expect(await s.call(`/api/workspace/approval-registrations/save_conversation/${identity.operationId}`)).toMatchObject({ ok: true, data: { status: 'revoked', approval: original, requestHash: identity.requestHash } });
    expect(flow.getLeaveState()).toBe('dirty');
  });
  it('saves a redacted existing-Issue subset separately then persists and rereads actual proposed candidates', async () => {
    const s = await setup(); const original = structuredClone(s.remote[0]); const saved = await s.saveSource();
    expect(saved.saved).toMatchObject({ ok: true, data: { sourceAlreadyPersisted: true, state: 'saved', issueNumber: 101 } });
    expect(s.remote[0]).toEqual(original); expect(s.remote).toHaveLength(2);
    expect(s.remote[1]!.body).not.toContain('UNSELECTED_FIXTURE_TITLE'); expect(s.remote[1]!.body).not.toContain('fixture-private-value');
    expect(s.complete).not.toHaveBeenCalled();
    await s.setAI(true); const request = await s.approveExtraction(saved.preview);
    const result = await s.call<DeliveryReceipt>(`/api/capture/${saved.preview.conversation.id}/extract`, request);
    expect(result).toMatchObject({ ok: true, data: { state: 'saved', batch: { state: 'available', revision: 1, retentionDays: 7, modelApprovalId: request.approval.id } } });
    if (!result.ok) return;
    expect(await s.services().readCandidates(s.base.ctx, saved.preview.conversation.id)).toEqual({ ok: true, data: result.data.candidates });
    expect(s.complete).toHaveBeenCalledOnce(); expect(s.base.git.publish).not.toHaveBeenCalled();
  });
  it('recovers an unknown actual Issue write by original ID without another create', async () => {
    const s = await setup(); s.loseWrite(); const saved = await s.saveSource();
    expect(saved.saved).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}`)).toMatchObject({ ok: true, data: { state: 'saved', id: saved.preview.conversation.id } });
    expect(s.remote).toHaveLength(2); expect(s.complete).not.toHaveBeenCalled();
  });
  it('recognizes a completed zero-candidate batch after SQLite reopen and never sends twice', async () => {
    const s = await setup(true); const saved = await s.saveSource(); await s.setAI(true); s.empty(); const request = await s.approveExtraction(saved.preview);
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}/extract`, request)).toMatchObject({ ok: true, data: { state: 'empty', batch: { revision: 1 } } });
    s.reopen();
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}/candidates`)).toMatchObject({ ok: true, data: { state: 'empty', batch: { state: 'available', modelApprovalId: request.approval.id } } });
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}/extract`, request)).toMatchObject({ ok: true, data: { state: 'empty' } });
    expect(s.complete).toHaveBeenCalledOnce();
    await s.setAI(false);
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}/model-operations/${request.approval.id}`)).toMatchObject({ ok: true, data: { state: 'done', modelId: 'fixture-actual-transport' } });
  });
  it('rejects revoked actual approval and preserves source after in-flight AI shutdown', async () => {
    const s = await setup(); const saved = await s.saveSource(); await s.setAI(true); const request = await s.approveExtraction(saved.preview);
    await s.call(`/api/capture/approvals/${request.approval.id}/revoke`, {});
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}/extract`, request)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.complete).not.toHaveBeenCalled();
    const next = await s.approveExtraction(saved.preview), normal = s.complete.getMockImplementation()!;
    s.complete.mockImplementation(async (...args) => { const result = await normal(...args); await s.setAI(false); return result; });
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}/extract`, next)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}/candidates`)).toMatchObject({ ok: true, data: { state: 'missing' } });
    expect(await s.call(`/api/capture/${saved.preview.conversation.id}`)).toMatchObject({ ok: true });
  });
  it('uses the client recovery flow and shared navigation after a lost actual candidate response and SQLite reopen', async () => {
    const s = await setup(true), source = await s.saveSource(); await s.setAI(true); s.empty();
    if (!source.saved.ok) throw new Error('Expected saved fixture source');
    const conversation = source.saved.data, scope: ModelScope = { task: source.preview.task, segmentIds: conversation.segments.map((part) => part.id), scopeConfirmed: true };
    const preview = await s.call<ModelPreview>(`/api/capture/${conversation.id}/model-preview`, scope); if (!preview.ok) throw new Error('Expected model preview');
    const transport = vi.fn(async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
      const response = await s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (path.endsWith('/extract')) throw new Error('Synthetic lost response after durable candidate save');
      return response;
    });
    const flow = new CaptureModelFlow(transport, conversation), navigation = new HashNavigation('#capture', { write: vi.fn(), confirmDiscard: () => true });
    navigation.registerLeaveGuard({ owner: 'capture', getState: flow.getLeaveState });
    await flow.send(scope, preview.data); expect(flow.getLeaveState()).toBe('blocked');
    expect(navigation.navigate(`#handoff?conversationId=${conversation.id}`)).toBe(false);
    const approvalId = flow.getSnapshot().approval!.id, id = flow.getSnapshot().registrationIdentity!.operationId; s.reopen(); await flow.readBack();
    expect(flow.getSnapshot()).toMatchObject({ phase: 'complete', delivery: { state: 'empty' } });
    expect(navigation.navigate(`#handoff?conversationId=${conversation.id}`)).toBe(true);
    const restored = new CaptureModelFlow(transport, conversation); await restored.restore(id);
    expect(restored.getSnapshot()).toMatchObject({ phase: 'complete', operation: { approvalId, state: 'done' } });
    expect(id).not.toBe(approvalId);
    expect(transport.mock.calls.filter(([path]) => path === `/api/workspace/operation-recovery/model/${id}?modelPurpose=extract`)).toHaveLength(2);
    expect(transport.mock.calls.some(([path]) => path === `/api/workspace/operation-recovery/model/${approvalId}?modelPurpose=extract`)).toBe(false);
    await restored.send(scope, preview.data); expect(s.complete).toHaveBeenCalledOnce();
    expect(transport.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
    expect(s.base.git.publish).not.toHaveBeenCalled();
  });
  it('does not overwrite the winning candidate batch when two independently approved sessions finish together', async () => {
    const s = await setup(), source = await s.saveSource(); await s.setAI(true);
    const first = await s.approveExtraction(source.preview), second = await s.approveExtraction(source.preview), other = s.fork();
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; }), normal = s.complete.getMockImplementation()!;
    s.complete.mockImplementation(async (...args) => { await barrier; return normal(...args); });
    const path = `/api/capture/${source.preview.conversation.id}/extract`, a = s.call<DeliveryReceipt>(path, first), b = other(path, second);
    try { await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2)); } finally { release(); }
    const results = await Promise.all([a, b]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const winner = results.find((result) => result.ok); if (!winner?.ok) throw new Error('Expected one committed batch');
    expect(await s.call(`/api/capture/${source.preview.conversation.id}/candidates`)).toMatchObject({ ok: true, data: { batch: { revision: 1, modelApprovalId: winner.data.batch!.modelApprovalId }, candidates: winner.data.candidates } });
    expect(s.base.git.publish).not.toHaveBeenCalled();
  });
  it.each(['invalid_reference', 'lost_save_response'])('distinguishes %s through actual Services and SQLite reopen without sending again', async (fault) => {
    const s = await setup(true), source = await s.saveSource(); await s.setAI(true);
    if (!source.saved.ok) throw new Error('Expected saved source');
    const request = await s.approveExtraction(source.preview), normal = s.complete.getMockImplementation()!;
    const save = s.services().saveCandidates.bind(s.services());
    const saves = vi.spyOn(s.services(), 'saveCandidates').mockImplementation(async (...args) => {
      const result = await save(...args);
      if (fault === 'lost_save_response' && result.ok) throw Error('Synthetic lost response from real CandidateStore');
      return result;
    });
    if (fault === 'invalid_reference') s.complete.mockImplementation(async (...args) => {
      const result = await normal(...args); if (!result.ok) return result;
      return { ok: true, data: { ...result.data, value: { candidates: [{ title: '错误引文', question: '问题', claim: '主张', kind: 'claim', whyKeep: '理由', uncertainties: [], spans: [{ segmentId: request.segmentIds[0]!, start: 0, end: 1, quote: '伪' }] }] } } };
    });
    const extracted = await s.call(`/api/capture/${source.saved.data.id}/extract`, request);
    expect(extracted).toMatchObject({ ok: false, error: { code: fault === 'invalid_reference' ? 'UPSTREAM' : 'UNKNOWN_RESULT' } });
    expect(saves).toHaveBeenCalledTimes(fault === 'invalid_reference' ? 0 : 1);
    s.reopen();
    const recovery = await readModelRecovery((path) => s.call(path), source.saved.data, request.approval);
    expect(recovery).toMatchObject({ ok: true, data: { state: fault === 'invalid_reference' ? 'rejected_without_save' : 'complete', stage: fault === 'invalid_reference' ? 'rejected_without_save' : 'saved_nonempty', operation: { state: 'done' }, delivery: { state: fault === 'invalid_reference' ? 'missing' : 'existing' } } });
    if (fault === 'lost_save_response') expect(recovery).toMatchObject({ data: { delivery: { batch: { modelApprovalId: request.approval.id, revision: 1, state: 'available' } } } });
    expect(s.complete).toHaveBeenCalledOnce(); expect(s.base.git.publish).not.toHaveBeenCalled();
  });
  it('W2-REQ-009: a rejected reference has a durable no-save terminal after restart', async () => {
    const s = await setup(true), source = await s.saveSource(); await s.setAI(true);
    if (!source.saved.ok) throw Error('Expected saved source');
    const request = await s.approveExtraction(source.preview);
    s.complete.mockResolvedValue({ ok: true, data: { modelId: 'fixture-rejected-source', generatedAt: new Date().toISOString(), value: { candidates: [{ title: 'Invalid reference', question: 'Question', claim: 'Claim', kind: 'claim', whyKeep: 'Test', uncertainties: [], spans: [{ segmentId: request.segmentIds[0]!, start: 0, end: 1, quote: 'INVALID' }] }] } } });
    expect(await s.call(`/api/capture/${source.saved.data.id}/extract`, request)).toMatchObject({ ok: false, error: { code: 'UPSTREAM' } });
    s.reopen();
    const recovery = await readModelRecovery((path) => s.call(path), source.saved.data, request.approval);
    expect(recovery).toMatchObject({ ok: true, data: { state: 'rejected_without_save' } });
  });
  it('W2-REQ-009: conversation discovery must block a new paid attempt after original IDs were lost', async () => {
    const s = await setup(true), source = await s.saveSource(); await s.setAI(true);
    if (!source.saved.ok) throw Error('Expected saved source');
    const conversation = source.saved.data, scope: ModelScope = { task: source.preview.task, segmentIds: conversation.segments.map((part) => part.id), scopeConfirmed: true };
    const preview = await s.call<ModelPreview>(`/api/capture/${conversation.id}/model-preview`, scope); if (!preview.ok) throw Error('Expected model preview');
    s.complete.mockResolvedValue({ ok: true, data: { modelId: 'fixture-invalid-reference', generatedAt: new Date().toISOString(), value: { candidates: [{ title: 'Invalid', question: 'Question', claim: 'Claim', kind: 'claim', whyKeep: 'Test', uncertainties: [], spans: [{ segmentId: scope.segmentIds[0]!, start: 0, end: 1, quote: 'INVALID' }] }] } } });
    const transport = vi.fn((path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined));
    const original = new CaptureModelFlow(transport, conversation); await original.send(scope, preview.data);
    expect(original.getLeaveState()).toBe('blocked'); expect(s.complete).toHaveBeenCalledOnce();
    s.reopen();
    const discovery = await s.call(`/api/workspace/conversations/${conversation.id}/extractions`);
    expect(discovery).toMatchObject({ ok: true, data: { conversationId: conversation.id, operations: [{ operationId: expect.any(String), stage: 'rejected_without_save' }], absenceIsFinal: false, retryAllowed: false } });
    const freshPage = new CaptureModelFlow(transport, conversation); await freshPage.discover();
    expect(freshPage.getSnapshot()).toMatchObject({ discovery: 'ready', discovered: [{ stage: 'rejected_without_save' }] });
    expect(freshPage.getLeaveState()).toBe('blocked');
    const discovered = freshPage.getSnapshot().discovered[0]!; await freshPage.restoreDiscovered(discovered);
    expect(freshPage.getSnapshot()).toMatchObject({ phase: 'rejected_without_save', stage: 'rejected_without_save', extraction: { operationId: discovered.operationId } });
    await freshPage.discover(); await freshPage.send(scope, preview.data);
    expect(s.complete).toHaveBeenCalledOnce();
    expect(transport.mock.calls.filter(([path]) => path.endsWith('/model-approve'))).toHaveLength(1);
    expect(transport.mock.calls.filter(([path]) => path.endsWith('/extract'))).toHaveLength(1);
  });
});

describe('G1 capture consumer through shared navigation, HTTP and SQLite (not browser/live)', () => {
  it.each(['candidate', 'manual', 'empty'])('hands the %s path to the same conversation, checks two-connection CAS, restart and lost permission', async (mode) => {
    const s = await setup(true), source = await s.saveSource();
    if (!source.saved.ok) throw Error('Expected saved source');
    const conversation = source.saved.data;
    const transport = async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
      const result = await s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (path.endsWith('/extract')) throw Error('Synthetic lost client extraction response');
      return result;
    };
    const flow = new CaptureModelFlow(transport, conversation), navigation = new HashNavigation('#capture', { write: vi.fn(), confirmDiscard: () => true });
    navigation.registerLeaveGuard({ owner: 'capture', getState: flow.getLeaveState });
    if (mode !== 'manual') {
      await s.setAI(true); if (mode === 'empty') s.empty();
      const scope: ModelScope = { task: source.preview.task, segmentIds: conversation.segments.map((part) => part.id), scopeConfirmed: true };
      const preview = await s.call<ModelPreview>(`/api/capture/${conversation.id}/model-preview`, scope); if (!preview.ok) throw Error('Expected model preview');
      await flow.send(scope, preview.data);
      expect(navigation.navigate(manualHandoffHref(conversation.id))).toBe(false);
      await flow.readBack(); expect(flow.getSnapshot().phase).toBe('complete');
    }
    const candidates = flow.getSnapshot().delivery?.candidates ?? [];
    const href = mode === 'candidate' ? handoffHref(conversation.id, candidates[0]!.id) : manualHandoffHref(conversation.id);
    expect(navigation.navigate(href)).toBe(true);
    expect(navigation.getSnapshot()).toMatchObject({ page: 'handoff', params: { conversationId: conversation.id, source: mode === 'candidate' ? 'candidate' : 'manual' } });
    type PublicReview = { conversation: Conversation; items: { draftId: string; nodeId: string; subject: Pick<Candidate, 'sources' | 'spans' | 'title' | 'question' | 'kind'> & { origin?: string } }[] };
    const path = `/api/handoff/${navigation.getSnapshot().params.conversationId}`;
    const review = mode === 'candidate' ? await s.call<PublicReview>(path) : await s.call<PublicReview>(`${path}/manual`, { segmentIds: [conversation.segments[0]!.id], expectedConversationHash: conversation.contentHash, confirmed: true });
    expect(review).toMatchObject({ ok: true, data: { conversation } }); if (!review.ok) throw Error('Expected same handoff source');
    const item = review.data.items[0]!;
    if (mode === 'candidate') expect(item.subject).toEqual(candidates[0]);
    else { expect(item.subject.origin).toBe('manual'); expect(item.subject).not.toHaveProperty('modelId'); }
    expect(await s.call(`${path}/draft-state?draftId=${item.draftId}`)).toMatchObject({ ok: true, data: { state: 'missing' } });
    const progress: ReviewProgress = { id: item.draftId, workspaceId: conversation.workspaceId, conversationId: conversation.id, nodeId: item.nodeId, baseRevision: s.base.base,
      disposition: 'later', title: mode === 'candidate' ? item.subject.title : 'G1 consumer review', question: mode === 'candidate' ? item.subject.question : source.preview.task.question,
      statement: '', kind: item.subject.kind, authorship: 'human_written', conditions: [], boundaries: [], sources: item.subject.sources, relations: [],
      relationInput: { targetId: '', type: '', direction: '', rationale: 'Unfinished relation', evidenceIds: [] } };
    const options: DraftSaveOptions = { operationId: 'g1-consumer-A', source: mode === 'candidate' ? { kind: 'candidate', candidateId: candidates[0]!.id } : { kind: 'manual', spans: item.subject.spans },
      expectedConversationHash: conversation.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
    expect(await s.call(`${path}/progress`, { progress, options: { ...options, confirmed: false } }, 'PUT')).toMatchObject({ ok: false });
    expect(await s.call(`${path}/draft-state?draftId=${item.draftId}`)).toMatchObject({ ok: true, data: { state: 'missing' } });
    const other = s.fork(), otherProgress = { ...progress, statement: 'Other session draft' };
    const results = await Promise.all([s.call<{ state: DraftState }>(`${path}/progress`, { progress, options }, 'PUT'), other<{ state: DraftState }>(`${path}/progress`, { progress: otherProgress, options: { ...options, operationId: 'g1-consumer-B' } }, 'PUT')]);
    expect(results.filter((result) => result.ok), JSON.stringify(results)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'CONFLICT' } });
    const winner = results[0]!.ok ? progress : otherProgress;
    s.reopen();
    expect(await s.call(`${path}/draft-state?draftId=${item.draftId}`)).toMatchObject({ ok: true, data: { revision: 1, source: options.source, document: { kind: 'progress', value: winner } } });
    expect(await s.call(`/api/capture/${conversation.id}`)).toMatchObject({ ok: true, data: conversation });
    expect(s.complete).toHaveBeenCalledTimes(mode === 'manual' ? 0 : 1); expect(s.remote).toHaveLength(2); expect(s.base.git.publish).not.toHaveBeenCalled();
    const workspace = await s.services().workspace(s.base.ctx); if (!workspace.ok) throw Error('Expected fixture workspace');
    s.base.headers.Authorization = `Bearer ${s.base.sessions.issue({ actorId: s.base.ctx.actorId, workspace: workspace.data, scopes: ['workspace:read'] })}`;
    const reads = s.base.transport.mock.calls.length;
    for (const endpoint of [`${path}?source=manual`, `${path}/draft-state?draftId=${item.draftId}`, `/api/capture/${conversation.id}`]) {
      const denied = await s.call(endpoint); expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(JSON.stringify(denied)).not.toContain(conversation.segments[0]!.text);
    }
    expect(s.base.transport).toHaveBeenCalledTimes(reads);
  });
  it('keeps cancellation before approval write-free and archive-only completion model-free', async () => {
    const s = await setup(true);
    const flow = new CaptureSaveFlow((path, init) => s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined));
    const input: PreviewInput = { conversationId: 'g1-archive-source', task: { id: 'g1-archive-task', question: 'Archive original source', constraints: [], intent: 'archive' }, source: { origin: 'paste' },
      segments: [{ id: 'selected', role: 'user', text: 'Synthetic source selected for archiving' }], personalInfoReviewed: true, scopeConfirmed: true };
    await flow.prepare(input); await flow.cancel();
    expect(s.remote).toHaveLength(1); expect(s.complete).not.toHaveBeenCalled();
    expect(s.base.journal.records(s.base.ctx.workspaceId, '@workspace', 'approval_registration:save_conversation')).toHaveLength(0);
    await flow.save(); expect(flow.getSnapshot().phase).toBe('saved');
    await flow.cancel(); expect(flow.getSnapshot().phase).toBe('saved');
    const saved = flow.getSnapshot().saved!; s.reopen();
    expect(await s.call(`/api/capture/${saved.id}`)).toMatchObject({ ok: true, data: saved });
    expect(await s.call(`/api/handoff/${saved.id}?source=manual`)).toMatchObject({ ok: true, data: { conversation: saved, items: [] } });
    expect(s.remote).toHaveLength(2); expect(s.complete).not.toHaveBeenCalled(); expect(s.base.git.publish).not.toHaveBeenCalled();
  });
});

describe('W2-REQ-006 capture task consumer with actual shared Services and SQLite', () => {
  it('refuses to preview stale task edits against a newer CAS until that exact task version is explicitly restored', async () => {
    const s = await setup(true), source = await s.saveSource(), other = s.fork();
    const transport = vi.fn((path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined));
    const flow = new CaptureTaskFlow(transport), task = source.preview.task;
    await flow.load(task.id, task.workspaceId); await flow.save(task, true);
    const snapshot = { task: flow.getSnapshot().remote!.task!, revision: flow.getSnapshot().remote!.revision };
    const draft = taskDraftFromContext(snapshot.task); if (!draft.ok) throw Error('Expected original task');
    const edited = { ...draft.data, question: 'My unsaved edit of revision A' };
    const second = new CaptureTaskFlow((path, init) => other(path, init?.body ? JSON.parse(String(init.body)) : undefined));
    await second.load(task.id, task.workspaceId); await second.save({ ...task, question: 'Revision B in another session' }, true);
    await flow.load(task.id, task.workspaceId);
    const remote = flow.getSnapshot().remote!;
    expect(await taskForStorageAtState(edited, remote, snapshot)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(transport.mock.calls.filter(([path]) => path === '/api/workspace/tasks')).toHaveLength(1);
    expect(remote).toMatchObject({ revision: 2, task: { question: 'Revision B in another session' } });
    const restoredDraft = taskDraftFromContext(remote.task!); if (!restoredDraft.ok) throw Error('Expected revision B');
    const confirmed = await taskForStorageAtState({ ...restoredDraft.data, question: 'Explicit edit after restoring B' }, remote, { task: remote.task!, revision: remote.revision });
    if (!confirmed.ok) throw Error('Expected current task preview');
    await flow.save(confirmed.data, true); s.reopen();
    const restored = new CaptureTaskFlow(transport); await restored.load(task.id, task.workspaceId);
    expect(restored.getSnapshot().remote).toMatchObject({ revision: 3, task: { question: 'Explicit edit after restoring B' } });
    expect(s.complete).not.toHaveBeenCalled(); expect(s.base.git.publish).not.toHaveBeenCalled();
  });
  it('keeps capture tasks temporary without consent, then recovers full original context after a lost write and restart', async () => {
    const s = await setup(true), source = await s.saveSource();
    s.base.initial.nodes[0]!.conditions = [{ id: 'original-premise', text: 'Original prerequisite', status: 'confirmed', evidenceIds: [] }];
    const task: TaskContext = { ...source.preview.task, constraints: [{ id: 'original-constraint', text: 'Original constraint', confirmedBy: s.base.ctx.actorId }],
      conditionChecks: [{ nodeRef: { workspaceId: s.base.ctx.workspaceId, objectId: 'k1', revision: s.base.base }, conditionId: 'original-premise', status: 'not_satisfied', confirmedBy: s.base.ctx.actorId }] };
    const transport = vi.fn(async (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => {
      const response = await s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (path === '/api/workspace/tasks' && response.ok) throw Error('Synthetic lost actual task save response');
      return response;
    });
    const flow = new CaptureTaskFlow(transport); await flow.load(task.id, task.workspaceId); await flow.save(task, false);
    expect(flow.getSnapshot().remote).toMatchObject({ state: 'missing', task: null });
    expect(s.base.journal.records(task.workspaceId, s.base.ctx.actorId, 'task')).toHaveLength(0);
    await flow.save(task, true); expect(flow.getSnapshot().phase).toBe('unknown');
    const pending = flow.getSnapshot().pending!; await flow.save(task, true); await flow.cancel();
    expect(flow.getLeaveState()).toBe('blocked'); s.reopen(); await flow.readBack();
    expect(flow.getSnapshot()).toMatchObject({ phase: 'saved', remote: { task, revision: 1 }, receipt: { operationId: pending.request.operationId, requestHash: pending.requestHash, contentHash: await contentHash(task) } });
    expect(transport.mock.calls.filter(([path]) => path === '/api/workspace/tasks')).toHaveLength(1);
    const restored = new CaptureTaskFlow(transport); await restored.load(task.id, task.workspaceId);
    expect(restored.getSnapshot().remote?.task).toEqual(task);
    const draft = taskDraftFromContext(restored.getSnapshot().remote!.task!); if (!draft.ok) throw Error('Expected original task form');
    expect(taskForStorage(draft.data, task.workspaceId, task, task.updatedAt)).toEqual({ ok: true, data: task });
    expect(s.remote[1]!.body).not.toContain(task.question); expect(s.remote[1]!.body).not.toContain('Original constraint');
    expect(s.complete).not.toHaveBeenCalled(); expect(s.base.git.publish).not.toHaveBeenCalled();
  });
  it('uses original task CAS across two connections and clears private restored content after revocation', async () => {
    const s = await setup(true), source = await s.saveSource(), other = s.fork();
    const normal = (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => s.call(path, init?.body ? JSON.parse(String(init.body)) : undefined);
    const parallel = (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => other(path, init?.body ? JSON.parse(String(init.body)) : undefined);
    const first = new CaptureTaskFlow(normal), second = new CaptureTaskFlow(parallel), task = source.preview.task;
    await first.load(task.id, task.workspaceId); await second.load(task.id, task.workspaceId);
    await Promise.all([first.save(task, true), second.save({ ...task, question: 'Other task revision' }, true)]);
    expect([first, second].filter((flow) => flow.getSnapshot().phase === 'saved')).toHaveLength(1);
    expect([first, second].filter((flow) => flow.getSnapshot().phase === 'failed')).toHaveLength(1);
    const winner = first.getSnapshot().phase === 'saved' ? first : second;
    const original = winner.getSnapshot().pending!;
    const latest = new CaptureTaskFlow(normal); await latest.load(task.id, task.workspaceId);
    await latest.save({ ...task, question: 'Explicit later revision' }, true); await winner.readBack();
    expect(winner.getSnapshot()).toMatchObject({ receipt: { revision: 1 }, remote: { revision: 2, task: { question: 'Explicit later revision' } } });
    expect(winner.getSnapshot().pending).toBe(original);
    s.reopen();
    const workspace = await s.services().workspace(s.base.ctx); if (!workspace.ok) throw Error('Expected fixture workspace');
    s.base.headers.Authorization = `Bearer ${s.base.sessions.issue({ actorId: s.base.ctx.actorId, workspace: workspace.data, scopes: ['workspace:read'] })}`;
    await latest.load(task.id, task.workspaceId);
    expect(latest.getSnapshot()).toMatchObject({ phase: 'failed', remote: null });
    expect(s.complete).not.toHaveBeenCalled(); expect(s.base.git.publish).not.toHaveBeenCalled();
  });
});
