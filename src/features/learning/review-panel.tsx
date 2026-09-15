import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, CalendarClock, Play, Plus, RefreshCw, Save, SkipForward, Trash2 } from 'lucide-react';
import type { TaskContext, VersionRef } from '../../contracts/domain';
import type { TaskSaveRequest, TaskState } from '../../contracts/task-record';
import { canonicalJson } from '../../contracts/hash';
import { apiRequest } from '../../app/api-client';
import { createQueue, selectQueueItem, updateQueue, type QueueItem, type ReviewQueueAction } from './queue';
import { AttemptPanel } from './attempt-panel';
import { AppealPanel, FeedbackPanel } from './feedback-panel';
import type { AttemptResponse, ReviewCatalogResponse, ReviewRequest } from './review-api';
import type { PublicReviewQuestion } from './question';
import { taskHref } from './links';
import { AttemptRequestGate } from './attempt-request';
import { failure } from './errors';
import type { NavigationProps } from '../../contracts/navigation';
import { useLearningLeaveGuard } from './leave-guard';
import { ensureReviewTask, readReviewTaskOperation, readReviewTaskState } from './review-task';
import { TaskConditionDetails } from './evidence-details';
import { RecoveryConsent, useRecoveryConsent } from './recovery-consent';
import { reviewRecoveryInput, taskRecoveryInput } from './recovery-anchor';

export function ReviewPanel({ actorId, workspaceId, taskId, task, nodeRef, title, registerLeaveGuard, retainOperationRecovery }: { actorId: string; workspaceId: string; taskId: string; task?: TaskContext; nodeRef?: VersionRef; title?: string } & NavigationProps) {
  const taskRecovery = useRecoveryConsent(retainOperationRecovery, { actorId, workspaceId });
  const reviewRecovery = useRecoveryConsent(retainOperationRecovery, { actorId, workspaceId });
  const [queue, setQueue] = useState(() => createQueue(workspaceId));
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeItem, setActiveItem] = useState<QueueItem | null>(null);
  const [questions, setQuestions] = useState<PublicReviewQuestion[]>([]);
  const [attempt, setAttempt] = useState<AttemptResponse | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(true);
  const [reviewConsent, setReviewConsent] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskConsent, setTaskConsent] = useState(false);
  const [taskState, setTaskState] = useState<TaskState | null>(null);
  const [taskRecoveryId, setTaskRecoveryId] = useState<string | null>(null);
  const [gate] = useState(() => new AttemptRequestGate({ requireReceipt: true }));
  const pendingTask = useRef<TaskSaveRequest | null>(null);
  const request = useRef<AbortController | null>(null);
  const queueState = useRef(queue);
  useLearningLeaveGuard(registerLeaveGuard, () => gate.blocked || pendingTask.current || request.current ? 'blocked'
    : queueState.current.items.length || (attempt && attempt.view.phase !== 'cancelled') ? 'dirty' : 'clean',
  () => setNotice('原作答操作尚未核验；请等待请求结束或读回同一操作，离开不会将其视为已取消。'));
  useEffect(() => () => { gate.interrupt(); request.current?.abort(); }, [gate]);
  const taskKey = canonicalJson({ actorId, workspaceId, taskId, task: task ?? null });
  useEffect(() => { setTaskConsent(false); setReviewConsent(false); setTaskState(null); }, [taskKey]);
  const readyTask = taskState?.state === 'available' && taskState.id === taskId && taskState.task
    && taskState.expiresAt && Date.parse(taskState.expiresAt) > Date.now()
    && (!task || canonicalJson(taskState.task) === canonicalJson(task)) ? taskState.task : null;
  const pendingTaskChange = (value: TaskSaveRequest | null) => { pendingTask.current = value; setTaskRecoveryId(value?.operationId ?? null); };
  const taskAction = async (save: boolean) => {
    if (request.current || gate.blocked || pendingTask.current || actorId === 'unconfigured') return;
    if (save && (!task || !taskConsent)) { setNotice('请先恢复原任务并单独确认任务保存范围。'); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setTaskSaving(save); setTaskState(null); setReviewConsent(false); setQuestions([]); setActiveItem(null); setNotice('');
    const transport = (path: string, init?: RequestInit) => apiRequest<unknown>(path, { ...init, signal: controller.signal });
    try {
      if (save && task) {
        const saved = await ensureReviewTask(transport, { actorId, workspaceId }, task, crypto.randomUUID(), {
          confirmed: taskConsent, onPending: pendingTaskChange,
          beforeSave: (original) => taskRecovery.before((expiry) => taskRecoveryInput(original, expiry)),
        });
        if (controller.signal.aborted) return;
        if (saved.ok) { setTaskState(saved.data.state); pendingTaskChange(null); setNotice(saved.data.receipt ? '原任务保存及原回执已核验。' : '已读取内容一致的原任务，未新增保存操作。'); }
        else {
          if (saved.error.dataState === 'not_written' && !['CONFLICT', 'UNKNOWN_RESULT'].includes(saved.error.code)) pendingTaskChange(null);
          setNotice(saved.error.message);
        }
      } else {
        const loaded = await readReviewTaskState(transport, { actorId, workspaceId }, taskId, task);
        if (controller.signal.aborted) return;
        if (loaded.ok) { setTaskState(loaded.data); setNotice(loaded.data.state === 'available' ? '已只读恢复原任务，未新增保存操作。' : '原任务缺失或已过期，未启动作答。'); }
        else setNotice(loaded.error.message);
      }
    } finally { if (request.current === controller) { request.current = null; setTaskSaving(false); setBusy(false); } }
  };
  const loadQuestions = async (item: QueueItem) => {
    if (gate.blocked || pendingTask.current || request.current) { setNotice('请先核验原任务或作答操作，再读取其他题目。'); return; }
    if (!readyTask || readyTask.id !== item.taskId) { setNotice('请先明确保存或只读恢复原任务。'); return; }
    const selected = selectQueueItem(queueState.current, item.id, new Date().toISOString());
    if (!selected.ok) { setNotice(selected.error.message); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setNotice(''); setActiveItem(item); setQuestions([]); setAttempt(null); setReviewConsent(false);
    try {
      const result = await apiRequest<ReviewCatalogResponse>(`/api/learning/reviews?${new URLSearchParams({ nodeId: item.nodeRef.objectId, revision: item.nodeRef.revision })}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        if (result.data.questions.some((question) => question.nodeRef.workspaceId !== item.nodeRef.workspaceId
          || question.nodeRef.objectId !== item.nodeRef.objectId || question.nodeRef.revision !== item.nodeRef.revision)) setNotice('审核题与所选知识版本不一致，未展示题目。');
        else { setQuestions(result.data.questions); if (!result.data.questions.length) setNotice('当前知识版本没有可用审核题，未启动作答。'); }
      } else setNotice(result.error.message);
    } catch { if (!controller.signal.aborted) setNotice('审核题读取失败，未启动作答。'); }
    finally { if (request.current === controller) { setBusy(false); request.current = null; } }
  };
  const send = async (payload: ReviewRequest) => {
    if (busy || uncertain || pendingTask.current || request.current) return;
    if (payload.action === 'start') {
      const selected = selectQueueItem(queueState.current, activeItem?.id ?? '', new Date().toISOString());
      if (!selected.ok) { setNotice(selected.error.message); return; }
      if (selected.data.taskId !== payload.taskId || selected.data.nodeRef.objectId !== payload.nodeRef.objectId
        || selected.data.nodeRef.revision !== payload.nodeRef.revision || payload.nodeRef.workspaceId !== workspaceId) {
        setNotice('题目入口与当前回顾项不一致，未启动作答。'); return;
      }
      if (!readyTask || readyTask.id !== payload.taskId || !taskState?.contentHash || !reviewConsent) { setNotice('原任务尚未就绪，或未独立确认本次作答保存范围。'); return; }
      if (payload.taskRevision !== taskState.revision || payload.taskContentHash !== taskState.contentHash) {
        setNotice('作答请求与已确认原任务的版本不一致，未启动作答。'); return;
      }
    }
    const pending = await gate.beginTrusted(payload);
    if (!pending.ok) { setNotice(pending.error.message); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setNotice('');
    try {
      const retained = await reviewRecovery.before((expiry) => reviewRecoveryInput(payload, expiry));
      if (!retained.ok || controller.signal.aborted) {
        gate.reject(pending.data, failure('FORBIDDEN', '本次业务作答未发送；恢复身份须另行核验。'));
        if (!controller.signal.aborted) setNotice(retained.ok ? '原页面已卸载，未发送作答。' : retained.error.message);
        return;
      }
      const result = await apiRequest<AttemptResponse>('/api/learning/attempts', { method: 'POST', body: JSON.stringify(payload), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        const accepted = gate.accept(pending.data, result.data);
        if (accepted.ok) { setAttempt(accepted.data); setFeedbackOpen(true); }
        else setNotice(accepted.error.message);
      }
      else {
        gate.reject(pending.data, result);
        setNotice(`${result.error.message} ${result.error.dataState === 'unknown' ? '结果未知，需要读回原会话。' : '当前作答未丢弃。'}`);
      }
      setUncertain(gate.needsReadBack);
    } catch {
      if (!controller.signal.aborted) {
        gate.reject(pending.data, failure('UNKNOWN_RESULT', '作答请求结果未知。', 'read_back', 'unknown'));
        setUncertain(gate.needsReadBack); setNotice('作答请求结果未知；保留本次输入，请读回原会话后继续。');
      }
    }
    finally { if (request.current === controller) { setBusy(false); request.current = null; } }
  };
  const startQuestion = (question: PublicReviewQuestion) => {
    if (!activeItem || !taskState?.contentHash) return;
    void send({ action: 'start', operationId: crypto.randomUUID(), taskId: activeItem.taskId,
      taskRevision: taskState.revision, taskContentHash: taskState.contentHash, nodeRef: activeItem.nodeRef,
      questionId: question.id, questionRevision: question.revision, retentionDays: 30, confirmed: true });
  };
  const readTaskBack = async () => {
    const original = pendingTask.current;
    if (!original || request.current || busy) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setNotice('');
    try {
      const result = await readReviewTaskOperation((path, init) => apiRequest(path, { ...init, signal: controller.signal }), { actorId, workspaceId }, original);
      if (controller.signal.aborted) return;
      if (result.ok) { setTaskState(result.data.state); pendingTaskChange(null); setNotice('原任务保存已按原操作只读核验；尚未启动作答。'); }
      else setNotice(result.error.message);
    } catch {
      if (!controller.signal.aborted) setNotice('原任务保存仍未核验；没有重新发送保存请求。');
    } finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  };
  const readBack = async () => {
    const id = gate.recoveryOperationId;
    const requestHash = gate.recoveryRequestHash;
    if (!id || !requestHash || busy) return;
    const pending = gate.beginReadBack();
    if (!pending.ok) { setNotice(pending.error.message); return; }
    const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const result = await apiRequest<AttemptResponse>(`/api/learning/attempts/${encodeURIComponent(id)}?${new URLSearchParams({ requestHash })}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        const accepted = gate.accept(pending.data, result.data);
        if (accepted.ok) { setAttempt(accepted.data); setNotice('已读回本次作答状态。'); }
        else setNotice(accepted.error.message);
      } else { gate.reject(pending.data, result); setNotice(result.error.message); }
      setUncertain(gate.needsReadBack);
    } catch {
      if (!controller.signal.aborted) {
        gate.reject(pending.data, failure('UNKNOWN_RESULT', '仍未确认本次作答状态。', 'read_back', 'unknown'));
        setUncertain(gate.needsReadBack); setNotice('仍未确认本次作答状态，没有重复发送原操作。');
      }
    }
    finally { if (request.current === controller) { setBusy(false); request.current = null; } }
  };
  const returnToQueue = () => {
    if (!attempt || busy || gate.blocked) return;
    if (attempt.feedback && feedbackOpen && !window.confirm('返回队列会关闭本次评阅，尚未确认的修改不会保存。是否继续？')) return;
    const released = gate.releaseView(attempt.view.id);
    if (!released.ok) { setNotice(released.error.message); return; }
    setAttempt(null); setActiveItem(null); setQuestions([]); setFeedbackOpen(true); setReviewConsent(false); setNotice('');
  };
  const change = (action: ReviewQueueAction) => {
    if (pendingTask.current || taskSaving) { setNotice('请先核验原任务保存，未丢弃原操作。'); return; }
    const result = updateQueue(queueState.current, action, new Date().toISOString());
    if (result.ok) {
      queueState.current = result.data; setQueue(result.data); setNotice('');
      const invalidatesSelection = action.type === 'disable'
        || ((action.type === 'remove' || action.type === 'skip' || action.type === 'defer') && activeItem?.id === action.id);
      if (invalidatesSelection) {
        gate.interrupt(); request.current?.abort(); request.current = null; setBusy(false);
        setUncertain(gate.needsReadBack);
        if (gate.needsReadBack) setNotice('已退出当前回顾项；刚才的请求结果尚未确认，再继续前需要读回。');
        if (!attempt) { setQuestions([]); setActiveItem(null); setReviewConsent(false); }
      }
    } else setNotice(result.error.message);
  };
  return <section aria-label="可选回顾"><div className="learning-section-heading"><BookOpen size={20}/><h2>可选回顾</h2><span>本页临时队列 · 未保存</span></div>
    <label className="learning-toggle"><input type="checkbox" checked={queue.enabled} disabled={taskSaving || !!taskRecoveryId} onChange={(event) => change({ type: event.target.checked ? 'enable' : 'disable' })}/><span>本次开启回顾</span></label>
    {notice && <p role="status" className="learning-notice">{notice}</p>}
    {taskRecoveryId && <div className="learning-actions"><button type="button" disabled={busy} className="learning-secondary" onClick={() => void readTaskBack()}><RefreshCw size={18}/>核验原任务保存</button><span>原任务保存待核验：<code>{taskRecoveryId}</code></span></div>}
    {uncertain && <div className="learning-actions"><button type="button" disabled={busy} className="learning-secondary" onClick={() => void readBack()}><RefreshCw size={18}/>核验本次作答状态</button><a href={taskHref(taskId)}><ArrowLeft size={18}/>返回原任务</a></div>}
    <div hidden={!queue.enabled}>
      {!attempt && <section aria-label="回顾原任务"><h3>原任务</h3><p><code>{taskId}</code></p>
        {(task ?? readyTask) && <><p>{(task ?? readyTask)!.question}</p><TaskConditionDetails task={(task ?? readyTask)!}/></>}
        <label className="learning-toggle"><input name="review-task-retention" type="checkbox" checked={taskConsent} disabled={busy || !!taskRecoveryId || !task} onChange={(event) => setTaskConsent(event.target.checked)}/><span>确认上述原任务私有保存 30 天</span></label>
        {retainOperationRecovery && <RecoveryConsent name="task-recovery-retention" consent={taskRecovery} disabled={busy || !!taskRecoveryId}/>}
        <div className="learning-actions"><button type="button" disabled={busy || !!taskRecoveryId || !task || !taskConsent} onClick={() => void taskAction(true)}><Save size={18}/>保存原任务</button><button type="button" className="learning-secondary" disabled={busy || !!taskRecoveryId || !taskId.trim()} onClick={() => void taskAction(false)}><RefreshCw size={18}/>读取原任务</button></div>
        {readyTask && <p role="status">原任务已读取 · 私有保存 30 天</p>}
      </section>}
      {retainOperationRecovery && <RecoveryConsent name="review-recovery-retention" consent={reviewRecovery} disabled={busy || uncertain || !!taskRecoveryId}/>}
      <div className="learning-actions"><button type="button" disabled={busy || !!taskRecoveryId || !nodeRef || !title || !readyTask} onClick={() => { if (nodeRef && title) change({ type: 'add', item: { id: crypto.randomUUID(), nodeRef, taskId: taskId.trim(), title } }); }}><Plus size={18}/>加入所选知识</button><a href={taskHref(taskId)}><ArrowLeft size={18}/>返回任务</a></div>
      {!queue.items.length && <p>未选择回顾内容。</p>}
      {!attempt && <ul className="learning-records">{queue.items.map((item) => <li key={item.id}><h3>{item.title}</h3><p><code>{item.nodeRef.revision}</code> · {item.status === 'ready' ? '待回顾' : item.status === 'skipped' ? '已跳过' : `延后至 ${new Date(item.dueAt).toLocaleDateString('zh-CN')}`}</p><div className="learning-actions"><button type="button" className="learning-secondary" disabled={busy || item.status === 'skipped'} onClick={() => void loadQuestions(item)}><BookOpen size={17}/>读取审核题</button><button type="button" className="learning-secondary" disabled={busy || item.status === 'skipped'} onClick={() => change({ type: 'defer', id: item.id, until: new Date(Date.now() + 86400000).toISOString() })}><CalendarClock size={17}/>延后</button><button type="button" className="learning-secondary" disabled={busy || item.status === 'skipped'} onClick={() => change({ type: 'skip', id: item.id })}><SkipForward size={17}/>跳过</button><button type="button" className="icon-button" aria-label={`移除回顾：${item.title}`} title="移除回顾" onClick={() => change({ type: 'remove', id: item.id })}><Trash2 size={18}/></button></div></li>)}</ul>}
      {!attempt && activeItem && <><label className="learning-toggle"><input name="review-attempt-retention" type="checkbox" checked={reviewConsent} disabled={busy || uncertain || !!taskRecoveryId} onChange={(event) => setReviewConsent(event.target.checked)}/><span>确认本次作答及提示、反馈、申诉私有保存 30 天</span></label><ul className="learning-records">{questions.map((question) => <li key={`${question.id}@${question.revision}`}><h3>{question.kind === 'recall' ? '回忆题' : '近迁移题'}</h3><p>{question.prompt}</p><button type="button" disabled={busy || uncertain || !!taskRecoveryId || !readyTask || !reviewConsent} onClick={() => startQuestion(question)}><Play size={18}/>选择此题</button></li>)}</ul></>}
      {attempt && <>
        {attempt.receipt && <details><summary>已核验的原事件回执</summary>
          <p>操作 <code>{attempt.receipt.operationId}</code> · {attempt.receipt.kind}</p>
          <p>请求摘要 <code>{attempt.receipt.requestHash}</code></p>
          <p>原事件版本 {attempt.receipt.expectedVersion} → {attempt.receipt.resultingVersion} · 当前会话版本 {attempt.view.version}</p>
          <p>原事件反馈版本 {attempt.receipt.feedbackVersion ?? '不适用'} · 作答保留到期 {attempt.receipt.expiresAt}</p>
          <p>该回执只证明所列原事件已应用，不证明已经掌握。</p>
        </details>}
        <AttemptPanel key={attempt.view.id} view={attempt.view} busy={busy || uncertain} returnHref={taskHref(attempt.view.taskId)} onReturnToQueue={returnToQueue} onAction={(event) => void send({ action: 'event', operationId: crypto.randomUUID(), attemptId: attempt.view.id, expectedVersion: attempt.view.version, event })}/>
        {attempt.view.phase === 'submitted' && attempt.feedback && <>
          {!feedbackOpen && <button type="button" className="learning-secondary" disabled={busy || uncertain} onClick={() => setFeedbackOpen(true)}><BookOpen size={18}/>继续人工评阅</button>}
          {feedbackOpen && <FeedbackPanel key={attempt.feedback.version} feedback={attempt.feedback} busy={busy || uncertain} onReview={(review) => void send({ action: 'feedback', operationId: crypto.randomUUID(), attemptId: attempt.view.id, expectedVersion: attempt.view.version, feedbackVersion: attempt.feedback!.version, review })} onCancel={() => { setFeedbackOpen(false); setNotice('已取消本次评阅，原始作答保留。'); }} />}
          <AppealPanel busy={busy || uncertain} onAppeal={(reason) => void send({ action: 'appeal', operationId: crypto.randomUUID(), attemptId: attempt.view.id, expectedVersion: attempt.view.version, feedbackVersion: attempt.feedback!.version, nodeRef: attempt.view.question.nodeRef, reason })}/>
        </>}
      </>}
      {!attempt && !notice && <p className="learning-notice">尚未启动回顾。当前运行不提供无提示掌握认证。</p>}
    </div>
  </section>;
}
