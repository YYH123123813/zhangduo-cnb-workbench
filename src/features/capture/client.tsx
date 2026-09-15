import { useEffect, useRef, useState } from 'react';
import { MessageSquareText, RotateCcw, RefreshCw } from 'lucide-react';
import { initialTaskDraft, taskDraftFromContext, taskForStorage, type StoredTaskContext, type TaskDraft } from './task';
import type { SourceDraft } from './parse';
import { SourcePicker } from './source-picker';
import { ScopeEditor } from './scope-editor';
import { Id, type Conversation, type TaskContext } from '../../contracts/domain';
import { PrivacyEditor } from './privacy-editor';
import { SavePanel } from './save-panel';
import { CaptureRecord } from './record';
import { apiRequest } from '../../app/api-client';
import type { CaptureStatus } from './status';
import { checkSavedReceipt } from './readback';
import type { NavigationProps } from '../../contracts/navigation';
import { TaskPanel } from './task-panel';
import './capture.css';

export interface PageProps extends NavigationProps { routeParams?: Readonly<Record<string, string>> }
export function Page({ routeParams = {}, registerLeaveGuard }: PageProps = {}) {
  const [task, setTask] = useState(() => initialTaskDraft());
  const [source, setSource] = useState<SourceDraft | null>(null);
  const [selected, setSelected] = useState<Conversation['segments']>([]);
  const [prepared, setPrepared] = useState<Conversation['segments'] | null>(null);
  const [version, setVersion] = useState(0);
  const [saveLocked, setSaveLocked] = useState(false);
  const [modelLocked, setModelLocked] = useState(false);
  const [taskLocked, setTaskLocked] = useState(false);
  const [originalTask, setOriginalTask] = useState<StoredTaskContext | undefined>();
  const locked = saveLocked || modelLocked || taskLocked;
  const draftDirty = useRef(false);
  const [saved, setSaved] = useState<Conversation | null>(null);
  const [savedTask, setSavedTask] = useState<TaskContext | undefined>();
  const [allowInitialExtraction, setAllowInitialExtraction] = useState(false);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [mode, setMode] = useState('unconfigured');
  const [connection, setConnection] = useState('工作区状态待检查；本地文本尚未上传。');
  const [recoveryId, setRecoveryId] = useState(routeParams.conversationId ?? '');
  const [recovering, setRecovering] = useState(false);
  const recoveryRequest = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState('草稿仅在当前页面；尚未保存或发送模型。');
  function invalidate() { setPrepared(null); setVersion((v) => v + 1); }
  function editTask(next: TaskDraft) { draftDirty.current = true; setTask(next); invalidate(); }
  useEffect(() => registerLeaveGuard?.({ owner: 'capture', getState: () => draftDirty.current ? 'dirty' : 'clean' }), [registerLeaveGuard]);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<CaptureStatus>('/api/capture/status', { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setMode(result.meta.mode);
      if (result.ok) { setStatus(result.data); setConnection(`${result.data.workspace.slug} · ${result.data.workspace.visibility === 'private' ? '私有工作区' : '公开工作区，保存需重新核对权限'}`); }
      else setConnection(result.error.message);
    }).catch(() => { if (!controller.signal.aborted) setConnection('工作区状态读取失败；可以保留本地文本，未执行远程动作。'); });
    return () => controller.abort();
  }, []);
  async function recover(id: string) {
    if (locked) { setNotice('当前原批准或操作仍需核验；不能切换现场。'); return; }
    recoveryRequest.current?.abort(); recoveryRequest.current = null;
    setRecovering(false); setSaved(null); setSavedTask(undefined);
    setAllowInitialExtraction(false);
    if (!Id.safeParse(id).success) { setNotice('请输入有效现场ID。'); return; }
    const controller = new AbortController(); recoveryRequest.current = controller; setRecovering(true);
    try {
      const result = await apiRequest<Conversation>(`/api/capture/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (recoveryRequest.current !== controller) return;
      setMode(result.meta.mode);
      if (!result.ok) { setNotice(result.error.message); return; }
      const parsed = await checkSavedReceipt(result.data, { id, workspaceId: status?.workspace.id }, controller.signal);
      if (recoveryRequest.current !== controller || controller.signal.aborted) return;
      if (!parsed.ok) { setNotice(parsed.error.message); return; }
      setSaved(parsed.data); setSavedTask(undefined); setAllowInitialExtraction(false); setNotice('现场已读回；原文已在CNB保存。');
    } catch { if (recoveryRequest.current === controller) setNotice('恢复读取未完成；没有重新创建现场。'); }
    finally { if (recoveryRequest.current === controller) { recoveryRequest.current = null; setRecovering(false); } }
  }
  useEffect(() => {
    setRecovering(false);
    if (routeParams.conversationId) {
      setRecoveryId(routeParams.conversationId);
      if (locked) setNotice('当前保存仍需核验；完成后可按所选ID读取另一现场。');
      else void recover(routeParams.conversationId);
    } else { setSaved(null); setSavedTask(undefined); }
    return () => { recoveryRequest.current?.abort(); recoveryRequest.current = null; };
  }, [routeParams.conversationId]);
  return <div className="capture">
    <header className="capture-heading"><h1><MessageSquareText size={24} aria-hidden="true"/>对话捕获</h1>
      <button type="button" disabled={locked} className="capture-icon" title="清空当前草稿" aria-label="清空当前草稿" onClick={() => { if (draftDirty.current && !window.confirm('清空尚未保存的任务、原文和编辑？已保存现场不会删除。')) return; editTask(initialTaskDraft()); setOriginalTask(undefined); draftDirty.current = false; setSource(null); setSelected([]); setNotice('已清空本地草稿；不会删除已保存现场或任务。'); }}><RotateCcw size={18}/></button>
    </header>
    <p className="capture-connection">{mode === 'fixture' ? 'Fixture测试模式，非真实CNB' : mode === 'live' ? 'Live工作区，确认后会产生真实副作用' : '未配置工作区'} · {connection}</p>
    <p className="capture-notice" role="status">{notice}</p>
    <section aria-labelledby="capture-task-title" className="capture-section">
      <h2 id="capture-task-title">当前任务</h2>
      <fieldset disabled={locked} className="capture-editor" aria-label="编辑当前任务">
      <label htmlFor="capture-question">当前问题</label>
      <textarea id="capture-question" rows={3} maxLength={4000} value={task.question} onChange={(e) => editTask({ ...task, question: e.target.value })}/>
      <label htmlFor="capture-constraints">约束（可选，最多5行）</label>
      <textarea id="capture-constraints" rows={2} maxLength={5000} value={task.constraints.map((item) => item.text).join('\n')} onChange={(e) => editTask({ ...task, constraints: e.target.value.split('\n').map((text, i) => ({ id: task.constraints[i]?.id ?? crypto.randomUUID(), text })) })}/>
      <fieldset><legend>处理目的</legend>
        <label className="capture-choice"><input type="radio" name="capture-intent" checked={task.intent === 'archive'} onChange={() => editTask({ ...task, intent: 'archive' })}/>只归档</label>
        <label className="capture-choice"><input type="radio" name="capture-intent" checked={task.intent === 'propose'} onChange={() => editTask({ ...task, intent: 'propose' })}/>归档后提取AI候选</label>
      </fieldset>
      </fieldset>
      <TaskPanel key={task.id} draft={task} original={originalTask} workspaceId={status?.workspace.id} recoveryTaskId={routeParams.taskId ?? saved?.taskId} locked={saveLocked || modelLocked} onLock={setTaskLocked} registerLeaveGuard={registerLeaveGuard}
        onRestore={(snapshot) => {
          if (locked || (draftDirty.current && !window.confirm('用已保存的原任务替换当前问题和约束？未选来源不会保存。'))) return;
          const value = snapshot.task;
          const restored = taskDraftFromContext(value); if (!restored.ok) { setNotice(restored.error.message); return; }
          setOriginalTask(snapshot); editTask(restored.data); if (saved?.taskId === value.id) setSavedTask(value);
          setNotice('原任务完整上下文已恢复；未发送模型或重新登记批准。');
        }} onStored={(snapshot) => { if (snapshot.task.id === task.id) { setOriginalTask(snapshot); if (saved?.taskId === snapshot.task.id) setSavedTask(snapshot.task); } }}/>
    </section>
    <fieldset disabled={locked} aria-label="编辑捕获范围" className="capture-editor">
    <SourcePicker key={task.id} onDirty={() => { draftDirty.current = true; }} onSelect={(value) => { if (value) draftDirty.current = true; setSource(value); setSelected([]); invalidate(); }}/>
    {source && <ScopeEditor key={source.id} source={source} onChange={(value) => { setSelected(value); invalidate(); }}/>}
    {selected.length > 0 && <PrivacyEditor key={`${version}:${task.intent}`} segments={selected} alreadySaved={source?.sourceAlreadyPersisted ?? false} intent={task.intent} onReady={setPrepared}/>}
    </fieldset>
    {prepared && source && <SavePanel key={version} task={task} source={source} segments={prepared} registerLeaveGuard={registerLeaveGuard} onLock={setSaveLocked} onSaved={(value, currentTask) => {
      const fullTask = taskForStorage(task, currentTask.workspaceId, originalTask?.task ?? currentTask, currentTask.updatedAt);
      setSaved(value); setSavedTask(fullTask.ok ? fullTask.data : currentTask); setAllowInitialExtraction(true);
      setNotice('现场已保存；任务只在单独确认30天保存后持久化，未选原文未随现场保存。');
    }}/>}
    <details className="capture-recovery"><summary>恢复已保存现场</summary><label htmlFor="capture-recovery-id">现场ID</label><input id="capture-recovery-id" maxLength={160} value={recoveryId} disabled={locked || recovering} onChange={(e) => setRecoveryId(e.target.value)}/><button type="button" disabled={locked || recovering || !recoveryId.trim()} onClick={() => void recover(recoveryId.trim())}><RefreshCw size={16} aria-hidden="true"/>读回现场</button></details>
    {saved && <CaptureRecord key={`${saved.id}:${saved.contentHash}:${routeParams.approvalId ?? ''}`} conversation={saved} task={savedTask} status={status} allowInitialExtraction={allowInitialExtraction} recoveryApprovalId={routeParams.approvalId} registerLeaveGuard={registerLeaveGuard} onLock={setModelLocked}/>}
  </div>;
}
