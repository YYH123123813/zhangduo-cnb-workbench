import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { Id, KnowledgeNodeSchema, RelationSchema, type KnowledgeSnapshot } from '../../contracts/domain';
import type { SessionRegistry } from '../identity';
import { failure } from '../result';
import type { CnbClient } from './client';

export const GitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const GitBranch = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).refine((name) => !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//'));
export const GitKnowledgeDocumentSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: Id, nodes: z.array(KnowledgeNodeSchema).max(10_000),
  relations: z.array(RelationSchema).max(30_000), excludedIds: z.array(Id).max(40_000),
}).strict();
const ContentSchema = z.object({ type: z.literal('blob'), path: z.literal('knowledge/snapshot.json'), encoding: z.literal('base64'), content: z.string(), sha: GitSha });
const invalid = (): Result<KnowledgeSnapshot> => failure('UPSTREAM', 'Git knowledge snapshot could not be verified', 'check_versioned_knowledge_format');

export class SnapshotReader {
  constructor(private readonly sessions: SessionRegistry, private readonly client: CnbClient) {}

  async read(ctx: RequestContext, requestedRevision?: string): Promise<Result<KnowledgeSnapshot>> {
    const access = this.sessions.authorize(ctx, 'knowledge:read');
    if (!access.ok) return access;
    if (ctx.mode !== this.client.mode) return failure('FORBIDDEN', 'Session and CNB transport modes do not match', 'configure_matching_transport');
    const configuration = this.client.config();
    if (!configuration.ok) return configuration;
    if (configuration.data.repository !== access.data.slug) return failure('FORBIDDEN', 'CNB connection belongs to another workspace', 'select_authorized_workspace');
    if (requestedRevision !== undefined && !GitSha.safeParse(requestedRevision).success) return failure('VALIDATION', 'Historical snapshots require a complete Git commit hash', 'select_immutable_revision');
    let revision = requestedRevision;
    if (!revision) {
      const head = await this.client.read('repo-code:r', '/-/git/head');
      if (!head.ok) return head;
      const branch = z.object({ name: GitBranch }).safeParse(head.data);
      if (!branch.success) return invalid();
      const commit = await this.client.read('repo-code:r', `/-/git/commits/${encodeURIComponent(branch.data.name)}`);
      if (!commit.ok) return commit;
      const parsedCommit = z.object({ sha: GitSha }).safeParse(commit.data);
      if (!parsedCommit.success) return invalid();
      revision = parsedCommit.data.sha;
    }
    const response = await this.client.read('repo-code:r', `/-/git/contents/knowledge/snapshot.json?ref=${revision}`);
    if (!response.ok) return response;
    const content = ContentSchema.safeParse(response.data);
    if (!content.success) return invalid();
    const base64 = content.data.content.replace(/\r?\n/g, '');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || bytes.length > 1_000_000) return invalid();
    const blobHash = createHash(content.data.sha.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blobHash !== content.data.sha) return invalid();
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { return invalid(); }
    const document = GitKnowledgeDocumentSchema.safeParse(raw);
    if (!document.success || document.data.workspaceId !== ctx.workspaceId) return invalid();
    const { nodes, relations, excludedIds } = document.data;
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (nodeIds.size !== nodes.length || new Set([...nodeIds, ...relations.map((relation) => relation.id)]).size !== nodes.length + relations.length || new Set(excludedIds).size !== excludedIds.length) return invalid();
    const storedRevision = (value: string) => value === '@snapshot' || GitSha.safeParse(value).success;
    if (nodes.some((node) => node.workspaceId !== ctx.workspaceId || !storedRevision(node.revision))) return invalid();
    if (relations.some((relation) => relation.workspaceId !== ctx.workspaceId || !nodeIds.has(relation.source.objectId) || !nodeIds.has(relation.target.objectId) || !storedRevision(relation.source.revision) || !storedRevision(relation.target.revision))) return invalid();
    const stillAuthorized = this.sessions.authorize(ctx, 'knowledge:read');
    if (!stillAuthorized.ok) return stillAuthorized;
    const stillConfigured = this.client.config();
    if (!stillConfigured.ok) return stillConfigured;
    if (stillConfigured.data.repository !== access.data.slug) return failure('FORBIDDEN', 'Workspace configuration changed during the read', 'select_authorized_workspace');
    return { ok: true, data: { workspaceId: ctx.workspaceId, revision,
      nodes: nodes.map((node) => ({ ...node, revision: node.revision === '@snapshot' ? revision : node.revision })),
      relations: relations.map((relation) => ({ ...relation, source: { ...relation.source, revision: relation.source.revision === '@snapshot' ? revision : relation.source.revision }, target: { ...relation.target, revision: relation.target.revision === '@snapshot' ? revision : relation.target.revision } })),
      excludedIds, generatedAt: new Date().toISOString() } };
  }
}
