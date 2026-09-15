import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { OperationJournal } from '../../src/platform/journal';
import { SessionRegistry } from '../../src/platform/identity';
import { ApprovalAuthority } from '../../src/platform/approvals';
import { CnbClient, readServerConfig } from '../../src/platform/cnb/client';
import { createServices } from '../../src/platform/services';
import type { GitPublisher } from '../../src/platform/cnb/git-publisher';
import type { KnowledgeNode } from '../../src/contracts/domain';
import { SCOPES } from '../../src/contracts/scopes';

export async function platformFixture(file = ':memory:') {
  const journal = new OperationJournal(file, { fixture: true });
  const sessions = new SessionRegistry();
  const workspace = { id: 'fixture-workspace', slug: 'fixture/platform', visibility: 'private' as const, mode: 'fixture' as const };
  const token = sessions.issue({ actorId: 'fixture-actor', workspace, scopes: Object.values(SCOPES) });
  const headers = { Authorization: `Bearer ${token}`, Origin: 'http://localhost', 'Content-Type': 'application/json' };
  const context = sessions.context(new Request('http://localhost', { headers }));
  if (!context.ok) throw new Error('Expected fixture session');
  const authority = new ApprovalAuthority(sessions, journal);
  const base = 'a'.repeat(40);
  const node: KnowledgeNode = { id: 'k1', workspaceId: workspace.id, schemaVersion: 1, revision: '@snapshot', title: 'Fixture claim', question: 'Which premise?', humanStatement: 'Original fixture conclusion', authorship: 'human_written', candidateIds: [], conversationId: 'c1', kind: 'claim', conditions: [], boundaries: [], sources: [], confirmation: 'confirmed', evidenceStatus: 'unverified', lifecycle: 'active', confirmedBy: 'fixture-actor', confirmedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
  const initial = { schemaVersion: 1 as const, workspaceId: workspace.id, nodes: [node], relations: [], excludedIds: [] };
  const documents = new Map<string, unknown>([[base, initial]]);
  const commits: { sha: string; parents: { sha: string }[]; commit: { message: string } }[] = [];
  let head = base;
  const transport = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/head')) return Response.json({ name: 'main' });
    if (url.pathname.endsWith('/commits/main')) return Response.json({ sha: head });
    if (url.pathname.endsWith('/commits')) return Response.json(commits);
    if (url.pathname.endsWith('/knowledge/base/query')) return Response.json([]);
    const bytes = Buffer.from(JSON.stringify(documents.get(url.searchParams.get('ref')!) ?? {}));
    return Response.json({ type: 'blob', path: 'knowledge/snapshot.json', encoding: 'base64', content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
  });
  const cnb = new CnbClient(() => readServerConfig({ CNB_REPO_SLUG: workspace.slug, CNB_TOKEN: 'fixture-secret', CNB_TOKEN_SCOPES: 'repo-code:rw,repo-issue:rw', CNB_LIVE_READS_FOR: workspace.slug, CNB_LIVE_WRITES_FOR: workspace.slug, CNB_LIVE_QUERIES_FOR: workspace.slug }), transport);
  const staged = new Map<string, { base: string; message: string }>();
  const git: GitPublisher = { mode: 'fixture', prepare: vi.fn<GitPublisher['prepare']>(async (input) => {
    const revision = createHash('sha1').update(JSON.stringify(input)).digest('hex');
    documents.set(revision, JSON.parse(input.files['knowledge/snapshot.json']!)); staged.set(revision, { base: input.baseRevision, message: input.message });
    return { ok: true, data: { revision, stagingKey: 'd'.repeat(64) } };
  }), publish: vi.fn<GitPublisher['publish']>(async (input) => {
    if (head !== input.baseRevision) return { ok: false, error: { code: 'CONFLICT', message: 'Fixture CAS rejected', retryable: false, dataState: 'not_written', nextAction: 'preview_again' } };
    head = input.revision;
    commits.unshift({ sha: head, parents: [{ sha: input.baseRevision }], commit: { message: staged.get(head)!.message } });
    return { ok: true, data: null };
  }) };
  const options = { sessions, cnb, journal, approvalAuthority: authority, git };
  return { services: createServices(options), options, journal, sessions, authority, ctx: context.data, headers, token, node, documents, initial, base, git, transport };
}
