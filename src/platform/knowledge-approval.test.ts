import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createApp } from '../server/app';
import { hashChangeSet } from '../contracts/hash';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import { createServices } from './services';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup(file = ':memory:') {
  const s = await platformFixture(file); if (file === ':memory:') journals.push(s.journal);
  const changes = { id: 'knowledge-operation', workspaceId: s.ctx.workspaceId, baseRevision: s.base, nodes: [{ ...s.node, revision: s.base }], relations: [], withdrawnIds: [], reason: 'Synthetic reviewed change', contentHash: '' };
  changes.contentHash = await hashChangeSet(changes);
  return { ...s, changes, input: { changes, confirmed: true as const } };
}

describe('W07 knowledge approval registration recovery', () => {
  it('atomically registers exactly one approval for concurrent identical changeSet requests', async () => {
    const s = await setup();
    const results = await Promise.all([s.services.approveKnowledge!(s.ctx, s.input), s.services.approveKnowledge!(s.ctx, s.input)]);
    expect(results[0]).toEqual(results[1]); expect(results[0]!.ok).toBe(true);
    expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('recovers the original approval from HTTP after a lost registration response and revokes it without re-registering', async () => {
    const s = await setup(), app = createApp(s.services);
    expect(await s.services.readKnowledgeApproval!(s.ctx, s.changes.id)).toMatchObject({ ok: true, data: { status: 'not_registered', approval: null, absenceIsFinal: false } });
    await app.request('/api/workspace/approvals/knowledge', { method: 'POST', headers: s.headers, body: JSON.stringify(s.input) });
    const response = await app.request(`/api/workspace/approvals/knowledge/${s.changes.id}`, { headers: s.headers });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const state = await response.json();
    expect(state).toMatchObject({ ok: true, data: { status: 'registered', approval: { contentHash: s.changes.contentHash, baseRevision: s.base, purpose: 'commit_knowledge' } } });
    expect(JSON.stringify(state)).not.toContain(s.changes.reason);
    await s.services.revokeApproval!(s.ctx, state.data.approval.id);
    expect(await s.services.readKnowledgeApproval!(s.ctx, s.changes.id)).toMatchObject({ ok: true, data: { status: 'revoked' } });
    expect((await s.services.approveKnowledge!(s.ctx, s.input)).ok).toBe(false);
  });
  it('never reuses an operation ID for a different payload, actor or untrusted context', async () => {
    const s = await setup(); await s.services.approveKnowledge!(s.ctx, s.input);
    const changes = { ...s.changes, reason: 'Changed approved content' }; changes.contentHash = await hashChangeSet(changes);
    expect(await s.services.approveKnowledge!(s.ctx, { changes, confirmed: true })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await s.services.readKnowledgeApproval!({ ...s.ctx }, s.changes.id)).ok).toBe(false);
    const workspace = await s.services.workspace(s.ctx); if (!workspace.ok) throw new Error('Expected workspace');
    const token = s.sessions.issue({ actorId: 'other', workspace: workspace.data, scopes: [...s.ctx.scopes] });
    const ctx = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
    if (!ctx.ok) throw new Error('Expected other session');
    expect((await s.services.readKnowledgeApproval!(ctx.data, s.changes.id)).ok).toBe(false);
    expect((await s.services.approveKnowledge!(ctx.data, s.input)).ok).toBe(false);
  });
  it('persists the mapping on restart and reports expiry without replacing the original approval', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/approval-fixture-')); const file = join(directory, 'state.sqlite');
    const s = await setup(file);
    try {
      const approval = await s.services.approveKnowledge!(s.ctx, s.input); if (!approval.ok) throw new Error('Expected approval');
      s.journal.close();
      const journal = new OperationJournal(file, { fixture: true });
      try {
        const authority = new ApprovalAuthority(s.sessions, journal, () => Date.parse(approval.data.expiresAt) + 1);
        const services = createServices({ ...s.options, journal, approvalAuthority: authority });
        expect(await services.readKnowledgeApproval!(s.ctx, s.changes.id)).toMatchObject({ ok: true, data: { status: 'expired', approval: approval.data } });
        expect((await services.approveKnowledge!(s.ctx, s.input)).ok).toBe(false);
      } finally { journal.close(); }
    } finally { try { s.journal.close(); } catch { /* Original connection already closed. */ } rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not interpret a damaged mapping or failed transaction as a definitive absence', async () => {
    const s = await setup();
    vi.spyOn(s.journal, 'putRecord').mockImplementationOnce(() => { throw new Error('Fixture write failure'); });
    expect((await s.services.approveKnowledge!(s.ctx, s.input)).ok).toBe(false);
    s.journal.putRecord(s.ctx.workspaceId, '@workspace', 'knowledge_approval', s.changes.id, { damaged: true }, null);
    expect(await s.services.readKnowledgeApproval!(s.ctx, s.changes.id)).toMatchObject({ ok: true, data: { status: 'unknown', approval: null, absenceIsFinal: false } });
  });
});
