import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { Id, type KnowledgeSnapshot } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { GovernanceFault, readSnapshot } from './http';
import { unreadableExclusions } from './evidence-scope';

export const comparisonRequestSchema = z.object({ nodeId: Id, revision: Id }).strict();
const comparedFields = ['title', 'question', 'humanStatement', 'conditions', 'boundaries', 'sources', 'evidenceStatus', 'confirmation', 'lifecycle'] as const;
export async function compareVersions(services: Services, ctx: RequestContext, input: z.infer<typeof comparisonRequestSchema>) {
  let historical: KnowledgeSnapshot | undefined;
  try { historical = await readSnapshot(services, ctx, input.revision); }
  catch (error) {
    if (!(error instanceof GovernanceFault) || !['NOT_CONFIGURED', 'NOT_IMPLEMENTED', 'VALIDATION'].includes(error.detail.code)) throw error;
  }
  // The current barrier must be read after historical content, including on a missing revision.
  const latest = await readSnapshot(services, ctx);
  const oldNode = historical?.nodes.find((node) => node.id === input.nodeId);
  const currentNode = latest.nodes.find((node) => node.id === input.nodeId);
  const restricted = unreadableExclusions(latest).includes(input.nodeId) || !!historical && unreadableExclusions(historical).includes(input.nodeId);
  const original = restricted ? null : oldNode ?? null;
  const current = restricted ? null : currentNode ?? null;
  return { nodeId: input.nodeId, referenceRevision: input.revision, currentSnapshotRevision: latest.revision,
    readOnly: true as const, state: restricted ? 'restricted' as const : original && current ? 'available' as const : 'unavailable' as const,
    original, current, changedFields: original && current ? comparedFields.filter((field) => JSON.stringify(original[field]) !== JSON.stringify(current[field])) : [],
  };
}
export type VersionComparison = Awaited<ReturnType<typeof compareVersions>>;
