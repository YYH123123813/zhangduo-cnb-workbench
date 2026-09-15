import { useEffect, useState } from 'react';
import { History, SearchCheck } from 'lucide-react';
import { apiRequest } from './api-client';
import type { WorkspaceSession } from '../contracts/session';
import { RecoveryAnchorSchema, type RecoveryAnchor, type RecoveryAnchorRead } from '../contracts/recovery-anchor';
import { routeHash } from './routing';

export function RecoveryPanel({ session, generation, recovery, message, navigate }: { session: WorkspaceSession; generation: number;
  recovery: RecoveryAnchorRead | null; message: string; navigate: (hash: string) => boolean }) {
  const [items, setItems] = useState<RecoveryAnchor[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiRequest<unknown>('/api/workspace/recovery-identities', { signal: controller.signal });
        if (controller.signal.aborted) return;
        const parsed = response.ok ? RecoveryAnchorSchema.array().safeParse(response.data) : null;
        if (!parsed?.success || response.meta.mode !== session.workspace.mode) { setError('原操作身份列表暂时无法核验。'); setItems([]); return; }
        setItems(parsed.data.filter((a) => a.actorId === session.actorId && a.workspaceId === session.workspace.id && Date.parse(a.expiresAt) > Date.now())); setError('');
      } catch { if (!controller.signal.aborted) { setError('原操作身份列表暂时无法核验。'); setItems([]); } }
    })();
    return () => controller.abort();
  }, [session.actorId, session.workspace.id, session.workspace.mode, generation]);
  return <details className="recovery-strip" open={recovery !== null || !!message || undefined}>
    <summary><History size={16} aria-hidden="true"/>原操作核验{items.length ? ` (${items.length})` : ''}</summary>
    {error && <p role="status">{error}</p>}
    {!error && !items.length && <p>没有保留中的原操作身份。</p>}
    <ul>{items.map((item) => <li key={item.id}><div><strong>{item.feature === 'retrieval' ? '检索回答' : '应用与回顾'}</strong><code>{item.operation.operationId}</code>
      <span>到期：{new Date(item.expiresAt).toLocaleString()}</span></div><button className="connection-command" onClick={() => navigate(routeHash({ page: item.feature, params: { recoveryId: item.id } }))}><SearchCheck size={16} aria-hidden="true"/>核验</button></li>)}</ul>
    {message && <p role="status">{message}</p>}
    {recovery && <p role="status">{recovery.binding === 'matched' ? '原身份与摘要匹配' : recovery.binding === 'mismatch' ? '原操作摘要不匹配' : '原操作结果仍未确定'}；只读核验，未发送或重试。{recovery.original ? ` 状态：${recovery.original.stage}` : ''}</p>}
  </details>;
}
