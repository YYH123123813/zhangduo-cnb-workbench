import { z } from 'zod';
import { Id, type EvidenceRecord, type KnowledgeSnapshot, type Relation } from '../../contracts/domain';
import type { RequestContext } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { SCOPES } from '../../contracts/scopes';
import { cancelSchema, checkBase, fail, readSnapshot, unwrap } from './http';
import { checkedEvidence, evidenceObjectIds, restrictedEvidenceIds, unreadableExclusions } from './evidence-scope';

export const objectIdsSchema = z.array(Id).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, 'Duplicate IDs');
export const impactInputSchema = z.object({ action: z.literal('preview'), objectIds: objectIdsSchema, baseRevision: Id, budget: z.number().int().min(1).max(10000).default(1000) }).strict();
export const impactRequestSchema = z.discriminatedUnion('action', [impactInputSchema, cancelSchema]);
export function activeRelation(snapshot: KnowledgeSnapshot, edge: Relation) {
  const source = snapshot.nodes.find((n) => n.id === edge.source.objectId);
  const target = snapshot.nodes.find((n) => n.id === edge.target.objectId);
  return edge.state === 'confirmed' && !snapshot.excludedIds.includes(edge.id)
    && !!source && !!target && [source, target].every((n) => n.confirmation === 'confirmed' && n.lifecycle === 'active' && !snapshot.excludedIds.includes(n.id))
    && source.revision === edge.source.revision && target.revision === edge.target.revision;
}
type HistoryCoverage = 'current' | 'unavailable' | 'not_authorized' | 'restricted';
export function inspectImpact(snapshot: KnowledgeSnapshot, records: EvidenceRecord[], input: z.infer<typeof impactInputSchema>, historyCoverage: HistoryCoverage = 'current') {
  checkBase(snapshot, input.baseRevision);
  if (input.objectIds.some((id) => snapshot.excludedIds.includes(id))) fail('FORBIDDEN', '不能检查已阻断对象的历史使用或正文。', 'review_delete_report');
  const allEvidence = checkedEvidence(records, snapshot.workspaceId);
  const restricted = restrictedEvidenceIds(allEvidence, unreadableExclusions(snapshot));
  const evidence = allEvidence.filter((record) => !restricted.has(record.id));
  if (evidence.length !== allEvidence.length) historyCoverage = 'restricted';
  const knownIds = new Set([...snapshot.nodes, ...snapshot.relations].map((item) => item.id));
  if (input.objectIds.some((id) => !knownIds.has(id))) fail('VALIDATION', '选定对象不属于当前快照。');
  const seeds = new Set(input.objectIds.filter((id) => snapshot.nodes.some((n) => n.id === id)));
  for (const edge of snapshot.relations.filter((r) => input.objectIds.includes(r.id))) {
    seeds.add(edge.source.objectId); seeds.add(edge.target.objectId);
  }
  const queue = [...seeds].map((id) => ({ id, depth: 0 }));
  const visited = new Set(seeds);
  const direct = new Set<string>();
  const indirect = new Set<string>();
  const relationIds = new Set<string>();
  const unverified = new Set<string>();
  let checked = 0;
  let budgetExhausted = false;
  // Breadth-first inspection follows dependency direction, not proof transitivity.
  traversal: for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    for (const edge of snapshot.relations) {
      if (checked >= input.budget) { budgetExhausted = true; break traversal; }
      checked++;
      let next: string | undefined;
      if (edge.type === 'depends_on' && edge.target.objectId === current.id) next = edge.source.objectId;
      if (edge.type === 'supports' && edge.source.objectId === current.id) next = edge.target.objectId;
      if (edge.type === 'contradicts' || edge.type === 'supersedes') {
        if (edge.source.objectId === current.id) next = edge.target.objectId;
        else if (edge.target.objectId === current.id) next = edge.source.objectId;
      }
      if (!next || edge.state !== 'confirmed' || snapshot.excludedIds.includes(edge.id)) continue;
      if (!activeRelation(snapshot, edge)) { unverified.add(edge.id); continue; }
      relationIds.add(edge.id);
      if (visited.has(next)) continue;
      visited.add(next);
      (current.depth === 0 ? direct : indirect).add(next);
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }
  const affectedEdges = new Set([...input.objectIds, ...relationIds]);
  return {
    snapshotRevision: snapshot.revision, objectIds: input.objectIds,
    directNodeIds: [...direct], indirectNodeIds: [...indirect], relationIds: [...relationIds],
    evidenceRefs: evidence.filter((record) => evidenceObjectIds(record).some((id) => visited.has(id) || affectedEdges.has(id)))
      .map(({ id, taskId, nodeRefs, relationRefs, recordedAt }) => ({ id, taskId, nodeRefs, relationRefs, recordedAt })),
    unverifiedRelationIds: [...unverified], checked, budgetExhausted,
    graphCoverage: budgetExhausted || unverified.size ? 'partial' as const : 'current' as const, historyCoverage,
    coverage: budgetExhausted || unverified.size || historyCoverage !== 'current' ? 'partial' as const : 'current' as const,
    isProof: false, warnings: ['间接影响仅用于复核，不构成多跳证明。', ...(budgetExhausted ? ['检查预算耗尽，影响范围尚未检查完。'] : []), ...(unverified.size ? ['部分关系引用旧版本或不可用节点，未用于推导。'] : []),
      ...(historyCoverage !== 'current' ? ['历史使用引用未完整核验；未接通、无权限或受限记录不能解释为零影响。'] : [])],
  };
}
export async function readImpact(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: z.infer<typeof impactInputSchema>) {
  checkBase(snapshot, input.baseRevision);
  if (input.objectIds.some((id) => snapshot.excludedIds.includes(id))) fail('FORBIDDEN', '不能检查已阻断对象的历史使用或正文。', 'review_delete_report');
  let records: EvidenceRecord[] = [];
  let historyCoverage: HistoryCoverage = 'not_authorized';
  if (ctx.scopes.includes(SCOPES.evidenceRead)) {
    const result = await services.listEvidence(ctx);
    if (!result.ok && ['NOT_CONFIGURED', 'NOT_IMPLEMENTED'].includes(result.error.code)) historyCoverage = 'unavailable';
    else { records = unwrap(result); historyCoverage = 'current'; }
  }
  return inspectImpact(await readSnapshot(services, ctx), records, input, historyCoverage);
}
