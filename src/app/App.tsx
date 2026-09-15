import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BookOpen, Inbox, FileCheck2, Network, ClipboardCheck, ShieldCheck, PanelsTopLeft, MessageSquare, Settings2 } from 'lucide-react';
import { Page as Capture } from '../features/capture/client';
import { Page as Handoff } from '../features/handoff/client';
import { Page as Retrieval } from '../features/retrieval/client';
import { Page as Learning } from '../features/learning/client';
import { Page as Governance } from '../features/governance/client';
import { apiRequest } from './api-client';
import { CONTRACT_VERSION, type RetrievalResult, type TaskContext } from '../contracts/domain';
import type { AppRoute, NavigationProps } from '../contracts/navigation';
import type { ApiResponse } from '../contracts/api';
import { bindHashNavigation, HashNavigation, routeHash } from './routing';
import { sessionKey, TransientRetrieval } from './transient-retrieval';
import { canRenderPage, settleSession, type SessionState } from './session-state';
import { ConnectionPanel } from './connection-panel';
import type { WorkspaceSession } from '../contracts/session';
import { hasRecoveryIntent, readRecoveryIdentity, recoveryForRoute, retainRecoveryIdentity, type RecoveryDelivery } from './recovery-client';
import { RecoveryPanel } from './recovery-panel';
import { IndexPanel } from './index-panel';
import { unavailable } from '../contracts/api';
import { IntelligencePanel } from './intelligence-panel';
import { ConversationPanel } from './conversation-panel';
import { SessionRequestBoundary } from './session-request-boundary';

const pages = [
  { id: 'conversation', label: 'AI 对话', icon: MessageSquare },
  { id: 'capture', label: '对话现场', icon: Inbox },
  { id: 'handoff', label: '知识交接', icon: FileCheck2 },
  { id: 'retrieval', label: '知识与检索', icon: Network },
  { id: 'learning', label: '应用与回顾', icon: ClipboardCheck },
  { id: 'governance', label: '版本与控制', icon: ShieldCheck },
  { id: 'intelligence', label: '模型与权重', icon: Settings2 },
] as const;

export function PageOutlet({ route, exchange, onResult, onInvalidateResult, ...navigation }: NavigationProps & {
  route: AppRoute; exchange: TransientRetrieval; onResult: (task: TaskContext, result: RetrievalResult) => void; onInvalidateResult: () => void;
}) {
  const recoveryRequested = hasRecoveryIntent(route);
  if (recoveryRequested && !navigation.recoveryIdentity) return <RecoveryAwaiting owner={route.page as 'learning' | 'retrieval'} registerLeaveGuard={navigation.registerLeaveGuard}/>;
  if (route.page === 'capture') return <Capture {...navigation} routeParams={route.params}/>;
  if (route.page === 'handoff') return <Handoff {...navigation} params={route.params}/>;
  if (route.page === 'retrieval') return <Retrieval {...navigation} recoveryRequested={recoveryRequested} task={exchange.taskFor(route.params.taskId)} nodeId={route.params.nodeId} revision={route.params.revision} onResult={onResult} onInvalidateResult={onInvalidateResult}/>;
  if (route.page === 'learning') return <Learning {...navigation} recoveryRequested={recoveryRequested} routeParams={route.params} retrieved={exchange.forLearning(route.params)}/>;
  if (route.page === 'governance') return <Governance {...navigation} routeParams={route.params} nodeId={route.params.nodeId} revision={route.params.revision}/>;
  if (route.page === 'conversation') return <ConversationPanel {...navigation} chatId={route.params.chatId}/>;
  if (route.page === 'intelligence') return <IntelligencePanel {...navigation}/>;
  return null;
}

function RecoveryAwaiting({ owner, registerLeaveGuard }: Pick<NavigationProps, 'registerLeaveGuard'> & { owner: 'learning' | 'retrieval' }) {
  useEffect(() => registerLeaveGuard?.({ owner, getState: () => 'blocked' }), [owner, registerLeaveGuard]);
  return <section className="module"><h1>原操作核验</h1><p role="status">原操作身份尚未核验。</p></section>;
}

export function App() {
  const [navigation] = useState(() => new HashNavigation(typeof window === 'undefined' ? '' : window.location.hash, {
    write: (hash, replace) => { window.history[replace ? 'replaceState' : 'pushState'](null, '', `${window.location.pathname}${window.location.search}${hash}`); },
    confirmDiscard: () => window.confirm('当前页面有未保存内容。确认放弃这些内容并离开？'),
  }));
  const route = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const hash = routeHash(route);
  const [exchange] = useState(() => new TransientRetrieval());
  const [session, setSession] = useState<SessionState>({ hash: '', value: null, message: '正在核对工作区', verified: false });
  const latestSession = useRef(session);
  const main = useRef<HTMLElement>(null);
  const installedIdentity = useRef('unconfigured');
  const [recoveryDelivery, setRecoveryDelivery] = useState<RecoveryDelivery | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [recoveryGeneration, setRecoveryGeneration] = useState(0);
  const ready = canRenderPage(session, hash, route.page);
  const recovery = recoveryForRoute(recoveryDelivery, session.value, session.verified, route);
  useEffect(() => {
    if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    return bindHashNavigation(navigation, window, document);
  }, [navigation]);
  useEffect(() => {
    let controller: AbortController | undefined;
    let active = true;
    if (['capture', 'handoff', 'governance'].includes(route.page)) exchange.invalidate();
    const verify = async () => {
      controller?.abort(); const request = new AbortController(); controller = request;
      let response: ApiResponse<unknown> | null = null;
      try {
        response = await apiRequest<unknown>('/api/workspace/session', { signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) });
      } catch { if (request.signal.aborted || !active) return; }
      if (request.signal.aborted || !active) return;
      const settled = settleSession(latestSession.current, hash, response);
      exchange.bind(settled.verified ? settled.value : null); installedIdentity.current = sessionKey(settled.verified ? settled.value : null);
      latestSession.current = settled; setSession(settled);
    };
    void verify(); window.addEventListener('focus', verify);
    return () => { active = false; controller?.abort(); window.removeEventListener('focus', verify); };
  }, [exchange, hash, route.page]);
  useEffect(() => { if (ready) { main.current?.focus(); document.title = `${pages.find((page) => page.id === route.page)?.label ?? '工作区'} · 掌舵`; } }, [hash, ready, route.page]);
  const onResult = useCallback((task: TaskContext, result: RetrievalResult) => {
    if (session.verified && navigation.getSnapshot().page === 'retrieval' && session.hash === hash && installedIdentity.current === sessionKey(session.value)) exchange.accept(task, result);
  }, [exchange, navigation, session, hash]);
  const onInvalidateResult = useCallback(() => exchange.invalidate(), [exchange]);
  const onSession = useCallback((value: WorkspaceSession | null) => {
    const next = { hash, value, verified: value !== null, message: value ? '私有工作区' : '工作区会话已断开' };
    exchange.bind(value); installedIdentity.current = sessionKey(value); latestSession.current = next; setSession(next);
  }, [hash, exchange]);
  const retainOperationRecovery = useCallback<NonNullable<NavigationProps['retainOperationRecovery']>>(async (input) => {
    const current = latestSession.current;
    if (!current.verified || !current.value || input.feature !== navigation.getSnapshot().page) return unavailable('请核对原工作区身份。');
    const originalIdentity = sessionKey(current.value);
    const result = await retainRecoveryIdentity(current.value, input);
    if (!latestSession.current.verified || originalIdentity !== sessionKey(latestSession.current.value)) return unavailable('工作区身份已变化。');
    if (result.ok) setRecoveryGeneration((value) => value + 1);
    return result;
  }, [navigation]);
  useEffect(() => {
    setRecoveryDelivery(null); setRecoveryMessage('');
    if (!session.verified || !session.value || !route.params.recoveryId) return;
    const controller = new AbortController();
    const originalSessionKey = sessionKey(session.value);
    setRecoveryMessage('正在只读核验原操作');
    void readRecoveryIdentity(session.value, route, fetch, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRecoveryDelivery(result.ok && result.data ? { sessionKey: originalSessionKey, value: result.data } : null);
      setRecoveryMessage(result.ok ? result.data ? '' : '原操作身份不存在或已到期；不能据此判断业务是否执行。' : result.error.message);
    });
    return () => controller.abort();
  }, [route, session.verified, sessionKey(session.value)]);
  return <div className="shell">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); main.current?.focus(); }}>跳到主内容</a>
    <aside className="sidebar"><a href="#retrieval" className="brand"><BookOpen size={23} aria-hidden="true"/><span>掌舵</span></a>
      <p className="workspace-label">CNB 个人知识工作台</p>
      <nav aria-label="工作区">{pages.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} aria-current={route.page === id ? 'page' : undefined}><Icon size={18} aria-hidden="true"/><span>{label}</span></a>)}</nav>
      <div className="sidebar-foot"><a href="#workspace" aria-current={route.page === 'workspace' ? 'page' : undefined}><PanelsTopLeft size={17} aria-hidden="true"/>工作区状态</a></div>
    </aside>
    <div className="content"><header className="topbar"><span>{session.value?.workspace.slug ?? '个人工作区'}</span><span className="connection" role="status">{ready ? session.verified && session.value?.workspace.mode === 'fixture' ? 'Fixture 合成数据' : session.message : '正在核对工作区'}</span></header>
      <main id="main-content" className="shell-main" tabIndex={-1} ref={main}>
        {ready && session.verified && session.value && <RecoveryPanel key={sessionKey(session.value)} session={session.value} generation={recoveryGeneration}
          recovery={recovery} message={recoveryMessage} navigate={(next) => navigation.navigate(next)}/>}
        {!ready ? <p className="state-line" role="status">正在读取工作区状态</p>
          : route.page === 'invalid' ? <section className="module"><h1>页面地址无效</h1><p role="alert">入口参数不受支持，未加载其他现场或知识。</p><a className="shell-link" href="#retrieval">返回知识与检索</a></section>
          : !session.value ? <ConnectionPanel key={hash} session={null} onSession={onSession}/>
          : route.page === 'workspace' ? <section className="module"><ConnectionPanel session={session.value} onSession={onSession}/><dl className="properties">
            <div><dt>CNB 工作区</dt><dd>{session.value?.workspace.slug ?? session.message}</dd></div>
            <div><dt>当前身份</dt><dd>{session.value?.actorId ?? '未建立可信会话'}</dd></div>
            <div><dt>接口契约</dt><dd>{CONTRACT_VERSION}</dd></div>
            <div><dt>数据模式</dt><dd>{session.value?.workspace.mode === 'fixture' ? '合成数据，非真实 CNB' : session.value?.workspace.mode === 'live' ? '授权工作区，具体写入需独立确认' : '未配置，无真实读写'}</dd></div>
          </dl><IndexPanel key={sessionKey(session.value)} session={session.value} registerLeaveGuard={navigation.registerLeaveGuard}/></section>
          : <SessionRequestBoundary key={`${route.page}:${sessionKey(session.value)}`} session={session.value}><PageOutlet route={route} exchange={exchange} registerLeaveGuard={navigation.registerLeaveGuard} pinHandoffOperation={navigation.pinHandoffOperation}
            retainOperationRecovery={retainOperationRecovery} recoveryIdentity={recovery}
            onResult={onResult} onInvalidateResult={onInvalidateResult}/></SessionRequestBoundary>
        }
      </main>
    </div>
  </div>;
}
