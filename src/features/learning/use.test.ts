import { describe, expect, it } from 'vitest';
import { previewUse } from './use';
import { snapshot, task, useInput } from './testing/fixtures';

describe('L01 application decision', () => {
  it('does not treat a confirmed knowledge premise or same-text constraint as satisfied in this task', () => {
    const fixed = { ...snapshot, revision: 'a'.repeat(40), nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'a'.repeat(40), boundaries: [], evidenceStatus: 'supported' as const,
      conditions: node.conditions.map((condition) => ({ ...condition, status: 'confirmed' as const, evidenceIds: ['source-1'], confirmedBy: contextActor })) })) };
    const selection = { ...useInput, snapshotRevision: fixed.revision, nodeRefs: [{ ...useInput.nodeRefs[0]!, revision: fixed.revision }],
      task: { ...task, constraints: [{ id: 'same-text', text: 'A local copy exists', confirmedBy: contextActor }] } };
    expect(previewUse(selection, fixed)).toMatchObject({ ok: true, data: { missingConditions: ['A local copy exists'] } });
    for (const status of ['satisfied', 'not_satisfied', 'unknown'] as const) {
      const input = { ...selection, task: { ...selection.task, conditionChecks: [{ nodeRef: selection.nodeRefs[0]!, conditionId: 'local-copy', status,
        ...(status === 'unknown' ? {} : { confirmedBy: contextActor }) }] } };
      const result = previewUse(input, fixed); expect(result.ok).toBe(true); if (!result.ok) return;
      expect(result.data.missingConditions).toEqual(status === 'satisfied' ? [] : ['A local copy exists']);
      if (status === 'not_satisfied') expect(result.data.warnings.join(' ')).toContain('本次任务前提不满足');
    }
  });
  it('retains an explicit conditional adoption without promoting truth or mastery', () => {
    const result = previewUse(useInput, snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.decision).toBe('adopt');
    expect(result.data.missingConditions).toEqual(['A local copy exists']);
    expect(result.data.persistence).toBe('not_saved');
    expect(result.data).not.toHaveProperty('mastery');
    expect(snapshot.nodes[0]?.evidenceStatus).toBe('unverified');
  });
  it('has no default decision and supports rejection or deferral', () => {
    expect(previewUse({ ...useInput, decision: undefined }, snapshot).ok).toBe(false);
    for (const decision of ['reject', 'verify_later']) {
      expect(previewUse({ ...useInput, decision, reason: '' }, snapshot).ok).toBe(true);
    }
  });
  it('refuses a cross-workspace reference and stale snapshot', () => {
    expect(previewUse({ ...useInput, task: { ...task, workspaceId: 'other' } }, snapshot)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(previewUse({ ...useInput, snapshotRevision: 'fixture:old' }, snapshot)).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'not_written' } });
  });
  it('does not adopt withdrawn, excluded or unconfirmed knowledge', () => {
    for (const current of [
      { ...snapshot, excludedIds: ['node-1'] },
      { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n, lifecycle: 'withdrawn' as const })) },
      { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n, confirmation: 'draft' as const })) },
    ]) expect(previewUse(useInput, current).ok).toBe(false);
  });
  it('rejects missing rationale for conditional adoption and fabricated graph edges', () => {
    expect(previewUse({ ...useInput, reason: '' }, snapshot).ok).toBe(false);
    expect(previewUse({ ...useInput, relationRefs: ['made-up'] }, snapshot).ok).toBe(false);
  });
  it('includes conditions of related prerequisite nodes in the application warning', () => {
    const current = structuredClone(snapshot);
    current.nodes[0]!.conditions = []; current.nodes[0]!.boundaries = []; current.nodes[0]!.evidenceStatus = 'supported';
    current.nodes.push({ ...structuredClone(current.nodes[0]!), id: 'node-2', conditions: [{ id: 'dependency', text: 'Related prerequisite is unknown', status: 'unknown', evidenceIds: [] }] });
    current.relations.push({ id: 'edge-1', workspaceId: task.workspaceId, source: useInput.nodeRefs[0]!, target: { ...useInput.nodeRefs[0]!, objectId: 'node-2' }, type: 'depends_on', rationale: 'The method requires this prerequisite.', evidenceIds: ['source-1'], state: 'confirmed', proposedBy: 'actor-1', confirmedBy: 'actor-1', confirmedAt: task.updatedAt, updatedAt: task.updatedAt });
    expect(previewUse({ ...useInput, relationRefs: ['edge-1'], reason: '' }, current).ok).toBe(false);
    expect(previewUse({ ...useInput, relationRefs: ['edge-1'] }, current)).toMatchObject({ ok: true, data: { missingConditions: ['Related prerequisite is unknown'] } });
  });
});

const contextActor = 'actor-1';
