import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiError, RequestContext, Result } from '../../contracts/api';
import { CONTRACT_VERSION, Id, KnowledgeNodeSchema, RelationSchema, Timestamp, type KnowledgeSnapshot } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';

export class GovernanceFault extends Error {
  constructor(readonly detail: ApiError) { super(detail.message); }
}
export function fail(code: ApiError['code'], message: string, nextAction = 'review_input', dataState: ApiError['dataState'] = 'not_written'): never {
  throw new GovernanceFault({ code, message, nextAction, dataState, retryable: false });
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    const messages: Record<ApiError['code'], string> = {
      NOT_IMPLEMENTED: '平台能力尚未实现，未执行远程动作。', NOT_CONFIGURED: '工作区或所需平台能力尚未连接。',
      UNAUTHORIZED: '会话无效或已过期。', FORBIDDEN: '平台拒绝访问，未扩大读取范围。', VALIDATION: '平台未通过输入校验。',
      CONFLICT: '平台版本、范围或批准发生变化，草稿保留。', UNKNOWN_RESULT: '平台操作结果未知，必须读回后再决定。',
      UPSTREAM: '上游操作未完整成功，请核验保存状态。', INTERNAL: '平台操作中断，结果未核验。',
    };
    const nextActions: Record<ApiError['code'], string> = {
      NOT_IMPLEMENTED: 'wait_for_platform_capability', NOT_CONFIGURED: 'configure_workspace', UNAUTHORIZED: 'sign_in', FORBIDDEN: 'request_scope',
      VALIDATION: 'review_input', CONFLICT: 'reload_and_preview', UNKNOWN_RESULT: 'read_back_before_retry', UPSTREAM: 'verify_platform_state', INTERNAL: 'read_back_before_retry',
    };
    throw new GovernanceFault({ ...result.error, message: messages[result.error.code] ?? messages.INTERNAL, nextAction: nextActions[result.error.code] ?? nextActions.INTERNAL,
      retryable: result.error.code === 'UNKNOWN_RESULT' ? false : result.error.retryable });
  }
  return result.data;
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) fail('VALIDATION', `字段无效：${value.error.issues.map((issue) => issue.path.join('.') || 'request').slice(0, 6).join('、')}`);
  return value.data;
}
export async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    const text = await c.req.text();
    if (text.length > 1_000_000) fail('VALIDATION', '请求超过允许范围。');
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof GovernanceFault) throw error;
    fail('VALIDATION', '请求必须是有效JSON。');
  }
  return parse(schema, value);
}
const snapshotSchema = z.object({
  workspaceId: Id, revision: Id, nodes: z.array(KnowledgeNodeSchema), relations: z.array(RelationSchema),
  excludedIds: z.array(Id), generatedAt: Timestamp,
}).strict();
export async function readSnapshot(services: Services, ctx: RequestContext, revision?: string): Promise<KnowledgeSnapshot> {
  const value = unwrap(await (revision ? services.snapshot(ctx, revision) : services.snapshot(ctx)));
  const checked = snapshotSchema.safeParse(value);
  if (!checked.success) fail('UPSTREAM', '平台返回的知识快照无效。', 'reload_snapshot');
  if (checked.data.workspaceId !== ctx.workspaceId || checked.data.nodes.some((n) => n.workspaceId !== ctx.workspaceId)
    || checked.data.relations.some((r) => r.workspaceId !== ctx.workspaceId)) fail('FORBIDDEN', '工作区不匹配，未读取其他工作区内容。');
  const ids = [...checked.data.nodes, ...checked.data.relations].map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail('UPSTREAM', '快照包含重复对象ID，不能确定唯一对象。', 'repair_snapshot_ids');
  if (revision && checked.data.revision !== revision) fail('UPSTREAM', '平台返回的版本与请求的历史版本不符。', 'verify_historical_reader');
  return checked.data;
}
export function checkBase(snapshot: KnowledgeSnapshot, baseRevision: string) {
  if (snapshot.revision !== baseRevision) fail('CONFLICT', '基准版本已变化，草稿保留，请重新预览。', 'reload_and_preview', 'preserved');
}
export const cancelled = { state: 'cancelled', dataState: 'not_written' } as const;
export const cancelSchema = z.object({ action: z.literal('cancel') }).strict();
export const httpStatus = { NOT_IMPLEMENTED: 501, NOT_CONFIGURED: 503, UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION: 422, CONFLICT: 409, UNKNOWN_RESULT: 409, UPSTREAM: 502, INTERNAL: 500 } as const;
export function requireScope(ctx: RequestContext, scope: string) {
  if (!ctx.scopes.includes(scope)) fail('FORBIDDEN', '权限不足，未执行该操作。', 'request_scope');
}

export async function route(c: Context, services: Services, scope: string, action: (ctx: RequestContext) => Promise<unknown>) {
  let ctx: RequestContext | undefined;
  try {
    ctx = unwrap(await services.context(c.req.raw));
    requireScope(ctx, scope);
    const data = await action(ctx);
    return c.json({ ok: true, data, meta: { requestId: ctx.requestId, mode: ctx.mode, contractVersion: CONTRACT_VERSION } });
  } catch (error) {
    const detail: ApiError = error instanceof GovernanceFault ? error.detail : {
      code: 'INTERNAL', message: '操作中断，结果尚未核验。', retryable: false, dataState: 'unknown', nextAction: 'read_back_before_retry',
    };
    return c.json({ ok: false, error: detail, meta: { requestId: ctx?.requestId ?? crypto.randomUUID(), mode: ctx?.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION } }, httpStatus[detail.code]);
  }
}
