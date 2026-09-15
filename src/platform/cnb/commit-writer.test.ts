import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationJournal } from '../journal';
import { SessionRegistry } from '../identity';
import { ApprovalAuthority } from '../approvals';
import { CnbClient, readServerConfig } from './client';
import { createServices } from '../services';
import { hashChangeSet } from '../../contracts/hash';
import type { ChangeSet, KnowledgeNode } from '../../contracts/domain';
import type { GitPublisher } from './git-publisher';

const base = 'a'.repeat(40), next = 'b'.repeat(40), later = 'c'.repeat(40);
const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));

async function setup() {
  const journal = new OperationJournal(':memory:', { fixture: true }); journals.push(journal);
  const sessions = new SessionRegistry();
  const workspace = { id: 'w1', slug: 'fixture/project', visibility: 'private' as const, mode: 'fixture' as const };
  const token = sessions.issue({ actorId: 'u1', workspace, scopes: ['knowledge:read', 'knowledge:write'] });
  const context = sessions.context(new Request('http://localhost/', { headers: { Authorization: `Bearer ${token}` } }));
  if (!context.ok) throw new Error('Expected trusted fixture');
  const ctx = context.data;
  const authority = new ApprovalAuthority(sessions, journal);
  const node: KnowledgeNode = { id: 'k1', workspaceId: 'w1', schemaVersion: 1, revision: base, title: 'Scoped claim', question: 'When?', humanStatement: 'Under known conditions', authorship: 'human_written', candidateIds: [], conversationId: 'c1', kind: 'claim', conditions: [], boundaries: [], sources: [], confirmation: 'confirmed', evidenceStatus: 'unverified', lifecycle: 'active', confirmedBy: 'u1', confirmedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
  const initial = { schemaVersion: 1, workspaceId: 'w1', nodes: [{ ...node, id: 'old', revision: '@snapshot' }], relations: [], excludedIds: [] };
  const documents = new Map<string, unknown>([[base, initial]]);
  let head = base, message = '', lost = false;
  const transport = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/head')) return Response.json({ name: 'main' });
    if (url.pathname.endsWith('/commits/main')) return Response.json({ sha: head });
    if (url.pathname.endsWith('/commits')) return Response.json(head === next ? [{ sha: next, parents: [{ sha: base }], commit: { message } }] : []);
    const bytes = Buffer.from(JSON.stringify(documents.get(url.searchParams.get('ref')!) ?? {}));
    return Response.json({ type: 'blob', path: 'knowledge/snapshot.json', encoding: 'base64', content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
  });
  const cnb = new CnbClient(() => readServerConfig({ CNB_REPO_SLUG: workspace.slug, CNB_TOKEN: 'fixture-secret', CNB_TOKEN_SCOPES: 'repo-code:rw', CNB_LIVE_READS_FOR: workspace.slug, CNB_LIVE_WRITES_FOR: workspace.slug }), transport);
  const prepare = vi.fn<GitPublisher['prepare']>(async (input) => { documents.set(next, JSON.parse(input.files['knowledge/snapshot.json']!)); message = input.message; return { ok: true, data: { revision: next, stagingKey: 'd'.repeat(64) } }; });
  const publish = vi.fn<GitPublisher['publish']>(async (input) => {
    if (head !== input.baseRevision) return { ok: false, error: { code: 'CONFLICT', message: 'CAS mismatch', dataState: 'not_written', retryable: false, nextAction: 'preview_again' } };
    head = next;
    return lost ? { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Lost reply', dataState: 'unknown', retryable: false, nextAction: 'read_commit' } } : { ok: true, data: null };
  });
  const git: GitPublisher = { mode: 'fixture', prepare, publish };
  const options = { sessions, cnb, journal, approvalAuthority: authority, git };
  const services = createServices(options);
  const changes: ChangeSet = { id: 'op1', workspaceId: 'w1', baseRevision: base, nodes: [node], relations: [], withdrawnIds: [], reason: 'Human review', contentHash: 'pending' };
  changes.contentHash = await hashChangeSet(changes);
  const approve = async (value = changes) => { const result = await services.approveKnowledge!(ctx, { changes: value, confirmed: true }); if (!result.ok) throw new Error(JSON.stringify(result)); return result.data; };
  return { services, options, ctx, changes, approve, prepare, publish, documents, authority, token, sessions, lost: () => { lost = true; }, advance: () => { head = later; } };
}

describe('W07 atomic knowledge commit', () => {
  it('publishes JSON and readable Markdown together, then verifies a fixed commit', async () => {
    const s = await setup();
    const result = await s.services.commit(s.ctx, s.changes, await s.approve());
    expect(result).toMatchObject({ ok: true, data: { changeSetId: 'op1', revision: next, indexing: 'pending' } });
    expect(s.publish).toHaveBeenCalledTimes(1);
    expect(Object.keys(s.prepare.mock.calls[0]![0].files)).toContain('knowledge/snapshot.json');
    expect(Object.keys(s.prepare.mock.calls[0]![0].files).some((file) => file.endsWith('.md'))).toBe(true);
    const snapshot = await s.services.snapshot(s.ctx);
    expect(snapshot).toMatchObject({ ok: true, data: { nodes: [expect.objectContaining({ id: 'old', revision: base }), expect.objectContaining({ id: 'k1', revision: next })] } });
  });
  it('keeps an operation idempotent across service reconstruction and lost push replies', async () => {
    const s = await setup(); s.lost();
    const approval = await s.approve();
    expect(await s.services.commit(s.ctx, s.changes, approval)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    const recovered = await createServices(s.options).readCommit!(s.ctx, 'op1');
    expect(recovered).toMatchObject({ ok: true, data: { revision: next } });
    expect((await s.services.commit(s.ctx, s.changes, approval)).ok).toBe(true);
    expect(s.publish).toHaveBeenCalledTimes(1);
  });
  it('returns conflict on a concurrent branch move and does not overwrite it', async () => {
    const s = await setup(); const approval = await s.approve();
    const original = s.prepare.getMockImplementation()!;
    s.prepare.mockImplementation(async (input) => { const result = await original(input); s.advance(); return result; });
    expect(await s.services.commit(s.ctx, s.changes, approval)).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    expect((await s.services.readCommit!(s.ctx, 'op1')).ok).toBe(false);
  });
  it('rejects changed content, duplicate IDs, unconfirmed nodes and revoked approvals before publishing', async () => {
    for (const scenario of ['changed', 'duplicate', 'unconfirmed', 'revoked']) {
      const s = await setup(); const approval = await s.approve();
      if (scenario === 'changed') s.changes.reason = 'Changed';
      if (scenario === 'duplicate') s.changes.nodes.push(s.changes.nodes[0]!);
      if (scenario === 'unconfirmed') s.changes.nodes[0]!.confirmation = 'draft';
      if (scenario === 'revoked') s.authority.revoke(s.ctx, approval.id);
      expect((await s.services.commit(s.ctx, s.changes, approval)).ok).toBe(false);
      expect(s.publish).not.toHaveBeenCalled();
    }
  });
  it('preserves the first payload when an operation ID is reused for a different approved change', async () => {
    const s = await setup(); await s.services.commit(s.ctx, s.changes, await s.approve());
    s.changes.reason = 'Different content'; s.changes.contentHash = await hashChangeSet(s.changes);
    expect(await s.services.approveKnowledge!(s.ctx, { changes: s.changes, confirmed: true })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const legacy = s.authority.register(s.ctx, 'knowledge:write', { purpose: 'commit_knowledge', objectIds: ['k1'], contentHash: s.changes.contentHash, baseRevision: s.changes.baseRevision });
    if (!legacy.ok) throw new Error('Expected explicit legacy fixture approval');
    expect(await s.services.commit(s.ctx, s.changes, legacy.data)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.publish).toHaveBeenCalledTimes(1);
  });
  it('never treats an absent operation or an empty commit search as proof of no write', async () => {
    const s = await setup();
    expect(await s.services.readCommit!(s.ctx, 'absent')).toEqual({ ok: true, data: null });
    s.lost(); await s.services.commit(s.ctx, s.changes, await s.approve()); s.advance();
    expect(await s.services.readCommit!(s.ctx, 'op1')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(s.publish).toHaveBeenCalledTimes(1);
  });
  it('rechecks revocation after preparation with zero remote publications', async () => {
    const s = await setup(); const approval = await s.approve();
    const original = s.prepare.getMockImplementation()!;
    s.prepare.mockImplementation(async (input) => { const result = await original(input); s.authority.revoke(s.ctx, approval.id); return result; });
    expect(await s.services.commit(s.ctx, s.changes, approval)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(s.publish).not.toHaveBeenCalled();
  });
  it('rebinds new relation endpoints while preserving an existing target version', async () => {
    const s = await setup();
    s.changes.relations.push({ id: 'r1', workspaceId: 'w1', source: { workspaceId: 'w1', objectId: 'k1', revision: base }, target: { workspaceId: 'w1', objectId: 'old', revision: base }, type: 'depends_on', rationale: 'Reviewed condition', evidenceIds: ['source1'], state: 'confirmed', proposedBy: 'u1', confirmedBy: 'u1', confirmedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' });
    s.changes.contentHash = await hashChangeSet(s.changes);
    expect((await s.services.commit(s.ctx, s.changes, await s.approve())).ok).toBe(true);
    expect(await s.services.snapshot(s.ctx)).toMatchObject({ ok: true, data: { relations: [expect.objectContaining({ source: { workspaceId: 'w1', objectId: 'k1', revision: next }, target: { workspaceId: 'w1', objectId: 'old', revision: base } })] } });
  });
});
