import { RelationSchema } from '../../contracts/domain';
import type { KnowledgeNode, KnowledgeSnapshot, Relation, SourceRecord } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure, sameSourceProvenance } from './model';

export type RelationSubject = Pick<KnowledgeNode, 'id' | 'workspaceId' | 'revision' | 'sources'>;
export function relationEvidence(records: readonly SourceRecord[]) {
  const sources = new Map<string, SourceRecord>();
  const ambiguous = new Set<string>();
  for (const source of records) {
    const previous = sources.get(source.id);
    if (previous && !sameSourceProvenance(previous, source)) ambiguous.add(source.id);
    if (!previous) sources.set(source.id, source);
  }
  return { sources: [...sources.values()].filter((source) => source.excerpt.trim() && !ambiguous.has(source.id)),
    ambiguousIds: [...ambiguous].sort() };
}
export function validateRelations(relations: Relation[], subject: RelationSubject, snapshot: KnowledgeSnapshot, allowProposed = false): Result<Relation[]> {
  if (snapshot.workspaceId !== subject.workspaceId || snapshot.excludedIds.includes(subject.id)) return failure('工作区或知识状态已变化。', 'FORBIDDEN', 'reload_snapshot');
  const ids = new Set<string>();
  const edges = new Set<string>();
  for (const relation of relations) {
    const parsed = RelationSchema.safeParse(relation);
    if (!parsed.success || (relation.state !== 'confirmed' && !(allowProposed && relation.state === 'proposed')) || !relation.rationale.trim() || relation.workspaceId !== subject.workspaceId) return failure('关系需要明确类型、理由、依据和人的确认。');
    const edge = JSON.stringify([relation.source.objectId, relation.type, relation.target.objectId]);
    if (ids.has(relation.id) || edges.has(edge) || relation.source.objectId === relation.target.objectId ||
      ![relation.source.objectId, relation.target.objectId].includes(subject.id)) return failure('重复、自指或无关关系不能提交。');
    ids.add(relation.id); edges.add(edge);
    const records: SourceRecord[] = [];
    for (const reference of [relation.source, relation.target]) {
      const node = reference.objectId === subject.id ? subject : snapshot.nodes.find((entry) => entry.id === reference.objectId);
      if (!node || reference.workspaceId !== subject.workspaceId || snapshot.excludedIds.includes(reference.objectId)) return failure('关系端点不存在、已撤回或跨工作区。');
      if (node.revision !== reference.revision) return failure('关系目标版本已变化，请重新核对。', 'CONFLICT', 'reload_snapshot', 'preserved');
      if (reference.objectId !== subject.id) {
        const existing = snapshot.nodes.find((entry) => entry.id === reference.objectId)!;
        if (existing.confirmation !== 'confirmed' || existing.lifecycle !== 'active') return failure('关系目标尚未确认或不是有效知识。');
      }
      records.push(...node.sources);
    }
    const evidence = relationEvidence(records);
    if (relation.evidenceIds.some((id) => evidence.ambiguousIds.includes(id))) return failure('来源 ID 对应不同原句或身份，请重新读取并选择明确的关系依据。');
    const evidenceIds = new Set(evidence.sources.map((source) => source.id));
    if (relation.evidenceIds.some((id) => !evidenceIds.has(id)) || new Set(relation.evidenceIds).size !== relation.evidenceIds.length) return failure('关系依据必须来自端点的真实来源原句。');
  }
  return { ok: true, data: relations };
}
