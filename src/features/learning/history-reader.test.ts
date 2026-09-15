import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeSnapshot } from '../../contracts/domain';
import { failure, success } from './errors';
import { buildUseDraft } from './history';
import { readHistoricalKnowledge } from './history-reader';
import { buildUseEvidence } from './application-record';
import { context, fixtureServices, snapshot, task, useInput } from './testing/fixtures';

const originalRevision = 'a'.repeat(40);
const currentRevision = 'b'.repeat(40);
const original: KnowledgeSnapshot = {
  ...structuredClone(snapshot), revision: originalRevision,
  nodes: snapshot.nodes.map((node) => ({ ...structuredClone(node), revision: originalRevision })),
};
const current: KnowledgeSnapshot = {
  ...structuredClone(original), revision: currentRevision,
  nodes: original.nodes.map((node) => ({ ...node, revision: currentRevision, conditions: [] })),
};
const preview = buildUseDraft({ ...useInput, snapshotRevision: originalRevision,
  nodeRefs: [{ ...useInput.nodeRefs[0], revision: originalRevision }],
}, original, 'record-1', task.updatedAt);
if (!preview.ok) throw new Error('Invalid history fixture');
const record = preview.data.record;
function servicesForHistory() {
  return fixtureServices({
    listEvidence: vi.fn(async () => success([structuredClone(record)])),
    snapshot: vi.fn(async (_ctx, revision) => success(structuredClone(revision ? original : current))),
  });
}

describe('L02 historical knowledge through shared snapshot port', () => {
  it('uses the shared exact record reader and retains recorded context for structured evidence', async () => {
    if (!preview.ok) throw new Error('Invalid fixture');
    const saved = buildUseEvidence(preview.data, original); if (!saved.ok) throw new Error(saved.error.message);
    const services = servicesForHistory(); services.readEvidence = vi.fn(async () => success(saved.data));
    expect(await readHistoricalKnowledge(services, context, record.id, 'node-1')).toMatchObject({ ok: true, data: { contextState: 'recorded' } });
    expect(services.listEvidence).not.toHaveBeenCalled(); expect(services.readEvidence).toHaveBeenCalledTimes(2);
  });
  it('does not disclose old knowledge after the evidence itself becomes unreadable during the historical read', async () => {
    const services = servicesForHistory(); let reads = 0;
    services.readEvidence = vi.fn(async () => success(++reads === 1 ? record : null));
    const result = await readHistoricalKnowledge(services, context, record.id, 'node-1');
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(original.nodes[0]!.humanStatement);
  });
  it('accepts the 64-character immutable Git revisions supported by the shared snapshot port', async () => {
    const revision = 'c'.repeat(64);
    const historical = { ...original, revision, nodes: original.nodes.map((node) => ({ ...node, revision })) };
    const services = servicesForHistory();
    services.listEvidence = vi.fn(async () => success([{ ...record, nodeRefs: record.nodeRefs.map((ref) => ({ ...ref, revision })) }]));
    services.snapshot = vi.fn(async (_ctx, requested) => success(requested ? historical : current));
    expect(await readHistoricalKnowledge(services, context, record.id, 'node-1'))
      .toMatchObject({ ok: true, data: { snapshotRevision: revision, nodeRef: { revision } } });
    expect(services.snapshot).toHaveBeenNthCalledWith(2, context, revision);
  });
  it('reads the record-pinned commit and never fabricates the original task or saved conditions', async () => {
    const services = servicesForHistory();
    const result = await readHistoricalKnowledge(services, context, 'record-1', 'node-1');
    expect(result).toMatchObject({ ok: true, data: {
      recordId: 'record-1', nodeRef: record.nodeRefs[0], snapshotRevision: originalRevision,
      provenance: 'historical_knowledge', contextState: 'not_recorded', currentState: 'changed',
      knowledge: { conditions: original.nodes[0]!.conditions },
    } });
    if (!result.ok) return;
    expect(result.data).not.toHaveProperty('taskSnapshot');
    expect(result.data).not.toHaveProperty('paths');
    expect(services.snapshot).toHaveBeenNthCalledWith(2, context, originalRevision);
    expect(services.appendEvidence).not.toHaveBeenCalled();
    expect(services.complete).not.toHaveBeenCalled();
    expect(services.semanticQuery).not.toHaveBeenCalled();
  });

  it.each(['knowledge:read', 'evidence:read'])('denies missing %s before reading private records', async (scope) => {
    const services = servicesForHistory();
    expect(await readHistoricalKnowledge(services, { ...context, scopes: context.scopes.filter((value) => value !== scope) }, 'record-1', 'node-1'))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(services.listEvidence).not.toHaveBeenCalled();
    expect(services.snapshot).not.toHaveBeenCalled();
  });

  it('rejects unknown, duplicate and foreign records without reading knowledge', async () => {
    for (const records of [[], [record, record], [{ ...record, workspaceId: 'other' }]]) {
      const services = servicesForHistory();
      services.listEvidence = vi.fn(async () => success(records));
      expect((await readHistoricalKnowledge(services, context, record.id, 'node-1')).ok).toBe(false);
      expect(services.snapshot).not.toHaveBeenCalled();
    }
  });

  it('does not read an arbitrary node or mutable/legacy revision in place of the evidence reference', async () => {
    const services = servicesForHistory();
    expect((await readHistoricalKnowledge(services, context, record.id, 'unrelated-node')).ok).toBe(false);
    services.listEvidence = vi.fn(async () => success([{ ...record, nodeRefs: useInput.nodeRefs }]));
    expect(await readHistoricalKnowledge(services, context, record.id, 'node-1'))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(services.snapshot).not.toHaveBeenCalled();
  });

  it('rejects a snapshot adapter that ignores the pinned revision', async () => {
    const services = servicesForHistory();
    services.snapshot = vi.fn(async () => success(current));
    expect(await readHistoricalKnowledge(services, context, record.id, 'node-1'))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it.each(['excluded', 'missing', 'foreign'] as const)('does not expose a currently %s object through history', async (state) => {
    const services = servicesForHistory();
    services.snapshot = vi.fn(async (_ctx, revision) => success(revision ? original : {
      ...current, workspaceId: state === 'foreign' ? 'other' : current.workspaceId,
      excludedIds: state === 'excluded' ? ['node-1'] : [], nodes: state === 'missing' ? [] : current.nodes,
    }));
    expect((await readHistoricalKnowledge(services, context, record.id, 'node-1')).ok).toBe(false);
    expect(services.snapshot).toHaveBeenCalledTimes(1);
  });

  it('rechecks current exclusions after the historical read', async () => {
    const services = servicesForHistory();
    let currentReads = 0;
    services.snapshot = vi.fn(async (_ctx, revision) => {
      if (revision) return success(original);
      currentReads += 1;
      return success({ ...current, excludedIds: currentReads > 1 ? ['node-1'] : [] });
    });
    expect(await readHistoricalKnowledge(services, context, record.id, 'node-1'))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(currentReads).toBe(2);
  });

  it('retains old knowledge for withdrawn nodes without treating it as currently applicable', async () => {
    const services = servicesForHistory();
    services.snapshot = vi.fn(async (_ctx, revision) => success(revision ? original : {
      ...current, nodes: current.nodes.map((node) => ({ ...node, lifecycle: 'withdrawn' as const })),
    }));
    expect(await readHistoricalKnowledge(services, context, record.id, 'node-1'))
      .toMatchObject({ ok: true, data: { currentState: 'withdrawn', applicability: 'not_assessed' } });
  });

  it('keeps an unavailable historical port visible instead of falling back to current content', async () => {
    const services = servicesForHistory();
    services.snapshot = vi.fn(async (_ctx, revision) => revision ? failure('NOT_CONFIGURED', 'History is not connected.') : success(current));
    expect(await readHistoricalKnowledge(services, context, record.id, 'node-1'))
      .toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });
});
