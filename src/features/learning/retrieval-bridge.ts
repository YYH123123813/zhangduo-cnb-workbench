import { z } from 'zod';
import { Id, KnowledgeNodeSchema, TaskContextSchema, Timestamp, VersionRefSchema, type KnowledgeSnapshot, type RetrievalResult } from '../../contracts/domain';
import type { RequestContext } from '../../contracts/api';
import { canonicalJson } from '../../contracts/hash';
import { buildUseDraft } from './history';
import { failure, success } from './errors';
import { validateTaskContext } from '../../contracts/task';
import { previewUse, type UseSelection } from './use';

const RetrievalHandoffSchema: z.ZodType<RetrievalResult> = z.object({
  queryId: Id, snapshotRevision: Id,
  groups: z.object({ eligible: z.array(KnowledgeNodeSchema), conditional: z.array(KnowledgeNodeSchema), conflicts: z.array(KnowledgeNodeSchema), excludedIds: z.array(Id) }).strict(),
  paths: z.array(z.object({ seedId: Id, relationIds: z.array(Id), nodeIds: z.array(Id).min(1), reason: z.string() }).strict()).max(100),
  answer: z.object({ text: z.string(), citations: z.array(z.object({ nodeRef: VersionRefSchema, sourceId: Id, quote: z.string() }).strict()) }).strict().nullable(),
  missingConditions: z.array(z.string()), warnings: z.array(z.string()), coverage: z.enum(['current', 'stale', 'partial', 'unavailable']),
}).strict();
export const RetrievedUseInputSchema = z.object({
  task: TaskContextSchema, retrieval: RetrievalHandoffSchema, nodeId: Id,
  decision: z.enum(['adopt', 'reject', 'verify_later']), reason: z.string().max(4000),
}).strict();
export type RetrievedUseInput = z.infer<typeof RetrievedUseInputSchema>;
const HandoffInputSchema = RetrievedUseInputSchema.extend({ recordId: Id, recordedAt: Timestamp });

export function prepareRetrievedUse(input: unknown, snapshot: KnowledgeSnapshot, ctx: RequestContext) {
  if (ctx.mode === 'unconfigured') return failure('NOT_CONFIGURED', '工作区未连接。', 'configure_workspace');
  if (!ctx.scopes.includes('knowledge:read')) return failure('FORBIDDEN', '检索交接需要知识读取权限。', 'request_access');
  const parsed = HandoffInputSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '检索交接格式不完整，不能重建版本化应用记录。');
  const value = parsed.data; const result = value.retrieval;
  const task = validateTaskContext(value.task, snapshot, ctx.actorId); if (!task.ok) return task;
  const candidates = [...result.groups.eligible, ...result.groups.conditional, ...result.groups.conflicts];
  if (value.task.workspaceId !== ctx.workspaceId || snapshot.workspaceId !== ctx.workspaceId || candidates.some((node) => node.workspaceId !== ctx.workspaceId)) return failure('FORBIDDEN', '检索任务或节点不属于当前工作区。');
  if (result.snapshotRevision !== snapshot.revision) return failure('CONFLICT', '检索结果基于旧快照，请重跑检索后重新预览。', 'rerun_retrieval');
  if (new Set(candidates.map((node) => node.id)).size !== candidates.length) return failure('VALIDATION', '检索分组包含重复节点，请重新检索。', 'rerun_retrieval');
  for (const node of candidates) {
    const official = snapshot.nodes.find((item) => item.id === node.id);
    if (!official || canonicalJson(node) !== canonicalJson(official)) return failure('CONFLICT', '检索节点内容与正式快照不一致，请重新检索。', 'rerun_retrieval');
  }
  if (result.groups.excludedIds.includes(value.nodeId)) return failure('VALIDATION', '所选节点已被本次检索排除，不产生应用结论。');
  if (value.decision === 'adopt' && (result.coverage !== 'current' || result.missingConditions.length || result.warnings.length) && !value.reason.trim()) return failure('VALIDATION', '检索仍有条件、覆盖或边界缺口，请明确本次采用的限制和理由。');
  if (value.decision === 'adopt' && result.groups.conflicts.some((node) => node.id === value.nodeId)) return failure('VALIDATION', '冲突节点需要人工复核，不能直接采用。');
  const node = candidates.find((node) => node.id === value.nodeId);
  if (!node) return failure('VALIDATION', '所选节点不在本次检索结果中。');
  const paths = result.paths.filter((path) => path.nodeIds.includes(value.nodeId));
  for (const path of paths) {
    if (path.nodeIds[0] !== path.seedId || path.relationIds.length !== path.nodeIds.length - 1 || new Set(path.relationIds).size !== path.relationIds.length || new Set(path.nodeIds).size !== path.nodeIds.length) return failure('VALIDATION', '检索路径不连续或存在循环，不能作为应用依据。');
    if (path.nodeIds.some((id) => result.groups.excludedIds.includes(id))) return failure('CONFLICT', '检索路径包含已排除节点。', 'rerun_retrieval');
    for (const [index, id] of path.relationIds.entries()) {
      const edge = snapshot.relations.find((edge) => edge.id === id);
      const from = path.nodeIds[index]; const to = path.nodeIds[index + 1];
      if (!edge || !((edge.source.objectId === from && edge.target.objectId === to) || (edge.source.objectId === to && edge.target.objectId === from))) return failure('CONFLICT', '检索路径和正式关系不一致。', 'rerun_retrieval');
    }
  }
  const selection: UseSelection = { task: value.task, snapshotRevision: result.snapshotRevision,
    nodeRefs: [{ workspaceId: node.workspaceId, objectId: node.id, revision: node.revision }],
    relationRefs: [...new Set(paths.flatMap((path) => path.relationIds))], decision: value.decision, reason: value.reason,
  };
  const draft = buildUseDraft(selection, snapshot, value.recordId, value.recordedAt);
  if (!draft.ok) return draft;
  const preview = previewUse(selection, snapshot);
  if (!preview.ok) return preview;
  const pathRelations = new Set(paths.flatMap((path) => path.relationIds));
  const allPaths = [...paths, ...draft.data.paths.filter((path) => path.relationIds.some((id) => !pathRelations.has(id)))];
  // Semantic coverage does not determine whether the Git-verified text is usable.
  const warnings = [...new Set([...result.warnings, ...(result.coverage === 'unavailable'
    ? ['语义检索覆盖不可用；本预览仅核对 Git 正式知识，检索完整性尚未确认。'] : [])])];
  return success({
    selection: { ...selection, relationRefs: draft.data.record.relationRefs },
    preview: { ...preview.data, missingConditions: [...new Set([...preview.data.missingConditions, ...result.missingConditions])], warnings: [...new Set([...preview.data.warnings, ...warnings])] },
    draft: { ...draft.data, paths: structuredClone(allPaths), retrievalContext: structuredClone({ queryId: result.queryId, coverage: result.coverage, missingConditions: result.missingConditions, warnings }) },
    exposure: result.answer ? 'seen' as const : 'unknown' as const, handoffTrust: 'client_preview_only' as const,
  });
}
