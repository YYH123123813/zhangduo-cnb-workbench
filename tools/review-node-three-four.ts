import assert from 'node:assert/strict';
import type { RequestContext } from '../src/contracts/api';
import type { Approval, Candidate, Conversation, KnowledgeSnapshot, RetrievalRequest } from '../src/contracts/domain';
import { createServices } from '../src/platform/services';
import { runQuery } from '../src/features/retrieval/query';
import { prepareRetrievedUse } from '../src/features/learning/retrieval-bridge';
import { acceptAI, createReview, writeStatement } from '../src/features/handoff/model';
import { toDraft } from '../src/features/handoff/draft';
import { buildChangeSet } from '../src/features/handoff/changes';
import { readableDiff } from '../src/features/handoff/preview';
import { newSubmission, settleSubmission } from '../src/features/handoff/submission';
import { canReplaceReview } from '../src/features/handoff/client-state';

const now = '2026-09-05T06:00:00Z';
const ctx: RequestContext = { requestId: 'review-request', actorId: 'review-user', workspaceId: 'review-workspace', mode: 'fixture', scopes: ['knowledge:read', 'knowledge:write'] };
const snapshot: KnowledgeSnapshot = {
  workspaceId: ctx.workspaceId, revision: 'fixture:review-r1', generatedAt: now, excludedIds: [], relations: [],
  nodes: [{ id: 'cache-node', workspaceId: ctx.workspaceId, revision: 'fixture:review-r1', schemaVersion: 1,
    title: 'Cache method', question: 'When may a cache be used?', humanStatement: 'Cache immutable data.',
    authorship: 'human_written', candidateIds: [], conversationId: 'fixture-conversation', kind: 'method', conditions: [], boundaries: [],
    sources: [{ id: 'review-source', kind: 'user_observation', title: 'Synthetic observation', excerpt: 'Cache immutable data.', accessedAt: now,
      support: 'supports', supportedClaim: 'Cache immutable data.', limitation: '' }],
    confirmation: 'confirmed', evidenceStatus: 'supported', lifecycle: 'active', confirmedBy: ctx.actorId, confirmedAt: now, updatedAt: now,
  }],
};
const request: RetrievalRequest = { task: { id: 'review-task', workspaceId: ctx.workspaceId, question: 'cache', constraints: [], mode: 'independent', updatedAt: now }, query: 'cache', confirmedOnly: true };
const servicesFor = (value: KnowledgeSnapshot) => ({ ...createServices(), snapshot: async () => ({ ok: true as const, data: structuredClone(value) }) });
const results: { name: string; passed: boolean; detail?: string }[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : 'Check failed' }); }
}

const conversation: Conversation = { id: 'fixture-conversation', workspaceId: ctx.workspaceId, taskId: request.task.id, origin: 'cnb_issue',
  issueNumber: 1, sourceAlreadyPersisted: true, segments: [{ id: 's1', role: 'source', text: 'Synthetic source' }], contentHash: 'fixture-hash', createdAt: now, state: 'saved' };
const candidate: Candidate = { id: 'fixture-candidate', conversationId: conversation.id, title: 'Synthetic candidate', question: 'When?', claim: 'Synthetic source', kind: 'claim', whyKeep: 'Review fixture',
  spans: [{ id: 'span1', conversationId: conversation.id, segmentId: 's1', start: 0, end: 16, quote: 'Synthetic source', contentHash: 'fixture-hash' }],
  sources: [], uncertainties: [], modelId: 'fixture-model', promptVersion: 'fixture-v1', generatedAt: now, state: 'proposed' };

await check('CONTROL: editing accepted AI text changes authorship and invalidates old source support', async () => {
  const review = createReview(conversation, [candidate]); assert(review.ok);
  const accepted = acceptAI(review.data.items[0]!);
  accepted.sources = [{ ...structuredClone(snapshot.nodes[0]!.sources[0]!), supportedClaim: candidate.claim }];
  const edited = writeStatement(accepted, 'New human edit');
  assert.equal(edited.authorship, 'human_edited');
  assert.equal(edited.sources[0]?.support, 'unverified');
});

await check('H-R1: a verified completed commit must not block the next candidate or conversation', async () => {
  const created = createReview(conversation, [candidate]); assert(created.ok);
  const review = created.data; review.actorId = ctx.actorId;
  const item = review.items[0]!; item.disposition = 'handoff'; item.statement = 'A human statement for review';
  const draft = toDraft(review, item, snapshot.revision, now); assert(draft.ok);
  const changes = await buildChangeSet(draft.data, review, snapshot, ctx, 'fixture-operation', 'Explicit review fixture', now); assert(changes.ok);
  const approval: Approval = { id: 'fixture-approval', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'commit_knowledge', objectIds: [item.nodeId],
    contentHash: changes.data.contentHash, baseRevision: snapshot.revision, approvedAt: now, expiresAt: '2026-09-05T07:00:00Z' };
  const state = { ...newSubmission(), preview: { draft: draft.data, changes: changes.data, diff: readableDiff(changes.data, snapshot, candidate) }, approval, pending: true };
  const completed = settleSubmission(state, { ok: true, data: { changeSetId: changes.data.id, revision: 'fixture:review-r2', commitUrl: 'https://cnb.cool/fixture/review/-/commit/fixture', indexing: 'pending' } });
  assert(completed.receipt && !completed.pending && !completed.unknown);
  const next = canReplaceReview(review, completed, true);
  assert(next.ok, `Verified receipt exists but next task is blocked: ${JSON.stringify(next)}; activeApproval=${Boolean(completed.approval)}`);
});

await check('R-R1: an old supportedClaim must not qualify a different current statement', async () => {
  const changed = structuredClone(snapshot);
  changed.nodes[0]!.humanStatement = 'Cache all mutable data without invalidation.';
  const result = await runQuery(ctx, request, servicesFor(changed)); assert(result.ok);
  assert(!result.data.groups.eligible.some((node) => node.id === 'cache-node'), `New statement remains eligible with stale source judgment; eligible=${JSON.stringify(result.data.groups.eligible.map((node) => node.id))}; missingConditions=${JSON.stringify(result.data.missingConditions)}`);
});

await check('R-L1: Git-only retrieval must remain usable in the learning handoff', async () => {
  const result = await runQuery(ctx, request, servicesFor(snapshot)); assert(result.ok);
  assert.equal(result.data.groups.eligible.length, 1);
  const use = prepareRetrievedUse({ task: request.task, retrieval: result.data, nodeId: 'cache-node', decision: 'adopt',
    reason: 'Use the reviewed Git original while semantic coverage is unavailable.', recordId: 'review-use', recordedAt: now }, snapshot, ctx);
  assert(use.ok, `Git query succeeded with one eligible result, coverage=${result.data.coverage}, but handoff=${JSON.stringify(use)}`);
});

await check('CONTROL: the same versions link when semantic coverage is partial', async () => {
  const services = { ...servicesFor(snapshot), semanticQuery: async () => ({ ok: true as const, data: [] }) };
  const result = await runQuery(ctx, request, services); assert(result.ok);
  const use = prepareRetrievedUse({ task: request.task, retrieval: result.data, nodeId: 'cache-node', decision: 'adopt',
    reason: 'Use the original with the stated coverage limitation.', recordId: 'review-use', recordedAt: now }, snapshot, ctx);
  assert(use.ok, JSON.stringify(use));
  assert.equal(use.data.draft.snapshotRevision, snapshot.revision);
});

for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? `\n  ${result.detail}` : ''}`);
console.log(`Review checks: ${results.filter((result) => result.passed).length}/${results.length} passed. Fixture-only; no remote calls or writes.`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
