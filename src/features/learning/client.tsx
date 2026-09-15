import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, BookOpen, Check, CircleAlert, ClipboardCheck, RefreshCw, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { KnowledgeNode, RetrievalResult, TaskContext } from '../../contracts/domain';
import type { NavigationProps } from '../../contracts/navigation';
import type { UsePreview, UseSelection } from './use';
import type { UseRecordDraft } from './history';
import { RecordsPanel } from './records-panel';
import { ReviewPanel } from './review-panel';
import { taskHref } from './links';
import { LearningLeaveGroup, useLearningLeaveGuard } from './leave-guard';
import { EvidenceSaveFlow } from './evidence-save-flow';
import { EvidenceSavePanel, useEvidenceSaveState } from './evidence-save-panel';
import { TaskConditionDetails } from './evidence-details';
import type { EvidenceStoragePreview } from './application-api';
import { EvidenceRecoveryPanel } from './evidence-recovery-panel';
import { RecoveryAnchorPanel } from './recovery-anchor-panel';
import './learning.css';

export interface LearningPageProps extends NavigationProps {
  routeParams?: Readonly<Record<string, string | undefined>>;
  retrieved?: { task: TaskContext; result: RetrievalResult };
}
type ApplicationPreview = UsePreview & { draft: UseRecordDraft; handoffTrust?: 'client_preview_only'; storage: EvidenceStoragePreview | null; storageNotice: string | null };
interface LearningContext {
  workspaceId: string; actorId: string; revision: string;
  nodes: Pick<KnowledgeNode, 'id' | 'revision' | 'title' | 'conditions' | 'boundaries'>[];
}

export function DecisionFields({ decision, onChange, disabled = false }: {
  decision: UseSelection['decision'] | ''; onChange: (value: UseSelection['decision']) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled}><legend>本次决定</legend><div className="learning-options">{([
    ['adopt', '采用'], ['reject', '不采用'], ['verify_later', '待验证'],
  ] as const).map(([value, label]) => <label key={value}><input type="radio" name="use-decision" value={value} checked={decision === value} onChange={() => onChange(value)}/><span>{label}</span></label>)}</div></fieldset>;
}

export function Page({ routeParams = {}, retrieved, registerLeaveGuard, retainOperationRecovery, recoveryIdentity }: LearningPageProps = {}) {
  const [context, setContext] = useState<LearningContext | null>(null);
  const [mode, setMode] = useState('检查中');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState(() => retrieved ? structuredClone(retrieved) : undefined);
  const [taskId, setTaskId] = useState(routeParams.taskId ?? retrieved?.task.id ?? '');
  const [question, setQuestion] = useState(retrieved?.task.question ?? '');
  const [constraints, setConstraints] = useState(retrieved?.task.constraints.map((item) => item.text).join('\n') ?? '');
  const [nodeId, setNodeId] = useState(routeParams.nodeId ?? '');
  const [decision, setDecision] = useState<UseSelection['decision'] | ''>('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ApplicationPreview | null>(null);
  const [saveFlow, setSaveFlow] = useState<EvidenceSaveFlow | null>(null);
  const saveState = useEvidenceSaveState(saveFlow);
  const [recordsRefresh, setRecordsRefresh] = useState(0);
  const saved = useCallback(() => setRecordsRefresh((value) => value + 1), []);
  const [view, setView] = useState<'use' | 'review'>('use');
  const [leaveGroup] = useState(() => new LearningLeaveGroup());
  const explainBlocked = () => {
    setView('review'); setNotice('保存或作答操作仍在进行或结果未知；请先核验原操作，再离开本页。'); leaveGroup.onBlocked();
  };
  useLearningLeaveGuard(leaveGroup.register, () => saveFlow?.blocked ? 'blocked' : saveState?.phase === 'saved' || saveState?.phase === 'cancelled' ? 'clean'
    : question.trim() || constraints.trim() || decision || reason.trim() || preview ? 'dirty' : 'clean', () => setView('use'));
  useLearningLeaveGuard(registerLeaveGuard, leaveGroup.getState, explainBlocked);
  const routeKey = JSON.stringify([routeParams.taskId, routeParams.nodeId, routeParams.revision, routeParams.queryId, routeParams.useId, routeParams.evidenceId, retrieved]);
  const [acceptedRoute, setAcceptedRoute] = useState(routeKey);
  const [routeRevision, setRouteRevision] = useState(routeParams.revision);
  const [scopeChanged, setScopeChanged] = useState(false);
  const previousIdentity = useRef<string | null>(null);
  const request = useRef<{ controller: AbortController; kind: 'context' | 'preview' } | null>(null);
  const routeChanged = routeKey !== acceptedRoute;
  const invalidatePreview = () => {
    if (saveFlow?.blocked) { explainBlocked(); return false; }
    setPreview(null); setSaveFlow(null);
    if (request.current?.kind === 'preview') { request.current.controller.abort(); request.current = null; setBusy(false); }
    return true;
  };
  const refresh = async () => {
    if (leaveGroup.getState() === 'blocked') { explainBlocked(); return; }
    request.current?.controller.abort(); const controller = new AbortController();
    request.current = { controller, kind: 'context' }; setBusy(true); setPreview(null); setSaveFlow(null);
    try {
      const result = await apiRequest<LearningContext>('/api/learning/context', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (leaveGroup.getState() === 'blocked') { explainBlocked(); return; }
      setMode(result.meta.mode === 'fixture' ? '合成测试数据' : result.meta.mode === 'live' ? '已连接工作区' : '工作区未连接');
      if (result.ok) {
        const identity = JSON.stringify([result.data.workspaceId, result.data.actorId]);
        if (previousIdentity.current && previousIdentity.current !== identity) setScopeChanged(true);
        previousIdentity.current = identity; setContext(result.data); setNotice('');
      }
      else { setContext(null); setNotice(result.error.code === 'NOT_CONFIGURED' ? 'CNB 未配置；尚未读取知识或保存记录。' : result.error.message); }
    } catch { if (!controller.signal.aborted) { if (leaveGroup.getState() === 'blocked') { explainBlocked(); return; } setNotice('服务连接失败；当前输入未保存。'); setContext(null); setMode('服务未连接'); } }
    finally { if (request.current?.controller === controller) { setBusy(false); request.current = null; } }
  };
  useEffect(() => { void refresh(); return () => request.current?.controller.abort(); }, []);
  useEffect(() => () => saveFlow?.interrupt(), [saveFlow]);
  useEffect(() => { if (routeKey !== acceptedRoute) invalidatePreview(); }, [routeKey, acceptedRoute]);
  const node = context?.nodes.find((item) => item.id === nodeId);
  const outdated = (!!routeRevision && !!node && routeRevision !== node.revision)
    || (!!handoff && !!context && handoff.result.snapshotRevision !== context.revision);
  const handoffMismatch = !!handoff && (handoff.task.id !== taskId || (!!context && handoff.task.workspaceId !== context.workspaceId)
    || (!!routeParams.queryId && routeParams.queryId !== handoff.result.queryId));
  const handoffMissing = !!routeParams.queryId && !handoff;
  const selectableNodes = context?.nodes.filter((item) => !handoff || (!handoff.result.groups.excludedIds.includes(item.id)
    && [...handoff.result.groups.eligible, ...handoff.result.groups.conditional, ...handoff.result.groups.conflicts].some((candidate) => candidate.id === item.id)));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saveFlow?.blocked) { explainBlocked(); return; }
    if (busy || !context || !node || !decision || outdated || routeChanged || scopeChanged || handoffMismatch || handoffMissing) return;
    const controller = new AbortController(); request.current = { controller, kind: 'preview' };
    setBusy(true); setNotice(''); setPreview(null); setSaveFlow(null);
    const selection: UseSelection = {
      task: handoff?.task ?? { id: taskId.trim(), workspaceId: context.workspaceId, question: question.trim(), constraints: constraints.split('\n').map((text) => text.trim()).filter(Boolean).map((text, index) => ({ id: `condition-${index + 1}`, text, confirmedBy: context.actorId })), mode: 'assisted', updatedAt: new Date().toISOString() },
      nodeRefs: [{ workspaceId: context.workspaceId, objectId: node.id, revision: node.revision }], relationRefs: [],
      snapshotRevision: context.revision, decision, reason,
    };
    try {
      const payload = handoff ? { action: 'preview_retrieved', task: handoff.task, retrieval: handoff.result, nodeId, decision, reason }
        : { action: 'preview', selection };
      const result = await apiRequest<ApplicationPreview>('/api/learning/use', { method: 'POST', body: JSON.stringify(payload), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        const flow = result.data.storage ? new EvidenceSaveFlow(result.data.storage, apiRequest) : null;
        setPreview(result.data); setSaveFlow(flow);
      } else setNotice(`${result.error.message} 当前输入未丢弃。`);
    } catch { if (!controller.signal.aborted) setNotice('预览请求失败；当前输入已保留，尚未保存。'); }
    finally { if (request.current?.controller === controller) { setBusy(false); request.current = null; } }
  };
  return <div className="learning"><section className="module">
    <header className="module-heading"><div><p className="eyebrow">APPLICATION & REVIEW</p><h1>应用与回顾</h1></div><div className="learning-heading-actions"><span className="status-tag">{mode}</span><button type="button" className="icon-button" aria-label="刷新工作区状态" title="刷新工作区状态" disabled={busy} onClick={() => void refresh()}><RefreshCw size={18}/></button></div></header>
    {notice && <p className="learning-notice" role="status"><CircleAlert size={18}/><span>{notice}</span></p>}
    {(routeParams.recoveryId || recoveryIdentity) && <RecoveryAnchorPanel key={JSON.stringify([routeParams.recoveryId, recoveryIdentity])} supplied={recoveryIdentity}/>}
    {(routeChanged || scopeChanged) && <section className="learning-notice" role="alert"><div><p>入口任务或工作区身份已变化；原草稿未改写，当前不能提交。</p><button type="button" className="learning-secondary" onClick={() => { if (leaveGroup.getState() === 'blocked') { explainBlocked(); return; } invalidatePreview(); setHandoff(retrieved ? structuredClone(retrieved) : undefined); setTaskId(routeParams.taskId ?? retrieved?.task.id ?? ''); setNodeId(routeParams.nodeId ?? ''); setRouteRevision(routeParams.revision); setQuestion(retrieved?.task.question ?? ''); setConstraints(retrieved?.task.constraints.map((item) => item.text).join('\n') ?? ''); setDecision(''); setReason(''); setAcceptedRoute(routeKey); setScopeChanged(false); setNotice('已切换上下文；原草稿未保存。'); }}><RefreshCw size={18}/>放弃草稿并切换上下文</button></div></section>}
    {handoffMismatch && <p role="alert" className="learning-notice">检索交接与当前任务或工作区不一致，未重新绑定原记录。</p>}
    {handoffMissing && <p role="alert" className="learning-notice">原检索上下文已失效或未随页面恢复；当前仅可查看知识，不能生成原查询的应用预览。<a href={taskHref(taskId)}>返回原任务重新检索</a></p>}
    <fieldset className="learning-mode"><legend>工作视图</legend><div className="learning-options"><label><input type="radio" name="learning-view" value="use" checked={view === 'use'} onChange={() => { if (leaveGroup.getState() === 'blocked') { explainBlocked(); return; } setView('use'); }}/><ClipboardCheck size={18}/><span>任务应用</span></label><label><input type="radio" name="learning-view" value="review" checked={view === 'review'} onChange={() => { if (leaveGroup.getState() === 'blocked') { explainBlocked(); return; } if (invalidatePreview()) setView('review'); }}/><BookOpen size={18}/><span>独立回顾</span></label></div></fieldset>
    <div hidden={view !== 'use'}>
    <div className="learning-section-heading"><ClipboardCheck size={20}/><h2>任务应用</h2><span>{saveState?.phase === 'saved' ? '原操作已核验保存' : '尚未核验保存'}</span></div>
    <form onSubmit={(event) => void submit(event)} onChange={invalidatePreview}>
      <fieldset className="learning-form-fields" disabled={saveFlow?.blocked || routeChanged || scopeChanged}>
      <div className="learning-grid"><label>任务 ID<input required readOnly={!!handoff || handoffMissing} maxLength={160} value={taskId} onChange={(event) => setTaskId(event.target.value)}/></label><label>知识节点<select required value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="">选择节点</option>{selectableNodes?.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
      <label>当前任务<textarea required readOnly={!!handoff || handoffMissing} maxLength={4000} rows={2} value={question} onChange={(event) => setQuestion(event.target.value)}/></label>
      <label>本次条件<textarea readOnly={!!handoff || handoffMissing} maxLength={4000} rows={2} value={constraints} onChange={(event) => setConstraints(event.target.value)}/></label>
      {handoff && <p>检索记录：<code>{handoff.result.queryId}</code> · 临时交接，未保存</p>}
      {handoff && <TaskConditionDetails task={handoff.task}/>}
      {node && <section className="learning-version" aria-label="所选知识条件"><h3>{node.title}</h3><p>节点版本 <code>{node.revision}</code></p>{node.conditions.map((condition) => <p key={condition.id}><strong>{condition.status === 'confirmed' ? '已确认' : condition.status === 'rejected' ? '不成立' : '待核对'}</strong> {condition.text}</p>)}{node.boundaries.map((text, index) => <p key={index}>边界：{text}</p>)}</section>}
      {outdated && <p role="alert" className="learning-notice">上游节点版本已变化；当前链接保留原版本，请重新检索后确认。</p>}
      <DecisionFields decision={decision} onChange={setDecision} disabled={handoffMissing}/>
      <label>决定理由<textarea maxLength={4000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)}/></label>
      <div className="learning-actions"><button type="submit" disabled={busy || !context || !node || !decision || outdated || routeChanged || scopeChanged || handoffMismatch || handoffMissing}><Check size={18}/>预览决定</button><button type="button" className="learning-secondary" onClick={() => { if (!invalidatePreview()) return; setDecision(''); setReason(''); setNotice('已取消当前决定编辑；已保存的历史记录不变。'); }}><X size={18}/>取消决定</button><a href={taskHref(taskId)}><ArrowLeft size={17}/>{saveState?.phase === 'saved' ? '返回原任务' : '不记录，返回任务'}</a></div>
      </fieldset>
    </form>
    {preview && !saveFlow && <section className="learning-preview" aria-label="应用预览"><h2>决定预览</h2><p>当前决定：{preview.decision === 'adopt' ? '采用' : preview.decision === 'reject' ? '不采用' : '待验证'}</p><p>{preview.reason || '未填写理由'}</p><p>记录状态：未保存</p>{preview.missingConditions.map((text, index) => <p key={index}>待核对：{text}</p>)}{preview.warnings.map((text, index) => <p key={`warning-${index}`}>限制：{text}</p>)}
      <ul aria-label="版本固定的关系路径">{preview.draft.paths.map((path, index) => <li key={index}><p>{path.nodeIds.join(' → ')}</p><p>{path.reason}</p><p>关系：{path.relationIds.join('、') || '直接命中'}</p></li>)}</ul>
      <p>{preview.storageNotice || '当前预览缺少可保存的固定版本，未登记批准。'}</p></section>}
    {saveFlow && <EvidenceSavePanel key={saveFlow.preview.operationId} flow={saveFlow} retainOperationRecovery={retainOperationRecovery} onSaved={saved}/>}
    <RecordsPanel key={context ? JSON.stringify([context.workspaceId, context.actorId]) : 'unconfigured'} taskId={taskId} refreshKey={recordsRefresh} useId={routeChanged ? undefined : routeParams.useId} evidenceId={routeChanged ? undefined : routeParams.evidenceId} registerLeaveGuard={leaveGroup.register} onBlocked={() => setView('use')} retainOperationRecovery={retainOperationRecovery}/>
    {context && !scopeChanged && <EvidenceRecoveryPanel key={JSON.stringify([context.workspaceId, context.actorId])} actorId={context.actorId} workspaceId={context.workspaceId}/>}
    </div>
    <div hidden={view !== 'review'}>
      <div className="learning-grid learning-review-selection"><label>关联任务 ID<input readOnly={!!handoff || handoffMissing} maxLength={160} value={taskId} onChange={(event) => setTaskId(event.target.value)}/></label><label>回顾知识<select value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="">选择节点</option>{selectableNodes?.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
      {outdated && <p className="learning-notice" role="alert">节点版本已变化，请重新检索后选择回顾版本。</p>}
      <ReviewPanel key={context ? JSON.stringify([context.workspaceId, context.actorId]) : 'unconfigured'} actorId={context?.actorId ?? 'unconfigured'} workspaceId={context?.workspaceId ?? 'unconfigured'} taskId={taskId} task={handoff?.task} nodeRef={context && node && !outdated && !routeChanged && !scopeChanged && !handoffMismatch && !handoffMissing ? { workspaceId: context.workspaceId, objectId: node.id, revision: node.revision } : undefined} title={node?.title} registerLeaveGuard={leaveGroup.register} retainOperationRecovery={retainOperationRecovery}/>
    </div>
  </section></div>;
}
