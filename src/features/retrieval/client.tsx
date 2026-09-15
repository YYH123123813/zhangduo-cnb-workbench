import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Search, X, Plus, Trash2, RefreshCw, List, Route, CircleAlert, History, Eye } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { RetrievalRequest, RetrievalResult, TaskContext, TaskConditionCheck } from '../../contracts/domain';
import type { NavigationProps } from '../../contracts/navigation';
import type { ApiError } from '../../contracts/api';
import { HistoryQuerySchema, type NodeDetail, type NodeSummary, type RetrievalStatus } from './api';
import { clarificationFor } from './clarification';
import { canRecordDetail, contentReads, latestRead, modelFailure, queryLeaveState, queryTask, sameTaskIdentity, updateConditionCheck } from './client-state';
import { ConditionChoices, conditionLabels } from './condition-controls';
import { NodeDetails, ResultList, TextPaths } from './views';
import { GraphBrowser } from './graph-view';
import { AnswerControls, type AnswerFlow } from './answer-view';
import { answerLeaveState, type AnswerState } from './answer-client';
import { AnswerRecoveryPage } from './answer-recovery-view';
import './styles.css';

export interface PageProps extends NavigationProps {
  task?: TaskContext; nodeId?: string; revision?: string;
  onResult?: (task: TaskContext, result: RetrievalResult) => void;
  onInvalidateResult?: () => void;
}
const coverageLabels = { current: '索引覆盖当前版本', stale: '索引版本过期', partial: '索引覆盖待核验', unavailable: '仅 Git 文本召回' } as const;

export function Page(props: PageProps = {}) {
  const recoverySeen = useRef(false);
  if (props.recoveryRequested || props.recoveryIdentity) recoverySeen.current = true;
  return recoverySeen.current ? <AnswerRecoveryPage recoveryIdentity={props.recoveryIdentity} registerLeaveGuard={props.registerLeaveGuard}/>
    : <RetrievalPage {...props}/>;
}

function RetrievalPage({ task, nodeId, revision, onResult, onInvalidateResult, registerLeaveGuard, retainOperationRecovery }: PageProps) {
  const [taskId, setTaskId] = useState<string>(() => task?.id ?? crypto.randomUUID());
  const [query, setQuery] = useState(task?.question ?? '');
  const [constraints, setConstraints] = useState<TaskContext['constraints']>(task?.constraints ?? []);
  const [conditionChecks, setConditionChecks] = useState<TaskConditionCheck[]>(() => structuredClone(task?.conditionChecks ?? []));
  const submittedDraft = useRef({ question: query, constraints: structuredClone(constraints), conditionChecks: structuredClone(conditionChecks) });
  const queryDraft = useRef({ question: query, constraints, conditionChecks }); queryDraft.current = { question: query, constraints, conditionChecks };
  const [connection, setConnection] = useState<RetrievalStatus | null>(null);
  const [mode, setMode] = useState('unconfigured');
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [historyTarget, setHistoryTarget] = useState<{ id: string; revision: string; snapshotRevision?: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const [resultTask, setResultTask] = useState<TaskContext | null>(null);
  const [resultStale, setResultStale] = useState(false);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [graphCenter, setGraphCenter] = useState<(NodeSummary & { snapshotRevision: string }) | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'paths'>('list');
  const [skipped, setSkipped] = useState(false);
  const [checkingCondition, setCheckingCondition] = useState<{ nodeId: string; id: string } | null>(null);
  const [conditionChoice, setConditionChoice] = useState<TaskConditionCheck['status']>();
  const pendingChoice = useRef(false); pendingChoice.current = conditionChoice !== undefined;
  const [answerScope, setAnswerScope] = useState<{ id: string; request: RetrievalRequest; actorId: string } | null>(null);
  const [modelBlocked, setModelBlocked] = useState(false);
  const activeAnswer = useRef<AnswerFlow | null>(null);
  const installAnswer = useCallback((flow: AnswerFlow | null) => { activeAnswer.current = flow; setModelBlocked(flow ? answerLeaveState(flow.state) === 'blocked' : false); }, []);
  const observeAnswer = useCallback((state: AnswerState) => setModelBlocked(answerLeaveState(state) === 'blocked'), []);
  const reads = useRef({ ...contentReads(), status: latestRead() });
  const taskIdentity = useRef({ id: taskId, workspaceId: task?.workspaceId });
  const invalidateCallback = useRef(onInvalidateResult); invalidateCallback.current = onInvalidateResult;
  const invalidateResult = useCallback(() => { setResultStale(true); setConditionChoice(undefined); setCheckingCondition(null); void activeAnswer.current?.invalidate(); invalidateCallback.current?.(); }, []);
  useEffect(() => registerLeaveGuard?.({ owner: 'retrieval', getState: () => queryLeaveState(queryDraft.current, submittedDraft.current,
    activeAnswer.current ? answerLeaveState(activeAnswer.current.state) : 'clean', pendingChoice.current),
    onBlocked: () => { setNotice('模型批准或原操作结果尚未核验，请先处理本次模型流程。'); document.getElementById('retrieval-model-flow')?.focus(); },
  }), [registerLeaveGuard]);
  const handleReadError = useCallback((failure: ApiError) => {
    if (reads.current.reject(failure)) {
      reads.current.status.cancel();
      setConditionChoice(undefined); setCheckingCondition(null);
      setConnecting(false); setLoading(false); setDetailLoading(false); setMode('unconfigured'); setConnection(null);
      setResult(null); setResultTask(null); setDetail(null); setDetailError(''); setHistoryTarget(null); setGraphCenter(null); setSelectedId(null);
      setError(failure.message); setNotice(''); invalidateResult();
    } else if (failure.code === 'CONFLICT') {
      setNotice('引用版本待重新核对，旧结果不能继续用于本次采用记录。'); invalidateResult();
    }
  }, [invalidateResult]);

  const refreshStatus = useCallback(async () => {
    const signal = reads.current.status.start(); setConnecting(true);
    setConditionChoice(undefined); setCheckingCondition(null);
    reads.current.cancel(); invalidateResult();
    setConnection(null); setResult(null); setDetail(null); setHistoryTarget(null); setGraphCenter(null); setSelectedId(null); setLoading(false); setDetailLoading(false);
    try {
      const response = await apiRequest<RetrievalStatus>('/api/retrieval/status', { signal });
      if (!reads.current.status.active(signal)) return;
      setMode(response.meta.mode);
      if (response.ok) { setConnection(response.data); setError(''); }
      else { setConnection(null); setError(response.error.message); setResult(null); setDetail(null); }
    } catch {
      if (reads.current.status.active(signal)) { setConnection(null); setError('应用服务连接失败，输入保留。'); }
    } finally { if (reads.current.status.active(signal)) setConnecting(false); }
  }, [invalidateResult]);
  useEffect(() => {
    void refreshStatus(); const current = reads.current;
    return () => { current.cancel(); current.status.cancel(); };
  }, [refreshStatus]);
  useEffect(() => {
    if (!task || sameTaskIdentity(taskIdentity.current, task)) return;
    const workspaceChanged = taskIdentity.current.workspaceId !== task.workspaceId;
    taskIdentity.current = { id: task.id, workspaceId: task.workspaceId };
    submittedDraft.current = { question: task.question, constraints: structuredClone(task.constraints), conditionChecks: structuredClone(task.conditionChecks ?? []) };
    reads.current.cancel(); invalidateResult();
    setTaskId(task.id); setQuery(task.question); setConstraints(task.constraints); setConditionChecks(structuredClone(task.conditionChecks ?? [])); setCheckingCondition(null); setConditionChoice(undefined);
    setResult(null); setResultTask(null); setDetail(null); setHistoryTarget(null); setGraphCenter(null); setSelectedId(null); setLoading(false); setDetailLoading(false);
    if (workspaceChanged) void refreshStatus();
  }, [task?.id, task?.workspaceId, invalidateResult, refreshStatus]);

  const loadDetail = useCallback(async (id: string, nodeRevision?: string, snapshotRevision?: string, historical = false) => {
    const signal = reads.current.detail.start();
    setSelectedId(id); setDetail(null); setDetailError(''); setHistoryTarget(null); setDetailLoading(true);
    if (historical) { reads.current.query.cancel(); reads.current.graph.cancel(); setLoading(false); setGraphCenter(null); invalidateResult(); }
    const params = new URLSearchParams();
    if (nodeRevision) params.set('revision', nodeRevision);
    if (snapshotRevision) params.set('snapshotRevision', snapshotRevision);
    try {
      const response = await apiRequest<NodeDetail>(`/api/retrieval/nodes/${encodeURIComponent(id)}${historical ? '/history' : ''}?${params}`, { signal });
      if (!reads.current.detail.active(signal)) return;
      if (response.ok) {
        setDetail(response.data);
        if (!response.data.history) setGraphCenter((center) => center ?? { ...response.data.node, snapshotRevision: response.data.snapshotRevision });
      }
      else {
        setDetailError(response.error.code === 'CONFLICT' ? '知识版本已变化，当前引用未被替换。请重新检索。' : response.error.message);
        if (!historical && response.error.code === 'CONFLICT') {
          const historicalRef = HistoryQuerySchema.safeParse({ revision: nodeRevision, snapshotRevision });
          if (historicalRef.success) setHistoryTarget({ id, ...historicalRef.data });
        }
        handleReadError(response.error);
      }
    } catch { if (reads.current.detail.active(signal)) setDetailError('详情读取失败，检索结果保留。'); }
    finally { if (reads.current.detail.active(signal)) setDetailLoading(false); }
  }, [handleReadError, invalidateResult]);
  useEffect(() => {
    if (connection && nodeId) {
      reads.current.cancel(); invalidateResult(); setLoading(false); setResult(null); setResultTask(null); setGraphCenter(null);
      void loadDetail(nodeId, revision);
    }
  }, [connection, nodeId, revision, loadDetail, invalidateResult]);

  async function search(nextConstraints = constraints, nextChecks = conditionChecks, skipClarification = false) {
    if (!connection || !query.trim()) return;
    setConditionChoice(undefined);
    reads.current.cancel(); invalidateResult(); const signal = reads.current.query.start();
    setLoading(true); setDetailLoading(false); setError(''); setNotice(''); setDetail(null); setHistoryTarget(null); setGraphCenter(null); setDetailError(''); setSelectedId(null); setSkipped(skipClarification); setCheckingCondition(null);
    const currentTask = queryTask(task, taskId, connection.workspaceId, query, nextConstraints, new Date().toISOString(), nextChecks);
    taskIdentity.current = { id: currentTask.id, workspaceId: currentTask.workspaceId };
    try {
      const response = await apiRequest<RetrievalResult>('/api/retrieval/query', { method: 'POST', signal,
        body: JSON.stringify({ task: currentTask, query: query.trim(), confirmedOnly: true }) });
      if (!reads.current.query.active(signal)) return;
      setMode(response.meta.mode);
      if (response.ok) {
        submittedDraft.current = { question: currentTask.question, constraints: structuredClone(currentTask.constraints), conditionChecks: structuredClone(currentTask.conditionChecks ?? []) };
        reads.current.detail.cancel(); setResult(response.data); setResultTask(currentTask); setResultStale(false);
        onResult?.(structuredClone(currentTask), structuredClone(response.data));
        const first = [...response.data.groups.eligible, ...response.data.groups.conditional, ...response.data.groups.conflicts][0];
        if (first) { setGraphCenter({ ...first, snapshotRevision: response.data.snapshotRevision }); void loadDetail(first.id, first.revision, response.data.snapshotRevision); }
      } else {
        setError(response.error.code === 'CONFLICT' ? '知识版本或任务核验已变化，旧结果仅供核对。请清除旧核验后重新检索。' : response.error.message);
        handleReadError(response.error);
      }
    } catch { if (reads.current.query.active(signal)) setError('检索请求失败，输入和已有结果保留。'); }
    finally { if (reads.current.query.active(signal)) setLoading(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (conditionChoice === undefined) void search(); }
  function reviseInput() { reads.current.query.cancel(); invalidateResult(); setConditionChecks([]); setCheckingCondition(null); setConditionChoice(undefined); setLoading(false); setSkipped(true); setNotice('输入已修改，本次条件需重新核对，已有结果仍基于上次查询。'); }
  function cancel() { reads.current.cancel(); setGraphCenter(null); setHistoryTarget(null); setConditionChoice(undefined); invalidateResult(); setLoading(false); setDetailLoading(false); setNotice('本次读取与核验已取消，输入保留；查询未保存。'); }
  function select(id: string) {
    const n = result && [...result.groups.eligible, ...result.groups.conditional, ...result.groups.conflicts].find((item) => item.id === id);
    const neighbor = detail?.neighbors.find((item) => item.id === id);
    void loadDetail(id, n?.revision ?? neighbor?.revision, result?.snapshotRevision ?? graphCenter?.snapshotRevision ?? detail?.snapshotRevision);
  }
  function changeView(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'list' : event.key === 'End' ? 'paths' : view === 'list' ? 'paths' : 'list';
    setView(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  }
  const allNodes = result ? [...result.groups.eligible, ...result.groups.conditional, ...result.groups.conflicts] : [];
  const clarification = !resultStale && (checkingCondition ?? (result && resultTask && clarificationFor(result, resultTask, skipped)));
  const conditionNode = clarification ? allNodes.find((n) => n.id === clarification.nodeId) : undefined;
  function confirmCondition(status: TaskConditionCheck['status']) {
    if (!clarification || !conditionNode || !connection) return;
    const next = updateConditionCheck(conditionChecks, conditionNode, clarification.id, status, connection.actorId);
    if (!next) { setError('本次核验需固定节点版本、有效条件ID且最多200项。'); return; }
    setConditionChecks(next); void search(constraints, next, status === 'unknown');
  }
  return <div className="retrieval">
    <header className="retrieval-heading"><div><h1>知识与检索</h1><p className="metadata">正式知识 · 查询未保存</p></div><div className="heading-actions"><span className={`mode-label ${mode}`}>{mode === 'fixture' ? 'Fixture 数据' : mode === 'live' ? '已授权工作区' : '工作区未连接'}</span><button type="button" className="tool-button" aria-label="刷新连接" title="刷新连接" disabled={connecting} onClick={() => void refreshStatus()}><RefreshCw size={18}/></button></div></header>
    <form className="query-form" onSubmit={submit}>
      <fieldset className="query-fields"><legend className="sr-only">检索任务</legend>
      <label htmlFor="retrieval-question">当前问题</label><textarea id="retrieval-question" value={query} maxLength={4000} rows={3} required onChange={(e) => { reviseInput(); setQuery(e.target.value); }} />
      <p className="metadata">{connection?.aiAnswer === 'preview_available' ? 'AI 回答可预览' : connection?.aiAnswer === 'disabled' ? 'AI 回答已关闭' : 'AI 回答未配置'}</p>
      <details className="task-conditions" open={constraints.length > 0} onChange={reviseInput} onClickCapture={(e) => { if (e.target instanceof Element && e.target.closest('button')) reviseInput(); }}><summary>任务补充说明 <span className="count">{constraints.length}</span></summary>
        {constraints.map((c, index) => <div className="constraint-row" key={c.id}><label className="sr-only" htmlFor={`retrieval-condition-${index}`}>条件 {index + 1}</label><input id={`retrieval-condition-${index}`} type="text" value={c.text} maxLength={1000} onChange={(e) => setConstraints(constraints.map((item, i) => i === index ? { id: item.id, text: e.target.value } : item))}/><label className="confirmed-control"><input type="checkbox" checked={Boolean(c.confirmedBy)} disabled={!connection || !c.text.trim()} onChange={(e) => setConstraints(constraints.map((item, i) => i === index ? { id: item.id, text: item.text, ...(e.target.checked && connection ? { confirmedBy: connection.actorId } : {}) } : item))}/>已确认</label><button type="button" className="tool-button" aria-label={`删除条件 ${index + 1}`} title={`删除条件 ${index + 1}`} onClick={() => setConstraints(constraints.filter((_, i) => i !== index))}><Trash2 size={16}/></button></div>)}
        <button type="button" className="text-command" disabled={constraints.length >= 50} onClick={() => setConstraints([...constraints, { id: crypto.randomUUID(), text: '' }])}><Plus size={16} aria-hidden="true"/>添加条件</button>
      </details>
      <div className="query-actions"><button className="primary-command" type="submit" disabled={loading || !connection || !query.trim() || conditionChoice !== undefined}><Search size={17} aria-hidden="true"/>{loading ? '正在检索' : '检索知识'}</button><button type="button" className="tool-button" title={clarification ? '取消条件核验' : '取消读取'} aria-label={clarification ? '取消条件核验' : '取消读取'} disabled={!loading && !detailLoading && !clarification} onClick={cancel}><X size={18}/></button><span className="metadata" role="status">{connecting ? '正在检查工作区' : notice || (loading ? '正在检查来源与关系' : '')}</span></div>
      </fieldset>
    </form>
    {error && <div className="error-line" role="alert"><CircleAlert size={18} aria-hidden="true"/><p>{error}</p></div>}
    {conditionChecks.length > 0 && <details className="task-conditions" open><summary>本次条件核验 <span className="count">{conditionChecks.length}</span></summary>
      <ul className="condition-list">{conditionChecks.map((check) => <li key={JSON.stringify([check.nodeRef.objectId, check.conditionId])}>
        <span>{allNodes.find((n) => n.id === check.nodeRef.objectId)?.conditions.find((c) => c.id === check.conditionId)?.text ?? check.conditionId}</span>
        <span>{conditionLabels[check.status]}</span><span className="metadata">{check.nodeRef.objectId} / {check.conditionId} · <code>{check.nodeRef.revision}</code>{check.confirmedBy && ` · ${check.confirmedBy}`}</span>
        {!resultStale && allNodes.some((n) => n.id === check.nodeRef.objectId && n.revision === check.nodeRef.revision) && <button type="button" className="text-command" disabled={loading || conditionChoice !== undefined} onClick={() => { setConditionChoice(undefined); setCheckingCondition({ nodeId: check.nodeRef.objectId, id: check.conditionId }); }}><RefreshCw size={16} aria-hidden="true"/>重新核对</button>}
      </li>)}</ul>
      <button type="button" className="text-command" disabled={loading || !connection} onClick={() => { setConditionChecks([]); void search(constraints, []); }}><RefreshCw size={16} aria-hidden="true"/>清除核验并重查</button>
    </details>}
    {clarification && conditionNode && <ConditionChoices node={conditionNode} conditionId={clarification.id} disabled={loading}
      status={conditionChoice} onChange={(value) => { setConditionChoice(value); void activeAnswer.current?.invalidate(); }}
      onConfirm={() => { if (conditionChoice !== undefined) confirmCondition(conditionChoice); }} onSkip={() => confirmCondition('unknown')}/>}
    {result && <div className="retrieval-summary"><p role="status">{allNodes.length} 条结果 · {coverageLabels[result.coverage]}</p><p className="metadata">结果问题：{resultTask?.question}</p><p className="metadata">快照 <code>{result.snapshotRevision}</code></p>{result.warnings.map((w) => <p key={w} className="notice">{w}</p>)}{result.missingConditions.length > 0 && <details><summary>条件与检查缺口 <span className="count">{result.missingConditions.length}</span></summary><ul>{result.missingConditions.map((c) => <li key={c}>{c}</li>)}</ul></details>}{result.groups.excludedIds.length > 0 && <p className="metadata">当前工作区有 {result.groups.excludedIds.length} 个对象未进入正式结果。</p>}
      {result.answer && <section className="checked-answer"><h2>来源化整理</h2><p className="original-text">{result.answer.text}</p><ol>{result.answer.citations.map((c, i) => <li key={i}><button type="button" onClick={() => select(c.nodeRef.objectId)}>{c.sourceId} · {c.nodeRef.revision}</button><blockquote>{c.quote}</blockquote></li>)}</ol></section>}
      {connection?.aiAnswer === 'preview_available' && resultTask && !resultStale && conditionChoice === undefined && <button type="button" className="text-command" disabled={modelBlocked || !result.groups.eligible.length || Boolean(result.groups.conflicts.length || result.missingConditions.length)}
        onClick={() => setAnswerScope({ id: crypto.randomUUID(), actorId: connection.actorId, request: { task: structuredClone(resultTask), query: resultTask.question, confirmedOnly: true } })}><Eye size={17} aria-hidden="true"/>预览模型范围</button>}
    </div>}
    {answerScope && <AnswerControls key={answerScope.id} request={answerScope.request} actorId={answerScope.actorId} reader={reads.current.answer} onReady={installAnswer} onState={observeAnswer} retainOperationRecovery={retainOperationRecovery}
      onFailure={(failure) => { void modelFailure(failure, () => search(), handleReadError); }} onResult={(next) => {
        setResult(next); setResultTask(answerScope.request.task); setResultStale(false);
        onResult?.(structuredClone(answerScope.request.task), structuredClone(next));
      }}/>}
    <div className="retrieval-workspace"><section className="retrieval-results" aria-label="检索结果" aria-busy={loading}>
      <div className="view-tabs" role="tablist" aria-label="结果视图">{([['list', List, '列表'], ['paths', Route, '文本路径']] as const).map(([id, Icon, label]) => <button type="button" role="tab" id={`retrieval-tab-${id}`} data-view={id} key={id} aria-selected={view === id} aria-controls={`retrieval-panel-${id}`} tabIndex={view === id ? 0 : -1} onKeyDown={changeView} onClick={() => setView(id)}><Icon size={16} aria-hidden="true"/>{label}</button>)}</div>
      <div role="tabpanel" id={`retrieval-panel-${view}`} aria-labelledby={`retrieval-tab-${view}`} tabIndex={0}>{result ? view === 'list' ? <ResultList result={result} selectedId={selectedId} onSelect={select}/> : <TextPaths paths={result.paths} nodes={allNodes} selectedId={selectedId} onSelect={select}/> : <p className="empty-state">尚无检索结果</p>}</div>
    </section><section className="retrieval-detail-region" aria-label="选中知识" aria-busy={detailLoading}>{detailLoading && <p role="status">正在读取固定版本</p>}{detailError && <p className="error-line" role="alert">{detailError}</p>}
      {historyTarget && <button type="button" className="text-command" onClick={() => void loadDetail(historyTarget.id, historyTarget.revision, historyTarget.snapshotRevision, true)}><History size={16} aria-hidden="true"/>查看引用版本</button>}
      {detail ? <NodeDetails detail={detail} taskId={taskId} canRecordUse={canRecordDetail(result, detail, resultStale || conditionChoice !== undefined)}
        onSelect={(id) => {
          if (detail.history) {
            const ref = [detail.node, ...detail.neighbors].find((n) => n.id === id);
            if (ref) void loadDetail(id, ref.revision, detail.snapshotRevision, true);
          } else select(id);
        }}
        onCurrent={() => { reads.current.cancel(); setResult(null); setResultTask(null); setGraphCenter(null); invalidateResult(); void loadDetail(detail.node.id); }}/>
        : !detailLoading && !detailError && <p className="empty-state">尚未选择知识</p>}</section></div>
    <GraphBrowser center={graphCenter} snapshotRevision={graphCenter?.snapshotRevision} selectedId={selectedId} onSelect={select}
      reader={reads.current.graph} onFailure={handleReadError} canRecenter={Boolean(detail && !detail.history && detail.node.id === selectedId)}
      onRecenter={() => { if (detail && !detail.history) setGraphCenter({ ...detail.node, snapshotRevision: detail.snapshotRevision }); }}/>
  </div>;
}
