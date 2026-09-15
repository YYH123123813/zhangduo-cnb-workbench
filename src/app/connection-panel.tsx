import { useEffect, useRef, useState } from 'react';
import { LogIn, LogOut, RefreshCw } from 'lucide-react';
import { LOCAL_DEMO_KEY, RuntimeStatusSchema, type RuntimeStatus } from '../contracts/runtime';
import { WorkspaceSessionSchema, type WorkspaceSession } from '../contracts/session';
import { apiRequest } from './api-client';

export function ConnectionForm({ ready, busy, fixture = false, onSubmit }: { ready: boolean; busy: boolean; fixture?: boolean; onSubmit: (key: string) => void }) {
  const [key, setKey] = useState(''), [confirmed, setConfirmed] = useState(false);
  const connectionKey = fixture ? LOCAL_DEMO_KEY : key;
  return <form className="connection-form" onSubmit={(event) => { event.preventDefault(); if (!ready || busy || !confirmed || !/^[a-f0-9]{64}$/.test(connectionKey)) return; onSubmit(connectionKey); setKey(''); setConfirmed(false); }}>
    {!fixture && <label htmlFor="connection-key">本地连接密钥<input id="connection-key" type="password" autoComplete="off" spellCheck={false} value={key} maxLength={64} disabled={!ready || busy} onChange={(event) => setKey(event.target.value)}/></label>}
    <label className="connection-consent"><input type="checkbox" checked={confirmed} disabled={!ready || busy} onChange={(event) => setConfirmed(event.target.checked)}/>{fixture ? '确认连接本机合成工作区；不访问真实 CNB，也不调用模型。' : '确认连接服务端预配的私人仓库'}</label>
    <button type="submit" disabled={!ready || busy || !confirmed || !/^[a-f0-9]{64}$/.test(connectionKey)}><LogIn size={18} aria-hidden="true"/>{fixture ? '进入本机工作区' : '连接工作区'}</button>
  </form>;
}

export function ConnectionPanel({ session, onSession }: { session: WorkspaceSession | null; onSession: (value: WorkspaceSession | null) => void }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef(true), pending = useRef(false), request = useRef<AbortController | null>(null);
  const refresh = async () => {
    try {
      const response = await apiRequest<unknown>('/api/workspace/connection');
      if (!active.current) return;
      const parsed = response.ok ? RuntimeStatusSchema.safeParse(response.data) : null;
      setStatus(parsed?.success ? parsed.data : null);
      if (!parsed?.success) setMessage('连接配置暂时无法核验。');
    } catch { if (active.current) setMessage('连接配置暂时无法读取。'); }
  };
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; request.current?.abort(); }; }, []);
  const operate = async (key?: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(''); const controller = new AbortController(); request.current = controller;
    try {
      const response = await apiRequest<unknown>(key ? '/api/workspace/connect' : '/api/workspace/disconnect', { method: 'POST',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]), ...(key ? { body: JSON.stringify({ connectionKey: key, confirmed: true }) } : {}) });
      if (!active.current || controller.signal.aborted) return;
      if (!response.ok) { setMessage(response.error.code === 'UNAUTHORIZED' ? '连接密钥未通过核验，或会话已失效。' : '操作未能核验，请读取当前会话后继续。'); return; }
      if (key) {
        const parsed = WorkspaceSessionSchema.safeParse(response.data);
        if (!parsed.success || parsed.data.workspace.mode !== response.meta.mode) { setMessage('工作区身份回执无法核验。'); return; }
        onSession(parsed.data);
      } else onSession(null);
      await refresh();
    } catch { if (active.current) setMessage('连接结果未知，请读取当前会话。'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const readSession = async () => {
    try {
      const response = await apiRequest<unknown>('/api/workspace/session'); if (!active.current) return;
      const parsed = response.ok ? WorkspaceSessionSchema.safeParse(response.data) : null;
      if (parsed?.success && response.ok && parsed.data.workspace.mode === response.meta.mode) { onSession(parsed.data); setMessage(''); }
      else if (!response.ok && ['UNAUTHORIZED', 'NOT_CONFIGURED'].includes(response.error.code)) { onSession(null); setMessage('未建立有效会话。'); }
      else setMessage('当前会话仍无法核验。');
    } catch { if (active.current) setMessage('当前会话仍无法核验。'); }
  };
  return <section className="workspace-connection" aria-labelledby="connection-heading">
    <h1 id="connection-heading">{session ? '工作区连接' : '连接工作区'}</h1>
    {!status ? <p role="status">正在读取服务端配置</p> : status.state === 'unconfigured' ? <><p role="status">服务端尚未配置私人工作区。</p><dl className="properties"><div><dt>待配置项</dt><dd>{status.missing.join('、')}</dd></div></dl></> : <p role="status">{session ? session.workspace.slug : status.state === 'revoked' ? '配置已变化，请重新启动服务端。' : '私人工作区配置已加载，身份尚需核验。'}</p>}
    {session ? <button className="connection-command" type="button" disabled={busy} onClick={() => void operate()}><LogOut size={18} aria-hidden="true"/>断开本机所有会话</button>
      : <ConnectionForm fixture={status?.mode === 'fixture'} ready={Boolean(status && ['ready', 'connected', 'unreachable'].includes(status.state))} busy={busy} onSubmit={(key) => void operate(key)}/>}
    <button className="connection-command" type="button" disabled={busy} onClick={() => void readSession()}><RefreshCw size={18} aria-hidden="true"/>读取当前会话</button>
    {message && <p role="alert">{message}</p>}
  </section>;
}
