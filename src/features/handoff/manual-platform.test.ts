import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResponse, Result } from '../../contracts/api';
import type { Approval, CommitReceipt, Conversation, RetrievalResult } from '../../contracts/domain';
import type { DraftSaveOptions } from '../../contracts/handoff';
import { SCOPES } from '../../contracts/scopes';
import { createApp } from '../../server/app';
import { createServices } from '../../platform/services';
import { OperationJournal } from '../../platform/journal';
import { ApprovalAuthority } from '../../platform/approvals';
import { handoffPlatformFixture } from './testing/platform';
import { assessSource, setKeyCondition, sourceFor, writeStatement } from './model';
import type { Review } from './model';
import { restoreProgressState, toProgress } from './progress';
import type { ProgressSaveResult } from './progress';
import { toDraft } from './draft';
import { loadReviewTarget } from './load-target';
import type { HandoffPreview } from './preview';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((close) => close()); });
function data<T>(result: Result<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.data;
}

async function setup() {
  mkdirSync('.local', { recursive: true });
  const directory = mkdtempSync(resolve('.local/handoff-manual-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'operations.sqlite');
  const fixture = await handoffPlatformFixture(file, 'manual');
  let journal = fixture.journal, services = fixture.services, app = createApp(services);
  cleanup.push(() => journal.close());
  async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers = fixture.headers): Promise<ApiResponse<T>> {
    const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  }
  const source = data(await call<Conversation>('/api/capture/issue', { issueNumber: 7, selected: true }));
  const path = `/api/handoff/${source.id}`;
  async function start(headers = fixture.headers) {
    return call<Review>(`${path}/manual`, { segmentIds: [source.segments[1]!.id], expectedConversationHash: source.contentHash, confirmed: true }, 'POST', headers);
  }
  function reopen() {
    journal.close();
    journal = new OperationJournal(file, { fixture: true });
    services = createServices({ ...fixture.options, journal, approvalAuthority: new ApprovalAuthority(fixture.sessions, journal) });
    app = createApp(services);
  }
  const read = <T>(path: string) => call<T>(path);
  return { fixture, source, path, start, call, reopen, read, services: () => services };
}

describe('H12 AI-off manual capture/handoff/retrieval over real Services; synthetic external transports', () => {
  it('saves blank manual progress, restarts, completes CAS and reads its human-written Git revision through retrieval', async () => {
    const s = await setup();
    expect(data(await s.services().settings(s.fixture.ctx))).toMatchObject({ aiExtraction: false, aiAnswer: false });
    expect(data(await s.call<Review>(`${s.path}?source=manual`)).items).toEqual([]);
    const review = data(await s.start()), item = review.items[0]!;
    expect(item.subject).toMatchObject({ origin: 'manual', title: '', question: '' });
    const progress = data(toProgress(review, item, s.fixture.base));
    const options: DraftSaveOptions = { operationId: 'manual-blank', source: sourceFor(item), expectedConversationHash: s.source.contentHash,
      expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
    const saved = data(await s.call<ProgressSaveResult>(`${s.path}/progress`, { progress, options }, 'PUT'));
    expect(saved.state).toMatchObject({ revision: 1, source: { kind: 'manual' }, document: { kind: 'progress', value: { statement: '', disposition: null } } });
    expect(JSON.stringify(saved.state)).not.toContain(s.source.segments[0]!.text);
    expect(s.fixture.git.publish).not.toHaveBeenCalled();
    s.reopen();
    const restored = data(await loadReviewTarget({ conversationId: s.source.id, draftId: item.draftId, source: 'manual' }, s.read));
    expect(restored.items[0]).toMatchObject({ draftId: item.draftId, nodeId: item.nodeId, statement: '', draftVersion: { revision: 1 } });
    let completed = writeStatement({ ...restored.items[0]!, disposition: 'handoff', subject: { ...restored.items[0]!.subject,
      title: 'Manual source checkpoint', question: 'When can this source be reused?' } }, 'Verify the source premise before reusing this conclusion.');
    completed = data(setKeyCondition(completed, 'The source premise has been verified.', 'confirmed'));
    completed = data(assessSource(completed, completed.sources[0]!.id, 'partial', 'The selected source supports checking the premise, not every later conclusion.'));
    completed.boundaries = ['Recheck when the original context changes.'];
    const draft = data(toDraft(restored, completed, s.fixture.base, new Date().toISOString()));
    data(await s.call(`${s.path}/draft`, { draft, consent: true, options: { ...options, operationId: 'manual-complete',
      expectedRevision: saved.state.revision, expectedContentHash: saved.state.contentHash } }, 'PUT'));
    s.reopen();
    const restoredDraft = data(await loadReviewTarget({ conversationId: s.source.id, draftId: item.draftId }, s.read));
    expect(restoredDraft.items[0]).toMatchObject({ statement: completed.statement, authorship: 'human_written', draftVersion: { revision: 2 } });
    const preview = data(await s.call<HandoffPreview>(`${s.path}/preview`, { draft, reason: 'Keep this bounded human statement.' }));
    const input = { draft: preview.draft, changes: preview.changes, confirmed: true };
    const approval = data(await s.call<Approval>(`${s.path}/approval`, input));
    const receipt = data(await s.call<CommitReceipt>(`${s.path}/commit`, { ...input, approval }));
    expect(receipt).toMatchObject({ changeSetId: preview.changes.id, indexing: 'pending' });
    const result = data(await s.call<RetrievalResult>('/api/retrieval/query', { query: 'Manual source checkpoint', confirmedOnly: true,
      task: { id: 'manual-next-task', workspaceId: s.fixture.ctx.workspaceId, question: 'Manual source checkpoint', constraints: [], mode: 'independent', updatedAt: new Date().toISOString() } }));
    expect(result.snapshotRevision).toBe(receipt.revision);
    expect(result.coverage).not.toBe('current');
    const node = [...result.groups.eligible, ...result.groups.conditional].find((entry) => entry.id === item.nodeId)!;
    expect(node).toMatchObject({ revision: receipt.revision, humanStatement: completed.statement, authorship: 'human_written', candidateIds: [], conversationId: s.source.id,
      sources: [{ url: s.source.issueUrl, excerpt: s.source.segments[1]!.text, support: 'partial' }] });
    expect(JSON.stringify(node)).not.toContain(s.source.segments[0]!.text);
    const original = data(await s.call<Conversation>('/api/capture/issue', { issueNumber: s.source.issueNumber, selected: true }));
    expect(original.contentHash).toBe(s.source.contentHash);
    s.reopen();
    expect(data(await s.call(`${s.path}/receipt?changeSetId=${preview.changes.id}`))).toEqual(receipt);
    expect(s.fixture.model.complete).not.toHaveBeenCalled();
    expect(s.fixture.git.publish).toHaveBeenCalledOnce();
    expect(data(await s.services().readCandidateState!(s.fixture.ctx, s.source.id)).state).toBe('missing');
  });

  it('starts without candidate/model permissions, rejects unsafe saves and isolates another actor', async () => {
    const s = await setup(), workspace = data(await s.services().workspace(s.fixture.ctx));
    const scopes = Object.values(SCOPES).filter((scope) => !scope.startsWith('candidate:') && !scope.startsWith('model:'));
    const token = s.fixture.sessions.issue({ actorId: s.fixture.ctx.actorId, workspace, scopes });
    const headers = { ...s.fixture.headers, Authorization: `Bearer ${token}` };
    const review = data(await s.start(headers)), item = review.items[0]!;
    const progress = data(toProgress(review, item, s.fixture.base));
    const options: DraftSaveOptions = { operationId: 'manual-rejected', source: sourceFor(item), expectedConversationHash: s.source.contentHash,
      expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
    for (const changes of [{ confirmed: false }, { expectedConversationHash: '0'.repeat(64) },
      { source: { kind: 'manual', spans: [{ ...item.subject.spans[0]!, quote: 'Forged source' }] } }]) {
      expect(await s.call(`${s.path}/progress`, { progress, options: { ...options, ...changes } }, 'PUT', headers)).toMatchObject({ ok: false });
    }
    expect(data(await s.services().readDraftState!(s.fixture.ctx, item.draftId)).state).toBe('missing');
    const saved = data(await s.call<ProgressSaveResult>(`${s.path}/progress`, { progress, options }, 'PUT', headers));
    const foreignToken = s.fixture.sessions.issue({ actorId: 'other-manual-actor', workspace, scopes });
    const foreignHeaders = { ...headers, Authorization: `Bearer ${foreignToken}` };
    expect(data(await s.call(`${s.path}/draft-state?draftId=${item.draftId}`, undefined, 'GET', foreignHeaders)))
      .toMatchObject({ state: 'missing', revision: 0, document: null, source: null, contentHash: null });
    expect(await s.call(`${s.path}/progress`, { progress, options: { ...options, operationId: 'manual-foreign',
      expectedRevision: saved.state.revision, expectedContentHash: saved.state.contentHash } }, 'PUT', foreignHeaders))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await s.call(`${s.path}/progress`, { progress: { ...progress, statement: 'A conflicting edit' }, options: { ...options, operationId: 'manual-conflict' } }, 'PUT', headers))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    expect(data(await restoreProgressState(review, saved.state)).items[0]!.statement).toBe('');
    expect(s.fixture.model.complete).not.toHaveBeenCalled();
    expect(s.fixture.git.publish).not.toHaveBeenCalled();
  });

  it('keeps two manual reviews independent and blocks saved source changes before a new preview', async () => {
    const s = await setup(), first = data(await s.start()), second = data(await s.start());
    const saved = [];
    for (const [index, review] of [first, second].entries()) {
      const item = writeStatement({ ...review.items[0]!, disposition: 'handoff', subject: { ...review.items[0]!.subject,
        title: `Independent manual ${index}`, question: 'What does this source establish?' } }, `Independent statement ${index}`);
      const progress = data(toProgress(review, item, s.fixture.base));
      const options: DraftSaveOptions = { operationId: `manual-independent-${index}`, source: sourceFor(item), expectedConversationHash: s.source.contentHash,
        expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
      data(await s.call(`${s.path}/progress`, { progress, options }, 'PUT'));
      saved.push({ item, draft: data(toDraft(review, item, s.fixture.base, new Date().toISOString())) });
    }
    s.reopen();
    for (const [index, entry] of saved.entries()) {
      const restored = data(await loadReviewTarget({ conversationId: s.source.id, draftId: entry.item.draftId }, s.read));
      expect(restored.items).toHaveLength(1);
      expect(restored.items[0]).toMatchObject({ draftId: entry.item.draftId, statement: `Independent statement ${index}` });
    }
    s.fixture.issue.body = 'Changed original source after the review was saved.';
    expect(await s.call(`${s.path}/preview`, { draft: saved[0]!.draft, reason: 'A stale source must not be approved.' }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.fixture.git.publish).not.toHaveBeenCalled();
    expect(s.fixture.model.complete).not.toHaveBeenCalled();
  });
});
