import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import { readEvidenceOperation, type EvidenceOperationView } from './evidence-recovery';
import { EvidenceRecordDetails } from './evidence-details';

export function EvidenceRecoveryPanel({ actorId, workspaceId }: { actorId: string; workspaceId: string }) {
  const [operationId, setOperationId] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [view, setView] = useState<EvidenceOperationView | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const read = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setBusy(true); setNotice(''); setView(null);
    const result = await readEvidenceOperation((path) => apiRequest(path, { signal: abort.signal }), { actorId, workspaceId }, operationId.trim());
    if (abort.signal.aborted) return;
    setBusy(false); if (result.ok) { setView(result.data); setNotice(result.data.message); } else setNotice(result.error.message);
  };
  return <section aria-label="原保存操作恢复"><div className="learning-section-heading"><h2>核验原保存操作</h2></div>
    <form onSubmit={(event) => void read(event)}><label>原操作 ID<input name="original-evidence-operation" required maxLength={160} value={operationId} disabled={busy} onChange={(event) => { setOperationId(event.target.value); setView(null); setNotice(''); }}/></label>
      <div className="learning-actions"><button type="submit" disabled={busy || !operationId.trim()}><RefreshCw size={18}/>读取原操作</button></div></form>
    {notice && <p role="status" className="learning-notice">{notice}</p>}
    {view && <><p>批准状态：{{ registered: '已登记', revoked: '已撤回', expired: '已过期', not_registered: '尚未读到', unknown: '未知' }[view.approvalStatus] ?? '未知'} · 原操作 <code>{view.operationId}</code></p>
      {view.operationRecovery && <p>共享恢复阶段：{{ not_registered: '尚未登记', approved: '已批准', sending: '发送中', saving: '保存中', saved: '已保存', executed: '已执行', unknown: '未知', done: '已完成', discarded: '已丢弃', not_sent: '未发送', expired: '已过期', revoked: '已撤回', failed: '失败' }[view.operationRecovery.stage] ?? '未知'} · 仅为只读元数据，不替代原回执核验</p>}
      {view.receipt && <p>原保存回执：<code>{view.receipt.operationId}</code> · 记录 <code>{view.receipt.recordId}</code> · indexing=excluded</p>}
      {view.record && <EvidenceRecordDetails record={view.record}/>}</>}
  </section>;
}
