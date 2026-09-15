import { useEffect, useRef, useState } from 'react';
import { Link2, RefreshCw, Save, X } from 'lucide-react';
import type { ApiError } from '../../contracts/api';
import type { HandoffOperationReceipt } from '../../contracts/handoff-operation';
import { lookupOriginalOperation } from './operation-client';
import type { OriginalLookupResult } from './operation-client';
import { PreviewPanel } from './PreviewPanel';
import { RequestGate } from './request-gate';
import { ResultPanel } from './ResultPanel';

export function OperationSavePanel({ consent, busy, unknown, saved, onConsent, onSave, onRead, href, onPin, pinning = false, pinned = false }: {
  consent: boolean; busy: boolean; unknown: boolean; saved: HandoffOperationReceipt | null;
  onConsent: (value: boolean) => void; onSave: () => void; onRead: () => void; href: string;
  onPin?: () => void; pinning?: boolean; pinned?: boolean;
}) {
  return <section className="handoff-fields" aria-label="原预览私有保存">
    <h3>原预览保存</h3>
    {saved ? <><p role="status">本次原预览已私有保存，有效期至 {new Date(saved.expiresAt).toLocaleString()}。<a href={href} target="_blank" rel="noreferrer">打开原预览（只读）</a></p>
      {onPin && <div className="handoff-actions"><button type="button" disabled={busy || pinning || pinned} onClick={onPin}><Link2 size={17} />{pinned ? '当前操作地址已固定' : pinning ? '正在固定操作地址' : '固定当前操作地址'}</button>
        {pinned && <span role="status">地址已替换为本次原操作，当前审阅页面仍保留。</span>}</div>}</> :
      unknown ? <div role="status"><p>原预览保存结果未知；原操作 ID 保留，未重发。</p>
        <button type="button" disabled={busy} onClick={onRead}><RefreshCw size={17} />核验原预览保存</button></div> : <>
        <label className="handoff-check"><input id="handoff-original-save-consent" type="checkbox" checked={consent} disabled={busy}
          onChange={(event) => onConsent(event.target.checked)} />同意私有保存本次完整预览、原句、理由与时间，最长30天且不超过原草稿期限，不入 Git 或索引</label>
        <button type="button" disabled={busy || !consent} onClick={onSave}><Save size={17} />保存本次原预览</button>
      </>}
    {!saved && !unknown && <p>本次原预览尚未持久保存。</p>}
  </section>;
}

export function OriginalOperationLookup({ conversationId, initialChangeSetId, disabled = false, actorId, workspaceId, draftId, source, operationHash }: {
  conversationId: string; initialChangeSetId?: string; disabled?: boolean; actorId?: string; workspaceId?: string;
  draftId?: string; source?: string; operationHash?: string;
}) {
  const [operationId, setOperationId] = useState(initialChangeSetId ?? '');
  const [result, setResult] = useState<(OriginalLookupResult & { scope: string }) | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const requests = useRef(new RequestGate());
  const scope = JSON.stringify([conversationId, initialChangeSetId, actorId, workspaceId, draftId, source, operationHash]);
  async function lookup(id = operationId.trim()) {
    if (disabled) return;
    const ticket = requests.current.beginReplacingRead(); if (ticket === null) return;
    setBusy(true); setResult(null); setError(null);
    try {
      const read = await lookupOriginalOperation(conversationId, id, undefined, { actorId, workspaceId, draftId, source, operationHash });
      if (!requests.current.isCurrent(ticket)) return;
      if (!read.ok) setError(read.error);
      else { setResult({ ...read.data, scope }); requestAnimationFrame(() => document.getElementById('handoff-preview-title')?.focus()); }
    } finally { if (requests.current.finish(ticket)) setBusy(false); }
  }
  useEffect(() => {
    requests.current.invalidate(); setBusy(false); setResult(null); setError(null); setOperationId(initialChangeSetId ?? '');
    if (initialChangeSetId && conversationId && !disabled) void lookup(initialChangeSetId);
    return () => requests.current.invalidate();
  }, [scope, disabled]);
  const visible = !disabled && result?.scope === scope ? result : null;
  const recovery = visible?.view.recovery, approval = recovery?.approval;
  return <details open={Boolean(initialChangeSetId)} className="handoff-receipt-lookup">
    <summary>原提交预览（只读）</summary>
    <form className="handoff-fields" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
      <label htmlFor="handoff-original-operation">原提交操作 ID</label>
      <input id="handoff-original-operation" value={operationId} maxLength={160} required disabled={busy || disabled}
        onChange={(event) => { setOperationId(event.target.value); setResult(null); setError(null); }} />
      <div className="handoff-actions"><button type="submit" disabled={busy || disabled || !conversationId || !operationId.trim()}><RefreshCw size={17} />恢复原预览</button>
        {(busy || result) && <button type="button" onClick={() => { requests.current.cancelReplacingRead(); setBusy(false); setResult(null); setError(null); }}><X size={17} />{busy ? '取消本次读取' : '关闭原预览'}</button>}</div>
    </form>
    {error && <div className="handoff-error" role="alert"><strong>{error.code}</strong><p>{error.message}</p></div>}
    {result && recovery?.preview && <>
      <p>原私有草稿版本：{result.view.storage.draftRevision} · 保存时间：{new Date(result.view.storage.storedAt).toLocaleString()} · 有效期至：{new Date(result.view.storage.expiresAt).toLocaleString()}</p>
      <p>原批准状态：{approval ? ({ registered: '已登记', revoked: '已撤回', expired: '已过期', unknown: '未知', not_registered: '未查到登记，结果仍未知' })[approval.status] : '未知'}</p>
      {recovery.error && <p role="status">{recovery.error.message}</p>}
      <PreviewPanel preview={recovery.preview} readOnly gitState={recovery.receipt ? 'saved' : 'unknown'}>
        <p>原提交理由：{recovery.preview.changes.reason}</p>
        <p>原确认时间：{recovery.preview.changes.nodes[0]?.confirmedAt}</p>
      </PreviewPanel>
      {recovery.receipt && <ResultPanel receipt={recovery.receipt} mode={result.mode} nodeId={recovery.preview.changes.nodes[0]!.id} conversationId={conversationId} />}
    </>}
  </details>;
}
