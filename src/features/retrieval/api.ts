import { z } from 'zod';
import { ApprovalSchema, GitRevisionSchema, Id, KnowledgeNodeSchema, TaskContextSchema, VersionRefSchema } from '../../contracts/domain';
import { ModelInputSchema } from '../../contracts/model';
import type { ApiError, RequestContext, Result } from '../../contracts/api';
import type { KnowledgeNode, Relation, RetrievalRequest, RetrievalResult } from '../../contracts/domain';

export const QuerySchema = z.object({
  task: TaskContextSchema.safeExtend({ question: z.string().trim().min(1).max(4000),
    constraints: z.array(TaskContextSchema.shape.constraints.element.extend({ text: z.string().trim().min(1).max(1000) })).max(50)
      .refine((values) => new Set(values.map((c) => c.id)).size === values.length, 'Condition IDs must be unique'),
  }),
  query: z.string().trim().min(1).max(4000), confirmedOnly: z.boolean(),
}).strict();
export const AnswerPreviewRequestSchema = z.object({ request: QuerySchema }).strict();
export const AnswerRequestSchema = AnswerPreviewRequestSchema.extend({ approval: ApprovalSchema.extend({ objectIds: ApprovalSchema.shape.objectIds.max(60) }) }).strict();
export const AnswerPreviewSchema = z.object({ input: ModelInputSchema.extend({ purpose: z.literal('answer') }),
  objectIds: z.array(Id).min(1).max(60).refine((ids) => new Set(ids).size === ids.length), baseRevision: Id,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type AnswerPreview = z.infer<typeof AnswerPreviewSchema>;
export const AnswerResultSchema = z.object({ queryId: Id, snapshotRevision: Id,
  groups: z.object({ eligible: z.array(KnowledgeNodeSchema).max(60), conditional: z.array(KnowledgeNodeSchema).max(60),
    conflicts: z.array(KnowledgeNodeSchema).max(60), excludedIds: z.array(Id) }).strict(),
  paths: z.array(z.object({ seedId: Id, relationIds: z.array(Id), nodeIds: z.array(Id), reason: z.string() }).strict()),
  answer: z.object({ text: z.string().min(1), citations: z.array(z.object({ nodeRef: VersionRefSchema, sourceId: Id, quote: z.string().min(1) }).strict()).min(1).max(4) }).strict().nullable(),
  missingConditions: z.array(z.string()), warnings: z.array(z.string()), coverage: z.enum(['current', 'stale', 'partial', 'unavailable']),
}).strict();
export interface RetrievalStatus { state: 'ready'; workspaceId: string; actorId: string; aiAnswer: 'preview_available' | 'disabled' | 'unavailable'; queryHistory: 'not_saved' }
export interface NodeSummary { id: string; title: string; revision: string }
export interface NodeDetail {
  node: KnowledgeNode; snapshotRevision: string; neighbors: NodeSummary[];
  relations: { relation: Relation; usable: boolean; reason: string }[];
  paths: RetrievalResult['paths']; warnings: string[];
  history?: { currentSnapshotRevision: string; currentNodeRevision: string };
}
export const HistoryQuerySchema = z.object({ revision: GitRevisionSchema, snapshotRevision: GitRevisionSchema.optional() }).strict();
export const DetailQuerySchema = z.object({ revision: z.string().min(1).max(160).optional(), snapshotRevision: z.string().min(1).max(160).optional() }).strict();
export const GraphQuerySchema = DetailQuerySchema.extend({ depth: z.coerce.number().int().min(1).max(2).default(1) });
export interface LocalGraphData {
  rootId: string; depth: number; snapshotRevision: string; nodes: KnowledgeNode[]; relations: Relation[];
  paths: RetrievalResult['paths']; truncated: boolean; warnings: string[];
}

const localErrors = new WeakSet<ApiError>();
export function failure<T = never>(code: ApiError['code'], message: string, nextAction: string, retryable = false, dataState: ApiError['dataState'] = 'not_written'): Result<T> {
  const error: ApiError = { code, message, nextAction, retryable, dataState };
  localErrors.add(error);
  return { ok: false, error };
}
export const cancelled = (modelRequested = false) => failure('CONFLICT', modelRequested
  ? '回答已取消，模型请求可能已发送，无法撤回已发送内容；本次输出已丢弃，查询未保存。'
  : '查询已取消，未保存查询或发送模型。', 'resume_query', false, modelRequested ? 'unknown' : 'not_written');
export function authorizeTask(ctx: RequestContext, request: RetrievalRequest): Result<RetrievalRequest> {
  if (request.task.workspaceId !== ctx.workspaceId || request.task.constraints.some((c) => c.confirmedBy && c.confirmedBy !== ctx.actorId) ||
    request.task.conditionChecks?.some((c) => c.confirmedBy && c.confirmedBy !== ctx.actorId)) {
    return failure('FORBIDDEN', '工作区或条件确认人不属于当前会话。', 'review_task');
  }
  return { ok: true, data: request };
}
export function safeError(error: ApiError): ApiError {
  if (localErrors.has(error)) return error;
  const messages: Record<ApiError['code'], [string, string]> = {
    NOT_IMPLEMENTED: ['此操作尚未实现，未执行。', 'wait_for_integration'],
    NOT_CONFIGURED: ['尚未连接工作区或所需能力，未执行远程动作。', 'configure_workspace'],
    UNAUTHORIZED: ['会话不可用，请重新连接。', 'sign_in'], FORBIDDEN: ['没有当前知识范围的读取权限。', 'check_permissions'],
    VALIDATION: ['请求或知识数据无效，请检查字段。', 'review_input'], CONFLICT: ['版本或请求状态已变化，请重新读取。', 'refresh_snapshot'],
    UNKNOWN_RESULT: ['上游结果未知，未保存查询。', 'check_upstream'], UPSTREAM: ['读取暂时失败，原始数据未改动。', 'retry_read'],
    INTERNAL: ['请求未能完成，原始数据未改动。', 'retry_read'],
  };
  const [message, nextAction] = messages[error.code] ?? messages.UPSTREAM;
  return { code: error.code in messages ? error.code : 'UPSTREAM', message, nextAction, retryable: error.retryable, dataState: 'not_written' };
}
