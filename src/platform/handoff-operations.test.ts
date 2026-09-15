import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext, Result } from '../contracts/api';
import type { ChangeSet, HandoffDraft } from '../contracts/domain';
import type { DraftSaveOptions, ReviewProgress } from '../contracts/handoff';
import { HandoffOperationSaveRequestSchema, HandoffOperationStateSchema } from '../contracts/handoff-operation';
import type { HandoffOperationSaveRequest } from '../contracts/handoff-operation';
import { contentHash, hashChangeSet, hashSegment } from '../contracts/hash';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createApp } from '../server/app';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import { createServices } from './services';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach((close) => close()); });
function data<T>(result: Result<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }

async function setup() {
  mkdirSync('.local/fixture', { recursive: true });
  const dir = mkdtempSync(resolve('.local/fixture/handoff-original-')), file = join(dir, 'state.sqlite');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = await platformFixture(file); let journal = f.journal, services = f.services;
  cleanup.push(() => journal.close());
  const issue = { number: '7', title: 'Selected source', body: 'Private synthetic original source', created_at: '2026-09-05T00:00:00Z', invisible: true };
  const transport = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (...args) => String(args[0]).endsWith('/issues/7') ? Response.json(issue) : transport(...args));
  const conversation = data(await services.readIssue(f.ctx, 7)), segment = conversation.segments[0]!;
  const span = { id: 'selected-span', conversationId: conversation.id, segmentId: segment.id, start: 0, end: segment.text.length,
    quote: segment.text, contentHash: await hashSegment(conversation.id, segment) };
  const now = new Date().toISOString();
  const draft: HandoffDraft = { id: 'draft-original', conversationId: conversation.id, candidateId: null, baseRevision: f.base, relations: [],
    node: { ...f.node, id: 'new-knowledge', revision: f.base, conversationId: conversation.id, humanStatement: 'Original human statement A',
      confirmation: 'draft', updatedAt: now, conditions: [{ id: 'premise', text: 'An explicit premise', status: 'unknown', evidenceIds: [] }],
      sources: [{ id: span.id, kind: 'conversation', title: 'Selected source', excerpt: span.quote, accessedAt: now, support: 'unverified', supportedClaim: '', limitation: '' }] } };
  delete draft.node.confirmedBy; delete draft.node.confirmedAt;
  const options: DraftSaveOptions = { operationId: 'save-original-draft', source: { kind: 'manual', spans: [span] },
    expectedConversationHash: conversation.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  data(await services.saveDraft(f.ctx, draft, options));
  const savedDraft = data(await services.readDraftState!(f.ctx, draft.id));
  const changes: ChangeSet = { id: 'original-change', workspaceId: f.ctx.workspaceId, baseRevision: f.base, reason: 'Original reason',
    nodes: [{ ...draft.node, confirmation: 'confirmed', confirmedBy: f.ctx.actorId, confirmedAt: now, updatedAt: now }], relations: [], withdrawnIds: [], contentHash: '' };
  changes.contentHash = await hashChangeSet(changes);
  const request = { draft, changes, source: options.source, draftRevision: savedDraft.revision, draftContentHash: savedDraft.contentHash!,
    expectedConversationHash: conversation.contentHash, expectedOperationRevision: 0 as const, retentionDays: 30 as const, confirmed: true as const };
  function reopen() { journal.close(); journal = new OperationJournal(file, { fixture: true });
    services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }); }
  return { ...f, serviceOptions: f.options, file, draft, options, savedDraft, request, issue, conversation, span, reopen, services: () => services, journal: () => journal };
}
async function context(f: Awaited<ReturnType<typeof setup>>, scopes = [...f.ctx.scopes], actorId = f.ctx.actorId): Promise<RequestContext> {
  const workspace = data(await f.services().workspace(f.ctx)), token = f.sessions.issue({ actorId, workspace, scopes });
  return data(f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
}

describe('W3-REQ-008 immutable original handoff operations', () => {
  it('saves the original preview through shared HTTP and restores identical content after SQLite reopen', async () => {
    const f = await setup(), app = createApp(f.services());
    const response = await app.request('/api/workspace/handoff-operations', { method: 'POST', headers: f.headers, body: JSON.stringify(f.request) });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const saved = data(await response.json());
    expect(saved).toMatchObject({ state: 'available', operationId: f.request.changes.id, revision: 1, readOnly: true,
      snapshot: { draft: f.draft, changes: f.request.changes, source: f.options.source, savedDraft: f.savedDraft } });
    f.reopen();
    const read = await createApp(f.services()).request(`/api/workspace/handoff-operations/${f.request.changes.id}`, { headers: f.headers });
    expect(read.status).toBe(200); expect(data(await read.json())).toEqual(saved);
    expect(f.git.publish).not.toHaveBeenCalled();
    expect(data(await f.services().readKnowledgeApproval!(f.ctx, f.request.changes.id)).status).toBe('not_registered');
  });
  it('keeps saved A and its original approval when another session advances the current draft to B', async () => {
    const f = await setup(), saved = data(await f.services().saveHandoffOperation!(f.ctx, f.request));
    const approval = data(await f.services().approveKnowledge!(f.ctx, { changes: f.request.changes, confirmed: true }));
    const second = await context(f), draftB = structuredClone(f.draft); draftB.node.humanStatement = 'Newer statement B';
    data(await f.services().saveDraft(second, draftB, { ...f.options, operationId: 'save-B', expectedRevision: 1, expectedContentHash: f.savedDraft.contentHash }));
    f.reopen();
    expect(data(await f.services().readDraft(f.ctx, f.draft.id))).toEqual(draftB);
    expect(data(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id))).toEqual(saved);
    expect(data(await f.services().readKnowledgeApproval!(f.ctx, f.request.changes.id))).toMatchObject({ status: 'registered', approval });
    expect(data(await f.services().saveHandoffOperation!(f.ctx, f.request))).toEqual(saved);
    const receipt = data(await f.services().readHandoffOperationReceipt!(f.ctx, f.request.changes.id));
    expect(receipt).toMatchObject({ operationId: f.request.changes.id, draftRevision: 1, requestHash: await contentHash(f.request), changeSetHash: f.request.changes.contentHash });
    expect(f.git.publish).not.toHaveBeenCalled();
  });
  it('recovers a lost Git response through the original receipt, without republishing or replacing the original preview', async () => {
    const f = await setup(), saved = data(await f.services().saveHandoffOperation!(f.ctx, f.request));
    const approval = data(await f.services().approveKnowledge!(f.ctx, { changes: f.request.changes, confirmed: true }));
    const publish = vi.mocked(f.git.publish).getMockImplementation()!;
    vi.mocked(f.git.publish).mockImplementationOnce(async (...args) => { await publish(...args); throw Error('Synthetic lost Git response'); });
    expect(await f.services().commit(f.ctx, f.request.changes, approval)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    f.reopen();
    expect(data(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id))).toEqual(saved);
    expect(data(await f.services().readCommit!(f.ctx, f.request.changes.id))).toMatchObject({ changeSetId: f.request.changes.id, indexing: 'pending' });
    expect(f.git.publish).toHaveBeenCalledOnce();
  });
  it('pins a complete preview to an explicitly saved partial-review version without manufacturing a current full draft', async () => {
    const f = await setup(), node = f.draft.node;
    const progress: ReviewProgress = { id: f.draft.id, workspaceId: node.workspaceId, conversationId: f.draft.conversationId, nodeId: node.id,
      baseRevision: f.base, disposition: 'handoff', title: node.title, question: node.question, statement: node.humanStatement, authorship: node.authorship,
      kind: node.kind, conditions: node.conditions, boundaries: node.boundaries, sources: node.sources, relations: [],
      relationInput: { targetId: 'k1', type: '', direction: '', rationale: 'Not yet a confirmed relation', evidenceIds: [] } };
    const state = data(await f.services().saveReviewProgress!(f.ctx, progress, { ...f.options, operationId: 'save-progress', expectedRevision: 1, expectedContentHash: f.savedDraft.contentHash }));
    const request = { ...f.request, draftRevision: state.revision, draftContentHash: state.contentHash! };
    const saved = data(await f.services().saveHandoffOperation!(f.ctx, request));
    expect(saved.snapshot?.savedDraft).toEqual(state);
    f.reopen(); expect(data(await f.services().readHandoffOperation!(f.ctx, request.changes.id))).toEqual(saved);
    f.journal().block(f.ctx.workspaceId, ['k1'], 'delete-pending-relation-target');
    expect(await f.services().readHandoffOperation!(f.ctx, request.changes.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('rejects changed draft, source, version, confirmation, consent and hidden fields before persisting an operation', async () => {
    const f = await setup(), requests: unknown[] = [
      { ...f.request, confirmed: false }, { ...f.request, approval: { purpose: 'commit_knowledge' } },
      { ...f.request, expectedOperationRevision: 1 }, { ...f.request, draftRevision: 2 },
      { ...f.request, source: { kind: 'manual', spans: [] } }, { ...f.request, draftContentHash: 'b'.repeat(64) },
      { ...f.request, expectedConversationHash: 'b'.repeat(64) },
      { ...f.request, draft: { ...f.draft, node: { ...f.draft.node, humanStatement: 'Unsaved draft body' } } },
    ];
    const changes = structuredClone(f.request.changes); changes.nodes[0]!.humanStatement = 'Changed approved projection'; changes.contentHash = await hashChangeSet(changes);
    requests.push({ ...f.request, changes });
    for (const request of requests) expect((await f.services().saveHandoffOperation!(f.ctx, request as HandoffOperationSaveRequest)).ok).toBe(false);
    expect(data(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id))).toMatchObject({ state: 'missing', snapshot: null, absenceIsFinal: false });
    expect(data(await f.services().readHandoffOperationReceipt!(f.ctx, f.request.changes.id))).toBeNull();
    expect(HandoffOperationSaveRequestSchema.safeParse({ ...f.request, changes: { ...changes, baseRevision: 'main' } }).success).toBe(false);
    expect(HandoffOperationStateSchema.safeParse({ operationId: 'x', workspaceId: 'w', actorId: 'a', state: 'available', revision: 1,
      requestHash: null, contentHash: null, snapshot: null, retentionDays: 30, absenceIsFinal: false, readOnly: true }).success).toBe(false);
  });
  it('performs immutable CAS across two SQLite connections and never substitutes the competing original operation', async () => {
    const f = await setup(), otherJournal = new OperationJournal(f.file, { fixture: true }); cleanup.push(() => otherJournal.close());
    const other = createServices({ ...f.serviceOptions, journal: otherJournal, approvalAuthority: new ApprovalAuthority(f.sessions, otherJournal) });
    const b = structuredClone(f.request); b.changes.reason = 'Competing original reason'; b.changes.contentHash = await hashChangeSet(b.changes);
    const results = await Promise.all([f.services().saveHandoffOperation!(f.ctx, f.request), other.saveHandoffOperation!(f.ctx, b)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'CONFLICT' } });
    const winner = results[0]!.ok ? f.request : b, saved = data(results.find((result) => result.ok)!);
    expect(data(await other.saveHandoffOperation!(f.ctx, winner))).toEqual(saved);
    expect(data(await f.services().readHandoffOperationReceipt!(f.ctx, winner.changes.id))?.requestHash).toBe(await contentHash(winner));
    expect(data(await other.readHandoffOperation!(f.ctx, winner.changes.id))).toEqual(saved);
  });
  it('rolls back body, receipt and audit together and rejects capacity exhaustion without false success', async () => {
    const f = await setup(), journal = f.journal(), put = journal.putRecord.bind(journal), audits = data(await f.services().audit(f.ctx));
    const write = vi.spyOn(journal, 'putRecord').mockImplementation((...args) => args[2] === 'handoff_operation_receipt' ? false : put(...args));
    expect(await f.services().saveHandoffOperation!(f.ctx, f.request)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(data(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id)).state).toBe('missing');
    expect(data(await f.services().readHandoffOperationReceipt!(f.ctx, f.request.changes.id))).toBeNull();
    expect(data(await f.services().audit(f.ctx))).toEqual(audits);
    write.mockRestore(); vi.spyOn(journal, 'privatePayloadFits').mockReturnValue(false);
    expect(await f.services().saveHandoffOperation!(f.ctx, f.request)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(data(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id)).state).toBe('missing');
  });
  it('isolates original actors and checks trusted permissions before loading stored body or remote sources', async () => {
    const f = await setup(); data(await f.services().saveHandoffOperation!(f.ctx, f.request));
    const foreign = await context(f, [...f.ctx.scopes], 'other-actor');
    expect(data(await f.services().readHandoffOperation!(foreign, f.request.changes.id))).toMatchObject({ state: 'missing', snapshot: null });
    expect(data(await f.services().readHandoffOperationReceipt!(foreign, f.request.changes.id))).toBeNull();
    const denied = await context(f, f.ctx.scopes.filter((scope) => scope !== 'knowledge:read'));
    const read = vi.spyOn(f.journal(), 'record'); f.transport.mockClear();
    for (const ctx of [denied, { ...f.ctx }]) {
      expect((await f.services().readHandoffOperation!(ctx, f.request.changes.id)).ok).toBe(false);
      expect((await f.services().saveHandoffOperation!(ctx, f.request)).ok).toBe(false);
    }
    expect(read).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    f.sessions.revoke(f.token);
    expect((await f.services().readHandoffOperation!(f.ctx, f.request.changes.id)).ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects changed or deleted source spans and preserves only the original metadata receipt', async () => {
    const f = await setup(); data(await f.services().saveHandoffOperation!(f.ctx, f.request));
    f.issue.body = 'Source changed after original approval';
    expect(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    f.journal().block(f.ctx.workspaceId, [f.span.segmentId], 'delete-source-segment'); f.reopen();
    expect(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(data(await f.services().readHandoffOperationReceipt!(f.ctx, f.request.changes.id))).toMatchObject({ outcome: 'saved', draftId: f.draft.id });
  });
  it('expires the original body with its pinned draft consent and cannot revive it with an old request', async () => {
    const f = await setup(), saved = data(await f.services().saveHandoffOperation!(f.ctx, f.request));
    const receipt = data(await f.services().readHandoffOperationReceipt!(f.ctx, f.request.changes.id));
    expect(saved.expiresAt).toBe(f.savedDraft.expiresAt);
    expect(f.journal().expirePrivatePayloads(saved.expiresAt!)).toBe(2);
    expect(JSON.stringify(f.journal().record(f.ctx.workspaceId, f.ctx.actorId, 'handoff_operation', f.request.changes.id))).not.toContain(f.draft.node.humanStatement);
    f.reopen();
    expect(data(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id))).toMatchObject({ state: 'expired', revision: 2, snapshot: null });
    expect(data(await f.services().readHandoffOperationReceipt!(f.ctx, f.request.changes.id))).toEqual(receipt);
    expect(await f.services().saveHandoffOperation!(f.ctx, f.request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it('does not return an in-memory original body when another connection expires it during source verification', async () => {
    const f = await setup(), saved = data(await f.services().saveHandoffOperation!(f.ctx, f.request));
    const other = new OperationJournal(f.file, { fixture: true }); cleanup.push(() => other.close());
    const transport = f.transport.getMockImplementation()!; let expired = false;
    f.transport.mockImplementation(async (...args) => {
      if (!expired && new URL(String(args[0])).searchParams.get('ref') === f.base) { expired = true; other.expirePrivatePayloads(saved.expiresAt!); }
      return transport(...args);
    });
    expect(data(await f.services().readHandoffOperation!(f.ctx, f.request.changes.id))).toMatchObject({ state: 'expired', snapshot: null });
    expect(expired).toBe(true);
  });
});
