import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CnbClient, readServerConfig } from './client';
import { SessionRegistry } from '../identity';
import { createServices } from '../services';
import type { KnowledgeNode, Relation } from '../../contracts/domain';

const revision = 'a'.repeat(40);
function setup() {
  const sessions = new SessionRegistry();
  const workspace = { id: 'w1', slug: 'fixture/project', visibility: 'private' as const, mode: 'fixture' as const };
  const token = sessions.issue({ actorId: 'u1', workspace, scopes: ['knowledge:read'] });
  const context = sessions.context(new Request('http://localhost/', { headers: { Cookie: `zhangduo_session=${token}` } }));
  if (!context.ok) throw new Error('Invalid fixture context');
  const node: KnowledgeNode = { id: 'k1', workspaceId: 'w1', schemaVersion: 1, revision: '@snapshot', title: 'Known claim', question: 'When?', humanStatement: 'Only under this condition', authorship: 'human_written', candidateIds: [], conversationId: 'c1', kind: 'claim', conditions: [], boundaries: ['Not universal'], sources: [], confirmation: 'confirmed', evidenceStatus: 'unverified', lifecycle: 'active', confirmedBy: 'u1', confirmedAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };
  const manifest = { schemaVersion: 1, workspaceId: 'w1', nodes: [node, { ...node, id: 'k2' }], relations: [] as Relation[], excludedIds: [] as string[] };
  const transport = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/head')) return Response.json({ name: 'main', protected: true });
    if (url.pathname.includes('/commits/')) return Response.json({ sha: revision });
    const bytes = Buffer.from(JSON.stringify(manifest));
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return Response.json({ type: 'blob', path: 'knowledge/snapshot.json', encoding: 'base64', content: bytes.toString('base64'), sha });
  });
  const cnb = new CnbClient(() => readServerConfig({ CNB_REPO_SLUG: workspace.slug, CNB_TOKEN: 'fixture-token', CNB_TOKEN_SCOPES: 'repo-code:r', CNB_LIVE_READS_FOR: workspace.slug }), transport);
  return { services: createServices({ sessions, cnb }), ctx: context.data, node, manifest, transport, sessions, token };
}

describe('W06 immutable CNB Git snapshots', () => {
  it('pins every content read to the resolved commit and derives refs from that same commit', async () => {
    const s = setup();
    s.manifest.relations.push({ id: 'r1', workspaceId: 'w1', source: { workspaceId: 'w1', objectId: 'k1', revision: '@snapshot' }, target: { workspaceId: 'w1', objectId: 'k2', revision: '@snapshot' }, type: 'depends_on', rationale: 'Condition', evidenceIds: ['e1'], state: 'confirmed', proposedBy: 'u1', confirmedBy: 'u1', confirmedAt: s.node.updatedAt, updatedAt: s.node.updatedAt });
    const result = await s.services.snapshot(s.ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.revision).toBe(revision);
    expect(result.data.nodes.every((node) => node.revision === revision)).toBe(true);
    expect(result.data.relations[0]?.source.revision).toBe(revision);
    const urls = s.transport.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.filter((url) => url.pathname.includes('/contents/')).every((url) => url.searchParams.get('ref') === revision)).toBe(true);
  });
  it('supports immutable historical reads without resolving today\'s HEAD', async () => {
    const s = setup();
    expect((await s.services.snapshot(s.ctx, revision)).ok).toBe(true);
    expect(s.transport.mock.calls.some(([url]) => String(url).endsWith('/head'))).toBe(false);
    expect((await s.services.snapshot(s.ctx, 'main')).ok).toBe(false);
  });
  it('does not fill missing node data or accept cross-workspace/duplicate objects', async () => {
    for (const corrupt of ['missing', 'workspace', 'duplicate']) {
      const s = setup();
      if (corrupt === 'missing') delete (s.manifest.nodes[0] as Partial<KnowledgeNode>).humanStatement;
      if (corrupt === 'workspace') s.manifest.nodes[0]!.workspaceId = 'private-other';
      if (corrupt === 'duplicate') s.manifest.nodes[1]!.id = 'k1';
      expect(await s.services.snapshot(s.ctx)).toMatchObject({ ok: false, error: { code: 'UPSTREAM' } });
    }
  });
  it('rechecks permission before returning a snapshot after remote reads', async () => {
    const s = setup();
    const original = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (...args) => { const response = await original(...args); if (String(args[0]).includes('/contents/')) s.sessions.revoke(s.token); return response; });
    expect(await s.services.snapshot(s.ctx)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });
  it('checks blob integrity instead of trusting corrupt base64 content', async () => {
    const s = setup();
    s.transport.mockResolvedValue(Response.json({ type: 'blob', path: 'knowledge/snapshot.json', encoding: 'base64', content: 'e30=', sha: revision }));
    expect((await s.services.snapshot(s.ctx, revision)).ok).toBe(false);
  });
});
