import type { ApiError, Result } from '../../contracts/api';

const localErrors = new WeakSet<ApiError>();
const messages: Record<ApiError['code'], string> = {
  NOT_IMPLEMENTED: '所需平台能力尚未实现。', NOT_CONFIGURED: '所需工作区或平台能力尚未配置。',
  UNAUTHORIZED: '尚未取得可信身份，请重新登录。', FORBIDDEN: '当前权限或批准不允许此操作。',
  VALIDATION: '平台未接受当前字段或范围，请重新预览。', CONFLICT: '内容、批准或来源版本不一致，请重新核对。',
  UNKNOWN_RESULT: '操作结果未知，请先读回核验，不要直接重试。', UPSTREAM: '平台请求未完成，请保留当前内容并核验状态。', INTERNAL: '请求未完成，请保留当前内容并核验状态。',
};
const actions = new Set(['configure_workspace', 'check_permissions', 'preview_again', 'read_back', 'read_candidates', 'read_model_operation', 'read_approval_state', 'continue_manually', 'approve_again', 'configure_approval_service', 'configure_operation_store']);

export function failure<T = never>(code: ApiError['code'], message: string, nextAction = 'edit_preview', dataState: ApiError['dataState'] = 'not_written'): Result<T> {
  const error: ApiError = { code, message, retryable: false, dataState, nextAction };
  localErrors.add(error);
  return { ok: false, error };
}

// Only messages constructed inside this module can carry field-level details to the browser.
export function publicResult<T>(result: Result<T>): Result<T> {
  if (result.ok || localErrors.has(result.error)) return result;
  const code = Object.hasOwn(messages, result.error.code) ? result.error.code : 'UPSTREAM';
  const dataState = ['not_written', 'preserved', 'partial', 'unknown'].includes(result.error.dataState) ? result.error.dataState : 'unknown';
  const nextAction = actions.has(result.error.nextAction) ? result.error.nextAction : dataState === 'unknown' ? 'read_back' : 'preview_again';
  return failure(code, messages[code], nextAction, dataState);
}
