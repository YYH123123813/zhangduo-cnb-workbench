import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CONTRACT_VERSION } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { failure } from './errors';

export function respond<T>(c: Context, result: Result<T>, ctx?: RequestContext) {
  const statuses = { NOT_IMPLEMENTED: 501, NOT_CONFIGURED: 503, UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION: 422, CONFLICT: 409, UNKNOWN_RESULT: 409, UPSTREAM: 502, INTERNAL: 500 } as const;
  const status: ContentfulStatusCode = result.ok ? 200 : statuses[result.error.code];
  c.header('Cache-Control', 'no-store');
  return c.json({ ...result, meta: { requestId: ctx?.requestId ?? crypto.randomUUID(), mode: ctx?.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION } }, status);
}

export function guarded(services: Services, scope: string, handler: (c: Context, ctx: RequestContext) => Promise<Response>) {
  return async (c: Context) => {
    let ctx: RequestContext | undefined;
    try {
      const context = await services.context(c.req.raw);
      if (!context.ok) return respond(c, context);
      ctx = context.data;
      if (ctx.mode === 'unconfigured') return respond(c, failure('NOT_CONFIGURED', '工作区未连接，未执行远程动作。', 'configure_workspace'), ctx);
      if (!ctx.scopes.includes(scope)) return respond(c, failure('FORBIDDEN', '当前身份没有执行此动作的权限。', 'request_access'), ctx);
      return await handler(c, ctx);
    } catch {
      return respond(c, failure('INTERNAL', '请求未能确认完成，当前输入已保留。', 'check_record_before_retry', 'unknown'), ctx);
    }
  };
}

export async function readJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}
