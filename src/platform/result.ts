import type { ErrorCode, Result, ApiError } from '../contracts/api';

export function failure<T>(code: ErrorCode, message: string, nextAction: string, dataState: ApiError['dataState'] = 'not_written', retryable = false): Result<T> {
  return { ok: false, error: { code, message, nextAction, dataState, retryable } };
}
