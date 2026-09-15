import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { NavigationProps } from '../../contracts/navigation';
import { createRestoredAnswerFlow, restoredAnswerState, type RestoredAnswerState } from './restored-answer';
import { AnswerRecoveryMetadata } from './answer-view';

const labels: Record<RestoredAnswerState['status'], string> = {
  checking: '正在核验', matched: '元数据匹配', unknown: '结果未知', mismatch: '绑定不匹配', missing: '身份不可读取', expired: '已过期', unauthorized: '身份或权限待复核',
};
export function AnswerRecoveryPanel({ state, onInspect }: { state: RestoredAnswerState; onInspect: () => void }) {
  return <section id="retrieval-recovered-answer" className="model-answer" aria-label="原回答操作只读核验" tabIndex={-1} aria-busy={state.status === 'checking'}>
    <h2>原回答操作</h2><p role="status">{labels[state.status]}：{state.message}</p>
    {state.identity && <dl className="node-meta"><dt>原登记 ID</dt><dd><code>{state.identity.operation.operationId}</code></dd>
      <dt>原内容摘要</dt><dd><code>{state.identity.binding.contentHash}</code></dd><dt>原知识版本</dt><dd><code>{state.identity.binding.baseRevision}</code></dd>
      <dt>身份保留期限</dt><dd><time dateTime={state.identity.expiresAt}>{state.identity.expiresAt}</time></dd></dl>}
    {state.metadata && <AnswerRecoveryMetadata metadata={state.metadata}/>}
    <p className="notice">未恢复查询、模型输入或回答正文。元数据不代表回答或引用有效，也不是未发送证明。</p>
    {state.status !== 'missing' && <button type="button" className="text-command" onClick={onInspect} disabled={state.status === 'checking'}><RefreshCw size={17} aria-hidden="true"/>核验原回答操作</button>}
  </section>;
}

export function AnswerRecoveryPage({ recoveryIdentity, registerLeaveGuard }: Pick<NavigationProps, 'recoveryIdentity' | 'registerLeaveGuard'>) {
  const [state, setState] = useState(() => restoredAnswerState('checking', '正在核对原工作区身份'));
  const active = useRef<ReturnType<typeof createRestoredAnswerFlow> | null>(null);
  const current = useRef(recoveryIdentity); current.current = recoveryIdentity;
  useEffect(() => {
    const flow = createRestoredAnswerFlow({ onState: setState }); active.current = flow;
    void flow.restore(recoveryIdentity ?? null);
    const verify = () => { void flow.restore(current.current ?? null); };
    window.addEventListener('focus', verify); window.addEventListener('online', verify);
    return () => { flow.dispose(); active.current = null; window.removeEventListener('focus', verify); window.removeEventListener('online', verify); };
  }, [recoveryIdentity]);
  useEffect(() => registerLeaveGuard?.({ owner: 'retrieval', getState: () => 'blocked',
    onBlocked: () => document.getElementById('retrieval-recovered-answer')?.focus() }), [registerLeaveGuard]);
  useEffect(() => {
    if (!state.identity) return;
    const timer = setTimeout(() => active.current?.expire(), Math.max(0, Date.parse(state.identity.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [state.identity]);
  const visible = state.identity && (state.identity.id !== recoveryIdentity?.identity?.id || state.identity.actorId !== recoveryIdentity?.identity?.actorId
    || state.identity.workspaceId !== recoveryIdentity?.identity?.workspaceId)
    ? restoredAnswerState(recoveryIdentity ? 'checking' : 'missing', '原恢复身份已变化，正在重新核验。') : state;
  return <div className="retrieval"><header className="retrieval-heading"><h1>知识与检索</h1></header>
    <AnswerRecoveryPanel state={visible} onInspect={() => void active.current?.inspect()}/></div>;
}
