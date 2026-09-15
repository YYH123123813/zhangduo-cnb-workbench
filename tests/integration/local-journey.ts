import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ApiResponse } from '../../src/contracts/api';
import { LOCAL_DEMO_KEY } from '../../src/contracts/runtime';
import { CONTRACT_VERSION, type Approval, type Candidate, type ChangeSet, type CommitReceipt, type Conversation, type EvidenceRecord,
  type HandoffDraft, type KnowledgeNode, type RetrievalResult, type TaskContext } from '../../src/contracts/domain';
import type { TaskState } from '../../src/contracts/task-record';
import type { ReviewOperationReceipt, ReviewQuestionPublic } from '../../src/contracts/review-session';
import type { IndexOperation, IndexPlan, IndexStatus } from '../../src/contracts/indexing';
import type { RecoveryAnchor, RecoveryAnchorRead } from '../../src/contracts/recovery-anchor';
import { contentHash } from '../../src/contracts/hash';

type Send = (request: Request) => Promise<Response>;
type Storage = { operationId: string; record: EvidenceRecord; baseRevision: string };
type Attempt = { view: { id: string; phase: string; version: number; standardAnswer?: string; evidenceClass: string }; receipt: ReviewOperationReceipt };

// These are HTTP business operations on synthetic data, not browser actions or live CNB acceptance.
export async function runLocalJourney(send: Send, origin = 'http://localhost') {
  let cookie = '', mutations = 0, reads = 0;
  async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const response = await send(new Request(`${origin}${path}`, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    if (method === 'GET') reads++; else mutations++;
    const value = await response.json() as ApiResponse<T>;
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(value.meta.mode, path === '/api/workspace/disconnect' ? 'unconfigured' : 'fixture', 'Only the explicitly synthetic runtime may run this journey');
    assert.equal(value.meta.contractVersion, CONTRACT_VERSION);
    assert(value.ok, `${method} ${path}: ${JSON.stringify(value)}`);
    const sessionCookie = response.headers.get('set-cookie'); if (sessionCookie) cookie = sessionCookie.split(';')[0]!;
    return value.data;
  }
  const status = await call<{ state: string }>('/api/workspace/connection');
  assert.notEqual(status.state, 'unconfigured');
  const session = await call<{ actorId: string; workspace: { id: string; mode: string } }>('/api/workspace/connect', { connectionKey: LOCAL_DEMO_KEY, confirmed: true });
  assert.equal(session.actorId, 'cnb-user:local-demo'); assert.equal(session.workspace.id, 'cnb-repo:local-demo');
  const settings = await call<{ settings: Record<string, unknown> }>('/api/workspace/settings');
  for (const key of ['aiExtraction', 'aiAnswer', 'aiReview', 'saveQueryHistory']) assert.equal(settings.settings[key], false);

  const id = `accept-${randomUUID()}`, title = `Original operation receipt ${id}`;
  const source = 'With the original operation identifier, read the original receipt instead of creating another write.';
  const capture = await call<{ conversation: Conversation; task: TaskContext }>('/api/capture/preview', { conversationId: id,
    task: { id: `${id}-task`, question: title, constraints: [], intent: 'propose' }, source: { origin: 'paste' },
    segments: [{ id: `${id}-segment`, role: 'user', text: source }], personalInfoReviewed: true, scopeConfirmed: true });
  const captureApproval = await call<Approval>('/api/capture/approve', { conversation: capture.conversation, baseRevision: 'new', confirmed: true });
  const saved = await call<Conversation>('/api/capture/save', { conversation: capture.conversation, approval: captureApproval, confirmed: true });
  assert.equal(saved.state, 'saved'); assert(saved.issueNumber);
  const taskSave = { operationId: `${id}-save-task`, task: capture.task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  await call('/api/workspace/tasks', taskSave);
  const base = (await call<IndexStatus>('/api/workspace/index/status')).baseRevision;
  const path = `/api/handoff/${encodeURIComponent(saved.id)}`;
  const manual = await call<{ items: { subject: { origin: string; spans: Candidate['spans']; sources: Candidate['sources'] }; draftId: string; nodeId: string }[] }>(`${path}/manual`, {
    segmentIds: saved.segments.map((segment) => segment.id), expectedConversationHash: saved.contentHash, confirmed: true });
  const item = manual.items[0]!; assert.equal(item.subject.origin, 'manual');
  const draft: HandoffDraft = { id: item.draftId, conversationId: saved.id, candidateId: null, baseRevision: base, relations: [], node: {
    id: item.nodeId, workspaceId: session.workspace.id, schemaVersion: 1, revision: base, title, question: title, humanStatement: source,
    authorship: 'human_written', candidateIds: [], conversationId: saved.id, kind: 'method',
    conditions: [{ id: `${id}-condition`, text: 'The original operation identifier is known.', status: 'confirmed', evidenceIds: [], confirmedBy: session.actorId }],
    boundaries: ['Synthetic local acceptance only.'], sources: item.subject.sources.map((s) => ({ ...s, support: 'supports', supportedClaim: source })),
    confirmation: 'draft', evidenceStatus: 'supported', lifecycle: 'active', updatedAt: new Date().toISOString(),
  } };
  await call(`${path}/draft`, { draft, consent: true, options: { operationId: `${id}-draft-save`, source: { kind: 'manual', spans: item.subject.spans },
    expectedConversationHash: saved.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true } }, 'PUT');
  const preview = await call<{ draft: HandoffDraft; changes: ChangeSet }>(`${path}/preview`, { draft, reason: 'Synthetic human confirmation, AI disabled' });
  const confirm = { draft: preview.draft, changes: preview.changes, confirmed: true };
  const approval = await call<Approval>(`${path}/approval`, confirm);
  const committed = await call<CommitReceipt>(`${path}/commit`, { ...confirm, approval });
  assert.equal(committed.indexing, 'pending');
  const receipt = await call<CommitReceipt>(`/api/workspace/commits/${encodeURIComponent(preview.changes.id)}`);
  assert.equal(receipt.revision, committed.revision);
  const query = { task: capture.task, query: title, confirmedOnly: true };
  const before = await call<RetrievalResult>('/api/retrieval/query', query);
  const nodes = (r: RetrievalResult): KnowledgeNode[] => [...r.groups.eligible, ...r.groups.conditional, ...r.groups.conflicts];
  assert(nodes(before).some((node) => node.id === draft.node.id && node.humanStatement === source));

  const use = await call<{ storage: Storage }>('/api/learning/use', { action: 'preview_retrieved', task: capture.task, retrieval: before,
    nodeId: draft.node.id, decision: 'adopt', reason: 'Synthetic use under the original identifier condition.' });
  async function store(storage: Storage, endpoint: string) {
    const request = { operationId: storage.operationId, record: storage.record, baseRevision: storage.baseRevision, retention: 'until_deleted', confirmed: true };
    const approved = await call<Approval>('/api/workspace/approvals/evidence', request);
    return call(endpoint, { action: 'execute', request, approval: approved });
  }
  await store(use.storage, '/api/learning/use');
  const oldUse = await call<{ record: EvidenceRecord }>(`/api/learning/records/${use.storage.record.id}`);
  const outcome = await call<{ storage: Storage }>('/api/learning/outcomes', { action: 'preview', outcome: { useRecordId: use.storage.record.id,
    status: 'failed', summary: 'Identifier alone did not prove the original content.', failureReason: 'The original content hash must also match.' } });
  await store(outcome.storage, '/api/learning/outcomes');

  const changedCondition = 'The original identity and content hash must both match.';
  const revision = await call<{ changes: ChangeSet }>(`/api/governance/nodes/${draft.node.id}`, { action: 'preview', operationId: `${id}-revision`,
    baseRevision: committed.revision, nodeRevision: committed.revision, reason: 'Synthetic failure exposed a missing precondition.',
    patch: { humanStatement: 'Read the original receipt only when both its operation identity and content hash match.',
      conditions: [{ ...draft.node.conditions[0], text: changedCondition }] } }, 'PATCH');
  const prepared = await call<{ changes: ChangeSet }>('/api/governance/changes/prepare', { action: 'prepare', changes: revision.changes });
  const reviseApproval = await call<Approval>('/api/workspace/approvals/knowledge', { changes: prepared.changes, confirmed: true });
  const revised = await call<{ receipt: CommitReceipt }>('/api/governance/changes/commit', { action: 'commit', changes: prepared.changes, approval: reviseApproval });
  const after = await call<RetrievalResult>('/api/retrieval/query', query);
  assert.equal(after.snapshotRevision, revised.receipt.revision); assert.notEqual(after.snapshotRevision, before.snapshotRevision);
  assert.equal(nodes(after).find((node) => node.id === draft.node.id)?.conditions[0]?.text, changedCondition);
  assert.deepEqual((await call<{ record: EvidenceRecord }>(`/api/learning/records/${use.storage.record.id}`)).record, oldUse.record);

  const plan = await call<IndexPlan>('/api/workspace/index/preview', { operationId: `${id}-index`, baseRevision: after.snapshotRevision });
  const indexApproval = await call<Approval>('/api/workspace/index/approve', { plan, confirmed: true });
  let indexed = await call<IndexOperation>('/api/workspace/index/execute', { operationId: plan.operationId, approval: indexApproval });
  for (let i = 0; i < 20 && indexed.state === 'pending'; i++) {
    await new Promise((done) => setTimeout(done, 100));
    indexed = await call<IndexOperation>(`/api/workspace/index/operations/${plan.operationId}`);
  }
  assert.equal(indexed.state, 'current'); assert.equal(indexed.observedIndexRevision, after.snapshotRevision);
  const indexedQuery = await call<RetrievalResult>('/api/retrieval/query', query);
  assert.equal(indexedQuery.snapshotRevision, after.snapshotRevision);
  assert.equal(indexedQuery.coverage, 'partial');
  assert.equal(nodes(indexedQuery).find((node) => node.id === draft.node.id)?.conditions[0]?.text, changedCondition);

  const reviewNode = await call<{ node: KnowledgeNode }>('/api/retrieval/nodes/demo-premise');
  const catalog = await call<{ questions: ReviewQuestionPublic[] }>(`/api/learning/reviews?nodeId=demo-premise&revision=${reviewNode.node.revision}`);
  assert(catalog.questions.length > 0); assert(!JSON.stringify(catalog).includes('standardAnswer')); assert(!JSON.stringify(catalog).includes('expectedEvidence'));
  const reviewTask: TaskContext = { id: `${id}-independent-review`, workspaceId: session.workspace.id, question: 'Recall the caching precondition.', constraints: [], mode: 'independent', updatedAt: new Date().toISOString() };
  const savedReviewTask = await call<TaskState>('/api/workspace/tasks', { operationId: `${id}-review-task`, task: reviewTask, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true });
  assert(savedReviewTask.state === 'available');
  const q = catalog.questions[0]!;
  const original = { operationId: `${id}-start`, taskId: reviewTask.id, questionId: q.id, questionRevision: q.revision, nodeRef: q.nodeRef,
    taskRevision: savedReviewTask.revision, taskContentHash: savedReviewTask.contentHash, retentionDays: 30, confirmed: true };
  const identity = await call<RecoveryAnchor>('/api/workspace/recovery-identities', { actorId: session.actorId, workspaceId: session.workspace.id,
    feature: 'learning', operation: { kind: 'review', operationId: original.operationId }, binding: { requestHash: await contentHash(original) },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), confirmed: true });
  let attempt = await call<Attempt>('/api/learning/attempts', { action: 'start', ...original });
  assert.equal(attempt.view.standardAnswer, undefined);
  for (const event of [{ type: 'confidence', value: 'skipped' }, { type: 'begin' }, { type: 'submit', answer: 'The current task permits briefly stale data.' }]) {
    attempt = await call<Attempt>('/api/learning/attempts', { action: 'event', operationId: `${id}-${event.type}`, attemptId: original.operationId, expectedVersion: attempt.view.version, event });
    assert.equal(attempt.receipt.operationId, `${id}-${event.type}`);
  }
  assert.equal(attempt.view.phase, 'submitted'); assert(!attempt.view.evidenceClass.startsWith('unassisted_'));
  await call('/api/workspace/disconnect', {});
  await call('/api/workspace/connect', { connectionKey: LOCAL_DEMO_KEY, confirmed: true });
  const mutationsBeforeRecovery = mutations;
  const restored = await call<RecoveryAnchorRead>(`/api/workspace/recovery-identities/${identity.id}`);
  assert.equal(restored.binding, 'matched'); assert.equal(restored.readOnly, true); assert.equal(restored.retryAllowed, false);
  assert.equal(restored.original?.operationId, original.operationId); assert.equal(mutations, mutationsBeforeRecovery);
  assert(!JSON.stringify(restored).includes(reviewTask.question));
  return { mode: 'fixture', externalTransport: 'synthetic CNB/Git/index; no external network or model calls', browserAcceptance: false,
    captureId: saved.id, issueNumber: saved.issueNumber, nodeId: draft.node.id, beforeCommit: before.snapshotRevision, afterCommit: after.snapshotRevision,
    useId: use.storage.record.id, outcomeId: outcome.storage.record.id, reviewAttemptId: original.operationId, reviewEvidence: attempt.view.evidenceClass,
    recoveryId: identity.id, indexState: indexed.state, reads, mutations };
}
