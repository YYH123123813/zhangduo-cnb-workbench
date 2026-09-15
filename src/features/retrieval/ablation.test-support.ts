import type { KnowledgeSnapshot, RetrievalRequest, RetrievalResult } from '../../contracts/domain';
import { runQuery } from './query';
import { context, fixtureServices } from './test-support';

// Deliberately test-only: production queries cannot turn off relation safety checks.
export async function compareRelationAblation(snapshot: KnowledgeSnapshot, request: RetrievalRequest, semanticHits: { objectId: string; score: number; text: string }[]) {
  async function run(withRelations: boolean): Promise<RetrievalResult> {
    const data = structuredClone(snapshot);
    if (!withRelations) data.relations = [];
    const result = await runQuery(context, structuredClone(request), fixtureServices({
      snapshot: async () => ({ ok: true, data }),
      semanticQuery: async () => ({ ok: true, data: structuredClone(semanticHits) }),
    }));
    if (!result.ok) throw new Error(`Fixture query failed: ${result.error.code}`);
    return result.data;
  }
  return { withRelations: await run(true), withoutRelations: await run(false) };
}
