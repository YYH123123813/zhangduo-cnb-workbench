import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, FileSearch, RefreshCw, Save, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { TaskContext } from '../../contracts/domain';
import type { NavigationProps } from '../../contracts/navigation';
import { CaptureTaskFlow } from './task-storage';
import { taskDraftFromContext, taskForStorageAtState, type StoredTaskContext, type TaskDraft } from './task';

interface Props extends NavigationProps {
  draft: TaskDraft; original?: StoredTaskContext; workspaceId?: string; recoveryTaskId?: string; locked: boolean;
  onLock: (locked: boolean) => void; onRestore: (snapshot: StoredTaskContext) => void; onStored: (snapshot: StoredTaskContext) => void;
}
export function TaskPanel({ draft, original, workspaceId, recoveryTaskId, locked, onLock, onRestore, onStored, registerLeaveGuard }: Props) {
  const [flow] = useState(() => new CaptureTaskFlow(apiRequest));
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  const [preview, setPreview] = useState<TaskContext | null>(null), [consent, setConsent] = useState(false);
  const [lookupId, setLookupId] = useState(recoveryTaskId ?? ''), [message, setMessage] = useState('');
  const callbacks = useRef({ onLock, onRestore, onStored, draft, original }); callbacks.current = { onLock, onRestore, onStored, draft, original };
  const notified = useRef<string | null>(null);
  const blocked = flow.getLeaveState() === 'blocked';
  const busy = ['reading', 'saving', 'checking'].includes(state.phase);
  useEffect(() => { flow.activate(); return () => { flow.dispose(); callbacks.current.onLock(false); }; }, [flow]);
  useEffect(() => { callbacks.current.onLock(blocked); }, [blocked]);
  useEffect(() => registerLeaveGuard?.({ owner: 'capture', getState: flow.getLeaveState, onBlocked: () => setMessage('原任务保存仍需核验，请先核验原操作。') }), [flow, registerLeaveGuard]);
  useEffect(() => { setPreview(null); setConsent(false); }, [draft, original]);
  useEffect(() => {
    let mounted = true;
    if (recoveryTaskId) queueMicrotask(() => { if (mounted) { setPreview(null); setConsent(false); setLookupId(recoveryTaskId); void flow.load(recoveryTaskId, workspaceId); } });
    return () => { mounted = false; };
  }, [flow, recoveryTaskId, workspaceId]);
  useEffect(() => {
    if (state.receipt && state.remote?.task && state.remote.revision === state.receipt.revision && notified.current !== state.receipt.operationId) {
      notified.current = state.receipt.operationId; callbacks.current.onStored({ task: state.remote.task, revision: state.remote.revision }); setConsent(false); setPreview(null);
    }
  }, [state.receipt, state.remote]);
  async function prepare() {
    if (locked || blocked) return;
    setMessage(''); setPreview(null); setConsent(false);
    const input = draft;
    await flow.load(input.id, workspaceId);
    const remote = flow.getSnapshot().remote;
    if (!remote || callbacks.current.draft !== input || flow.getLeaveState() === 'blocked') return;
    const result = await taskForStorageAtState(input, remote, original);
    if (callbacks.current.draft !== input || callbacks.current.original !== original || flow.getSnapshot().remote !== remote || flow.getLeaveState() === 'blocked') return;
    if (result.ok) setPreview(result.data); else setMessage(result.error.message);
  }
  function restore() {
    const task = state.remote?.task;
    if (!task || locked || blocked) return;
    const checked = taskDraftFromContext(task);
    if (!checked.ok) { setMessage(checked.error.message); return; }
    callbacks.current.onRestore({ task, revision: state.remote!.revision }); setPreview(null); setConsent(false);
  }
  return <div className="capture-task-storage">
    <div className="capture-actions"><button type="button" disabled={locked || blocked || !draft.question.trim()} onClick={() => void prepare()}><FileSearch size={16} aria-hidden="true"/>核对任务保存范围</button>
      {(busy || blocked) && <button type="button" onClick={() => { flow.cancel(); setConsent(false); setPreview(null); }}><X size={16} aria-hidden="true"/>停止后续任务保存</button>}
      {state.pending && <button type="button" disabled={busy} onClick={() => { setMessage(''); void flow.readBack(); }}><RefreshCw size={16} aria-hidden="true"/>核验原任务保存</button>}
    </div>
    {preview && <><details open><summary>本次任务保存内容</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>
      <label className="capture-choice"><input type="checkbox" checked={consent} disabled={locked || blocked} onChange={(event) => setConsent(event.target.checked)}/>同意将本次完整任务私有保存30天；不随Issue归档，不进入Git或语义索引，到期不承诺物理抹除。</label>
      <button type="button" disabled={!consent || locked || blocked} onClick={() => { setMessage(''); void flow.save(preview, consent); }}><Save size={16} aria-hidden="true"/>确认保存任务</button>
    </>}
    <details><summary>恢复已保存任务</summary><label htmlFor="capture-task-recovery-id">原任务ID</label><input id="capture-task-recovery-id" maxLength={160} value={lookupId} disabled={locked || blocked} onChange={(event) => setLookupId(event.target.value)}/>
      <button type="button" disabled={locked || blocked || !lookupId.trim()} onClick={() => { setPreview(null); setConsent(false); setMessage(''); void flow.load(lookupId.trim(), workspaceId); }}><RefreshCw size={16} aria-hidden="true"/>读取原任务</button>
      {state.remote?.task && <><pre>{JSON.stringify(state.remote.task, null, 2)}</pre><button type="button" disabled={locked || blocked} onClick={restore}><Download size={16} aria-hidden="true"/>使用已存任务</button></>}
    </details>
    {state.remote && <p>任务ID：<code>{state.remote.id}</code> · 保存版本：{state.remote.revision} · 私有保留30天</p>}
    {state.pending && <p>原任务保存操作ID：<code>{state.pending.request.operationId}</code></p>}
    {(message || state.message) && <p role="status" className="capture-notice">{message || state.message}</p>}
  </div>;
}
