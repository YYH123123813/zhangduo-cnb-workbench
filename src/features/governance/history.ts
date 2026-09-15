import type { EvidenceRecord, KnowledgeSnapshot } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import type { RequestContext } from '../../contracts/api';
import { GovernanceFault, readSnapshot } from './http';
import { checkedEvidence, evidenceObjectIds, restrictedEvidenceIds, unreadableExclusions } from './evidence-scope';

export function historyNotices(snapshot: KnowledgeSnapshot, records: EvidenceRecord[], nodeId?: string, historical = new Map<string, KnowledgeSnapshot>()) {
  const checked = checkedEvidence(records, snapshot.workspaceId);
  const restrictedIds = restrictedEvidenceIds(checked, unreadableExclusions(snapshot));
  return {
    snapshotRevision: snapshot.revision,
    entries: checked.filter((record) => !nodeId || evidenceObjectIds(record).includes(nodeId)).map((record) => {
      const restricted = restrictedIds.has(record.id);
      return {
      summary: { id: record.id, kind: record.kind, recordedAt: record.recordedAt }, restricted,
      useContextStatus: restricted ? 'restricted' as const : record.useContext ? 'recorded' as const : 'not_recorded' as const,
      record: restricted ? null : structuredClone(record), usableAsCurrentConclusion: false,
      nodes: record.nodeRefs.map((ref) => {
        const node = snapshot.nodes.find((n) => n.id === ref.objectId);
        const exact = node?.revision === ref.revision;
        const oldSnapshot = historical.get(ref.revision);
        const saved = record.useContext?.knowledge.find((n) => n.id === ref.objectId && n.revision === ref.revision);
        const old = restricted ? undefined : saved ?? (exact ? node : oldSnapshot?.excludedIds.includes(ref.objectId) ? undefined : oldSnapshot?.nodes.find((n) => n.id === ref.objectId && n.revision === ref.revision));
        const state = node?.lifecycle === 'withdrawn' ? 'withdrawn' : snapshot.excludedIds.includes(ref.objectId) ? 'excluded' : !node ? 'missing'
          : node.lifecycle === 'superseded' ? 'superseded'
          : !exact ? 'changed' : 'unchanged';
        return { ref, currentRevision: node?.revision ?? null, state, historyAvailable: !!old,
          historicalConditions: old?.conditions ?? null,
          historicalBoundaries: old?.boundaries ?? null,
          message: restricted ? '历史记录涉及已阻断对象，仅保留引用标识，正文和当时条件不可读。' : old ? '原记录与产生时的条件保留，不代表当前任务适用。' : '原答案未改写；产生时的条件需要读取原Git版本，当前尚不可核验。' };
      }),
      relations: record.relationRefs.map((id) => {
        const edge = snapshot.relations.find((r) => r.id === id);
        const historicalRelation = restricted ? null : record.useContext?.relations.find((relation) => relation.id === id) ?? null;
        return { id, state: edge?.state === 'withdrawn' ? 'withdrawn' : snapshot.excludedIds.includes(id) ? 'excluded' : !edge ? 'missing' : edge.state,
          historicalVersionAvailable: !!historicalRelation, historicalRelation,
          message: historicalRelation ? '原使用记录保留当时的方向、版本与依据，不代表当前仍然适用。' : '此记录未保存原关系正文，不能据当前边反推当时的方向或依据。' };
      }),
    }; }),
    warnings: ['历史使用记录不是新的检索结论，也不自动证明无提示掌握。'],
  };
}
export async function readHistoryNotices(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, records: EvidenceRecord[], nodeId?: string) {
  const initial = historyNotices(snapshot, records, nodeId);
  const revisions = [...new Set(initial.entries.filter((entry) => !entry.restricted).flatMap((entry) => entry.nodes.filter((n) => !n.historyAvailable).map((n) => n.ref.revision)))];
  const historical = new Map<string, KnowledgeSnapshot>();
  for (const revision of revisions.slice(0, 12)) {
    try { historical.set(revision, await readSnapshot(services, ctx, revision)); }
    catch (error) {
      if (!(error instanceof GovernanceFault) || !['NOT_CONFIGURED', 'NOT_IMPLEMENTED', 'VALIDATION'].includes(error.detail.code)) throw error;
    }
  }
  const latest = await readSnapshot(services, ctx);
  return { ...historyNotices(latest, records, nodeId, historical), historyReadLimitReached: revisions.length > 12 };
}
