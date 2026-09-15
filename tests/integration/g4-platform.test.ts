import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { platformFixture } from './platform-fixture';
import type { OperationJournal } from '../../src/platform/journal';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
describe('G4 governance and retrieval using the shared platform implementation', () => {
  it('revises via governance HTTP, reads a real platform receipt and changes the same retrieval query', async () => {
    const s = await platformFixture(); journals.push(s.journal); const app = createApp(s.services);
    const send = async (path: string, body: unknown, method = 'POST') => {
      const response = await app.request(path, { method, headers: s.headers, body: JSON.stringify(body) });
      const result = await response.json(); expect(result.ok, `${path}: ${JSON.stringify(result)}`).toBe(true); return result.data;
    };
    const query = { task: { id: 'task1', workspaceId: s.ctx.workspaceId, question: 'fixture', constraints: [], mode: 'assisted', updatedAt: '2026-09-05T00:00:00Z' }, query: 'fixture', confirmedOnly: true };
    const before = await send('/api/retrieval/query', query);
    expect(before.groups.conditional[0].humanStatement).toBe('Original fixture conclusion');
    const preview = await send('/api/governance/nodes/k1', { action: 'preview', operationId: 'gov-revision-1', baseRevision: before.snapshotRevision, nodeRevision: s.base, reason: 'Correct a premise', patch: { humanStatement: 'Revised fixture conclusion' } }, 'PATCH');
    const prepared = await send('/api/governance/changes/prepare', { action: 'prepare', changes: preview.changes });
    const approval = await send('/api/workspace/approvals/knowledge', { changes: prepared.changes, confirmed: true });
    const committed = await send('/api/governance/changes/commit', { action: 'commit', changes: prepared.changes, approval });
    expect(committed.snapshotVerified).toBe(false); expect(committed.receipt.indexing).toBe('pending');
    const verified = await send('/api/governance/changes/verify', { action: 'verify', changes: prepared.changes });
    expect(verified.snapshotVerified).toBe(true); expect(verified.receipt).toEqual(committed.receipt);
    const after = await send('/api/retrieval/query', query);
    expect(after.snapshotRevision).not.toBe(before.snapshotRevision);
    expect(after.groups.conditional[0].humanStatement).toBe('Revised fixture conclusion');
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { nodes: [expect.objectContaining({ humanStatement: 'Original fixture conclusion' })] } });
    const plan = await s.services.previewDelete(s.ctx, ['k1']); if (!plan.ok) throw new Error('Expected plan');
    const deletion = await s.services.approveGovernance!(s.ctx, { purpose: 'delete', planId: plan.data.id, confirmed: true }); if (!deletion.ok) throw new Error('Expected approval');
    expect((await s.services.executeDelete(s.ctx, plan.data, deletion.data)).ok).toBe(true);
    const blocked = await send('/api/retrieval/query', query);
    expect([...blocked.groups.eligible, ...blocked.groups.conditional, ...blocked.groups.conflicts]).toEqual([]);
    expect(blocked.groups.excludedIds).toContain('k1');
  });
});
