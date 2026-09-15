import type { ApiResponse } from '../contracts/api';
import type { AppRoute } from '../contracts/navigation';
import { WorkspaceSessionSchema, type WorkspaceSession } from '../contracts/session';
import { parseRoute } from './routing';

export interface SessionState { hash: string; value: WorkspaceSession | null; message: string; verified: boolean }
export function canRenderPage(state: SessionState, hash: string, page: AppRoute['page']): boolean {
  if (state.hash === hash) return true;
  return state.verified && Boolean(state.hash) && parseRoute(state.hash).page === page;
}
export function settleSession(previous: SessionState, hash: string, response: ApiResponse<unknown> | null): SessionState {
  if (response?.ok) {
    const checked = WorkspaceSessionSchema.safeParse(response.data);
    if (!checked.success || checked.data.workspace.mode === 'unconfigured' || checked.data.workspace.mode !== response.meta.mode) return { hash, value: null, verified: false, message: '工作区身份未能核验' };
    return { hash, value: checked.data, verified: true, message: checked.data.workspace.visibility === 'private' ? '私有工作区' : '公开工作区' };
  }
  const code = response && !response.ok ? response.error.code : null;
  if (code === 'NOT_CONFIGURED') return { hash, value: null, verified: false, message: 'CNB 未配置' };
  if (code && ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION'].includes(code)) return { hash, value: null, verified: false, message: '工作区会话已失效' };
  return { hash, value: previous.hash === hash ? previous.value : null, verified: false, message: '暂时无法核对工作区，当前输入保留' };
}
