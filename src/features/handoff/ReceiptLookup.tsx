import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ApiError } from '../../contracts/api';
import { lookupReceipt } from './receipt-lookup';
import type { ReceiptLookupResult } from './receipt-lookup';
import { RequestGate } from './request-gate';
import { ResultPanel } from './ResultPanel';

export function ReceiptLookup({ conversationId, initialChangeSetId, disabled = false }: {
  conversationId: string; initialChangeSetId?: string; disabled?: boolean;
}) {
  const [operationId, setOperationId] = useState(initialChangeSetId ?? '');
  const [result, setResult] = useState<ReceiptLookupResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const requests = useRef(new RequestGate());
  const titleId = useId();
  useEffect(() => {
    requests.current.invalidate(); setBusy(false); setResult(null); setError(null);
    setOperationId(initialChangeSetId ?? '');
    return () => requests.current.invalidate();
  }, [conversationId, initialChangeSetId]);

  async function lookup() {
    if (disabled) return;
    const ticket = requests.current.begin(); if (ticket === null) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const read = await lookupReceipt(conversationId, operationId.trim());
      if (!requests.current.isCurrent(ticket)) return;
      if (read.ok) {
        setResult(read.data);
        requestAnimationFrame(() => document.getElementById(titleId)?.focus());
      } else setError(read.error);
    } finally { if (requests.current.finish(ticket)) setBusy(false); }
  }
  return <details open={Boolean(initialChangeSetId)} className="handoff-receipt-lookup">
    <summary>已有提交记录</summary>
    <form className="handoff-fields" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
      <label htmlFor="handoff-receipt-operation">提交操作 ID</label>
      <input id="handoff-receipt-operation" value={operationId} maxLength={160} disabled={busy || disabled} required
        onChange={(event) => { setOperationId(event.target.value); setResult(null); setError(null); }} />
      <button type="submit" disabled={busy || disabled || !conversationId || !operationId.trim()}><RefreshCw size={17} />核验提交结果</button>
    </form>
    {error && <div className="handoff-error" role="alert"><strong>{error.code}</strong><p>{error.message}</p></div>}
    {result && <ResultPanel receipt={result.receipt} mode={result.mode} titleId={titleId} />}
  </details>;
}
