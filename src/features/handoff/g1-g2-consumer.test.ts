import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse, Result } from '../../contracts/api';
import type { KnowledgeApprovalState } from '../../contracts/approval';
import type { Approval, CommitReceipt, Conversation, Relation, RetrievalResult } from '../../contracts/domain';
import type { DraftSaveOptions } from '../../contracts/handoff';
import { ApprovalAuthority } from '../../platform/approvals';
import { OperationJournal } from '../../platform/journal';
import { createServices } from '../../platform/services';
import { createApp } from '../../server/app';
import { toDraft } from './draft';
import { loadReviewTarget } from './load-target';
import { assessSource, setKeyCondition, sourceFor, writeStatement } from './model';
import type { Review } from './model';
import type { HandoffPreview } from './preview';
import { makeOperationRequest } from './operation';
import { lookupOriginalOperation, saveOperationSnapshot } from './operation-client';
import { toProgress } from './progress';
import type { ProgressSaveResult } from './progress';
import { handoffPlatformFixture } from './testing/platform';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));
function data<T>(result: Result<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.data;
}

async function setup(origin: 'candidate' | 'manual') {
  mkdirSync('.local', { recursive: true });
  const directory = mkdtempSync(resolve('.local/handoff-g1-g2-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'operations.sqlite'), f = await handoffPlatformFixture(file, origin);
  let journal = f.journal, services = f.services, app = createApp(services);
  cleanup.push(() => journal.close());
  async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<ApiResponse<T>> {
    const response = await app.request(path, { method, headers: f.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  }
  function reopen() {
    journal.close(); journal = new OperationJournal(file, { fixture: true });
    services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) });
    app = createApp(services);
  }
  return { f, call, reopen, services: () => services, read: <T>(path: string) => call<T>(path) };
}

describe('Node 3 G1/G2 consumers: real shared HTTP/Services/SQLite; synthetic CNB, model and Git transports', () => {
  it.each([['candidate', 'depends_on'], ['manual', 'contradicts']] as const)(
    '%s retains partial review and its %s relation through restart, one Git publication and retrieval', async (origin, relationType) => {
      const s = await setup(origin), { f } = s;
      const source = data(await s.call<Conversation>('/api/capture/issue', { issueNumber: 7, selected: true }));
      const path = `/api/handoff/${source.id}`;
      if (origin === 'candidate') {
        expect(data(await s.call(`/api/capture/${source.id}/candidates`))).toMatchObject({ state: 'existing', batch: { state: 'available' } });
      }
      const review = data(origin === 'manual' ? await s.call<Review>(`${path}/manual`, {
        segmentIds: [source.segments[1]!.id], expectedConversationHash: source.contentHash, confirmed: true,
      }) : await s.call<Review>(path));
      const initial = review.items[0]!, title = origin === 'manual' ? 'Bounded manual review' : initial.subject.title;
      const partial = writeStatement({ ...initial, disposition: 'handoff',
        subject: origin === 'manual' ? { ...initial.subject, title, question: 'When is this conclusion applicable?' } : initial.subject }, `My bounded ${origin} statement needs a verified premise.`);
      const options: DraftSaveOptions = { operationId: `${origin}-partial-A`, source: sourceFor(initial),
        expectedConversationHash: source.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
      const progress = data(toProgress(review, partial, f.base));
      const saved = data(await s.call<ProgressSaveResult>(`${path}/progress`, { progress, options }, 'PUT'));
      expect(saved.state.document).toEqual({ kind: 'progress', value: progress });
      expect(await s.call(`${path}/progress`, { progress: { ...progress, statement: 'Conflicting session B' },
        options: { ...options, operationId: `${origin}-partial-B` } }, 'PUT')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(f.git.publish).not.toHaveBeenCalled();
      s.reopen();
      const restored = data(await loadReviewTarget({ conversationId: source.id, draftId: initial.draftId }, s.read));
      expect(restored.items[0]).toMatchObject({ statement: partial.statement, draftVersion: { revision: 1 }, conditions: partial.conditions });
      let completed = data(setKeyCondition(restored.items[0]!, 'The premise was checked for this task.', 'confirmed'));
      completed = data(assessSource(completed, completed.sources[0]!.id, 'partial', 'The source supports checking a premise, not all applications.'));
      completed.boundaries = ['Recheck when the task or source changes.'];
      const now = new Date().toISOString();
      const relation: Relation = { id: `${origin}-formal-relation`, workspaceId: f.ctx.workspaceId,
        source: { workspaceId: f.ctx.workspaceId, objectId: initial.nodeId, revision: f.base },
        target: { workspaceId: f.ctx.workspaceId, objectId: f.node.id, revision: f.base }, type: relationType,
        rationale: relationType === 'depends_on' ? 'This conclusion depends on the original premise.' : 'This bounded conclusion contradicts the earlier unrestricted claim.',
        evidenceIds: [completed.sources[0]!.id], state: 'confirmed', proposedBy: f.ctx.actorId,
        confirmedBy: f.ctx.actorId, confirmedAt: now, updatedAt: now };
      completed.relations = [relation];
      const draft = data(toDraft(restored, completed, f.base, now));
      expect(await s.call(`${path}/preview`, { draft: { ...draft, relations: [{ ...relation, type: 'conflicts_with' }] }, reason: 'Reject undefined enum.' }))
        .toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      data(await s.call(`${path}/draft`, { draft, consent: true, options: { ...options, operationId: `${origin}-complete`,
        expectedRevision: saved.state.revision, expectedContentHash: saved.state.contentHash } }, 'PUT'));
      s.reopen();
      const completeRead = data(await loadReviewTarget({ conversationId: source.id, draftId: initial.draftId }, s.read));
      expect(completeRead.items[0]).toMatchObject({ statement: partial.statement, sources: completed.sources,
        conditions: draft.node.conditions, relations: [relation], draftVersion: { revision: 2 } });
      const preview = data(await s.call<HandoffPreview>(`${path}/preview`, { draft, reason: 'Keep the human-reviewed statement and formal relation together.' }));
      expect(preview.changes.relations).toEqual([relation]);
      const request = <T>(url: string, init?: RequestInit) => s.call<T>(url, init?.body ? JSON.parse(String(init.body)) : undefined, init?.method);
      const originalRequest = data(makeOperationRequest(preview, completeRead, completeRead.items[0]!, true));
      const originalReceipt = data(await saveOperationSnapshot(originalRequest, f.ctx, request));
      expect(originalReceipt).toMatchObject({ operationId: preview.changes.id, draftRevision: 2 });
      const input = { draft: preview.draft, changes: preview.changes, confirmed: true };
      const approve = s.services().approveKnowledge!;
      s.services().approveKnowledge = vi.fn(async (...args: Parameters<typeof approve>) => {
        const result = await approve(...args); data(result); throw Error('Synthetic lost approval response');
      });
      expect(await s.call(`${path}/approval`, input)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
      const approveCall = s.services().approveKnowledge;
      s.reopen();
      const registered = data(await s.call<KnowledgeApprovalState>(`/api/workspace/approvals/knowledge/${preview.changes.id}`));
      expect(registered).toMatchObject({ status: 'registered', approval: { actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId,
        contentHash: preview.changes.contentHash, baseRevision: f.base, objectIds: [initial.nodeId, relation.id] } });
      expect(await s.call(`${path}/receipt?changeSetId=${preview.changes.id}`))
        .toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
      expect(f.git.publish).not.toHaveBeenCalled();
      const approval: Approval = registered.approval!;
      const publish = vi.mocked(f.git.publish).getMockImplementation()!;
      vi.mocked(f.git.publish).mockImplementationOnce(async (request) => { data(await publish(request)); throw Error('Synthetic lost Git response'); });
      expect(await s.call(`${path}/commit`, { ...input, approval })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
      s.reopen();
      const receipt = data(await s.call<CommitReceipt>(`${path}/receipt?changeSetId=${preview.changes.id}`));
      expect(receipt).toMatchObject({ changeSetId: preview.changes.id, indexing: 'pending' });
      const recovered = data(await lookupOriginalOperation(source.id, preview.changes.id, request));
      expect(recovered.view).toMatchObject({ storage: originalReceipt, recovery: { preview: { draft: preview.draft, changes: preview.changes },
        commitState: 'saved', canSubmit: false, receipt } });
      const result = data(await s.call<RetrievalResult>('/api/retrieval/query', { query: title, confirmedOnly: true,
        task: { id: `${origin}-next-task`, workspaceId: f.ctx.workspaceId, question: title, constraints: [], mode: 'independent', updatedAt: now } }));
      expect(result.snapshotRevision).toBe(receipt.revision); expect(result.coverage).not.toBe('current');
      expect([...result.groups.eligible, ...result.groups.conditional, ...result.groups.conflicts]).toContainEqual(expect.objectContaining({
        id: initial.nodeId, revision: receipt.revision, humanStatement: completed.statement, authorship: 'human_written',
        sources: completed.sources, conditions: draft.node.conditions, boundaries: completed.boundaries,
        candidateIds: draft.candidateId ? [draft.candidateId] : [], conversationId: source.id,
      }));
      expect(result.paths).toContainEqual(expect.objectContaining({ seedId: initial.nodeId, relationIds: [relation.id], nodeIds: [initial.nodeId, f.node.id] }));
      const detail = data(await s.call(`/api/retrieval/nodes/${initial.nodeId}?revision=${receipt.revision}&snapshotRevision=${receipt.revision}`));
      expect(detail).toMatchObject({ snapshotRevision: receipt.revision, relations: [{ usable: true, relation: {
        ...relation, source: { ...relation.source, revision: receipt.revision },
      } }] });
      expect(data(await s.services().readConversation(f.ctx, source.id)).contentHash).toBe(source.contentHash);
      expect(JSON.stringify(detail)).not.toContain(source.segments[0]!.text);
      expect(approveCall).toHaveBeenCalledOnce(); expect(f.git.publish).toHaveBeenCalledOnce();
      expect(f.model.complete).toHaveBeenCalledTimes(origin === 'manual' ? 0 : 1);
      expect(data(await s.services().settings(f.ctx)).aiExtraction).toBe(origin === 'candidate');
    });
});
