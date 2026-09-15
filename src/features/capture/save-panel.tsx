import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FileSearch, RefreshCw, Save, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { Conversation, TaskContext } from '../../contracts/domain';
import type { SourceDraft } from './parse';
import type { TaskDraft } from './task';
import type { PreviewInput } from './preview';
import { CaptureSaveFlow } from './save-flow';
import type { NavigationProps } from '../../contracts/navigation';
import { captureHref } from './links';

export function SavePanel({ task, source, segments, onLock, onSaved, registerLeaveGuard }: { task: TaskDraft; source: SourceDraft; segments: Conversation['segments']; onLock: (value: boolean) => void; onSaved: (value: Conversation, task: TaskContext) => void } & NavigationProps) {
  const [id] = useState(() => crypto.randomUUID());
  const [flow] = useState(() => new CaptureSaveFlow(apiRequest));
  const { phase, preview, saved, message, mode, sent, approvalId, approvalState, registrationIdentity } = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  const [blockedNotice, setBlockedNotice] = useState('');
  const callbacks = useRef({ onLock, onSaved }); callbacks.current = { onLock, onSaved };
  const notified = useRef<Conversation | null>(null);
  const locked = flow.getLeaveState() === 'blocked';
  useEffect(() => { flow.activate(); return () => { flow.dispose(); callbacks.current.onLock(false); }; }, [flow]);
  useEffect(() => registerLeaveGuard?.({ owner: 'capture', getState: flow.getLeaveState, onBlocked: () => setBlockedNotice('保存或原批准仍需核验；请先使用本节的核验或撤回入口。') }), [flow, registerLeaveGuard]);
  useEffect(() => { callbacks.current.onLock(locked); }, [locked]);
  useEffect(() => { if (saved && preview && notified.current !== saved) { notified.current = saved; callbacks.current.onSaved(saved, preview.task); } }, [saved, preview]);
  function prepare() {
    let descriptor: PreviewInput['source'];
    if (source.origin === 'cnb_issue') {
      if (!source.issueNumber || !source.sourceRevision) return;
      descriptor = { origin: 'cnb_issue', issueNumber: source.issueNumber, sourceRevision: source.sourceRevision };
    } else descriptor = { origin: source.origin };
    void flow.prepare({ conversationId: id, task, source: descriptor, segments, personalInfoReviewed: true, scopeConfirmed: true });
  }
  return <section className="capture-section" aria-labelledby="capture-save-title">
    <h2 id="capture-save-title">确认保存</h2>
    {mode && <p>{mode === 'fixture' ? 'Fixture测试数据，非真实CNB' : mode === 'live' ? 'Live工作区，写入将产生真实副作用' : '未配置工作区'}</p>}
    {preview && <dl className="capture-purpose"><div><dt>保存位置</dt><dd>CNB新现场；不覆盖原Issue</dd></div><div><dt>工作区</dt><dd>{preview.conversation.workspaceId}</dd></div><div><dt>内容摘要</dt><dd><code>{preview.conversation.contentHash}</code></dd></div><div><dt>操作ID</dt><dd><code>{id}</code></dd></div><div><dt>保存片段</dt><dd>{preview.conversation.segments.length}段</dd></div></dl>}
    <div className="capture-actions">
      {!preview && <button type="button" disabled={phase === 'previewing' || !task.question.trim() || (source.origin === 'cnb_issue' && (!source.issueNumber || !source.sourceRevision))} onClick={prepare}><FileSearch size={16} aria-hidden="true"/>生成保存预览</button>}
      {preview && !sent && <button type="button" disabled={locked} onClick={() => { setBlockedNotice(''); void flow.save(); }}><Save size={16} aria-hidden="true"/>确认保存至CNB</button>}
      {preview && !sent && approvalState === 'active' && phase === 'unknown' && <button type="button" onClick={() => { setBlockedNotice(''); void flow.continueOriginal(); }}><Save size={16} aria-hidden="true"/>继续原批准保存至CNB</button>}
      {phase !== 'saved' && <button type="button" disabled={approvalState === 'revoking'} onClick={() => { setBlockedNotice(''); void flow.cancel(); }}><X size={16} aria-hidden="true"/>{approvalId && approvalState === 'unknown' ? '重试撤回原批准' : '停止后续操作'}</button>}
      {sent && phase !== 'saved' && <button type="button" disabled={phase === 'saving' || phase === 'checking' || approvalState === 'revoking'} onClick={() => { setBlockedNotice(''); void flow.readBack(); }}><RefreshCw size={16} aria-hidden="true"/>按原ID核验</button>}
      {registrationIdentity && phase !== 'saved' && <button type="button" disabled={phase === 'saving' || phase === 'checking' || approvalState === 'revoking'} onClick={() => { setBlockedNotice(''); void flow.readApprovalRegistration(); }}><RefreshCw size={16} aria-hidden="true"/>核验原批准登记</button>}
    </div>
    {preview && <p><a href={captureHref(id)}>本次现场恢复入口</a></p>}
    {approvalId && <p>原保存批准ID：<code>{approvalId}</code></p>}
    {registrationIdentity && <p>原保存登记ID：<code>{registrationIdentity.operationId}</code></p>}
    {(blockedNotice || message) && <p role="status" className="capture-notice">{blockedNotice || message}</p>}
  </section>;
}
