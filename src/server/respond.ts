import type { Context } from 'hono';
import { CONTRACT_VERSION } from '../contracts/domain';
import type { ErrorCode, RequestContext, Result } from '../contracts/api';
import { SESSION_BINDING_HEADER } from '../contracts/session';

const statusByError: Record<ErrorCode, 401 | 403 | 409 | 422 | 500 | 501 | 502 | 503> = {
  NOT_IMPLEMENTED: 501, NOT_CONFIGURED: 503, UNAUTHORIZED: 401, FORBIDDEN: 403,
  VALIDATION: 422, CONFLICT: 409, UNKNOWN_RESULT: 409, UPSTREAM: 502, INTERNAL: 500,
};

export function respond<T>(c: Context, result: Result<T>, ctx?: RequestContext) {
  const binding = c.req.header(SESSION_BINDING_HEADER);
  if (ctx && binding) c.header(SESSION_BINDING_HEADER, binding);
  return c.json({ ...result, meta: { requestId: ctx?.requestId ?? crypto.randomUUID(), mode: ctx?.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION } }, result.ok ? 200 : statusByError[result.error.code]);
}

export function notImplemented(c: Context, feature: string) {
  return c.json({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: `${feature}: implementation pending`, retryable: false, dataState: 'not_written', nextAction: 'implement_assigned_module' },
    meta: { requestId: crypto.randomUUID(), mode: 'unconfigured', contractVersion: CONTRACT_VERSION },
  }, 501);
}
