import type { Mode } from './domain';
import type { z } from 'zod';

export type ErrorCode = 'NOT_IMPLEMENTED' | 'NOT_CONFIGURED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'VALIDATION' | 'CONFLICT' | 'UNKNOWN_RESULT' | 'UPSTREAM' | 'INTERNAL';
export interface ApiError {
  code: ErrorCode; message: string; retryable: boolean;
  dataState: 'not_written' | 'preserved' | 'partial' | 'unknown'; nextAction: string;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export type ApiResponse<T> = Result<T> & { meta: { requestId: string; mode: z.infer<typeof Mode>; contractVersion: string } };
export interface RequestContext {
  requestId: string; actorId: string; workspaceId: string;
  mode: z.infer<typeof Mode>; scopes: readonly string[];
}
export function unavailable<T>(message = 'CNB workspace is not configured'): Result<T> {
  return { ok: false, error: { code: 'NOT_CONFIGURED', message, retryable: false, dataState: 'not_written', nextAction: 'configure_workspace' } };
}
