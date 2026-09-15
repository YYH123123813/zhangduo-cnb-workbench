import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse, RequestContext, Result } from '../../contracts/api';
import type { Approval } from '../../contracts/domain';
import type { DraftReceipt, DraftSaveOptions, DraftState } from '../../contracts/handoff';
import type { HandoffOperationSaveRequest } from '../../contracts/handoff-operation';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import { OperationJournal } from '../../platform/journal';
import { ApprovalAuthority } from '../../platform/approvals';
import { appFor } from './testing/app';
import { handoffPlatformFixture, platformPreview } from './testing/platform';
import { loadReview } from './server';
import { sourceFor } from './model';
import { verifyOriginalPreview } from './original-preview';
import { verifyOperationEnvelope } from './operation';
import { readSavedOperation, saveOperationSnapshot } from './operation-client';
import { acceptOriginalPreview, beginOriginalRecovery, readOriginalFacts } from './original-recovery';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach((close) => close()); });
function data<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }

async function setup(loseSaveResponse = false, persistSnapshot = true) {
  mkdirSync('.local', { recursive: true });
  const directory = mkdtempSync(resolve('.local/handoff-original-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'operations.sqlite');
  const f = await handoffPlatformFixture(file), prepared = await platformPreview(f);
  let journal = f.journal, services = f.services, app = appFor(services);
  cleanup.push(() => journal.close());
  async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers = f.headers): Promise<ApiResponse<T>> {
    const response = await app.request(`/api/handoff/${f.source.id}${path}`, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  }
  const source = sourceFor(prepared.item);
  const options: DraftSaveOptions = { operationId: 'original-draft-save-A', source, expectedConversationHash: f.source.contentHash,
    expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  if (loseSaveResponse) {
    const save = services.saveDraft;
    services.saveDraft = vi.fn(async (...args: Parameters<typeof save>) => { await save(...args); throw Error('Synthetic lost draft response'); });
  }
  const saveResult = await call('/draft', { draft: prepared.draft, options, consent: true }, 'PUT');
  if (loseSaveResponse) expect(saveResult).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
  else data(saveResult);
  const savedDraft = data(await call<DraftState>(`/draft-state?draftId=${prepared.draft.id}`));
  const operationRequest: HandoffOperationSaveRequest = { draft: prepared.draft, changes: prepared.preview.changes, source,
    draftRevision: savedDraft.revision, draftContentHash: savedDraft.contentHash!, expectedConversationHash: f.source.contentHash,
    expectedOperationRevision: 0, retentionDays: 30, confirmed: true };
  const original = persistSnapshot ? structuredClone(data(await services.saveHandoffOperation!(f.ctx, operationRequest)).snapshot!)
    : structuredClone({ draft: prepared.draft, changes: prepared.preview.changes, source, savedDraft });
  const key = { actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId, conversationId: f.source.id,
    changeSetId: original.changes.id, contentHash: original.changes.contentHash, baseRevision: original.changes.baseRevision,
    draftId: original.draft.id, draftRevision: savedDraft.revision, draftContentHash: savedDraft.contentHash! };
  function reopen() {
    journal.close(); journal = new OperationJournal(file, { fixture: true });
    services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) });
    app = appFor(services);
  }
  async function verify(input?: typeof original, ctx: RequestContext = f.ctx) {
    if (!input) {
      const state = await services.readHandoffOperation!(ctx, key.changeSetId);
      if (!state.ok) return state;
      const receipt = await services.readHandoffOperationReceipt!(ctx, key.changeSetId);
      if (!receipt.ok) return receipt;
      const verified = await verifyOperationEnvelope(state.data, receipt.data, ctx, f.source.id, key.changeSetId, Date.now());
      if (!verified.ok) return verified;
      input = verified.data.snapshot;
    }
    const review = data(await loadReview(services, ctx, f.source.id));
    const snapshot = data(await services.snapshot(ctx, key.baseRevision));
    return verifyOriginalPreview(key, input, review, snapshot, ctx, Date.now());
  }
  async function restored() { return acceptOriginalPreview(beginOriginalRecovery(key), await verify()); }
  return { f, prepared, call, original, key, options, operationRequest, reopen, verify, restored, services: () => services };
}

describe('1.17 original recovery consumer with actual immutable snapshot/draft/approval/Git Services; synthetic transports', () => {
  it('keeps approved A distinct from another session saving B, across a real SQLite reopen', async () => {
    const s = await setup();
    const approve = s.services().approveKnowledge!;
    s.services().approveKnowledge = vi.fn(async (...args: Parameters<typeof approve>) => { await approve(...args); throw Error('Lost approval response'); });
    expect(await s.call('/approval', s.prepared.input)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    const draftB = structuredClone(s.original.draft);
    draftB.node.humanStatement = 'Statement B from another session';
    draftB.node.sources = draftB.node.sources.map((source) => ({ ...source, support: 'unverified', supportedClaim: '' }));
    draftB.node.evidenceStatus = 'unverified'; draftB.relations = [];
    const workspace = data(await s.services().workspace(s.f.ctx));
    const token = s.f.sessions.issue({ actorId: s.f.ctx.actorId, workspace, scopes: [...s.f.ctx.scopes] });
    data(await s.call('/draft', { draft: draftB, consent: true, options: { ...s.options, operationId: 'original-draft-save-B',
      expectedRevision: s.key.draftRevision, expectedContentHash: s.key.draftContentHash } }, 'PUT', { ...s.f.headers, Authorization: `Bearer ${token}` }));
    s.reopen();
    const latest = data(await s.call<DraftState>(`/draft-state?draftId=${s.key.draftId}`));
    expect(latest).toMatchObject({ revision: 2, document: { kind: 'draft', value: { node: { humanStatement: draftB.node.humanStatement } } } });
    expect((await s.verify({ ...s.original, savedDraft: latest })).ok).toBe(false);
    const recovered = await readOriginalFacts(await s.restored(), s.services(), s.f.ctx, Date.now());
    expect(recovered).toMatchObject({ phase: 'read_only', canSubmit: false, approval: { status: 'registered', approval: { contentHash: s.key.contentHash } }, commitState: 'unknown' });
    expect(recovered.preview!.draft.node.humanStatement).toBe(s.original.draft.node.humanStatement);
    expect(recovered.preview!.changes).toEqual(s.original.changes);
    expect(await s.call(`/operation?changeSetId=${s.key.changeSetId}`)).toMatchObject({ ok: true, data: {
      recovery: { preview: { draft: s.original.draft, changes: s.original.changes }, canSubmit: false, commitState: 'unknown' },
      storage: { operationId: s.key.changeSetId, draftRevision: 1 },
    } });
    expect(s.f.git.publish).not.toHaveBeenCalled();
  });
  it('reads the original draft receipt after a lost save response, without replaying its save', async () => {
    const s = await setup(true), save = s.services().saveDraft;
    s.reopen();
    const receipt = data(await s.call<DraftReceipt>(`/draft-receipt?draftId=${s.key.draftId}&operationId=${s.options.operationId}`));
    expect(receipt).toMatchObject({ operationId: s.options.operationId, draftId: s.key.draftId, contentHash: s.key.draftContentHash, revision: 1 });
    expect((await s.verify()).ok).toBe(true);
    expect(save).toHaveBeenCalledOnce(); expect(s.f.git.publish).not.toHaveBeenCalled();
  });
  it('resolves a lost Git publication through the original read after reopen, preserving the pending index', async () => {
    const s = await setup();
    const approval = data(await s.call<Approval>('/approval', s.prepared.input));
    const publish = vi.mocked(s.f.git.publish).getMockImplementation()!;
    vi.mocked(s.f.git.publish).mockImplementationOnce(async (input) => { await publish(input); throw Error('Lost Git response'); });
    expect(await s.call('/commit', { ...s.prepared.input, approval })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    s.reopen();
    const recovered = await readOriginalFacts(await s.restored(), s.services(), s.f.ctx, Date.now());
    expect(recovered).toMatchObject({ phase: 'committed', canSubmit: false, receipt: { changeSetId: s.key.changeSetId, indexing: 'pending' } });
    expect(s.f.git.publish).toHaveBeenCalledOnce();
  });
  it('keeps the shared Git fact when approval or subsequent receipt read responses are lost', async () => {
    const s = await setup();
    const approval = data(await s.call<Approval>('/approval', s.prepared.input));
    data(await s.call('/commit', { ...s.prepared.input, approval }));
    s.reopen();
    const readApproval = s.services().readKnowledgeApproval!;
    s.services().readKnowledgeApproval = vi.fn(async (...args: Parameters<typeof readApproval>) => {
      data(await readApproval(...args)); throw Error('Lost approval read response');
    });
    const recovered = await readOriginalFacts(await s.restored(), s.services(), s.f.ctx, Date.now());
    expect(recovered).toMatchObject({ phase: 'committed', approval: null, commitState: 'saved', canSubmit: false,
      receipt: { changeSetId: s.key.changeSetId, indexing: 'pending' }, error: { dataState: 'unknown' } });
    const readCommit = s.services().readCommit!;
    s.services().readCommit = vi.fn(async (...args: Parameters<typeof readCommit>) => {
      data(await readCommit(...args)); throw Error('Lost commit read response');
    });
    const reread = await readOriginalFacts(recovered, s.services(), s.f.ctx, Date.now());
    expect(reread).toMatchObject({ phase: 'committed', commitState: 'saved', canSubmit: false, receipt: recovered.receipt });
    expect(s.f.git.publish).toHaveBeenCalledOnce();
  });
  it.each(['save_response', 'receipt_response', 'receipt_error'] as const)('recovers a lost original %s through GET without saving again', async (fault) => {
    const s = await setup(false, false), methods: string[] = [];
    const request = async <T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> => {
      methods.push(init?.method ?? 'GET');
      const response = await createApp(s.services()).request(path, { ...init, headers: s.f.headers });
      if ((fault === 'save_response' && init?.method === 'POST') || (fault === 'receipt_response' && path.includes('handoff-operation-receipts'))) {
        throw Error('Synthetic dropped original save/receipt response');
      }
      const result: ApiResponse<T> = await response.json();
      if (fault === 'receipt_error' && path.includes('handoff-operation-receipts')) return { ok: false, meta: result.meta,
        error: { code: 'UPSTREAM', message: 'Receipt temporarily unavailable', retryable: true, dataState: 'preserved', nextAction: 'retry_read' } };
      return result;
    };
    expect(await saveOperationSnapshot(s.operationRequest, s.f.ctx, request)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    const writeCount = methods.filter((method) => method === 'POST').length;
    s.reopen();
    const read = async <T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> => {
      methods.push(init?.method ?? 'GET');
      return (await createApp(s.services()).request(path, { ...init, headers: s.f.headers })).json();
    };
    expect(data(await readSavedOperation(s.operationRequest, s.f.ctx, read))).toMatchObject({ operationId: s.key.changeSetId, draftRevision: 1 });
    expect(methods.filter((method) => method === 'POST')).toHaveLength(writeCount);
    expect(data(await s.call(`/operation?changeSetId=${s.key.changeSetId}`))).toMatchObject({ recovery: { canSubmit: false, commitState: 'unknown' } });
    expect(s.f.git.publish).not.toHaveBeenCalled();
  });
  it('does not return an old body when deletion occurs during approval/Git reconciliation', async () => {
    const s = await setup(), read = s.services().readCommit!;
    s.services().readCommit = vi.fn(async (...args: Parameters<typeof read>) => {
      const result = await read(...args);
      const plan = data(await s.services().previewDelete(s.f.ctx, [s.f.node.id]));
      const approval = data(await s.services().approveGovernance!(s.f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
      data(await s.services().executeDelete(s.f.ctx, plan, approval));
      return result;
    });
    const response = await s.call(`/operation?changeSetId=${s.key.changeSetId}`);
    expect(response).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(response)).not.toContain(s.original.draft.node.humanStatement);
    expect(s.f.git.publish).not.toHaveBeenCalled();
  });
  it('refuses an expired original body after restart without generating a replacement preview', async () => {
    const s = await setup();
    const receipt = data(await s.services().readHandoffOperationReceipt!(s.f.ctx, s.key.changeSetId))!;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(receipt.expiresAt) + 1);
    s.reopen();
    const response = await s.call(`/operation?changeSetId=${s.key.changeSetId}`);
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toContain(s.original.draft.node.humanStatement);
    expect(data(await s.services().readHandoffOperationReceipt!(s.f.ctx, s.key.changeSetId))).toEqual(receipt);
    expect(s.f.git.publish).not.toHaveBeenCalled();
  });
  it('refuses a deleted relation premise and clears content under a real restricted session', async () => {
    const s = await setup(), state = await s.restored();
    const workspace = data(await s.services().workspace(s.f.ctx));
    const token = s.f.sessions.issue({ actorId: s.f.ctx.actorId, workspace, scopes: s.f.ctx.scopes.filter((scope) => scope !== 'knowledge:read') });
    const restricted = data(s.f.sessions.context(new Request('http://localhost', { headers: { ...s.f.headers, Authorization: `Bearer ${token}` } })));
    expect(await readOriginalFacts(state, s.services(), restricted, Date.now())).toMatchObject({ phase: 'unavailable', preview: null, receipt: null });
    const plan = data(await s.services().previewDelete(s.f.ctx, [s.f.node.id]));
    const approval = data(await s.services().approveGovernance!(s.f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    data(await s.services().executeDelete(s.f.ctx, plan, approval));
    s.reopen();
    expect((await s.verify()).ok).toBe(false);
    expect(s.f.git.publish).not.toHaveBeenCalled();
  });
});
