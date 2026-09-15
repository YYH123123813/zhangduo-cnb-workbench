import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import {
  Id, KnowledgeNodeSchema, RelationSchema, Timestamp,
  type KnowledgeNode, type KnowledgeSnapshot, type VersionRef,
} from '../../contracts/domain';
import { failure, success } from './errors';
import { describeHistory, validateEvidenceList } from './history';
import { readApplicationEvidence } from './application-save';
import { canonicalJson } from '../../contracts/hash';

const GitRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const SnapshotResponse = z.object({
  workspaceId: Id, revision: Id, nodes: z.array(KnowledgeNodeSchema),
  relations: z.array(RelationSchema), excludedIds: z.array(Id), generatedAt: Timestamp,
}).strict();

export interface HistoricalKnowledgeView {
  recordId: string;
  nodeRef: VersionRef;
  snapshotRevision: string;
  provenance: 'historical_knowledge';
  contextState: 'not_recorded' | 'recorded' | 'linked_use';
  applicability: 'not_assessed';
  currentState: 'current' | 'changed' | 'withdrawn' | 'superseded' | 'needs_review';
  knowledge: Pick<KnowledgeNode, 'id' | 'revision' | 'title' | 'humanStatement' | 'conditions' | 'boundaries' | 'evidenceStatus' | 'confirmation' | 'lifecycle'>;
}

async function readSnapshot(services: Services, ctx: RequestContext, revision?: string): Promise<Result<KnowledgeSnapshot>> {
  const result = revision === undefined ? await services.snapshot(ctx) : await services.snapshot(ctx, revision);
  if (!result.ok) return result;
  const parsed = SnapshotResponse.safeParse(result.data);
  if (!parsed.success) return failure('UPSTREAM', '知识存储返回了不合法的快照。', 'check_storage');
  const value = parsed.data;
  if (value.workspaceId !== ctx.workspaceId || value.nodes.some((node) => node.workspaceId !== ctx.workspaceId)
    || value.relations.some((edge) => [edge.workspaceId, edge.source.workspaceId, edge.target.workspaceId].some((id) => id !== ctx.workspaceId))) {
    return failure('FORBIDDEN', '知识快照不属于当前工作区，未展示内容。', 'check_storage');
  }
  if (new Set(value.nodes.map((node) => node.id)).size !== value.nodes.length) return failure('UPSTREAM', '知识快照包含重复节点。', 'check_storage');
  if (revision !== undefined && value.revision !== revision) return failure('CONFLICT', '历史读取未返回记录指定的版本，未以当前知识替代。', 'check_historical_support');
  return success(value);
}

function visibleNode(snapshot: KnowledgeSnapshot, nodeId: string): Result<KnowledgeNode> {
  const node = snapshot.nodes.find((item) => item.id === nodeId);
  if (!node || snapshot.excludedIds.includes(nodeId)) return failure('FORBIDDEN', '该知识当前不可读取，历史入口不绕过排除限制。', 'check_access');
  return success(node);
}

export async function readHistoricalKnowledge(services: Services, ctx: RequestContext, recordId: string, nodeId: string): Promise<Result<HistoricalKnowledgeView>> {
  if (ctx.mode === 'unconfigured') return failure('NOT_CONFIGURED', '工作区未连接。', 'configure_workspace');
  if (!ctx.scopes.includes('evidence:read') || !ctx.scopes.includes('knowledge:read')) return failure('FORBIDDEN', '读取原版本知识需要证据及知识读取权限。', 'request_access');
  if (!Id.safeParse(recordId).success || !Id.safeParse(nodeId).success) return failure('VALIDATION', '记录或节点 ID 不正确。');
  const exact = services.readEvidence ? await readApplicationEvidence(services, ctx, recordId) : null;
  if (exact && !exact.ok) return exact;
  const stored = exact?.ok ? success([exact.data]) : await services.listEvidence(ctx);
  if (!stored.ok) return stored;
  const parsed = validateEvidenceList(stored.data, ctx.workspaceId);
  if (!parsed.ok) return parsed;
  const records = parsed.data.filter((record) => record.id === recordId);
  if (records.length !== 1) return failure('CONFLICT', '原记录不存在或标识不唯一，无法确认原版本。', 'reload_records');
  const refs = records[0]!.nodeRefs.filter((ref) => ref.objectId === nodeId);
  if (refs.length !== 1) return failure('VALIDATION', '节点不在原记录中，或版本引用不唯一。');
  const ref = refs[0]!;
  if (!GitRevision.safeParse(ref.revision).success) return failure('VALIDATION', '原记录没有完整 Git 版本，无法读取历史知识。', 'check_original_record');

  const current = await readSnapshot(services, ctx);
  if (!current.ok) return current;
  const permitted = visibleNode(current.data, nodeId);
  if (!permitted.ok) return permitted;
  const original = await readSnapshot(services, ctx, ref.revision);
  if (!original.ok) return original;
  const historical = visibleNode(original.data, nodeId);
  if (!historical.ok) return historical;
  if (historical.data.revision !== ref.revision) return failure('CONFLICT', '历史节点版本与原记录不一致。', 'check_storage');

  // Recheck present access after the slow historical read; this is not a platform deletion lock.
  const latest = await readSnapshot(services, ctx);
  if (!latest.ok) return latest;
  const visible = visibleNode(latest.data, nodeId);
  if (!visible.ok) return visible;
  if (services.readEvidence) {
    const record = await readApplicationEvidence(services, ctx, recordId); if (!record.ok) return record;
    if (canonicalJson(record.data) !== canonicalJson(records[0]!)) return failure('CONFLICT', '原证据在历史读取期间变化，未展示旧正文。', 'read_original_evidence');
  }
  const currentState = visible.data.lifecycle !== 'active' ? visible.data.lifecycle
    : visible.data.revision === ref.revision && visible.data.confirmation === 'confirmed' ? 'current' : 'changed';
  const { id, revision, title, humanStatement, conditions, boundaries, evidenceStatus, confirmation, lifecycle } = historical.data;
  return success(structuredClone({
    recordId, nodeRef: ref, snapshotRevision: original.data.revision,
    provenance: 'historical_knowledge', contextState: describeHistory(records[0]!).contextState, applicability: 'not_assessed', currentState,
    knowledge: { id, revision, title, humanStatement, conditions, boundaries, evidenceStatus, confirmation, lifecycle },
  }));
}
