import { describe, expect, it } from 'vitest';
import { runQuery } from './query';
import { assessConditions } from './conditions';
import { clarificationFor } from './clarification';
import { context, fixtureServices, node, relation, request, snapshot } from './test-support';

describe('R02 minimal clarification', () => {
  const n = node('n1', { conditions: [
    { id: 'immutable', text: 'Data is immutable', status: 'unknown', evidenceIds: [] },
    { id: 'bounded', text: 'Size is bounded', status: 'unknown', evidenceIds: [] },
  ] });
  it('asks only one material condition and leaves the result conditional when skipped', async () => {
    const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot([n]) }) }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.eligible).toHaveLength(0);
    expect(result.data.groups.conditional.map((n) => n.id)).toEqual(['n1']);
    expect(clarificationFor(result.data, request.task)).toEqual({ nodeId: 'n1', id: 'immutable', text: 'Data is immutable' });
    expect(clarificationFor(result.data, request.task, true)).toBeNull();
    expect(result.data.missingConditions).toHaveLength(2);
  });
  it('does not ask when there are no matching conditional nodes', async () => {
    const result = await runQuery(context, { ...request, query: 'unrelated' }, fixtureServices());
    expect(result.ok && clarificationFor(result.data, request.task)).toBeNull();
  });
  it('does not treat unconfirmed user text as a satisfied condition', async () => {
    const result = await runQuery(context, { ...request, task: { ...request.task, constraints: [{ id: 'immutable', text: 'Data is immutable' }] } }, fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot([n]) }) }));
    expect(result.ok && result.data.groups.eligible).toEqual([]);
  });
  it('does not interrupt for an unknown condition while a direct unresolved conflict blocks the knowledge', async () => {
    const data = snapshot([n, node('opposite')], { relations: [relation('conflict', 'n1', 'opposite', 'contradicts')] });
    const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data }) }));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.data.groups.conflicts.map((item) => item.id)).toContain(n.id);
    expect(clarificationFor(result.data, request.task)).toBeNull();
    expect(result.data.missingConditions).toContain(n.conditions[0]!.text);
  });
  it('does not ask a condition that cannot resolve lifecycle, rejected-premise, boundary or source blockers', async () => {
    for (const blocked of [
      { ...n, lifecycle: 'needs_review' as const }, { ...n, lifecycle: 'superseded' as const },
      { ...n, conditions: [...n.conditions, { id: 'rejected', text: 'No valid inputs', status: 'rejected' as const, evidenceIds: [] }] },
      { ...n, boundaries: ['Only a different task context'] }, { ...n, evidenceStatus: 'partial' as const },
      { ...n, sources: [] }, { ...n, sources: [{ ...n.sources[0]!, supportedClaim: 'A different statement.' }] },
    ]) {
      const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot([blocked]) }) }));
      if (!result.ok) throw new Error(result.error.code);
      expect(clarificationFor(result.data, request.task), JSON.stringify(blocked)).toBeNull();
      expect(result.data.groups.conditional.map((item) => item.id)).toContain(n.id);
      expect(result.data.missingConditions).toContain(n.conditions[0]!.text);
    }
  });
  it('skips blocked candidates and asks one actionable condition without changing the original result', async () => {
    const ready = node('ready', { conditions: [{ id: 'ready-condition', text: 'Ready for this task', status: 'unknown', evidenceIds: [] }] });
    const data = snapshot([{ ...n, sources: [] }, ready]);
    const result = await runQuery(context, request, fixtureServices({ snapshot: async () => ({ ok: true, data }) }));
    if (!result.ok) throw new Error(result.error.code);
    const before = structuredClone(result.data);
    expect(clarificationFor(result.data, request.task)).toEqual({ nodeId: ready.id, id: 'ready-condition', text: 'Ready for this task' });
    expect(result.data).toEqual(before); expect(clarificationFor(result.data, request.task, true)).toBeNull();
  });
  it('binds confirmation to the remaining condition ID when two nodes use the same wording', async () => {
    const condition = { text: 'Input is stable', status: 'unknown' as const, evidenceIds: [] };
    const revision = 'a'.repeat(40);
    const services = fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot([
      node('n1', { revision, conditions: [{ ...condition, id: 'first-condition' }] }),
      node('n2', { revision, conditions: [{ ...condition, id: 'second-condition' }] }),
    ]) }) });
    const first = await runQuery(context, request, services); if (!first.ok) throw new Error(first.error.code);
    expect(clarificationFor(first.data, request.task)).toEqual({ nodeId: 'n1', id: 'first-condition', text: condition.text });
    const task = { ...request.task, conditionChecks: [{ nodeRef: { workspaceId: 'w1', objectId: 'n1', revision }, conditionId: 'first-condition', status: 'satisfied' as const, confirmedBy: context.actorId }] };
    const second = await runQuery(context, { ...request, task }, services); if (!second.ok) throw new Error(second.error.code);
    expect(clarificationFor(second.data, task)).toEqual({ nodeId: 'n2', id: 'second-condition', text: condition.text });
    expect(second.data.groups.eligible.map((n) => n.id)).toEqual(['n1']);
    const done = { ...task, conditionChecks: [...task.conditionChecks, { nodeRef: { workspaceId: 'w1', objectId: 'n2', revision }, conditionId: 'second-condition', status: 'satisfied' as const, confirmedBy: context.actorId }] };
    const third = await runQuery(context, { ...request, task: done }, services); if (!third.ok) throw new Error(third.error.code);
    expect(clarificationFor(third.data, done)).toBeNull();
    expect(third.data.groups.eligible.map((n) => n.id)).toEqual(['n1', 'n2']);
  });
});

describe('R06 task applicability', () => {
  const condition = { id: 'immutable', text: 'Data is immutable', status: 'confirmed' as const, evidenceIds: ['s-n1'], confirmedBy: 'u1' };
  it('distinguishes satisfied, rejected and unknown without model guesses', () => {
    const n = node('n1', { revision: 'a'.repeat(40), conditions: [condition] });
    expect(assessConditions(n, request.task)[0]?.status).toBe('unknown');
    const task = { ...request.task, conditionChecks: [{ nodeRef: { workspaceId: n.workspaceId, objectId: n.id, revision: n.revision }, conditionId: condition.id, status: 'satisfied' as const, confirmedBy: 'u1' }] };
    expect(assessConditions(n, task)[0]?.status).toBe('satisfied');
    expect(assessConditions({ ...n, conditions: [{ ...condition, status: 'rejected' }] }, task)[0]?.status).toBe('not_satisfied');
  });
  it('does not reinterpret a changed condition or an unconfirmed paraphrase as satisfaction', () => {
    const n = node('n1', { conditions: [condition] });
    for (const constraint of [{ id: 'immutable', text: 'Data is mutable', confirmedBy: 'u1' }, { id: 'immutable', text: condition.text }]) {
      expect(assessConditions(n, { ...request.task, constraints: [constraint] })[0]?.status).toBe('unknown');
    }
  });
  it('propagates an unmet low-similarity premise and preserves the user task', async () => {
    const premise = node('premise', { title: 'Input stability', question: 'Input state?', humanStatement: 'Immutable inputs', conditions: [condition] });
    const input = structuredClone(request);
    const services = fixtureServices({ snapshot: async () => ({ ok: true, data: snapshot([node(), premise], { relations: [relation('requires', 'n1', 'premise')] }) }) });
    const result = await runQuery(context, input, services);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.groups.eligible).toEqual([]);
    expect(result.data.groups.conditional.map((n) => n.id).sort()).toEqual(['n1', 'premise']);
    expect(result.data.missingConditions.join()).toContain('前提');
    expect(input).toEqual(request);
  });
});
