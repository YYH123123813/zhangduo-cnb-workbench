import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, RefreshCw, Save, X } from 'lucide-react';
import type { EvidenceReceipt } from '../../contracts/evidence';
import type { EvidenceSaveFlow } from './evidence-save-flow';
import { EvidenceRecordDetails } from './evidence-details';
import type { NavigationProps } from '../../contracts/navigation';
import { RecoveryConsent, useRecoveryConsent } from './recovery-consent';
import { evidenceRecoveryInput } from './recovery-anchor';

const noSubscribe = () => () => {};
const noSnapshot = () => null;
export function useEvidenceSaveState(flow: EvidenceSaveFlow | null) {
  return useSyncExternalStore(flow?.subscribe ?? noSubscribe, flow?.getSnapshot ?? noSnapshot, flow?.getSnapshot ?? noSnapshot);
}

export function EvidenceSavePanel({ flow, onSaved, retainOperationRecovery }: { flow: EvidenceSaveFlow; onSaved?: (receipt: EvidenceReceipt) => void } & NavigationProps) {
  const state = useEvidenceSaveState(flow)!;
  const [confirmed, setConfirmed] = useState(false);
  const [retaining, setRetaining] = useState(false);
  const recovery = useRecoveryConsent(retainOperationRecovery, { actorId: flow.preview.actorId, workspaceId: flow.preview.record.workspaceId });
  const approving = useRef(false);
  const approve = async () => {
    if (approving.current || !confirmed || state.phase !== 'preview') return;
    approving.current = true; setRetaining(true);
    try {
      const retained = await recovery.before((expiry) => evidenceRecoveryInput(flow.preview, expiry));
      if (retained.ok) await flow.approve(confirmed);
    } finally { approving.current = false; setRetaining(false); }
  };
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved;
  const settled = state.phase === 'saved' || state.phase === 'saved_receipt_only' || state.phase === 'cancelled';
  useEffect(() => { if (state.phase === 'saved' && !state.busy && state.receipt) savedCallback.current?.(state.receipt); }, [state.phase, state.busy, state.receipt]);
  return <section className="learning-evidence-save" aria-label="私有证据保存" aria-busy={state.busy}>
    {state.phase !== 'saved_receipt_only' && <EvidenceRecordDetails record={flow.preview.record} saved={state.phase === 'saved'}/>}
    <p>原操作 ID：<code>{flow.preview.operationId}</code></p>
    <p>私有保存直到删除（retention=until_deleted），不进入语义索引。批准和保存是两个独立动作。</p>
    {!settled && <>
      <label className="learning-toggle"><input type="checkbox" name="evidence-retention" required checked={confirmed} disabled={retaining || state.phase !== 'preview'} onChange={(event) => setConfirmed(event.target.checked)}/><span>我确认上述具体内容，批准私有保存直到删除</span></label>
      {retainOperationRecovery && <RecoveryConsent name="evidence-recovery-retention" consent={recovery} disabled={retaining || state.busy || state.phase !== 'preview'}/>}
      <div className="learning-actions">
        <button type="button" disabled={retaining || state.busy || state.phase !== 'preview' || !confirmed} onClick={() => void approve()}><Check size={18}/>登记保存批准</button>
        <button type="button" disabled={state.busy || state.phase !== 'approved' || state.cancelRequested} onClick={() => void flow.save()}><Save size={18}/>{flow.preview.record.kind === 'outcome' ? '保存实际结果' : '保存应用记录'}</button>
        {state.phase !== 'preview' && <button type="button" className="learning-secondary" disabled={state.busy} onClick={() => void flow.verify()}><RefreshCw size={18}/>核验原操作</button>}
        <button type="button" className="learning-secondary" disabled={retaining || state.busy} onClick={() => void flow.cancel()}><X size={18}/>{state.phase === 'preview' ? '取消保存' : '撤回保存批准'}</button>
      </div>
    </>}
    {state.message && <p role="status" className="learning-notice">{state.message}</p>}
    {state.phase === 'saved' && state.receipt && <div role="status"><p>已保存到当前工作区私有证据存储 · persistence=saved · indexing=excluded</p><p>原回执：<code>{state.receipt.operationId}</code> · 记录：<code>{state.receipt.recordId}</code></p></div>}
    {state.phase === 'saved_receipt_only' && state.receipt && <div role="status"><p>原保存回执已核验，但当前不能读取记录正文；未将正文恢复或删除状态冒充为完整保存读回。</p><p>原回执：<code>{state.receipt.operationId}</code> · 记录：<code>{state.receipt.recordId}</code></p></div>}
  </section>;
}
