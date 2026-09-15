import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, FileCheck2, MessageSquare, Plus, RefreshCw, Send, Trash2, User, X } from 'lucide-react';
import { ChatSchema, type MemoryChat } from '../contracts/intelligence';
import type { NavigationProps } from '../contracts/navigation';
import { useIntelligence } from './intelligence-client';
import { chatSendBlockReason, intelligenceLeaveState, recoverFromChat, settleConversationDraft } from './intelligence-ui-state';
import './intelligence.css';

export function ConversationPanel({ registerLeaveGuard, chatId }: NavigationProps & { chatId?: string }) {
  const { data, message, busy, refreshing, readingChat, readingOperation, verified, denied, accessVersion, unresolved, refresh, readChat, readOperation, execute, setMessage } = useIntelligence();
  const [chat, setChat] = useState<MemoryChat | null>(null), [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatVerified, setChatVerified] = useState(false);
  const [title, setTitle] = useState(''), [drafts, setDrafts] = useState<Record<string, string>>({});
  const [deliveredDrafts, setDeliveredDrafts] = useState<Record<string, string>>({});
  const [saveConsent, setSaveConsent] = useState(false), [sendConsent, setSendConsent] = useState<string | null>(null), [archiveConsent, setArchiveConsent] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null), chatHeading = useRef<HTMLHeadingElement>(null);
  const loadSequence = useRef(0), intent = useRef<string | undefined>(undefined);
  const lifetime = useRef(0);
  const inflight = busy || refreshing || readingChat || readingOperation;
  const locked = inflight || !verified || Boolean(unresolved);
  const text = chat ? drafts[chat.id] ?? '' : '';
  const model = data?.providers.find((provider) => provider.id === data.settings.provider);
  const sendScope = chat ? JSON.stringify([chat.id, chat.revision, text, data?.revision, data?.settings.provider, model?.model, model?.ready]) : '';
  const archiveScope = chat ? `${chat.id}:${chat.revision}` : '';
  const alreadyDelivered = Boolean(chat && text.trim() && text.trim() === deliveredDrafts[chat.id]);
  const sendBlocked = !chatVerified ? '会话状态尚未核验。' : !model ? '所选模型状态未知，请只读刷新。' : chat ? chatSendBlockReason(chat, text, model.ready) : '尚未选择会话';
  const guard = useRef<'clean' | 'dirty' | 'blocked'>('clean');
  guard.current = denied ? 'clean' : intelligenceLeaveState(busy, Boolean(unresolved), [title, ...Object.values(drafts)]);
  useEffect(() => registerLeaveGuard?.({ owner: 'conversation', getState: () => guard.current,
    onBlocked: () => setMessage('原操作正在处理或尚未核验，请先只读核验。') }), [registerLeaveGuard, setMessage]);
  useEffect(() => () => { loadSequence.current++; lifetime.current++; }, []);
  useEffect(() => {
    loadSequence.current++; lifetime.current++; setChat(null); setChatVerified(false); setSelectedId(null); setCreating(false); setTitle(''); setDrafts({}); setDeliveredDrafts({});
    setSaveConsent(false); setSendConsent(null); setArchiveConsent(null); intent.current = undefined;
  }, [accessVersion]);
  useEffect(() => { if (sendConsent !== sendScope) setSendConsent(null); }, [sendScope, sendConsent]);
  useEffect(() => { if (archiveConsent !== archiveScope) setArchiveConsent(null); }, [archiveScope, archiveConsent]);
  useEffect(() => { if (creating) titleInput.current?.focus(); else if (chat) chatHeading.current?.focus(); }, [creating, chat?.id]);

  const load = useCallback(async (id: string) => {
    const sequence = ++loadSequence.current;
    setSelectedId(id); setCreating(false); setChat((current) => current?.id === id ? current : null); setChatVerified(false); setSendConsent(null); setArchiveConsent(null);
    const result = await readChat(id);
    if (!result || sequence !== loadSequence.current) return;
    const original = unresolved?.command;
    if (original?.action === 'send' && recoverFromChat(original, result))
      setDeliveredDrafts((current) => ({ ...current, [id]: original.text.trim() }));
    setChat(result); setChatVerified(true);
  }, [readChat, unresolved]);
  useEffect(() => {
    if (!chatId) { intent.current = undefined; return; }
    if (chatId && data && !denied && !busy && intent.current !== chatId) { intent.current = chatId; void load(chatId); }
  }, [chatId, data, denied, busy, load]);
  useEffect(() => {
    if (!chat || chat.status !== 'sending' || busy || unresolved) return;
    const timer = setInterval(() => { if (!document.hidden) void load(chat.id); }, 4000);
    return () => clearInterval(timer);
  }, [chat?.id, chat?.status, busy, unresolved, load]);

  const create = async () => {
    if (locked || !saveConsent || !title.trim()) return;
    const result = await execute({ action: 'create_chat', operationId: crypto.randomUUID(), title, retentionDays: 30, confirmed: true });
    if (result?.ok) {
      const saved = ChatSchema.parse(result.data); setChat(saved); setChatVerified(true); setSelectedId(saved.id); setCreating(false); setTitle(''); setSaveConsent(false);
      setMessage('会话已创建，尚未发送给模型。'); void refresh();
    } else if (result) setSaveConsent(false);
  };
  const send = async () => {
    if (!chat || !data || locked || sendBlocked || alreadyDelivered || sendConsent !== sendScope) return;
    const submitted = text;
    const result = await execute({ action: 'send', id: chat.id, expectedRevision: chat.revision, operationId: crypto.randomUUID(), text, provider: data.settings.provider, modelConsent: true, confirmed: true });
    if (!result) return;
    setSendConsent(null); setArchiveConsent(null);
    if (result.ok) {
      setChat(ChatSchema.parse(result.data)); setChatVerified(true);
      setDrafts((current) => settleConversationDraft(current, chat.id, submitted, true));
      setMessage('本轮消息与回复已保存。'); void refresh();
    } else if (result.error.code === 'CONFLICT') void load(chat.id);
    else if (result.error.code === 'NOT_CONFIGURED') void refresh();
  };
  const archive = async () => {
    if (!chat || !chatVerified || locked || archiveConsent !== archiveScope || !chat.messages.length || chat.status !== 'ready') return;
    const result = await execute({ action: 'archive', id: chat.id, expectedRevision: chat.revision, operationId: crypto.randomUUID(), confirmed: true });
    if (!result) return;
    setArchiveConsent(null);
    if (result.ok) { setMessage('现场已归档，正式知识仍需人工确认。'); void load(chat.id); void refresh(); }
    else if (result.error.code === 'CONFLICT') void load(chat.id);
  };
  const remove = async () => {
    if (!chat || !chatVerified || locked || chat.status === 'sending' || !window.confirm('删除本机会话正文及此会话的未发送草稿？已归档的 CNB Issue、正式知识、训练产物不会同时删除；备份及磁盘历史残留未核验。')) return;
    const result = await execute({ action: 'delete_chat', id: chat.id, expectedRevision: chat.revision, operationId: crypto.randomUUID(), confirmed: true });
    if (result?.ok) {
      setChat(null); setSelectedId(null); setDrafts((current) => { const next = { ...current }; delete next[chat.id]; return next; });
      setMessage('本机会话已删除。CNB 归档、正式知识、训练产物及物理残留未同时删除。'); void refresh();
    } else if (result && result.error.code === 'CONFLICT') void load(chat.id);
  };
  const verifyOriginal = async () => {
    const original = unresolved?.command, recovery = unresolved;
    const sequence = loadSequence.current, epoch = lifetime.current;
    const receipt = await readOperation();
    if (!receipt || epoch !== lifetime.current) return;
    if (receipt?.state === 'completed' && original?.action === 'send') setDeliveredDrafts((current) => ({ ...current, [original.id]: original.text.trim() }));
    if (receipt?.state === 'completed' && original?.action === 'delete_chat') {
      setChat((current) => current?.id === original.id ? null : current);
      setSelectedId((current) => current === original.id ? null : current);
      setDrafts((current) => { const next = { ...current }; delete next[original.id]; return next; });
    }
    void refresh();
    if (sequence !== loadSequence.current) return;
    const id = recovery?.action === 'create_chat' ? recovery.operationId : recovery?.action !== 'delete_chat' ? recovery?.targetId : null;
    if (id) void load(id);
  };

  return <section className="intelligence conversation-workspace" aria-busy={inflight}>
    <header className="intelligence-heading"><div><p className="eyebrow">掌舵 / 对话与沉淀</p><h1><MessageSquare size={25} aria-hidden="true"/>AI 对话</h1></div>
      <button type="button" onClick={() => { setCreating(true); setSaveConsent(false); }} disabled={locked}><Plus size={18} aria-hidden="true"/>新建会话</button></header>
    {message && <p role="status" className="intelligence-message">{message}</p>}
    {unresolved && !denied && <div className="intelligence-message" role="status"><strong>原操作待核验</strong><p>操作编号：{unresolved.operationId}</p>
      <button type="button" onClick={() => void verifyOriginal()} disabled={inflight}><RefreshCw size={16} aria-hidden="true"/>只读核验原操作</button></div>}
    {!data || denied ? <div className="conversation-empty"><p role="status">{denied ? '工作区身份待核验' : refreshing ? '正在读取会话列表' : '尚未取得服务器状态'}</p>
      <button type="button" onClick={() => void refresh()} disabled={inflight}><RefreshCw size={16} aria-hidden="true"/>只读刷新</button><a href="#workspace">工作区状态</a></div>
      : <div className="conversation-layout"><aside className="conversation-list" aria-label="已保存的会话">
        <div className="section-title"><h2>会话</h2><button type="button" className="icon-button" aria-label="刷新会话列表" title="刷新会话列表" disabled={inflight} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true"/></button></div>
        <div className="conversation-choices">{data.chats.map((item) => <button type="button" key={item.id} className={selectedId === item.id && !creating ? 'selected' : ''}
          aria-pressed={selectedId === item.id && !creating} onClick={() => void load(item.id)} disabled={busy}>
          <MessageSquare size={16} aria-hidden="true"/><span>{item.title}<small>{item.status === 'ready' ? new Date(item.createdAt).toLocaleDateString('zh-CN') : item.status === 'sending' ? '发送处理中' : '结果未知'}{drafts[item.id] ? ' / 有草稿' : ''}</small></span></button>)}
        {!data.chats.length && <p className="empty-memory">暂无已保存会话</p>}</div>
        <a className="memory-link" href="#capture">导入已有对话</a>
      </aside><div className="conversation-main">
        {creating ? <form className="conversation-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <h2>新建会话</h2><label htmlFor="chat-title">主题</label><input id="chat-title" ref={titleInput} value={title} maxLength={120} required disabled={locked}
            onChange={(event) => { setTitle(event.target.value); setSaveConsent(false); }}/>
          <label className="intelligence-consent"><input type="checkbox" checked={saveConsent} disabled={locked} onChange={(event) => setSaveConsent(event.target.checked)}/>
            <span>同意在本机私有工作区保存本会话全部消息 30 天，最多 100 条。不自动发送给模型、用于训练或写入 CNB。</span></label>
          <div className="intelligence-actions"><button type="submit" className="primary" disabled={locked || !saveConsent || !title.trim()}><Plus size={17} aria-hidden="true"/>创建</button>
            <button type="button" onClick={() => { setCreating(false); setSaveConsent(false); }} disabled={busy}><X size={17} aria-hidden="true"/>返回会话</button></div>
        </form> : readingChat && !chat ? <p role="status">正在只读核验完整会话，草稿仍保留。</p> : chat ? <>
          <header className="conversation-title"><h2 ref={chatHeading} tabIndex={-1}>{chat.title}</h2><div className="conversation-tools">
            <button type="button" className="icon-button" title="只读核验当前会话" aria-label="只读核验当前会话" onClick={() => void load(chat.id)} disabled={inflight}><RefreshCw size={17} aria-hidden="true"/></button>
            <button type="button" className="icon-button" title="删除本机会话" aria-label="删除本机会话" onClick={() => void remove()} disabled={locked || !chatVerified || chat.status === 'sending'}><Trash2 size={17} aria-hidden="true"/></button></div></header>
          <div className="conversation-meta">本机私有保存 / {new Date(chat.expiresAt).toLocaleDateString('zh-CN')} 到期 / {chat.messages.length} 条消息 / 版本 {chat.revision}</div>
          <ConversationHistory chat={chat}/>
          {chat.status !== 'ready' && <p className="intelligence-message" role="status">{chat.status === 'sending' ? '模型正在处理原消息。' : '原模型结果未知。'}已保存消息不会重发，只能只读核验。</p>}
          <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <div className="section-title"><label htmlFor="chat-message">消息</label><button type="button" className="icon-button" title="清空未发送草稿" aria-label="清空未发送草稿" disabled={busy || !text}
              onClick={() => { if (window.confirm('清空当前未发送草稿？已保存的会话不会删除。')) { setDrafts((current) => ({ ...current, [chat.id]: '' })); setSendConsent(null); } }}><X size={16} aria-hidden="true"/></button></div>
            <textarea id="chat-message" rows={5} maxLength={12000} value={text} aria-describedby="chat-provider chat-limits" disabled={busy}
              onChange={(event) => { setDrafts((current) => ({ ...current, [chat.id]: event.target.value })); setSendConsent(null); }}/>
            <div className="composer-provider" id="chat-provider"><span>{model?.model || data.settings.provider} / {!model ? '模型状态未知' : model.ready ? '服务器已配置' : '服务器未配置'}</span><a href="#intelligence">模型设置</a></div>
            <p className="intelligence-hint" id="chat-limits">{text.length} / 12000 字符{sendBlocked && (text.trim() || !model?.ready) ? `；${sendBlocked}` : ''}</p>
            {alreadyDelivered && <p className="intelligence-message" role="status">此草稿对应的原消息和回复已核验。草稿仍保留，请先编辑或清空后再发送新消息。</p>}
            <label className="intelligence-consent"><input type="checkbox" checked={sendConsent === sendScope} disabled={locked || Boolean(sendBlocked) || alreadyDelivered}
              onChange={(event) => setSendConsent(event.target.checked ? sendScope : null)}/><span>同意将本会话全部历史和本条消息发送给上述模型，并在本机会话到期前保存本轮消息与回复。</span></label>
            <button type="submit" className="primary" disabled={locked || Boolean(sendBlocked) || alreadyDelivered || sendConsent !== sendScope}><Send size={17} aria-hidden="true"/>{busy ? '处理中' : '发送'}</button>
          </form>
          <section className="intelligence-section"><h2>知识交接</h2>{chat.archivedConversationId ? <><p className="intelligence-hint">当前现场已归档，正式知识仍需人工确认。</p><div className="intelligence-actions">
            <a className="memory-command" href={`#capture?conversationId=${encodeURIComponent(chat.archivedConversationId)}`}><FileCheck2 size={17} aria-hidden="true"/>审阅与 AI 提取</a>
            <a className="memory-command" href={`#handoff?conversationId=${encodeURIComponent(chat.archivedConversationId)}&source=manual`}><FileCheck2 size={17} aria-hidden="true"/>手动整理</a></div></>
            : <><label className="intelligence-consent"><input type="checkbox" checked={archiveConsent === archiveScope} disabled={locked || !chatVerified || !chat.messages.length || chat.status !== 'ready'}
              onChange={(event) => setArchiveConsent(event.target.checked ? archiveScope : null)}/><span>同意将当前已保存的全部消息归档到私人 CNB 工作区 Issue。不包含未发送草稿，不自动成为正式知识或训练样本。</span></label>
              <button type="button" onClick={() => void archive()} disabled={locked || !chatVerified || archiveConsent !== archiveScope || !chat.messages.length || chat.status !== 'ready'}><FileCheck2 size={17} aria-hidden="true"/>归档现场</button></>}</section>
        </> : <div className="conversation-empty"><MessageSquare size={38} aria-hidden="true"/><h2>对话现场</h2><p>{selectedId ? '尚未取得此会话正文，未发送草稿仍保留。' : '尚未选择会话'}</p>
          {selectedId && <button type="button" onClick={() => void load(selectedId)} disabled={inflight}><RefreshCw size={16} aria-hidden="true"/>只读重查会话</button>}
          <a className="memory-link" href="#intelligence">模型与权重</a></div>}
      </div></div>}
  </section>;
}

export function ConversationHistory({ chat }: { chat: MemoryChat }) {
  return <div className="conversation-messages" role="region" aria-label="完整对话">
    {chat.messages.map((entry) => <article key={entry.id} className={`conversation-message ${entry.role}`}><header>
      {entry.role === 'user' ? <User size={17} aria-hidden="true"/> : <Bot size={17} aria-hidden="true"/>}<strong>{entry.role === 'user' ? '我' : 'AI'}</strong>
      <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></header><p>{entry.text}</p></article>)}
    {!chat.messages.length && <p className="empty-memory">此会话还没有消息。</p>}
  </div>;
}
