import type { Context } from 'hono';
import type { z } from 'zod';
import type { ApiError, RequestContext, Result } from '../../contracts/api';
import { CONTRACT_VERSION } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { failure, publicResult } from './result';

const codes = { NOT_IMPLEMENTED: 501, NOT_CONFIGURED: 503, UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION: 422, CONFLICT: 409, UNKNOWN_RESULT: 409, UPSTREAM: 502, INTERNAL: 500 } as const;
export function respond<T>(c: Context, result: Result<T>, ctx?: RequestContext) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  const safe = publicResult(result);
  return c.json({ ...safe, meta: { requestId: ctx?.requestId ?? crypto.randomUUID(), mode: ctx?.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION } }, safe.ok ? 200 : codes[safe.error.code]);
}
export async function withContext<T>(c: Context, services: Services, run: (ctx: RequestContext) => Promise<Result<T>>, dataState: ApiError['dataState'] = 'not_written') {
  let ctx: RequestContext | undefined;
  try {
    const identity = await services.context(c.req.raw);
    if (!identity.ok) return respond(c, identity);
    ctx = identity.data;
    if (ctx.mode === 'unconfigured') return respond(c, failure('NOT_CONFIGURED', '尚未连接工作区；未执行远程动作。', 'configure_workspace'), ctx);
    return respond(c, await run(ctx), ctx);
  } catch {
    return respond(c, failure(dataState === 'unknown' ? 'UNKNOWN_RESULT' : 'UPSTREAM', dataState === 'unknown' ? '写入结果未知；请先读回核验。' : '请求未完成；当前页面内容仍保留。', dataState === 'unknown' ? 'read_back' : 'retry_read', dataState), ctx);
  }
}
export async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<Result<T>> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return failure('VALIDATION', '请求必须为JSON。');
  try {
    const reader = c.req.raw.body?.getReader();
    if (!reader) return failure('VALIDATION', '请求正文为空，请重新预览。');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 262144) { await reader.cancel(); return failure('VALIDATION', '本次内容超过256KiB，请缩小范围。'); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? { ok: true, data: parsed.data } : failure('VALIDATION', '请求字段或范围无效，请重新预览。');
  } catch { return failure('VALIDATION', '无法解析请求，请重新预览。'); }
}
