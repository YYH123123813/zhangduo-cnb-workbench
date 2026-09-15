import { describe, expect, it } from 'vitest';
import type { RetrievalResult } from '../../contracts/domain';
import { prepareRetrievedUse } from './retrieval-bridge';
import { context, snapshot, task, useInput } from './testing/fixtures';

const coverageWarning = '语义检索覆盖不可用；本预览仅核对 Git 正式知识，检索完整性尚未确认。';
const upstreamWarning = '语义召回不可用，当前仅显示 Git 文本结果。';

function fallbackFixture() {
  const official = structuredClone(snapshot);
  official.nodes.push({ ...structuredClone(snapshot.nodes[0]!), id: 'prerequisite',
    conditions: [{ id: 'stable', text: 'The local copy is stable', status: 'unknown', evidenceIds: [] }],
  });
  official.relations.push({ id: 'requires', workspaceId: context.workspaceId,
    source: { workspaceId: context.workspaceId, objectId: 'node-1', revision: official.revision },
    target: { workspaceId: context.workspaceId, objectId: 'prerequisite', revision: official.revision },
    type: 'depends_on', state: 'confirmed', rationale: 'A required premise', evidenceIds: ['source-1'],
    proposedBy: context.actorId, confirmedBy: context.actorId, confirmedAt: task.updatedAt, updatedAt: task.updatedAt,
  });
  const retrieval: RetrievalResult = {
    queryId: 'git-only-query', snapshotRevision: official.revision,
    groups: { eligible: [], conditional: structuredClone(official.nodes), conflicts: [], excludedIds: [] },
    paths: [{ seedId: 'node-1', nodeIds: ['node-1', 'prerequisite'], relationIds: ['requires'], reason: 'Confirmed prerequisite' }],
    answer: null, missingConditions: ['An external dependency was not checked'], warnings: [upstreamWarning], coverage: 'unavailable',
  };
  return { official, input: { task: structuredClone(task), retrieval, nodeId: 'node-1', decision: 'adopt' as const,
    reason: useInput.reason, recordId: 'record-1', recordedAt: task.updatedAt } };
}

describe('Git-verified application preview with unavailable semantic coverage', () => {
  it.each([{ source: 'provider warnings', warnings: [upstreamWarning] }, { source: 'no provider warnings', warnings: [] }])('keeps verified text, conditions and visible coverage warnings with $source', ({ warnings }) => {
    const { official, input } = fallbackFixture();
    input.retrieval.warnings = warnings;
    const original = structuredClone(input);
    const result = prepareRetrievedUse(input, official, context);
    expect(result).toMatchObject({ ok: true, data: {
      selection: { relationRefs: ['requires'] }, handoffTrust: 'client_preview_only', exposure: 'unknown',
      preview: { persistence: 'not_saved', missingConditions: expect.arrayContaining([
        'A local copy exists', 'The local copy is stable', 'An external dependency was not checked',
      ]), warnings: expect.arrayContaining([...warnings, coverageWarning, 'Not suitable for live updates']) },
      draft: { persistence: 'not_saved', indexing: 'excluded', taskSnapshot: input.task, paths: input.retrieval.paths,
        knowledge: expect.arrayContaining([expect.objectContaining({ id: 'node-1', humanStatement: 'Use a local copy.' })]),
        retrievalContext: { queryId: 'git-only-query', coverage: 'unavailable', warnings: [...warnings, coverageWarning] },
        record: { kind: 'use', answerVisible: true, result: 'unverified' },
      },
    } });
    expect(input).toEqual(original);
    if (!result.ok) throw new Error('Expected a verified Git preview');
    input.retrieval.warnings.push('Later client mutation');
    input.retrieval.paths[0]!.reason = 'Changed path';
    input.task.constraints.length = 0;
    expect(result.data.draft.paths).toEqual(original.retrieval.paths);
    expect(result.data.draft.taskSnapshot).toEqual(original.task);
    expect(result.data.draft.retrievalContext?.warnings).not.toContain('Later client mutation');
  });

  it.each(['reject', 'verify_later'] as const)('allows %s without an adoption rationale, still showing the gap', (decision) => {
    const { official, input } = fallbackFixture();
    expect(prepareRetrievedUse({ ...input, decision, reason: '' }, official, context)).toMatchObject({ ok: true, data: {
      preview: { decision, warnings: expect.arrayContaining([coverageWarning]) }, exposure: 'unknown', handoffTrust: 'client_preview_only',
    } });
  });

  it('requires an adoption rationale even for otherwise unconditional knowledge', () => {
    const { official, input } = fallbackFixture();
    official.nodes.forEach((node) => { node.conditions = []; node.boundaries = []; node.evidenceStatus = 'supported'; });
    input.retrieval.groups.conditional = structuredClone(official.nodes);
    input.retrieval.missingConditions = []; input.retrieval.warnings = [];
    expect(prepareRetrievedUse({ ...input, reason: '   ' }, official, context)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(prepareRetrievedUse(input, official, context).ok).toBe(true);
  });

  it('does not infer unassisted evidence from either a missing answer or unavailable coverage', () => {
    const { official, input } = fallbackFixture();
    input.retrieval.answer = { text: 'Already displayed answer', citations: [] };
    expect(prepareRetrievedUse(input, official, context)).toMatchObject({ ok: true, data: {
      exposure: 'seen', handoffTrust: 'client_preview_only', draft: { record: { kind: 'use', answerVisible: true, result: 'unverified' } },
    } });
  });

  it('continues to reject missing knowledge, unauthorized workspaces and stale node or snapshot versions', () => {
    const { official, input } = fallbackFixture();
    expect(prepareRetrievedUse({ ...input, nodeId: 'not-a-hit' }, official, context).ok).toBe(false);
    expect(prepareRetrievedUse(input, official, { ...context, scopes: [] })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(prepareRetrievedUse(input, official, { ...context, workspaceId: 'foreign' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(prepareRetrievedUse(input, { ...official, nodes: [] }, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(prepareRetrievedUse(input, { ...official, revision: 'fixture:r2' }, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    input.retrieval.groups.conditional[0]!.revision = 'fixture:old';
    expect(prepareRetrievedUse(input, official, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it.each(['node-1', 'prerequisite', 'requires'])('keeps current Git exclusions authoritative: %s', (id) => {
    const { official, input } = fallbackFixture(); official.excludedIds = [id];
    expect(prepareRetrievedUse(input, official, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('keeps retrieval exclusions, path integrity and confirmed relation endpoints mandatory', () => {
    const { official, input } = fallbackFixture();
    for (const id of ['node-1', 'prerequisite']) {
      expect(prepareRetrievedUse({ ...input, retrieval: { ...input.retrieval, groups: { ...input.retrieval.groups, excludedIds: [id] } } }, official, context).ok).toBe(false);
    }
    expect(prepareRetrievedUse(input, { ...official, relations: [] }, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    official.relations[0]!.state = 'proposed';
    expect(prepareRetrievedUse(input, official, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    official.relations[0]!.state = 'confirmed'; official.relations[0]!.target.revision = 'fixture:old';
    expect(prepareRetrievedUse(input, official, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    input.retrieval.paths[0]!.nodeIds.reverse();
    expect(prepareRetrievedUse(input, official, context)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it.each(['draft', 'withdrawn', 'superseded', 'conflict'] as const)('does not permit adoption of %s knowledge', (state) => {
    const { official, input } = fallbackFixture();
    if (state === 'draft') official.nodes[0]!.confirmation = 'draft';
    else if (state !== 'conflict') official.nodes[0]!.lifecycle = state;
    input.retrieval.groups.conditional = structuredClone(official.nodes);
    if (state === 'conflict') input.retrieval.groups.conflicts = input.retrieval.groups.conditional.splice(0, 1);
    expect(prepareRetrievedUse(input, official, context)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});
