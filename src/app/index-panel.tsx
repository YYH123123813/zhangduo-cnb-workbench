import { useEffect, useRef, useState } from 'react';
import { Check, Eye, Play, RefreshCw, X } from 'lucide-react';
import { ApprovalSchema, type Approval } from '../contracts/domain';
import { IndexOperationSchema, IndexPlanSchema, IndexStatusSchema, type IndexOperation, type IndexPlan, type IndexStatus } from '../contracts/indexing';
import type { RegisterLeaveGuard } from '../contracts/navigation';
import type { WorkspaceSession } from '../contracts/session';
import { apiRequest } from './api-client';

const labels = { not_requested: '未申请更新', approved: '原范围已批准，尚未发送', pending: '已发送，等待结果', current: '目标版本与配置已核验', failed: '索引失败，Git 正文保留', unknown: '结果未知，禁止重发' };
export function IndexPanel({ registerLeaveGuard, session }: { registerLeaveGuard: RegisterLeaveGuard; session: WorkspaceSession }) {
  const [status, setStatus] = useState<IndexStatus | null>(null), [plan, setPlan] = useState<IndexPlan | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null), [result, setResult] = useState<IndexOperation | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [message, setMessage] = useState('');
  const active = useRef(true), pending = useRef(false), guard = useRef<'clean' | 'dirty' | 'blocked'>('clean');
  const executionRequested = useRef(false);
  guard.current = busy || unknown || approval || result && ['pending', 'unknown'].includes(result.state) ? 'blocked' : 'clean';
  useEffect(() => registerLeaveGuard({ owner: 'workspace', getState: () => guard.current }), [registerLeaveGuard]);
  async function refresh() {
    try {
      const response = await apiRequest<unknown>('/api/workspace/index/status'); if (!active.current) return;
      const parsed = response.ok ? IndexStatusSchema.safeParse(response.data) : null;
      if (parsed?.success && response.meta.mode === session.workspace.mode && parsed.data.operations.every((o) => o.actorId === session.actorId && o.workspaceId === session.workspace.id)) { setStatus(parsed.data); } else setMessage('索引状态无法核验，Git 正文不受影响。');
    } catch { if (active.current) setMessage('索引状态读取失败。'); }
  }
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, []);
  async function operate(action: 'preview' | 'approve' | 'execute' | 'read' | 'revoke', operation?: IndexOperation) {
    if (pending.current) return;
    const originalId = plan?.operationId ?? result?.operationId;
    if (operation && guard.current === 'blocked' && originalId && operation.operationId !== originalId) { setMessage('请先核验当前原操作。'); return; }
    pending.current = true; setBusy(true); setMessage('');
    const id = operation?.operationId ?? originalId;
    try {
      const path = action === 'read' ? `/api/workspace/index/operations/${encodeURIComponent(id!)}` : action === 'revoke'
        ? `/api/workspace/approvals/${encodeURIComponent(approval!.id)}/revoke` : `/api/workspace/index/${action}`;
      const body = action === 'preview' ? { operationId: crypto.randomUUID(), baseRevision: status?.baseRevision }
        : action === 'approve' ? { plan, confirmed } : action === 'execute' ? { operationId: id, approval } : {};
      if (action === 'execute') executionRequested.current = true;
      const response = await apiRequest<unknown>(path, action === 'read' ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body) });
      if (!active.current) return;
      if (!response.ok) { setMessage(`${response.error.message} (${response.error.nextAction})`); if (['approve', 'execute', 'revoke'].includes(action) && response.error.dataState !== 'not_written') setUnknown(true); return; }
      if (response.meta.mode !== session.workspace.mode) throw Error('Mode changed');
      if (action === 'preview') {
        const parsed = IndexPlanSchema.safeParse(response.data); if (!parsed.success || parsed.data.actorId !== session.actorId || parsed.data.workspaceId !== session.workspace.id) throw Error('Invalid plan');
        setPlan(parsed.data); setConfirmed(false); setResult(null); setUnknown(false);
        executionRequested.current = false;
      } else if (action === 'approve') {
        const parsed = ApprovalSchema.safeParse(response.data);
        if (!parsed.success || parsed.data.actorId !== session.actorId || parsed.data.workspaceId !== session.workspace.id || parsed.data.purpose !== 'update_index' || parsed.data.contentHash !== plan?.contentHash || parsed.data.baseRevision !== plan.baseRevision) throw Error('Invalid approval');
        setApproval(parsed.data); setUnknown(false);
      } else if (action === 'revoke') {
        if (!(response.data && typeof response.data === 'object' && 'revoked' in response.data && response.data.revoked === true)) throw Error('Revocation unverified');
        setApproval(null); setUnknown(executionRequested.current); setMessage(executionRequested.current ? '原批准已撤回；这不等于撤销已发送的构建，仍须核验原操作。' : '原索引批准已撤回。');
      }
      else {
        const parsed = IndexOperationSchema.safeParse(response.data);
        if (!parsed.success || parsed.data.operationId !== id || parsed.data.actorId !== session.actorId || parsed.data.workspaceId !== session.workspace.id
          || (plan && plan.operationId === id && (parsed.data.planHash !== plan.contentHash || parsed.data.baseRevision !== plan.baseRevision))) throw Error('Original receipt mismatch');
        if (operation && plan?.operationId !== id) setPlan(null);
        setResult(parsed.data); setUnknown(parsed.data.state === 'unknown');
        if (parsed.data.state !== 'approved') setApproval(null);
      }
      await refresh();
    } catch { if (active.current) { setUnknown(action !== 'preview'); setMessage('原操作结果无法核验，未自动重试。'); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const blocked = busy || unknown || approval !== null || result !== null && ['pending', 'unknown'].includes(result.state);
  return <section className="index-panel" aria-labelledby="index-heading"><h2 id="index-heading">知识库索引</h2>
    <p role="status">{status ? labels[status.state] : '正在读取索引状态'}</p>
    {status && <dl className="properties"><div><dt>当前 Git Commit</dt><dd><code>{status.baseRevision}</code></dd></div><div><dt>Embedding 模型</dt><dd>{status.embeddingModel ?? '未配置'}</dd></div></dl>}
    {status && !status.updateAuthorized && <p>缺少独立索引授权、模型或触发权限；正式知识仍可文本检索。</p>}
    <button className="connection-command" disabled={!status?.updateAuthorized || blocked} onClick={() => void operate('preview')}><Eye size={17} aria-hidden="true"/>核对更新范围</button>
    <button className="connection-command" disabled={busy} onClick={() => void refresh()}><RefreshCw size={17} aria-hidden="true"/>读取索引状态</button>
    {plan && <><dl className="properties"><div><dt>原操作</dt><dd><code>{plan.operationId}</code></dd></div><div><dt>批准范围</dt><dd>{plan.files.length} 个正式知识文件，{plan.totalBytes} 字节；不含 Issue。</dd></div></dl>
      {!approval && !result && <><label className="index-consent"><input type="checkbox" checked={confirmed} disabled={busy || unknown} onChange={(e) => setConfirmed(e.target.checked)}/>同意此范围生成向量并消耗流水线资源；不删除或重建知识库。</label>
        <button className="connection-command" disabled={!confirmed || busy || unknown} onClick={() => void operate('approve')}><Check size={17} aria-hidden="true"/>批准索引更新</button></>}
      {approval && <><button className="connection-command" disabled={busy || unknown} onClick={() => void operate('execute')}><Play size={17} aria-hidden="true"/>开始更新</button>
        <button className="connection-command" disabled={busy} onClick={() => void operate('revoke')}><X size={17} aria-hidden="true"/>撤回原批准</button></>}
      <button className="connection-command" disabled={busy} onClick={() => void operate('read')}><RefreshCw size={17} aria-hidden="true"/>核验原操作</button></>}
    {message && <p role="alert">{message}</p>}
    {result && <p role="status">{labels[result.state]} · {result.reason}</p>}
    <p>索引失败不会撤销 Git 提交。旧向量、WAL 和备份的物理清理未核验。</p>
    {!!status?.operations.length && <ul className="index-operations">{status.operations.map((item) => <li key={item.operationId}><code>{item.operationId}</code><span>{labels[item.state]}</span>
      <button className="connection-command" disabled={busy} onClick={() => void operate('read', item)}><RefreshCw size={17} aria-hidden="true"/>读回</button></li>)}</ul>}
  </section>;
}
