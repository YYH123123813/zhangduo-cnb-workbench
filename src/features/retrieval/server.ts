import type { Context, Hono } from 'hono';
import type { Services } from '../../contracts/ports';
import type { RequestContext, Result } from '../../contracts/api';
import { CONTRACT_VERSION, Id } from '../../contracts/domain';
import { ModelOperationReceiptSchema } from '../../contracts/model';
import { SCOPES } from '../../contracts/scopes';
import { AnswerPreviewRequestSchema, AnswerRequestSchema, authorizeTask, cancelled, DetailQuerySchema, failure, GraphQuerySchema, HistoryQuerySchema, QuerySchema, safeError, type RetrievalStatus } from './api';
import { runQuery } from './query';
import { answerAvailability, generateAnswer, hasAnswerPorts, previewAnswer } from './answer';
import { readLocalGraph, readNodeDetail } from './details';
import { readHistoricalDetail } from './history';

const statuses = { NOT_IMPLEMENTED: 501, NOT_CONFIGURED: 503, UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION: 422, CONFLICT: 409, UNKNOWN_RESULT: 409, UPSTREAM: 502, INTERNAL: 500 } as const;

export function registerRoutes(app: Hono, services: Services) {
  function route(handler: (c: Context, ctx: RequestContext, onModelRequested: () => void) => Promise<Result<unknown>>,
    scopes: readonly string[] = [SCOPES.knowledgeRead]) {
    return async (c: Context) => {
      c.header('Cache-Control', 'no-store');
      c.header('Vary', 'Cookie, Authorization');
      let ctx: RequestContext | undefined;
      let modelRequested = false;
      function respond(result: Result<unknown>, trustedMessage = false) {
        const meta = { requestId: ctx?.requestId ?? crypto.randomUUID(), mode: ctx?.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION };
        if (result.ok) return c.json({ ...result, meta }, 200);
        let error = trustedMessage ? result.error : safeError(result.error);
        if (modelRequested) error = { ...error, dataState: 'unknown', retryable: false,
          message: error.message.includes('可能已发送') ? error.message : `${error.message} 模型请求可能已发送，未自动重试；查询未保存。` };
        return c.json({ ok: false as const, error, meta }, statuses[error.code] ?? 502);
      }
      try {
        const identity = await services.context(c.req.raw);
        if (!identity.ok) return respond(identity);
        ctx = identity.data;
        // Platform ports recognize the issued object; copy only comparison fields.
        const principal = { actorId: ctx.actorId, workspaceId: ctx.workspaceId, mode: ctx.mode };
        if (scopes.some((scope) => !ctx!.scopes.includes(scope))) return respond(failure('FORBIDDEN', '缺少本次读取所需的权限。', 'check_permissions'), true);
        if (c.req.raw.signal.aborted) return respond(cancelled(), true);
        const result = await handler(c, ctx, () => { modelRequested = true; });
        if (c.req.raw.signal.aborted) return respond(cancelled(modelRequested), true);
        if (result.ok) {
          const refreshed = await services.context(c.req.raw);
          if (c.req.raw.signal.aborted) return respond(cancelled(modelRequested), true);
          if (!refreshed.ok) return respond(refreshed);
          if (refreshed.data.actorId !== principal.actorId || refreshed.data.workspaceId !== principal.workspaceId ||
            refreshed.data.mode !== principal.mode || scopes.some((scope) => !refreshed.data.scopes.includes(scope)) ||
            (modelRequested && (!refreshed.data.scopes.includes(SCOPES.modelAnswer) || !refreshed.data.scopes.includes(SCOPES.settingsRead)))) {
            return respond(failure('FORBIDDEN', '会话授权已变化。', 'check_permissions'), true);
          }
        }
        return respond(result);
      } catch {
        return respond(failure('UPSTREAM', '读取失败。', 'retry_read', true));
      }
    };
  }
  app.get('/api/retrieval/status', route(async (_c, ctx) => ({ ok: true, data: {
    state: 'ready', workspaceId: ctx.workspaceId, actorId: ctx.actorId, aiAnswer: await answerAvailability(ctx, services), queryHistory: 'not_saved',
  } satisfies RetrievalStatus })));
  app.post('/api/retrieval/query', route(async (c, ctx) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return failure('VALIDATION', '请求必须是有效 JSON。', 'review_input'); }
    const parsed = QuerySchema.safeParse(body);
    if (!parsed.success) return failure('VALIDATION', '请检查问题（1至4000字）、条件（每条1至1000字、最多50条且ID不重复）和任务字段。', 'review_input');
    const authorized = authorizeTask(ctx, parsed.data);
    if (!authorized.ok) return authorized;
    return runQuery(ctx, authorized.data, services, c.req.raw.signal);
  }));
  app.post('/api/retrieval/answer/preview', route(async (c, ctx) => {
    if (!hasAnswerPorts(services)) return failure('NOT_CONFIGURED', '可信模型批准或撤回能力尚未配置。', 'configure_workspace');
    const parsed = AnswerPreviewRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return failure('VALIDATION', '请提供本次检索任务。', 'review_input');
    return previewAnswer(ctx, parsed.data.request, services, c.req.raw.signal);
  }));
  app.post('/api/retrieval/answer', route(async (c, ctx, onModelRequested) => {
    if (!hasAnswerPorts(services)) return failure('NOT_CONFIGURED', '可信模型批准或撤回能力尚未配置。', 'configure_workspace');
    const parsed = AnswerRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return failure('VALIDATION', '需要本次任务和平台登记的批准；不能提交浏览器构造的检索结果。', 'preview_model_input');
    const authorized = authorizeTask(ctx, parsed.data.request); if (!authorized.ok) return authorized;
    const direct = await runQuery(ctx, parsed.data.request, services, c.req.raw.signal);
    if (!direct.ok) return direct;
    return generateAnswer(ctx, parsed.data.request, direct.data, parsed.data.approval, services, c.req.raw.signal, onModelRequested);
  }));
  app.get('/api/retrieval/answer/operations/:id', route(async (c, ctx) => {
    const id = Id.safeParse(c.req.param('id'));
    if (!id.success) return failure('VALIDATION', '需要原模型批准 ID。', 'review_input');
    if (!services.readModelOperation) return failure('NOT_CONFIGURED', '模型原操作读回能力尚未配置。', 'configure_workspace');
    const response = await services.readModelOperation(ctx, id.data);
    if (!response.ok) return response;
    const parsed = ModelOperationReceiptSchema.nullable().safeParse(response.data);
    if (!parsed.success) return failure('UPSTREAM', '模型原操作回执无法核验。', 'review_model_operation');
    const receipt = parsed.data;
    if (receipt && (receipt.approvalId !== id.data || receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId || receipt.purpose !== 'answer')) {
      return failure('FORBIDDEN', '回执不属于当前身份的原回答操作。', 'review_model_operation');
    }
    return { ok: true, data: receipt };
  }, [SCOPES.workspaceRead, SCOPES.modelAnswer]));
  app.get('/api/retrieval/nodes/:id/history', route(async (c, ctx) => {
    const parsed = HistoryQuerySchema.safeParse(c.req.query()); const id = c.req.param('id');
    if (!parsed.success || !id || id.length > 160) return failure('VALIDATION', '节点无效或未提供完整Git版本。', 'review_input');
    return readHistoricalDetail(ctx, services, id, parsed.data.revision, { signal: c.req.raw.signal, snapshotRevision: parsed.data.snapshotRevision });
  }));
  app.get('/api/retrieval/nodes/:id', route(async (c, ctx) => {
    const parsed = DetailQuerySchema.safeParse(c.req.query());
    const id = c.req.param('id');
    if (!parsed.success || !id || id.length > 160) return failure('VALIDATION', '节点或版本参数无效。', 'review_input');
    return readNodeDetail(ctx, services, id, parsed.data.revision, parsed.data.snapshotRevision);
  }));
  app.get('/api/retrieval/graph/:id', route(async (c, ctx) => {
    const parsed = GraphQuerySchema.safeParse(c.req.query()); const id = c.req.param('id');
    if (!parsed.success || !id || id.length > 160) return failure('VALIDATION', '图谱范围或版本参数无效。', 'review_input');
    return readLocalGraph(ctx, services, id, parsed.data.depth, parsed.data.revision, parsed.data.snapshotRevision);
  }));
}
