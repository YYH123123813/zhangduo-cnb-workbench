import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/app';
import { unavailable } from '../../contracts/api';
import type { Approval, ChangeSet, EvidenceRecord, KnowledgeSnapshot, RetrievalRequest, RetrievalResult } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { hashChangeSet } from '../../contracts/hash';
import { ctx, fixture, json, node, now, ok, relation, snapshot } from './fixtures.test-support';
import { deleteApproval, deletePlan } from './delete.fixtures.test-support';

const baseRevision = 'a'.repeat(40);
const task: RetrievalRequest = { query: 'cache', confirmedOnly: true, task: { id: 'task-regression', workspaceId: ctx.workspaceId, question: 'When can this cache be reused?', constraints: [{ id: 'condition-1', text: 'Same version', confirmedBy: ctx.actorId }],
  conditionChecks: [{ nodeRef: { workspaceId: ctx.workspaceId, objectId: 'node-1', revision: baseRevision }, conditionId: 'condition-1', status: 'satisfied', confirmedBy: ctx.actorId }], mode: 'assisted', updatedAt: now } };
const originalRecord: EvidenceRecord = { id: 'old-evidence', workspaceId: ctx.workspaceId, taskId: task.task.id, kind: 'use', nodeRefs: [{ workspaceId: ctx.workspaceId, objectId: 'node-1', revision: baseRevision }], relationRefs: ['edge-1'], decision: 'adopt', answer: 'Original version answer', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'self_reported', recordedAt: now };

function regressionFixture() {
  const statement = 'Reuse only when the version is unchanged.';
  const sources = [{ ...node().sources[0]!, supportedClaim: statement }];
  const edge = relation(); edge.source.revision = baseRevision; edge.target.revision = baseRevision;
  let head = snapshot({ revision: baseRevision, relations: [edge], nodes: [node('node-1', { revision: baseRevision, humanStatement: statement, sources, boundaries: [] }), node('node-2', { revision: baseRevision, humanStatement: statement, sources, conditions: [], boundaries: [] })] });
  const history = new Map<string, KnowledgeSnapshot>([[head.revision, structuredClone(head)]]);
  const receipts = new Map<string, { changeSetId: string; revision: string; commitUrl: string; indexing: 'pending' }>();
  const { services } = fixture({
    snapshot: vi.fn<Services['snapshot']>(async (_ctx, revision) => revision ? history.has(revision) ? ok(structuredClone(history.get(revision)!)) : unavailable() : ok(structuredClone(head))),
    semanticQuery: vi.fn(async () => ok([{ objectId: 'node-1', score: 0.95, text: 'VECTOR_OLD_SECRET' }, { objectId: 'node-2', score: 0.9, text: 'VECTOR_OLD_SECRET' }])),
    settings: vi.fn(async () => ok({ aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false })),
    listEvidence: vi.fn(async () => ok([structuredClone(originalRecord)])),
    commit: vi.fn<Services['commit']>(async (_ctx, changes) => {
      const prior = receipts.get(changes.id);
      if (prior) return ok(prior);
      const revision = String(history.size + 1).padStart(40, '0');
      head = { ...head, revision, nodes: head.nodes.map((old) => { const edited = changes.nodes.find((n) => n.id === old.id); return edited ? { ...edited, revision } : old; }),
        relations: head.relations.map((old) => changes.relations.find((r) => r.id === old.id) ?? old), excludedIds: [...new Set([...head.excludedIds, ...changes.withdrawnIds])] };
      history.set(revision, structuredClone(head));
      const receipt = { changeSetId: changes.id, revision, commitUrl: `https://example.invalid/${revision}`, indexing: 'pending' as const };
      receipts.set(changes.id, receipt);
      return ok(receipt);
    }),
    previewDelete: vi.fn(async () => ok(await deletePlan({ baseRevision: head.revision }))),
    executeDelete: vi.fn<Services['executeDelete']>(async (_ctx, plan) => {
      head = { ...head, revision: String(history.size + 1).padStart(40, '0'), excludedIds: [...head.excludedIds, ...plan.objectIds] };
      history.set(head.revision, structuredClone(head));
      return ok({ planId: plan.id, retrievalBlocked: true, layers: [{ name: 'index', state: 'pending', detail: 'Stale vectors remain' }] });
    }),
  });
  const app = createApp(services);
  async function query(conditionChecks = task.task.conditionChecks): Promise<RetrievalResult> {
    const response = await app.request('/api/retrieval/query', json('POST', { ...task, task: { ...task.task, conditionChecks } }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.data;
  }
  async function confirm(changes: Omit<ChangeSet, 'contentHash'>) {
    const prepared = await (await app.request('/api/governance/changes/prepare', json('POST', { action: 'prepare', changes }))).json();
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    const value: ChangeSet = prepared.data.changes;
    const approval: Approval = { id: `${value.id}-approval`, workspaceId: ctx.workspaceId, actorId: ctx.actorId, purpose: 'commit_knowledge', objectIds: prepared.data.objectIds, baseRevision: value.baseRevision, contentHash: await hashChangeSet(value), approvedAt: new Date(Date.now() - 1).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const result = await app.request('/api/governance/changes/commit', json('POST', { action: 'commit', changes: value, approval }));
    expect(result.status, await result.clone().text()).toBe(200);
  }
  return { app, services, query, confirm, getHead: () => head };
}

describe('G14 shared-API regression with stale semantic fixtures', () => {
  it('changes a prerequisite, retains original evidence and restores through a new revision', async () => {
    const { app, query, confirm, getHead } = regressionFixture();
    const initial = await query();
    expect(initial.groups.eligible.map((n) => n.id), JSON.stringify(initial)).toContain('node-1');
    expect(initial.groups.eligible.map((n) => n.id)).toContain('node-2');
    const edit = await (await app.request('/api/governance/nodes/node-1', json('PATCH', { action: 'preview', operationId: 'revision-test', baseRevision, nodeRevision: baseRevision, reason: 'Changed prerequisite', patch: { conditions: [{ id: 'new-condition', text: 'A different required version', status: 'unknown', evidenceIds: [] }] } }))).json();
    await confirm(edit.data.changes);
    expect((await app.request('/api/retrieval/query', json('POST', task))).status).toBe(409);
    const after = await query([]);
    expect(after.groups.eligible.map((n) => n.id)).not.toContain('node-1');
    expect(after.groups.eligible.map((n) => n.id)).not.toContain('node-2');
    expect(JSON.stringify(after)).not.toContain('VECTOR_OLD_SECRET');
    const history = (await (await app.request('/api/governance/history?nodeId=node-1')).json()).data;
    expect(history.entries[0].record).toEqual(originalRecord);
    expect(history.entries[0].nodes[0].historicalConditions[0].text).toBe('Same version');
    const restored = await (await app.request('/api/governance/rollback', json('POST', { action: 'preview', operationId: 'restore-test', nodeId: 'node-1', baseRevision: getHead().revision, historicalRevision: baseRevision, reason: 'Restore original conditions' }))).json();
    await confirm(restored.data.changes);
    expect(getHead().revision).toBe('3'.padStart(40, '0'));
    expect((await app.request('/api/retrieval/query', json('POST', task))).status).toBe(409);
    const restoredResult = await query([]);
    const restoredNode = [...restoredResult.groups.eligible, ...restoredResult.groups.conditional].find((n) => n.id === 'node-1');
    expect(restoredNode, JSON.stringify(restoredResult)).toMatchObject({ revision: getHead().revision, conditions: [{ text: 'Same version' }] });
    expect(restoredResult.groups.eligible.map((n) => n.id)).not.toContain('node-1');
    expect(restoredResult.coverage).not.toBe('current');
    expect(JSON.stringify(restoredResult)).not.toContain('VECTOR_OLD_SECRET');
  });
  it('withdraws an edge and blocks deleted knowledge while stale vectors still exist', async () => {
    const { app, query, confirm, getHead, services } = regressionFixture();
    const before = await query();
    expect(before.paths.some((path) => path.relationIds.includes('edge-1'))).toBe(true);
    const edit = await (await app.request('/api/governance/relations/edge-1', json('PATCH', { action: 'preview', operationId: 'withdraw-test', baseRevision: getHead().revision, reason: 'Wrong relationship', patch: { state: 'withdrawn' } }))).json();
    await confirm(edit.data.changes);
    expect((await query()).paths.some((path) => path.relationIds.includes('edge-1'))).toBe(false);
    const plan = await deletePlan({ baseRevision: getHead().revision });
    const response = await app.request('/api/governance/delete/execute', json('POST', { action: 'execute', plan, approval: deleteApproval(plan) }));
    expect(response.status, await response.clone().text()).toBe(200);
    const after = await query([]);
    expect([...after.groups.eligible, ...after.groups.conditional, ...after.groups.conflicts].map((n) => n.id)).not.toContain('node-1');
    expect(JSON.stringify(after)).not.toContain('VECTOR_OLD_SECRET');
    expect(services.complete).not.toHaveBeenCalled();
  });
});
