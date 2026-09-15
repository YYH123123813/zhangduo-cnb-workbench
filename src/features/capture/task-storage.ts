import type { ApiResponse } from '../../contracts/api';
import { Id, type TaskContext } from '../../contracts/domain';
import { contentHash } from '../../contracts/hash';
import { WorkspaceSessionSchema } from '../../contracts/session';
import { TaskReceiptSchema, TaskSaveRequestSchema, TaskStateSchema, type TaskReceipt, type TaskSaveRequest, type TaskState } from '../../contracts/task-record';
import type { LeaveGuard } from '../../contracts/navigation';

type Transport = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
interface PendingTask { request: TaskSaveRequest; actorId: string; requestHash: string; contentHash: string }
interface TaskFlowState {
  phase: 'idle' | 'reading' | 'ready' | 'saving' | 'checking' | 'saved' | 'unknown' | 'failed';
  remote: TaskState | null; pending: PendingTask | null; receipt: TaskReceipt | null; message: string;
}
export class CaptureTaskFlow {
  private state: TaskFlowState = { phase: 'idle', remote: null, pending: null, receipt: null, message: '' };
  private listeners = new Set<() => void>();
  private current: AbortController | null = null;
  private alive = true;
  constructor(private request: Transport) {}
  getSnapshot = () => this.state;
  getLeaveState: LeaveGuard['getState'] = () => this.current || (this.state.pending && !this.state.receipt) ? 'blocked' : 'clean';
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate() { this.alive = true; }
  dispose() { this.cancel(); this.alive = false; }
  private update(change: Partial<TaskFlowState>) { if (this.alive) { this.state = { ...this.state, ...change }; this.listeners.forEach((listener) => listener()); } }
  private owns(controller: AbortController) { return this.alive && this.current === controller && !controller.signal.aborted; }
  private finish(controller: AbortController) { if (this.current === controller) { this.current = null; this.update({}); } }
  private async session(signal: AbortSignal) {
    const result = await this.request('/api/workspace/session', { signal });
    if (!result.ok) throw Error('原任务身份或读取权限未核验。');
    const session = WorkspaceSessionSchema.parse(result.data);
    if (session.workspace.mode === 'unconfigured' || session.workspace.visibility !== 'private' || !session.scopes.includes('task:read')) throw Error('需要原私有工作区的任务读取权限。');
    return session;
  }
  private async readState(id: string, workspaceId: string, actorId: string, signal: AbortSignal): Promise<TaskState> {
    const result = await this.request(`/api/workspace/tasks/${encodeURIComponent(id)}`, { signal });
    if (!result.ok) throw Error('原任务读取被拒绝或尚未核验。');
    const remote = TaskStateSchema.parse(result.data);
    if (remote.id !== id || remote.workspaceId !== workspaceId || remote.actorId !== actorId
      || (remote.task && (await contentHash(remote.task) !== remote.contentHash || Date.parse(remote.expiresAt!) <= Date.now()))) throw Error('原任务身份、版本或完整内容摘要不一致。');
    return remote;
  }
  async load(id: string, workspaceId?: string) {
    if (!this.alive || this.getLeaveState() === 'blocked') return;
    if (!Id.safeParse(id).success) { this.update({ phase: 'failed', remote: null, message: '原任务ID无效。' }); return; }
    const controller = new AbortController(); this.current = controller;
    this.update({ phase: 'reading', remote: null, pending: null, receipt: null, message: '正在读取原任务版本；未保存。' });
    try {
      const session = await this.session(controller.signal);
      if (!this.owns(controller)) return;
      if (workspaceId && session.workspace.id !== workspaceId) throw Error('原工作区已改变。');
      const remote = await this.readState(id, session.workspace.id, session.actorId, controller.signal);
      if (this.owns(controller)) this.update({ phase: 'ready', remote, message: remote.state === 'available' ? '已读取原任务及保存版本。' : remote.state === 'expired' ? '原任务已过期，正文不再提供；没有重建旧任务。' : '未发现已存任务；这不能证明其他在途保存未执行。' });
    } catch { if (this.owns(controller)) this.update({ phase: 'failed', remote: null, message: '原任务身份、权限或保存状态未核验；没有恢复旧正文。' }); }
    finally { this.finish(controller); }
  }
  async save(task: TaskContext, confirmed: boolean) {
    const remote = this.state.remote;
    if (!this.alive || this.getLeaveState() === 'blocked' || !confirmed || !remote || remote.state === 'expired' || task.id !== remote.id || task.workspaceId !== remote.workspaceId) return;
    const controller = new AbortController(); this.current = controller;
    this.update({ phase: 'saving', pending: null, receipt: null, message: '正在核对独立任务保存授权。' });
    try {
      const session = await this.session(controller.signal);
      if (!this.owns(controller)) return;
      if (session.actorId !== remote.actorId || session.workspace.id !== remote.workspaceId || !session.scopes.includes('task:write')) throw Error('原任务写入身份已改变。');
      const request = TaskSaveRequestSchema.parse(JSON.parse(JSON.stringify({ operationId: crypto.randomUUID(), task, expectedRevision: remote.revision, expectedContentHash: remote.contentHash, retentionDays: 30, confirmed: true })));
      const pending = { request, actorId: remote.actorId, requestHash: await contentHash(request), contentHash: await contentHash(request.task) };
      if (!this.owns(controller)) return;
      this.update({ pending, message: '正在保存已确认任务，范围已锁定。' });
      const result = await this.request('/api/workspace/tasks', { method: 'POST', body: JSON.stringify(request) });
      if (!this.owns(controller)) return;
      if (!result.ok) {
        const refused = result.error.dataState === 'not_written' || (result.error.code === 'CONFLICT' && result.error.dataState === 'preserved');
        this.update({ phase: refused ? 'failed' : 'unknown', remote: null, ...(refused ? { pending: null } : {}), message: refused ? '任务保存被拒绝或版本冲突；请先读取原任务版本。' : '任务保存结果未知；请只读核验原操作。' }); return;
      }
      const returned = TaskStateSchema.parse(result.data);
      if (returned.id !== task.id || returned.actorId !== pending.actorId || returned.workspaceId !== task.workspaceId || returned.revision !== request.expectedRevision + 1 || returned.contentHash !== pending.contentHash || !returned.task || await contentHash(returned.task) !== pending.contentHash) throw Error('Unverified task save response');
      await this.verify(pending, controller);
    } catch { if (this.owns(controller)) this.update({ phase: this.state.pending ? 'unknown' : 'failed', remote: null, message: this.state.pending ? '任务保存结果未知；保留原操作，不重复保存。' : '任务写入权限或保存范围未核验；没有发送保存请求。' }); }
    finally { this.finish(controller); }
  }
  private async verify(pending: PendingTask, controller: AbortController) {
    const request = pending.request;
    const result = await this.request(`/api/workspace/task-receipts/${encodeURIComponent(request.operationId)}`, { signal: controller.signal });
    if (!result.ok) throw Error('Task receipt unavailable');
    const receipt = TaskReceiptSchema.parse(result.data);
    if (receipt.operationId !== request.operationId || receipt.taskId !== request.task.id || receipt.actorId !== pending.actorId || receipt.workspaceId !== request.task.workspaceId
      || receipt.requestHash !== pending.requestHash || receipt.contentHash !== pending.contentHash || receipt.previousRevision !== request.expectedRevision) throw Error('Original task receipt mismatch');
    if (!this.owns(controller)) return;
    const remote = await this.readState(request.task.id, request.task.workspaceId, pending.actorId, controller.signal);
    if (remote.revision < receipt.revision || (remote.revision === receipt.revision && remote.contentHash !== receipt.contentHash)) throw Error('Task revision not verified');
    if (this.owns(controller)) this.update({ phase: 'saved', receipt, remote, message: remote.revision === receipt.revision ? '原任务保存已核验，私有保留30天。' : '原任务保存回执已核验；当前版本已推进或过期，没有用旧任务覆盖它。' });
  }
  async readBack() {
    const pending = this.state.pending;
    if (!this.alive || this.current || !pending) return;
    const controller = new AbortController(); this.current = controller;
    this.update({ phase: 'checking', remote: null, receipt: null, message: '正在只读核验原任务保存。' });
    try { await this.verify(pending, controller); }
    catch { if (this.owns(controller)) this.update({ phase: 'unknown', message: '原任务回执或当前版本未核验；不会按相同内容认领其他操作。' }); }
    finally { this.finish(controller); }
  }
  cancel() {
    this.current?.abort(); this.current = null;
    const pending = this.state.pending && !this.state.receipt;
    this.update({ phase: pending ? 'unknown' : this.state.receipt ? 'saved' : 'idle', message: pending ? '已停止等待；已发出的任务保存仍需核验原操作。' : '已停止后续任务保存。' });
  }
}
