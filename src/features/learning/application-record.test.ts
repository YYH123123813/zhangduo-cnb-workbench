import { describe, expect, it } from 'vitest';
import { EvidenceRecordSchema, type EvidenceRecord } from '../../contracts/domain';
import { buildUseEvidence, buildOutcomeEvidence } from './application-record';
import { buildUseDraft, describeHistory, evidenceKindLabel } from './history';
import { prepareRetrievedUse } from './retrieval-bridge';
import { context, snapshot, useInput } from './testing/fixtures';

const fixed = { ...structuredClone(snapshot), revision: 'a'.repeat(40), nodes: snapshot.nodes.map((node) => ({ ...structuredClone(node), revision: 'a'.repeat(40) })) };
const selection = { ...useInput, snapshotRevision: fixed.revision, nodeRefs: useInput.nodeRefs.map((ref) => ({ ...ref, revision: fixed.revision })) };
function originalUse() {
  const draft = buildUseDraft(selection, fixed, 'use-structured', '2026-09-05T01:00:00Z');
  if (!draft.ok) throw new Error(draft.error.message);
  const result = buildUseEvidence(draft.data, fixed);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

describe('1.14 application evidence projection', () => {
  it.each(['adopt', 'reject', 'verify_later'] as const)('preserves the original structured context for %s without encoding it in answer', (decision) => {
    const draft = buildUseDraft({ ...selection, decision }, fixed, `use-${decision}`, '2026-09-05T01:00:00Z');
    if (!draft.ok) throw new Error(draft.error.message);
    const result = buildUseEvidence(draft.data, fixed);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(EvidenceRecordSchema.safeParse(result.data).success).toBe(true);
    expect(result.data).toMatchObject({ kind: 'use', decision, answer: '', answerVisible: true, result: 'unverified',
      useContext: { task: selection.task, snapshotRevision: fixed.revision, reason: selection.reason,
        knowledge: [{ conditions: fixed.nodes[0]!.conditions, boundaries: fixed.nodes[0]!.boundaries }],
        retrievalContext: { queryId: null, coverage: 'unavailable', trust: 'client_preview_only', missingConditions: ['A local copy exists'] } } });
    expect(describeHistory(result.data).contextState).toBe('recorded');
    fixed.nodes[0]!.title = 'Changed after projection';
    expect(result.data.useContext!.knowledge[0]!.title).not.toBe(fixed.nodes[0]!.title);
    fixed.nodes[0]!.title = snapshot.nodes[0]!.title;
  });

  it('retains upstream coverage and warnings as well as required formal prerequisites', () => {
    const prepared = prepareRetrievedUse({ task: selection.task, nodeId: 'node-1', decision: 'adopt', reason: selection.reason,
      recordId: 'use-retrieved', recordedAt: '2026-09-05T01:00:00Z', retrieval: { queryId: 'query-original', snapshotRevision: fixed.revision,
        groups: { eligible: [], conditional: fixed.nodes, conflicts: [], excludedIds: [] }, paths: [], answer: null,
        coverage: 'unavailable', warnings: ['CNB semantic unavailable'], missingConditions: ['Original task-specific gap'] } }, fixed, context);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const result = buildUseEvidence(prepared.data.draft, fixed);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.useContext!.retrievalContext).toMatchObject({ queryId: 'query-original', coverage: 'unavailable', trust: 'client_preview_only' });
    expect(result.data.useContext!.retrievalContext.missingConditions).toEqual(expect.arrayContaining(['Original task-specific gap', 'A local copy exists']));
    expect(result.data.useContext!.retrievalContext.warnings).toEqual(expect.arrayContaining(['CNB semantic unavailable', 'Not suitable for live updates']));
  });

  it('does not turn symbolic fixture revisions into persistable Git evidence', () => {
    const draft = buildUseDraft(useInput, snapshot, 'use-fixture', '2026-09-05T01:00:00Z');
    if (!draft.ok) throw new Error(draft.error.message);
    expect(buildUseEvidence(draft.data, snapshot)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(describeHistory(draft.data.record).contextState).toBe('not_recorded');
  });

  it('creates a separate self-reported outcome tied to the original use after knowledge changes', () => {
    const original = originalUse(), before = structuredClone(original);
    const result = buildOutcomeEvidence({ useRecordId: original.id, status: 'failed', summary: 'Did not meet the task', failureReason: 'The premise was false' },
      original, context, 'outcome-1', '2026-09-05T02:00:00Z');
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data).toMatchObject({ id: 'outcome-1', kind: 'outcome', taskId: original.taskId, nodeRefs: original.nodeRefs,
      answer: '', answerVisible: true, result: 'self_reported', outcome: { useRecordId: original.id, status: 'failed', verification: 'self_reported' } });
    expect(result.data).not.toHaveProperty('decision'); expect(result.data).not.toHaveProperty('useContext');
    expect(original).toEqual(before);
    expect(describeHistory(result.data).contextState).toBe('linked_use');
    expect(evidenceKindLabel(result.data.kind)).toBe('实际结果');
  });

  it('refuses missing historical context, wrong use identity and record ID reuse', () => {
    const original = originalUse(), outcome = { useRecordId: original.id, status: 'failed' as const, summary: 'Failed', failureReason: 'Unknown premise' };
    const legacy: EvidenceRecord = { ...original }; delete legacy.useContext;
    expect(buildOutcomeEvidence(outcome, legacy, context, 'outcome-1', '2026-09-05T02:00:00Z').ok).toBe(false);
    expect(buildOutcomeEvidence({ ...outcome, useRecordId: 'other' }, original, context, 'outcome-1', '2026-09-05T02:00:00Z').ok).toBe(false);
    expect(buildOutcomeEvidence(outcome, original, context, original.id, '2026-09-05T02:00:00Z').ok).toBe(false);
  });
});
