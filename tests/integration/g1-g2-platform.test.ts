import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../../src/contracts/api';
import type { Approval, Candidate, ChangeSet, CommitReceipt, Conversation, HandoffDraft, RetrievalResult, TaskContext } from '../../src/contracts/domain';
import type { DraftSaveOptions, DraftState, ReviewProgress } from '../../src/contracts/handoff';
import { hashSettings } from '../../src/contracts/hash';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/platform/services';
import { OperationJournal } from '../../src/platform/journal';
import { ApprovalAuthority } from '../../src/platform/approvals';
import type { ModelTransport } from '../../src/platform/model';
import { platformFixture } from './platform-fixture';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function data<T>(result: Result<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.data;
}

async function setup(empty = false, extract = true) {
  mkdirSync('.local/fixture', { recursive: true });
  const directory = mkdtempSync(resolve('.local/fixture/g1-g2-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'operations.sqlite'), f = await platformFixture(file);
  let journal = f.journal;
  cleanup.push(() => journal.close());
  const remote = [{ number: '7', title: 'Unselected original title', body: 'Stable operation IDs prevent duplicate writes.', invisible: true, created_at: '2026-09-05T00:00:00Z' }];
  const upstream = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/-/issues') && init?.method === 'POST') {
      const issue = { ...JSON.parse(String(init.body)), number: String(100 + remote.length), created_at: new Date().toISOString() };
      remote.push(issue); return Response.json(issue, { status: 201 });
    }
    if (path.endsWith('/-/issues')) return Response.json(remote);
    const match = /\/-\/issues\/(\d+)$/.exec(path);
    if (match) { const row = remote.find((issue) => issue.number === match[1]); return Response.json(row ?? {}, { status: row ? 200 : 404 }); }
    return upstream(input, init);
  });
  const complete = vi.fn<ModelTransport['complete']>(async (_ctx, input) => {
    const segment = JSON.parse(input.text).untrustedSegments[0];
    return { ok: true, data: { modelId: 'synthetic-g1-model', generatedAt: new Date().toISOString(), value: { candidates: empty ? [] : [{
      title: 'Stable operation IDs', question: 'How to recover a write?', claim: 'Keep an operation ID.', kind: 'method', whyKeep: 'Check recovery', uncertainties: [],
      spans: [{ segmentId: segment.id, start: 0, end: segment.text.length, quote: segment.text }],
    }] } } };
  });
  const model: ModelTransport = { mode: 'fixture', complete };
  let services = createServices({ ...f.options, model }), app = createApp(services);
  async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Result<T>> {
    const response = await app.request(path, { method, headers: f.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  }
  const original = data(await call<Conversation>('/api/capture/issue', { issueNumber: 7, selected: true }));
  const preview = data(await call<{ conversation: Conversation; task: TaskContext }>('/api/capture/preview', {
    conversationId: 'g1-selected-capture', task: { id: 'g1-original-task', question: 'How to prevent duplicate writes?', constraints: [], intent: 'propose' },
    source: { origin: 'cnb_issue', issueNumber: 7, sourceRevision: original.contentHash }, segments: [original.segments[1]], personalInfoReviewed: true, scopeConfirmed: true,
  }));
  const approval = data(await call<Approval>('/api/capture/approve', { conversation: preview.conversation, baseRevision: 'new', confirmed: true }));
  const saved = data(await call<Conversation>('/api/capture/save', { conversation: preview.conversation, approval, confirmed: true }));
  expect(saved.issueNumber).toBe(101); expect(remote[1]!.body).not.toContain(remote[0]!.title);
  let modelApproval: Approval | null = null;
  let extracted: { candidates: Candidate[]; state: string } = { candidates: [], state: 'missing' };
  if (extract) {
  const current = data(await services.settingsState!(f.ctx)), settings = { ...current.settings, aiExtraction: true };
  const settingsApproval = data(await call<Approval>('/api/workspace/approvals/governance', { purpose: 'settings', settings, baseRevision: f.base,
    expectedSettingsHash: await hashSettings(f.ctx.workspaceId, f.base, current.settings), expectedSettingsRevision: current.revision, confirmed: true }));
  data(await services.saveSettings(f.ctx, settings, settingsApproval));
  const scope = { task: preview.task, segmentIds: saved.segments.map((segment) => segment.id), scopeConfirmed: true };
  const modelPreview = data(await call<{ approvalRequest: { contentHash: string; baseRevision: string } }>(`/api/capture/${saved.id}/model-preview`, scope));
  modelApproval = data(await call<Approval>(`/api/capture/${saved.id}/model-approve`, { ...scope,
    expectedInputHash: modelPreview.approvalRequest.contentHash, expectedConversationHash: modelPreview.approvalRequest.baseRevision, retentionDays: 7, confirmed: true }));
  extracted = data(await call<{ candidates: Candidate[]; state: string }>(`/api/capture/${saved.id}/extract`, { ...scope, approval: modelApproval, retentionDays: 7, confirmed: true }));
  }
  const path = `/api/handoff/${saved.id}`;
  return { f, remote, complete, call, saved, extracted, path, task: preview.task, modelApproval, services: () => services,
    reopen() { journal.close(); journal = new OperationJournal(file, { fixture: true });
      services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal), model }); app = createApp(services); },
  };
}

async function prepareDraft(s: Awaited<ReturnType<typeof setup>>) {
  const review = data(await s.call<{ conversation: Conversation; items: { subject: Candidate; draftId: string; nodeId: string }[] }>(s.path));
  expect(review.conversation).toEqual(s.saved); expect(review.items[0]!.subject).toEqual(s.extracted.candidates[0]);
  const item = review.items[0]!, candidate = item.subject, now = new Date().toISOString();
  const progress: ReviewProgress = { id: item.draftId, workspaceId: s.f.ctx.workspaceId, conversationId: s.saved.id, nodeId: item.nodeId,
    baseRevision: s.f.base, disposition: 'later', title: candidate.title, question: candidate.question, statement: '', kind: candidate.kind,
    authorship: 'human_written', conditions: [{ id: 'condition-1', text: '', status: 'unknown', evidenceIds: [] }], boundaries: [],
    sources: candidate.sources, relations: [], relationInput: { targetId: '', type: '', direction: '', rationale: 'Unfinished review', evidenceIds: [] } };
  const options: DraftSaveOptions = { operationId: 'g1-progress-A', source: { kind: 'candidate', candidateId: candidate.id },
    expectedConversationHash: s.saved.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  const response = data(await s.call<{ state: DraftState }>(`${s.path}/progress`, { progress, options }, 'PUT'));
  expect(response.state.revision).toBe(1);
  expect(await s.call(`${s.path}/progress`, { progress: { ...progress, statement: 'Other session' }, options: { ...options, operationId: 'g1-progress-B' } }, 'PUT'))
    .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  s.reopen();
  const restored = data(await s.call<DraftState>(`${s.path}/draft-state?draftId=${item.draftId}`));
  expect(restored.document).toEqual({ kind: 'progress', value: progress });
  expect(data(await s.call(`${s.path}/draft-receipt?draftId=${item.draftId}&operationId=${options.operationId}`)))
    .toMatchObject({ operationId: options.operationId, revision: 1 });
  const statement = 'For retries of this operation, reuse the original stable ID and verify the receipt.';
  const draft: HandoffDraft = { id: item.draftId, conversationId: s.saved.id, candidateId: candidate.id, baseRevision: s.f.base, relations: [], node: {
    id: item.nodeId, workspaceId: s.f.ctx.workspaceId, schemaVersion: 1, revision: s.f.base, title: candidate.title, question: candidate.question,
    humanStatement: statement, authorship: 'human_written', candidateIds: [candidate.id], conversationId: s.saved.id, kind: candidate.kind,
    conditions: [{ id: 'condition-1', text: 'The operation identity remains stable.', status: 'confirmed', confirmedBy: s.f.ctx.actorId, evidenceIds: [] }],
    boundaries: ['A receipt cannot establish remote physical deletion.'], sources: candidate.sources.map((source) => ({ ...source, support: 'supports', supportedClaim: statement })),
    confirmation: 'draft', evidenceStatus: 'supported', lifecycle: 'active', updatedAt: now,
  } };
  data(await s.call(`${s.path}/draft`, { draft, consent: true, options: { ...options, operationId: 'g1-complete-draft', expectedRevision: restored.revision, expectedContentHash: restored.contentHash } }, 'PUT'));
  const preview = data(await s.call<{ draft: HandoffDraft; changes: ChangeSet }>(`${s.path}/preview`, { draft, reason: 'Human source review completed' }));
  return { draft: preview.draft, changes: preview.changes, confirmed: true as const };
}

describe('G1/G2 public HTTP with real Services and SQLite; external transports synthetic', () => {
  it('carries one selected source through candidate, partial CAS, restart, draft, Git and new-task retrieval', async () => {
    const s = await setup(), input = await prepareDraft(s);
    expect(s.f.git.publish).not.toHaveBeenCalled();
    const approval = data(await s.call<Approval>(`${s.path}/approval`, input));
    const receipt = data(await s.call<CommitReceipt>(`${s.path}/commit`, { ...input, approval }));
    expect(receipt).toMatchObject({ changeSetId: input.changes.id, indexing: 'pending' });
    const result = data(await s.call<RetrievalResult>('/api/retrieval/query', { query: 'Stable operation IDs', confirmedOnly: true,
      task: { ...s.task, id: 'g2-next-task', question: 'Stable operation IDs', constraints: [{ id: 'condition-1', text: 'The operation identity remains stable.', confirmedBy: s.f.ctx.actorId }] } }));
    expect(result.snapshotRevision).toBe(receipt.revision); expect(result.coverage).not.toBe('current');
    expect([...result.groups.eligible, ...result.groups.conditional]).toContainEqual(expect.objectContaining({ id: input.draft.node.id,
      humanStatement: input.draft.node.humanStatement, conversationId: s.saved.id, revision: receipt.revision }));
    expect(result.groups.excludedIds).not.toContain(input.draft.node.id);
    s.reopen();
    expect(data(await s.call(`${s.path}/receipt?changeSetId=${input.changes.id}`))).toEqual(receipt);
    expect(s.complete).toHaveBeenCalledOnce(); expect(s.f.git.publish).toHaveBeenCalledOnce(); expect(s.remote).toHaveLength(2);
  });
  it('separately recovers original knowledge approval and an unknown Git publication using GET after restart', async () => {
    const s = await setup(), input = await prepareDraft(s);
    const approval = data(await s.call<Approval>(`${s.path}/approval`, input));
    s.reopen();
    expect(data(await s.call(`/api/workspace/approvals/knowledge/${input.changes.id}`))).toMatchObject({ status: 'registered', approval });
    expect(s.f.git.publish).not.toHaveBeenCalled();
    const publish = vi.mocked(s.f.git.publish).getMockImplementation()!;
    vi.mocked(s.f.git.publish).mockImplementationOnce(async (request) => { await publish(request); throw Error('Synthetic lost publication response'); });
    expect(await s.call(`${s.path}/commit`, { ...input, approval })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    s.reopen();
    expect(data(await s.call<CommitReceipt>(`${s.path}/receipt?changeSetId=${input.changes.id}`)).changeSetId).toBe(input.changes.id);
    expect(s.f.git.publish).toHaveBeenCalledOnce(); expect(s.complete).toHaveBeenCalledOnce();
  });
  it('preserves a completed empty candidate batch across restart without turning it into unperformed extraction', async () => {
    const s = await setup(true); expect(s.extracted.state).toBe('empty'); s.reopen();
    expect(data(await s.call(`${s.path}`))).toMatchObject({ conversation: { id: s.saved.id }, items: [] });
    expect(data(await s.call(`/api/capture/${s.saved.id}/candidates`))).toMatchObject({ state: 'empty', batch: { state: 'available', revision: 1 } });
    expect(data(await s.call(`/api/workspace/model-operations/${s.modelApproval!.id}`))).toMatchObject({ state: 'done' });
    expect(s.complete).toHaveBeenCalledOnce(); expect(s.f.git.publish).not.toHaveBeenCalled();
  });
  it('keeps AI disabled for the selected Issue, manual source, restart, human commit and retrieval path', async () => {
    const s = await setup(false, false);
    const review = data(await s.call<{ items: { subject: { origin: 'manual'; spans: Candidate['spans']; sources: Candidate['sources'] }; draftId: string; nodeId: string }[] }>(`${s.path}/manual`, {
      segmentIds: s.saved.segments.map((segment) => segment.id), expectedConversationHash: s.saved.contentHash, confirmed: true,
    }));
    const item = review.items[0]!; expect(item.subject.origin).toBe('manual'); expect(item.subject).not.toHaveProperty('modelId');
    const statement = 'Reuse the original operation ID when reading back this task.';
    const draft: HandoffDraft = { id: item.draftId, conversationId: s.saved.id, candidateId: null, baseRevision: s.f.base, relations: [], node: {
      id: item.nodeId, workspaceId: s.f.ctx.workspaceId, schemaVersion: 1, revision: s.f.base, title: 'Manual recovery notes', question: 'How to recover?',
      humanStatement: statement, authorship: 'human_written', candidateIds: [], conversationId: s.saved.id, kind: 'method',
      conditions: [{ id: 'manual-condition', text: 'The same operation ID is known.', status: 'confirmed', confirmedBy: s.f.ctx.actorId, evidenceIds: [] }], boundaries: [],
      sources: item.subject.sources.map((source) => ({ ...source, support: 'supports', supportedClaim: statement })),
      confirmation: 'draft', evidenceStatus: 'supported', lifecycle: 'active', updatedAt: new Date().toISOString(),
    } };
    const options: DraftSaveOptions = { operationId: 'manual-save-A', source: { kind: 'manual', spans: item.subject.spans }, expectedConversationHash: s.saved.contentHash,
      expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
    data(await s.call(`${s.path}/draft`, { draft, consent: true, options }, 'PUT'));
    s.reopen(); expect(data(await s.call<DraftState>(`${s.path}/draft-state?draftId=${draft.id}`)).source).toEqual(options.source);
    const preview = data(await s.call<{ draft: HandoffDraft; changes: ChangeSet }>(`${s.path}/preview`, { draft, reason: 'Explicit manual review' }));
    const input = { draft: preview.draft, changes: preview.changes, confirmed: true };
    const approval = data(await s.call<Approval>(`${s.path}/approval`, input));
    const receipt = data(await s.call<CommitReceipt>(`${s.path}/commit`, { ...input, approval }));
    const result = data(await s.call<RetrievalResult>('/api/retrieval/query', { task: { ...s.task, question: draft.node.title }, query: draft.node.title, confirmedOnly: true }));
    expect([...result.groups.eligible, ...result.groups.conditional]).toContainEqual(expect.objectContaining({ id: draft.node.id, authorship: 'human_written', candidateIds: [], revision: receipt.revision }));
    expect(data(await s.services().settings(s.f.ctx)).aiExtraction).toBe(false);
    expect(s.complete).not.toHaveBeenCalled(); expect(s.f.git.publish).toHaveBeenCalledOnce();
    expect(data(await s.services().readCandidateState!(s.f.ctx, s.saved.id)).state).toBe('missing');
  });
});
