import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { KnowledgeSnapshot, Relation } from '../src/contracts/domain';
import type { RequestContext } from '../src/contracts/api';
import { createServices } from '../src/platform/services';
import { registerRoutes } from '../src/features/learning/server';
import { startAttempt, publicAttempt, transitionAttempt } from '../src/features/learning/attempt';
import type { ReviewQuestion } from '../src/features/learning/question';

const now = '2026-09-05T06:00:00Z';
const ctx: RequestContext = { requestId: 'review-request', workspaceId: 'review-w5', actorId: 'review-user', mode: 'fixture', scopes: ['workspace:read', 'knowledge:read', 'evidence:read', 'evidence:write'] };
const base: KnowledgeSnapshot = {
  workspaceId: ctx.workspaceId, revision: 'fixture:review-r1', generatedAt: now, excludedIds: [], relations: [],
  nodes: [{
    id: 'method-a', workspaceId: ctx.workspaceId, revision: 'fixture:review-r1', schemaVersion: 1,
    title: 'Synthetic method', question: 'When may this method be used?', humanStatement: 'Synthetic approved statement',
    authorship: 'human_written', candidateIds: [], conversationId: 'fixture-source', kind: 'method',
    conditions: [], boundaries: [], confirmation: 'confirmed', evidenceStatus: 'supported', lifecycle: 'active',
    sources: [{ id: 'fixture-evidence', kind: 'user_observation', title: 'Synthetic observation', excerpt: 'Synthetic evidence', accessedAt: now,
      support: 'supports', supportedClaim: 'Synthetic approved statement', limitation: 'Review fixture only' }],
    confirmedBy: ctx.actorId, confirmedAt: now, updatedAt: now,
  }],
};
const ref = (id: string) => ({ workspaceId: ctx.workspaceId, objectId: id, revision: base.revision });
const selection = {
  task: { id: 'review-task', workspaceId: ctx.workspaceId, question: 'Apply the synthetic method', constraints: [], mode: 'assisted', updatedAt: now },
  snapshotRevision: base.revision, nodeRefs: [ref('method-a')], relationRefs: [], decision: 'adopt', reason: '',
};
function edge(type: Relation['type']): Relation {
  return { id: 'review-edge', workspaceId: ctx.workspaceId, source: ref('method-a'), target: ref('condition-b'), type,
    rationale: 'Synthetic graph relationship', evidenceIds: ['fixture-evidence'], state: 'confirmed',
    proposedBy: ctx.actorId, confirmedBy: ctx.actorId, confirmedAt: now, updatedAt: now };
}
function appFor(snapshot: KnowledgeSnapshot) {
  const services = { ...createServices(),
    context: async () => ({ ok: true as const, data: ctx }),
    snapshot: async () => ({ ok: true as const, data: structuredClone(snapshot) }),
  };
  const app = new Hono();
  registerRoutes(app, services);
  return app;
}
async function preview(snapshot: KnowledgeSnapshot) {
  const response = await appFor(snapshot).request('/api/learning/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'preview', selection }) });
  return { status: response.status, body: await response.json() };
}
const results: { name: string; passed: boolean; detail?: string }[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : 'Check failed' }); }
}

await check('CONTROL: explicit unconditional use preview succeeds without saving', async () => {
  const { status, body } = await preview(base);
  assert.equal(status, 200);
  assert.equal(body.data.persistence, 'not_saved');
  assert.equal(body.meta.mode, 'fixture');
});

await check('L-R1: omitted relationRefs must not hide a known rejected prerequisite', async () => {
  const snapshot = structuredClone(base);
  const text = 'Required local resource is missing';
  snapshot.nodes.push({ ...structuredClone(base.nodes[0]!), id: 'condition-b', conditions: [{ id: 'missing-resource', text, status: 'rejected', evidenceIds: [] }] });
  snapshot.relations.push(edge('depends_on'));
  const { status, body } = await preview(snapshot);
  assert(!body.ok || body.data.missingConditions.includes(text), `HTTP ${status}; decision=${body.data?.decision}; missingConditions=${JSON.stringify(body.data?.missingConditions)}; warnings=${JSON.stringify(body.data?.warnings)}; frozenNodes=${JSON.stringify(body.data?.draft.knowledge.map((node: { id: string }) => node.id))}`);
});

await check('L-R2: omitted relationRefs must not hide an existing confirmed conflict', async () => {
  const snapshot = structuredClone(base);
  snapshot.nodes.push({ ...structuredClone(base.nodes[0]!), id: 'condition-b' });
  snapshot.relations.push(edge('contradicts'));
  const { status, body } = await preview(snapshot);
  assert(!body.ok || body.data.warnings.length > 0, `HTTP ${status}; decision=${body.data?.decision}; warnings=${JSON.stringify(body.data?.warnings)}; returnedRelations=${JSON.stringify(body.data?.relationRefs)}`);
});

await check('CONTROL: formal use save stays closed without the shared ports', async () => {
  const response = await appFor(base).request('/api/learning/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', selection, consent: true }) });
  const body = await response.json();
  assert.equal(response.status, 501);
  assert.equal(body.error.code, 'NOT_IMPLEMENTED');
  assert.equal(body.error.dataState, 'not_written');
});

await check('CONTROL: answers stay private and unknown exposure is not unassisted', async () => {
  const question: ReviewQuestion = {
    id: 'review-question', workspaceId: ctx.workspaceId, revision: 'fixture:q1', nodeRef: ref('method-a'), kind: 'recall',
    prompt: 'Synthetic question', standardAnswer: 'Synthetic private standard answer', hints: ['First hint', 'Second hint', 'Third hint'],
    rubric: { version: 'fixture:rubric1', criteria: [{ id: 'criterion-1', description: 'State the condition', expectedEvidence: 'Synthetic rubric evidence', required: true }], necessaryConditions: [] },
    review: { status: 'approved', reviewedBy: ctx.actorId, reviewedAt: now },
  };
  const result = startAttempt({ id: 'review-attempt', taskId: 'review-task' }, question, base, ctx, 'unknown', now);
  assert(result.ok);
  let state = result.data;
  assert(!JSON.stringify(publicAttempt(state)).includes(question.standardAnswer));
  for (const event of [{ type: 'confidence', value: 'skipped' }, { type: 'begin' }, { type: 'submit', answer: 'Synthetic original response' }]) {
    const next = transitionAttempt(state, event, ctx, state.version, now, base);
    assert(next.ok);
    state = next.data;
  }
  assert.equal(publicAttempt(state).evidenceClass, 'unverified_exposure');
  assert.equal(state.submission?.answerVisible, true);
});

for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? `\n  ${result.detail}` : ''}`);
console.log(`Review checks: ${results.filter((result) => result.passed).length}/${results.length} passed. No CNB calls or remote writes.`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
