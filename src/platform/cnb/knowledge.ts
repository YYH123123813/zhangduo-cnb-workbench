import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { unavailable } from '../../contracts/api';
import type { SemanticQueryResult } from '../../contracts/retrieval';
import type { Services } from '../../contracts/ports';
import type { SessionRegistry } from '../identity';
import type { CnbClient } from './client';
import { failure } from '../result';
import { indexPath } from './knowledge-document';
export { indexPath, indexFiles } from './knowledge-document';

export class KnowledgeQuery {
  constructor(private readonly sessions: SessionRegistry, private readonly client: CnbClient, private readonly snapshot: Services['snapshot']) {}
  async query(ctx: RequestContext, input: string): Promise<Result<SemanticQueryResult>> {
    const access = this.sessions.authorize(ctx, 'knowledge:read');
    if (!access.ok) return access;
    const parsed = z.string().trim().min(1).max(4000).safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Query must contain 1 to 4000 characters', 'shorten_query');
    const config = this.client.config();
    if (!config.ok) return config;
    if (ctx.mode !== this.client.mode || config.data.repository !== access.data.slug || access.data.visibility !== 'private') return failure('FORBIDDEN', 'Semantic connection does not match the private workspace', 'select_authorized_workspace');
    if (!config.data.queriesAuthorized) return unavailable('Semantic query transmission has not been authorized; Git text remains available');
    const before = await this.snapshot(ctx);
    if (!before.ok) return before;
    const response = await this.client.read('repo-code:r', `/-/knowledge/base/query?query=${encodeURIComponent(parsed.data)}&top_k=20&score_threshold=0`);
    if (!response.ok) return response;
    const hits = z.array(z.object({ score: z.number().min(0).max(1), chunk: z.string().max(100_000), metadata: z.object({ path: z.string().max(512) }) })).max(100).safeParse(response.data);
    if (!hits.success) return failure('UPSTREAM', 'Knowledge index response could not be verified', 'retry_query');
    const current = await this.snapshot(ctx);
    if (!current.ok) return current;
    if (current.data.revision !== before.data.revision) return failure('CONFLICT', 'Git knowledge changed during semantic retrieval', 'rerun_query');
    const allowed = new Map(current.data.nodes.filter((node) => node.confirmation === 'confirmed' && node.lifecycle === 'active' && !current.data.excludedIds.includes(node.id)).map((node) => [indexPath(node.id), node]));
    const results = new Map<string, SemanticQueryResult['hits'][number]>();
    for (const hit of hits.data) {
      const node = allowed.get(hit.metadata.path);
      if (!node) continue;
      const previous = results.get(node.id);
      if (!previous || previous.score < hit.score) results.set(node.id, { objectId: node.id, score: hit.score, text: node.humanStatement });
    }
    const stillAuthorized = this.sessions.authorize(ctx, 'knowledge:read');
    if (!stillAuthorized.ok) return stillAuthorized;
    return { ok: true, data: { hits: [...results.values()], snapshotRevision: current.data.revision, indexRevision: null, coverage: 'partial' } };
  }
}
