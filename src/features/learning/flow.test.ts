import { describe, expect, it } from 'vitest';
import type { RetrievalResult } from '../../contracts/domain';
import { prepareRetrievedUse } from './retrieval-bridge';
import { revisionClues, taskHref } from './links';
import { describeHistory } from './history';
import { previewOutcome } from './outcome';
import { context, snapshot, task } from './testing/fixtures';

const retrieval: RetrievalResult = {
  queryId: 'query-1', snapshotRevision: snapshot.revision,
  groups: { eligible: [], conditional: snapshot.nodes, conflicts: [], excludedIds: [] },
  paths: [{ seedId: 'node-1', relationIds: [], nodeIds: ['node-1'], reason: 'Pinned conditional retrieval hit.' }],
  answer: { text: 'Use the local copy if present.', citations: [] },
  missingConditions: ['A local copy exists'], warnings: [], coverage: 'current',
};
const input = { task, retrieval, nodeId: 'node-1', decision: 'adopt' as const, reason: 'I will check for the local copy.', recordId: 'record-1', recordedAt: task.updatedAt };

describe('L10 contract-only retrieval/use/revision flow (fixture, not cross-window integration)', () => {
  it('pins retrieved conditions and paths, and keeps same-session answers exposed', () => {
    const result = prepareRetrievedUse(input, snapshot, context);
    expect(result).toMatchObject({ ok: true, data: { exposure: 'seen', draft: { paths: retrieval.paths, snapshotRevision: 'fixture:r1' } } });
    expect(prepareRetrievedUse({ ...input, retrieval: { ...retrieval, answer: null } }, snapshot, context)).toMatchObject({ ok: true, data: { exposure: 'unknown' } });
  });
  it('retains the original version when failure leads to a manual revision link', () => {
    const prepared = prepareRetrievedUse(input, snapshot, context);
    if (!prepared.ok) throw new Error('invalid fixture');
    const outcome = previewOutcome({ useRecordId: 'record-1', status: 'failed', summary: 'No local copy.', failureReason: 'The prerequisite changed.' }, prepared.data.draft.record, context);
    if (!outcome.ok) throw new Error('invalid fixture');
    const links = revisionClues(outcome.data, context);
    expect(links).toMatchObject({ ok: true, data: [{ href: '#governance?nodeId=node-1&revision=fixture%3Ar1&useId=record-1&taskId=task-1', origin: 'user_report' }] });
    const current = { ...snapshot, revision: 'fixture:r2', nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'fixture:r2', conditions: [] })) };
    expect(prepareRetrievedUse(input, current, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(describeHistory(prepared.data.draft.record, current).record.nodeRefs[0]?.revision).toBe('fixture:r1');
    expect(prepared.data.draft.taskSnapshot.constraints[0]?.text).toBe('No network');
  });
  it('rejects fabricated paths, absent retrieval hits, conflict adoption and foreign workspaces', () => {
    expect(prepareRetrievedUse({ ...input, retrieval: { ...retrieval, paths: [{ seedId: 'node-1', relationIds: ['fake-edge'], nodeIds: ['node-1'], reason: 'fake' }] } }, snapshot, context).ok).toBe(false);
    expect(prepareRetrievedUse({ ...input, retrieval: { ...retrieval, coverage: 'unavailable', groups: { eligible: [], conditional: [], conflicts: [], excludedIds: [] }, paths: [] } }, snapshot, context).ok).toBe(false);
    expect(prepareRetrievedUse({ ...input, retrieval: { ...retrieval, groups: { ...retrieval.groups, conflicts: snapshot.nodes } } }, snapshot, context).ok).toBe(false);
    expect(prepareRetrievedUse(input, snapshot, { ...context, workspaceId: 'other' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('keeps return URLs identifier-only and never redirects to an arbitrary origin', () => {
    const href = taskHref('task?x=1&next=https://untrusted.example');
    expect(href).toMatch(/^#retrieval\?taskId=/); expect(href).not.toContain('&next=');
    expect(new URLSearchParams(href.split('?')[1]).get('taskId')).toBe('task?x=1&next=https://untrusted.example');
    expect(taskHref('')).toBe('#retrieval');
  });
  it('rejects missing scope, ambiguous groups and edited knowledge under an unchanged revision', () => {
    expect(prepareRetrievedUse(input, snapshot, { ...context, scopes: [] })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const ambiguous = { ...retrieval, groups: { ...retrieval.groups, eligible: snapshot.nodes } };
    expect(prepareRetrievedUse({ ...input, retrieval: ambiguous }, snapshot, context).ok).toBe(false);
    const edited = { ...retrieval, groups: { ...retrieval.groups, conditional: snapshot.nodes.map((node) => ({ ...node, conditions: [] })) } };
    expect(prepareRetrievedUse({ ...input, retrieval: edited }, snapshot, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it('requires acknowledgment of retrieval gaps even when the selected node itself is unconditional', () => {
    const clean = { ...snapshot, nodes: snapshot.nodes.map((node) => ({ ...node, conditions: [], boundaries: [], evidenceStatus: 'supported' as const })) };
    const gaps = { ...retrieval, groups: { ...retrieval.groups, conditional: clean.nodes }, missingConditions: ['External dependency is not checked'], warnings: ['Index filtering is incomplete'] };
    expect(prepareRetrievedUse({ ...input, retrieval: gaps, reason: '' }, clean, context).ok).toBe(false);
    expect(prepareRetrievedUse({ ...input, retrieval: gaps }, clean, context)).toMatchObject({ ok: true, data: {
      preview: { missingConditions: gaps.missingConditions, warnings: expect.arrayContaining(gaps.warnings) },
      handoffTrust: 'client_preview_only',
    } });
  });
  it('does not allow missing client paths to hide a confirmed prerequisite', () => {
    const related = structuredClone(snapshot);
    related.nodes.push({ ...structuredClone(snapshot.nodes[0]!), id: 'prerequisite', conditions: [{ id: 'extra', text: 'An additional prerequisite', status: 'unknown', evidenceIds: [] }] });
    related.relations.push({ id: 'edge-1', workspaceId: context.workspaceId,
      source: { workspaceId: context.workspaceId, objectId: 'node-1', revision: snapshot.revision },
      target: { workspaceId: context.workspaceId, objectId: 'prerequisite', revision: snapshot.revision },
      type: 'depends_on', state: 'confirmed', rationale: 'A required condition', evidenceIds: ['source-1'],
      proposedBy: context.actorId, confirmedBy: context.actorId, confirmedAt: task.updatedAt, updatedAt: task.updatedAt,
    });
    const result = prepareRetrievedUse(input, related, context);
    expect(result).toMatchObject({ ok: true, data: {
      preview: { relationRefs: ['edge-1'], missingConditions: expect.arrayContaining(['An additional prerequisite']) },
      draft: { paths: expect.arrayContaining([expect.objectContaining({ relationIds: ['edge-1'] })]) },
    } });
  });
});
