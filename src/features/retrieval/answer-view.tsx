import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Eye, Send, XCircle, RefreshCw } from 'lucide-react';
import type { ApiError } from '../../contracts/api';
import type { RetrievalRequest, RetrievalResult } from '../../contracts/domain';
import { answerOperationLabels, answerOperationState, createAnswerFlow, emptyAnswerState, type AnswerState } from './answer-client';
import type { latestRead } from './client-state';
import type { NavigationProps } from '../../contracts/navigation';
import type { OperationRecovery } from '../../contracts/operation-recovery';

export type AnswerFlow = ReturnType<typeof createAnswerFlow>;
export function AnswerRecoveryMetadata({ metadata }: { metadata: OperationRecovery }) {
  return <dl className="node-meta"><dt>原操作恢复</dt><dd><code>{metadata.operationId}</code></dd>
    <dt>恢复阶段</dt><dd>{metadata.stage}</dd><dt>恢复批准绑定</dt><dd><code>{metadata.approvalId ?? '尚未核验'}</code></dd>
    <dt>恢复方式</dt><dd>只读元数据；不恢复正文、不批准、不发送</dd></dl>;
}
export function AnswerPanel({ state, confirmed, onConfirm, onPreview, onApprove, onSend, onCancel, onInspect, onInspectRegistration, onInspectRecovery,
  retentionConfirmed = false, onRetainConfirm }: {
  state: AnswerState; confirmed: boolean; onConfirm: (value: boolean) => void;
  retentionConfirmed?: boolean; onRetainConfirm?: (value: boolean) => void;
  onPreview: () => void; onApprove: () => void; onSend: () => void; onCancel: () => void; onInspect?: () => void; onInspectRegistration?: () => void; onInspectRecovery?: () => void;
}) {
  const busy = ['previewing', 'approving', 'sending', 'checking', 'cancelling'].includes(state.phase);
  return <section id="retrieval-model-flow" className="model-answer" aria-label="模型发送范围" tabIndex={-1} aria-busy={busy}>
    <h2>本次模型回答</h2>
    {state.invalidated && <p className="notice">本次模型范围已失效。</p>}
    {state.notice && <p role="status" className="notice">{state.notice}</p>}
    {state.error && <p role="alert" className="error-line">{state.error}</p>}
    {state.preview && <>
      <p className="notice">知识与来源已在 Git 保存。批准后，本次问题、已确认条件和下列内容将额外发送给工作区配置的模型；查询正文不在本应用持久化。</p>
      <dl className="node-meta"><dt>知识版本</dt><dd><code>{state.preview.baseRevision}</code></dd><dt>知识范围</dt><dd>{state.preview.objectIds.join('、')}</dd><dt>来源范围</dt><dd>{state.preview.input.sourceIds.join('、')}</dd><dt>内容摘要</dt><dd><code>{state.preview.contentHash}</code></dd></dl>
      <label htmlFor="retrieval-model-input">精确发送内容</label><textarea id="retrieval-model-input" className="model-input" readOnly rows={12} value={state.preview.input.text}/>
    </>}
    {state.phase === 'preview' && <label className="confirmed-control model-consent"><input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)}/>我同意仅将本次范围发送给模型</label>}
    {state.phase === 'preview' && onRetainConfirm && <label className="confirmed-control model-consent"><input type="checkbox" checked={retentionConfirmed} onChange={(e) => onRetainConfirm(e.target.checked)}/>单独同意保留原操作身份 24 小时，不含查询或回答正文</label>}
    {state.retention && <p role="status" className="metadata">恢复身份：{state.retention.status === 'saved' ? '已核验保留' : state.retention.status === 'saving' ? '正在保留' : '保存未知'}
      {state.retention.identity && <> · 到期 <time dateTime={state.retention.identity.expiresAt}>{state.retention.identity.expiresAt}</time></>}</p>}
    {state.approval && <p className="metadata">批准 <code>{state.approval.id}</code> · 有效至 <time dateTime={state.approval.expiresAt}>{state.approval.expiresAt}</time></p>}
    {state.registration && !state.operation && <dl className="node-meta"><dt>原批准登记</dt><dd><code>{state.registration.operationId}</code></dd>
      <dt>登记请求摘要</dt><dd><code>{state.registration.requestHash}</code></dd><dt>原知识版本</dt><dd><code>{state.registration.baseRevision}</code></dd>
      <dt>登记状态</dt><dd>{state.registrationStatus ? { registered: '已登记', revoked: '已撤回', expired: '已过期', not_registered: '尚未查到，仍待核验', unknown: '登记结果未知' }[state.registrationStatus] : '未核验'}</dd>
    </dl>}
    {state.recovery && <AnswerRecoveryMetadata metadata={state.recovery}/>}
    {state.operation && <dl className="node-meta"><dt>原操作</dt><dd><code>{state.operation.id}</code></dd>
      <dt>原知识版本</dt><dd><code>{state.operation.baseRevision}</code></dd><dt>原知识范围</dt><dd>{state.operation.objectIds.join('、')}</dd>
      <dt>原内容摘要</dt><dd><code>{state.operation.contentHash}</code></dd>
      <dt>操作状态</dt><dd>{answerOperationLabels[answerOperationState(state)]}</dd>
      <dt>回执状态</dt><dd>{state.receipt ? { sending: '处理中', done: '操作已结束', unknown: '结果未知', discarded: '输出已丢弃', not_sent: '平台已证明未发送' }[state.receipt.state] : '未核验'}</dd>
      {state.receipt?.modelId && <><dt>实际模型</dt><dd>{state.receipt.modelId}</dd></>}
      {state.receipt?.generatedAt && <><dt>生成时间</dt><dd><time dateTime={state.receipt.generatedAt}>{state.receipt.generatedAt}</time></dd></>}
    </dl>}
    {state.uncertain && !busy && <p className="notice">原操作结果待核验，不能确认未发送或未计费。{!state.operation && !state.registration && '批准登记响应缺失，尚无可核验的原操作 ID；不能确认批准已撤回。'}</p>}
    {state.approval && state.receipt && !state.uncertain && <p className="notice">原批准尚未核验撤回，请先撤回批准再离开。</p>}
    <div className="query-actions">
      {['idle', 'done'].includes(state.phase) && !state.invalidated && !state.approval && !state.uncertain && <button type="button" className="text-command" onClick={onPreview}><Eye size={17} aria-hidden="true"/>重新预览范围</button>}
      {state.phase === 'preview' && <button type="button" className="primary-command" onClick={onApprove} disabled={!confirmed}><CheckCircle2 size={17} aria-hidden="true"/>批准本次范围</button>}
      {state.phase === 'approved' && <button type="button" className="primary-command" onClick={onSend}><Send size={17} aria-hidden="true"/>生成回答</button>}
      {state.operation && state.uncertain && !busy && onInspect && <button type="button" className="text-command" onClick={onInspect}><RefreshCw size={17} aria-hidden="true"/>核验原操作</button>}
      {state.registration && !state.operation && state.uncertain && !busy && onInspectRegistration && <button type="button" className="text-command" onClick={onInspectRegistration}><RefreshCw size={17} aria-hidden="true"/>核验原批准登记</button>}
      {state.registration && state.uncertain && !busy && !state.recovery && onInspectRecovery && <button type="button" className="text-command" onClick={onInspectRecovery}><RefreshCw size={17} aria-hidden="true"/>读取原操作元数据</button>}
      {state.phase === 'revoke_failed' ? <button type="button" className="text-command" onClick={onCancel}><RefreshCw size={17} aria-hidden="true"/>重试撤回批准</button>
        : (state.preview || state.approval || busy) && <button type="button" className="text-command" onClick={onCancel} disabled={state.phase === 'cancelling'}><XCircle size={17} aria-hidden="true"/>{state.approval ? '撤回批准并停止' : '取消本次流程'}</button>}
      {busy && <span role="status" className="metadata">{state.phase === 'previewing' ? '正在核对模型范围' : state.phase === 'approving' ? '正在登记批准' : state.phase === 'sending' ? '正在等待模型与引用校验' : state.phase === 'checking' ? '正在核验原操作回执' : '正在核验撤回'}</span>}
    </div>
  </section>;
}

export function AnswerControls({ request, actorId, reader, onReady, onState, onResult, onFailure, retainOperationRecovery }: {
  request: RetrievalRequest; actorId: string; reader: ReturnType<typeof latestRead>;
  onReady: (flow: AnswerFlow | null) => void; onState: (state: AnswerState) => void;
  onResult: (result: RetrievalResult) => void; onFailure: (error: ApiError) => void;
  retainOperationRecovery?: NavigationProps['retainOperationRecovery'];
}) {
  const [state, setState] = useState(emptyAnswerState); const [confirmed, setConfirmed] = useState(false);
  const [retentionConfirmed, setRetentionConfirmed] = useState(false);
  const flow = useRef<AnswerFlow | null>(null);
  const callbacks = useRef({ onReady, onState, onResult, onFailure, retainOperationRecovery }); callbacks.current = { onReady, onState, onResult, onFailure, retainOperationRecovery };
  useEffect(() => {
    let mounted = true;
    const session = createAnswerFlow({ request, actorId, reader,
      retainOperationRecovery: (input) => callbacks.current.retainOperationRecovery?.(input) ?? Promise.resolve({ ok: false, error: { code: 'NOT_CONFIGURED', message: '恢复保留端口未配置。', retryable: false, dataState: 'unknown', nextAction: 'read_original_operation' } }),
      onState: (value) => { if (mounted) { setState(value); callbacks.current.onState(value); if (value.phase !== 'preview') { setConfirmed(false); setRetentionConfirmed(false); } } },
      onResult: (value) => { if (mounted) callbacks.current.onResult(value); },
      onFailure: (value) => { if (mounted) callbacks.current.onFailure(value); },
    });
    flow.current = session; callbacks.current.onReady(session); void session.preview();
    return () => { mounted = false; session.detach(); flow.current = null; callbacks.current.onReady(null); };
  }, [request, actorId, reader]);
  return <AnswerPanel state={state} confirmed={confirmed} onConfirm={setConfirmed} onPreview={() => void flow.current?.preview()}
    retentionConfirmed={retentionConfirmed} onRetainConfirm={retainOperationRecovery ? setRetentionConfirmed : undefined}
    onApprove={() => void flow.current?.approve(confirmed, retentionConfirmed)} onSend={() => void flow.current?.send()} onCancel={() => void flow.current?.cancel()}
    onInspect={() => void flow.current?.inspect()} onInspectRegistration={() => void flow.current?.inspectRegistration()}
    onInspectRecovery={() => void flow.current?.inspectRecovery()}/>;
}
