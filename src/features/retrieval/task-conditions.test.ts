import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeNode, TaskConditionCheck, TaskContext } from '../../contracts/domain';
import { TransientRetrieval } from '../../app/transient-retrieval';
import { QuerySchema } from './api';
import { prepareAnswerInput } from './answer';
import { queryLeaveState, queryTask } from './client-state';
import { assessConditions } from './conditions';
import { clarificationFor } from './clarification';
import { runQuery } from './query';
import { registerRoutes } from './server';
import { context, fixtureServices, node, relation, request, snapshot } from './test-support';

const revision = 'a'.repeat(40);
const claim = node('claim', { revision });
const premise = node('premise', { revision, title: 'Input state', question: 'When?', humanStatement: 'Immutable inputs',
  conditions: [{ id: 'stable', text: 'Input is stable', status: 'confirmed', evidenceIds: [] }] });
const edge = relation('requires', claim.id, premise.id, 'depends_on', {
  source: { workspaceId: 'w1', objectId: claim.id, revision }, target: { workspaceId: 'w1', objectId: premise.id, revision },
});
const data = snapshot([claim, premise], { revision, relations: [edge] });
const checkFor = (status: TaskConditionCheck['status'], n = premise, conditionId = 'stable'): TaskConditionCheck => ({
  nodeRef: { workspaceId: n.workspaceId, objectId: n.id, revision: n.revision }, conditionId, status,
  ...(status === 'unknown' ? {} : { confirmedBy: context.actorId }),
});
const taskFor = (status: TaskConditionCheck['status']): TaskContext => ({ ...request.task, mode: 'assisted', conditionChecks: [checkFor(status)] });
const servicesFor = (nodes = data.nodes, relations = data.relations) => fixtureServices({ snapshot: async () => ({ ok: true, data: { ...data, nodes, relations } }) });

describe('W4-REQ-006 exact task condition tri-state', () => {
  it('changes only one task check on the same snapshot and propagates rejection, uncertainty and satisfaction', async () => {
    const original = structuredClone(data); const results = [];
    for (const status of ['not_satisfied', 'unknown', 'satisfied'] as const) {
      const task = taskFor(status); const before = structuredClone(task);
      const result = await runQuery(context, { ...request, task }, servicesFor());
      if (!result.ok) throw new Error(result.error.code);
      expect(result.data.snapshotRevision).toBe(revision);
      expect(result.data.paths.some((path) => path.relationIds.includes(edge.id))).toBe(true);
      expect(result.data.groups.eligible.map((n) => n.id).sort()).toEqual(status === 'satisfied' ? ['claim', 'premise'] : []);
      if (status !== 'satisfied') expect(result.data.missingConditions.join()).toContain('前提 premise');
      if (status === 'not_satisfied') {
        expect(result.data.missingConditions.join()).toContain('不满足');
        expect(clarificationFor(result.data, task)).toBeNull();
      }
      if (status === 'unknown') {
        expect(result.data.missingConditions).toContain(premise.conditions[0]!.text);
        expect(clarificationFor(result.data, task)?.nodeId).toBe(premise.id);
        expect(clarificationFor(result.data, task, true)).toBeNull();
      }
      expect(task).toEqual(before); results.push(result.data);
    }
    expect(results[0]!.missingConditions).not.toEqual(results[1]!.missingConditions);
    expect(data).toEqual(original);
  });
  it('keeps legacy confirmation and natural-language negation unknown', async () => {
    for (const text of ['Input is stable', 'Input is NOT stable']) {
      const task = { ...request.task, constraints: [{ id: 'stable', text, confirmedBy: context.actorId }] };
      expect(assessConditions(premise, task)[0]?.status).toBe('unknown');
      const result = await runQuery(context, { ...request, task }, servicesFor());
      expect(result.ok && result.data.groups.eligible).toEqual([]);
    }
  });
  it('does not share a confirmation between matching text on different nodes or condition IDs', async () => {
    const second = node('second', { revision, conditions: [{ ...premise.conditions[0]!, id: 'different' }, premise.conditions[0]!] });
    const task = { ...taskFor('satisfied'), conditionChecks: [checkFor('satisfied'), checkFor('satisfied', second, 'different')] };
    expect(assessConditions(second, task).map((check) => check.status)).toEqual(['satisfied', 'unknown']);
    const result = await runQuery(context, { ...request, task }, servicesFor([claim, premise, second]));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.data.groups.eligible.map((n) => n.id).sort()).toEqual(['claim', 'premise']);
    expect(clarificationFor(result.data, task)).toMatchObject({ nodeId: second.id, id: 'stable' });
  });
  it('rejects old checks when a source/version or condition ID changes, even with identical text', async () => {
    for (const changed of [
      { ...premise, revision: 'b'.repeat(40), sources: [{ ...premise.sources[0]!, excerpt: 'Changed source' }] },
      { ...premise, conditions: [{ ...premise.conditions[0]!, id: 'renamed' }] },
    ]) {
      expect(assessConditions(changed, taskFor('satisfied'))[0]?.status).toBe('unknown');
      const services = servicesFor([claim, changed]);
      const semantic = vi.spyOn(services, 'semanticQuery');
      expect(await runQuery(context, { ...request, task: taskFor('satisfied') }, services)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(semantic).not.toHaveBeenCalled();
    }
  });
  it('rejects impersonated confirmation at the actual retrieval HTTP boundary', async () => {
    const services = servicesFor(); services.approveModel = vi.fn(); services.revokeApproval = vi.fn();
    const read = vi.spyOn(services, 'snapshot');
    const app = new Hono(); registerRoutes(app, services);
    for (const path of ['/api/retrieval/query', '/api/retrieval/answer/preview']) {
      const input = { ...request, task: { ...taskFor('satisfied'), conditionChecks: [{ ...checkFor('satisfied'), confirmedBy: 'fake-actor' }] } };
      const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(path.endsWith('query') ? input : { request: input }) });
      expect(response.status).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('preserves public schema refinements for attribution, duplicates and fixed versions', () => {
    const check = checkFor('satisfied');
    for (const checks of [
      [{ ...check, confirmedBy: undefined }], [{ ...check, status: 'unknown' }], [check, check],
      [{ ...check, nodeRef: { ...check.nodeRef, revision: 'HEAD' } }],
    ]) expect(QuerySchema.safeParse({ ...request, task: { ...request.task, conditionChecks: checks } }).success, JSON.stringify(checks)).toBe(false);
    expect(QuerySchema.safeParse({ ...request, task: taskFor('unknown') }).success).toBe(true);
  });
  it('rejects a foreign workspace binding through the shared authorized task validator', async () => {
    const check = checkFor('satisfied');
    const task = { ...taskFor('satisfied'), conditionChecks: [{ ...check, nodeRef: { ...check.nodeRef, workspaceId: 'foreign-workspace' } }] };
    expect(await runQuery(context, { ...request, task }, servicesFor())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('does not ask disconnected conditions or send them as model input', async () => {
    const disconnected = node('disconnected', { revision, title: 'Unrelated topic', question: 'Separate?', humanStatement: 'Private unrelated state', conditions: premise.conditions });
    const task = { ...taskFor('satisfied'), conditionChecks: [checkFor('satisfied'), checkFor('unknown', disconnected)] };
    const result = await runQuery(context, { ...request, task }, servicesFor([claim, premise, disconnected]));
    if (!result.ok) throw new Error(result.error.code);
    expect(clarificationFor(result.data, task)).toBeNull();
    const input = prepareAnswerInput({ ...request, task }, result.data);
    if (!input.ok) throw new Error(input.error.code);
    expect(JSON.parse(input.data.text).conditionChecks).toEqual([checkFor('satisfied')]);
    expect(input.data.text).not.toContain(disconnected.id);
  });
  it('keeps source, lifecycle, conflict and replacement gates after satisfaction', async () => {
    const other = node('other', { revision });
    const incident = (type: 'contradicts' | 'supersedes') => ({ ...edge, id: type, type, source: { ...edge.source, objectId: other.id }, target: { ...edge.target, objectId: claim.id } });
    const variants: [KnowledgeNode[], typeof data.relations][] = [
      [[claim, { ...premise, sources: [] }], [edge]], [[{ ...claim, lifecycle: 'needs_review' }, premise], [edge]],
      [[claim, premise, other], [edge, incident('contradicts')]], [[claim, premise, other], [edge, incident('supersedes')]],
    ];
    for (const [nodes, relations] of variants) {
      const result = await runQuery(context, { ...request, task: taskFor('satisfied') }, servicesFor(nodes, relations));
      if (!result.ok) throw new Error(result.error.code);
      expect(result.data.groups.eligible.map((n) => n.id)).not.toContain(claim.id);
    }
  });
  it('freezes full tri-state task/result handoff and marks changed checks dirty', async () => {
    const task = taskFor('not_satisfied');
    const result = await runQuery(context, { ...request, task }, servicesFor());
    if (!result.ok) throw new Error(result.error.code);
    const sent = queryTask(task, task.id, task.workspaceId, task.question, task.constraints, task.updatedAt);
    const bridge = new TransientRetrieval();
    bridge.bind({ actorId: context.actorId, workspace: { id: context.workspaceId, slug: 'fixture/conditions', mode: 'fixture', visibility: 'private' }, scopes: [...context.scopes] });
    expect(bridge.accept(sent, result.data)).toBe(true);
    expect(queryLeaveState(taskFor('unknown'), task, 'clean')).toBe('dirty');
    task.conditionChecks![0]!.status = 'satisfied';
    expect(sent.conditionChecks![0]!.status).toBe('not_satisfied');
    const original = bridge.forLearning({ taskId: sent.id, nodeId: claim.id, revision });
    expect(original?.task.conditionChecks).toEqual([checkFor('not_satisfied')]);
  });
});
