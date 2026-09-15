import type { ApiError, ErrorCode, Result } from '../../contracts/api';

export function failure<T = never>(code: ErrorCode, message: string, nextAction = 'edit_and_retry', dataState: ApiError['dataState'] = 'not_written'): Result<T> {
  return { ok: false, error: { code, message, retryable: false, dataState, nextAction } };
}

export function success<T>(data: T): Result<T> {
  return { ok: true, data };
}
