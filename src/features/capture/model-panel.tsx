import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FileSearch, RefreshCw, Send, X } from 'lucide-react';
import type { Conversation, TaskContext } from '../../contracts/domain';
import { apiRequest } from '../../app/api-client';
import type { ModelPreview, ModelScope } from './model-input';
import type { DeliveryReceipt } from './delivery';
import type { CaptureStatus } from './status';
import { safeDisplayText } from './redaction';
import { CaptureModelFlow } from './model-flow';
import { checkModelPreview } from './model-preview-receipt';
import type { NavigationProps } from '../../contracts/navigation';
import { captureHref } from './links';
import { canStartModelExtraction, shouldAutoDiscoverModelOperations, shouldOfferDiscoveryRetry } from './model-panel-guards';

export function ModelPanel({ conversation, task: initialTask, status, storedDelivery, onDelivery, onUnknown, onLock, registerLeaveGuard, recoveryApprovalId, allowInitialExtraction = false }: { conversation: Conversation; task?: TaskContext; status: CaptureStatus | null; storedDelivery: DeliveryReceipt | null; onDelivery: (value: DeliveryReceipt) => void; onUnknown: () => void; onLock: (value: boolean) => void; recoveryApprovalId?: string; allowInitialExtraction?: boolean } & NavigationProps) {
  const [enabled, setEnabled] = useState(initialTask?.mode === 'assisted');
  const [task, setTask] = useState<TaskContext>(() => initialTask ?? { id: conversation.taskId, workspaceId: conversation.workspaceId, question: '', constraints: [], mode: 'assisted', updatedAt: new Date().toISOString() });
  const [ids, setIds] = useState(conversation.segments.map((s) => s.id));
  const [preview, setPreview] = useState<ModelPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [recoveryId, setRecoveryId] = useState('');
  const [flow] = useState(() => new CaptureModelFlow(apiRequest, conversation));
  const operation = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  const unknown = flow.getLeaveState() === 'blocked';
  const busy = previewBusy || ['sending', 'checking'].includes(operation.phase) || operation.registration === 'revoking';
  const canExtract = canStartModelExtraction(operation, storedDelivery, allowInitialExtraction);
  const active = useRef<AbortController | null>(null);
  const dirty = useRef(false);
  const callbacks = useRef({ onDelivery, onUnknown, onLock }); callbacks.current = { onDelivery, onUnknown, onLock };
  const notified = useRef<DeliveryReceipt | null>(null);
  useEffect(() => { flow.activate(); return () => { active.current?.abort(); active.current = null; flow.dispose(); callbacks.current.onLock(false); }; }, [flow]);
  useEffect(() => {
    if (initialTask && initialTask.id === conversation.taskId && initialTask.workspaceId === conversation.workspaceId && !flow.getSnapshot().sent && flow.getLeaveState() !== 'blocked') {
      active.current?.abort(); active.current = null; setPreviewBusy(false); setPreview(null); setTask(initialTask); setEnabled(initialTask.mode === 'assisted');
    }
  }, [initialTask, conversation.taskId, conversation.workspaceId, flow]);
  useEffect(() => registerLeaveGuard?.({ owner: 'capture', getState: () => flow.getLeaveState() === 'blocked' ? 'blocked' : dirty.current ? 'dirty' : 'clean', onBlocked: () => setMessage('原模型批准或候选仍需核验，请使用本节的核验或撤回入口。') }), [flow, registerLeaveGuard]);
  useEffect(() => {
    let mounted = true;
    if (recoveryApprovalId) queueMicrotask(() => { if (mounted) { setEnabled(true); void flow.restore(recoveryApprovalId); } });
    return () => { mounted = false; };
  }, [flow, recoveryApprovalId]);
  useEffect(() => {
    if (shouldAutoDiscoverModelOperations({ recoveryApprovalId, storedBatchState: storedDelivery?.batch?.state, sent: operation.sent, discovery: operation.discovery, allowInitialExtraction })) void flow.discover();
  }, [allowInitialExtraction, flow, operation.discovery, operation.sent, recoveryApprovalId, storedDelivery?.batch?.state]);
  useEffect(() => { callbacks.current.onLock(unknown); }, [unknown]);
  useEffect(() => {
    if (operation.delivery && notified.current !== operation.delivery) { notified.current = operation.delivery; dirty.current = false; setPreview(null); callbacks.current.onDelivery(operation.delivery); }
    else if (operation.phase === 'unknown') callbacks.current.onUnknown();
  }, [operation.delivery, operation.phase]);
  const scope: ModelScope = { task, segmentIds: ids, scopeConfirmed: true };
  function invalidate() { active.current?.abort(); active.current = null; dirty.current = true; setPreview(null); setMessage(''); setPreviewBusy(false); }
  async function prepare() {
    if (active.current || unknown || !canExtract) return;
    const controller = new AbortController(); active.current = controller; setPreviewBusy(true); setPreview(null);
    try {
      const response = await apiRequest<unknown>(`/api/capture/${encodeURIComponent(conversation.id)}/model-preview`, { method: 'POST', body: JSON.stringify(scope), signal: controller.signal });
      if (active.current !== controller) return;
      const result = response.ok ? await checkModelPreview(response.data, conversation, scope) : response;
      if (active.current !== controller) return;
      if (result.ok) { setPreview(result.data); setMessage('模型输入已核对；尚未发送。'); }
      else setMessage(result.error.message);
    } catch { if (active.current === controller) setMessage('预览失败；现场已保留，尚未发送模型。'); }
    finally { if (active.current === controller) { active.current = null; setPreviewBusy(false); } }
  }
  async function send() {
    if (active.current || !preview || unknown || !canExtract) return;
    setMessage(''); await flow.send(scope, preview);
  }
  async function stop() {
    active.current?.abort(); active.current = null; setPreviewBusy(false); setPreview(null); setMessage('');
    await flow.cancel();
  }
  return <section className="capture-section" aria-labelledby="capture-model-title">
    <h2 id="capture-model-title">AI候选</h2>
    <label className="capture-choice"><input type="checkbox" checked={enabled} disabled={busy || unknown || operation.sent} onChange={(e) => { invalidate(); setEnabled(e.target.checked); }}/>{enabled ? '本次提取待审候选' : '只归档，不发送模型'}</label>
    {enabled && <>
      {status?.aiExtraction !== 'enabled' && <p>AI提取{status?.aiExtraction === 'disabled' ? '已关闭' : '状态未就绪'}；已有现场与人工交接仍可用。</p>}
      <fieldset disabled={busy || unknown || operation.sent} aria-label="本次模型范围">
        <label htmlFor="capture-model-question">当前问题{!initialTask && '（重新填写）'}</label>
        <textarea id="capture-model-question" rows={2} maxLength={4000} value={task.question} onChange={(e) => { invalidate(); setTask({ ...task, question: e.target.value, updatedAt: new Date().toISOString() }); }}/>
        {task.constraints.length > 0 && <ul>{task.constraints.map((item) => <li key={item.id}>{safeDisplayText(item.text)}</li>)}</ul>}
        {conversation.segments.map((segment, index) => <label key={segment.id} className="capture-choice"><input type="checkbox" checked={ids.includes(segment.id)} onChange={(e) => { invalidate(); setIds(e.target.checked ? [...ids, segment.id] : ids.filter((id) => id !== segment.id)); }}/>模型片段 {index + 1}</label>)}
      </fieldset>
      <div className="capture-actions"><button type="button" disabled={busy || unknown || !canExtract || !task.question.trim() || !ids.length || status?.aiExtraction !== 'enabled'} onClick={() => void prepare()}><FileSearch size={16} aria-hidden="true"/>预览模型输入</button>
        {(busy || unknown) && <button type="button" disabled={operation.registration === 'revoking'} onClick={() => void stop()}><X size={16} aria-hidden="true"/>{operation.approval && !busy ? '撤回原批准' : '停止后续操作'}</button>}
        {operation.sent && <button type="button" disabled={busy} onClick={() => { setMessage(''); void flow.readBack(); }}><RefreshCw size={16} aria-hidden="true"/>核验原模型操作</button>}</div>
      {operation.registrationIdentity && !['complete', 'discarded', 'expired'].includes(operation.phase) && <button type="button" disabled={operation.phase === 'checking' || operation.registration === 'revoking' || (operation.phase === 'sending' && operation.sent)} onClick={() => { setMessage(''); void flow.readApprovalRegistration(); }}><RefreshCw size={16} aria-hidden="true"/>核验原批准登记</button>}
      {preview && <div className="capture-model-preview"><h3>本次发送内容</h3><pre>{preview.input.text}</pre><p>输入摘要：<code>{preview.approvalRequest.contentHash}</code></p>
        <p>用途：选中来源生成的待审候选在本工作区私有状态保存7天，不入正式Git或语义索引。到期停止提供候选正文，不保证物理副本已抹除。</p>
        {status?.modelApproval !== 'available' && <p role="status">可信模型批准尚未连接；未发送模型，可继续人工交接。</p>}
        <button type="button" disabled={busy || unknown || !canExtract || status?.aiExtraction !== 'enabled' || status?.modelApproval !== 'available'} onClick={() => void send()}><Send size={16} aria-hidden="true"/>确认发送并保存待审候选</button>
        {operation.registration === 'active' && !operation.sent && operation.phase === 'unknown' && <button type="button" disabled={busy || status?.aiExtraction !== 'enabled' || status?.modelApproval !== 'available'} onClick={() => { setMessage(''); void flow.continueOriginal(scope, preview); }}><Send size={16} aria-hidden="true"/>继续原批准发送并保存候选</button>}
      </div>}
    </>}
    {operation.discovery === 'ready' && operation.discovered.length > 0 && <div className="capture-model-recovery" role="region" aria-labelledby="capture-model-recovery-title">
      <h3 id="capture-model-recovery-title">发现的原提取操作</h3>
      <p>同一会话已有原操作；不能根据相同内容重新批准或发送模型。</p>
      <ul>
        {operation.discovered.map((item) => <li key={item.operationId}><code>{item.operationId}</code> <span>{item.stage}</span> <button type="button" disabled={busy || operation.sent} onClick={() => { setMessage(''); void flow.restoreDiscovered(item); }}><RefreshCw size={16} aria-hidden="true"/>只读核验</button></li>)}
      </ul>
    </div>}
    {operation.discovery === 'ready' && operation.discovered.length === 0 && <p role="status">当前未读到原提取操作；absenceIsFinal=false，不能据此证明没有发送或计费。</p>}
    {shouldOfferDiscoveryRetry(operation) && <div className="capture-model-recovery" role="status"><p>原提取操作发现失败；在核验成功前不会重新批准或发送模型。</p><button type="button" disabled={busy} onClick={() => { setMessage(''); void flow.discover(); }}><RefreshCw size={16} aria-hidden="true"/>重试只读发现</button></div>}
    {operation.approval && <p>实际模型批准ID：<code>{operation.approval.id}</code></p>}
    {operation.recoveryId && <p>原模型操作ID：<code>{operation.recoveryId}</code></p>}
    {operation.registrationIdentity && operation.registrationIdentity.operationId !== operation.recoveryId && <p>原模型登记操作ID：<code>{operation.registrationIdentity.operationId}</code></p>}
    {(operation.approval || operation.recoveryId || operation.registrationIdentity) && <p><a href={captureHref(conversation.id, operation.registrationIdentity?.operationId ?? operation.recoveryId ?? undefined)}>{operation.registrationIdentity || operation.recoveryId ? '原模型操作恢复入口' : '按现场发现原提取操作'}</a></p>}
    {!operation.sent && <details><summary>恢复原模型操作</summary><label htmlFor="capture-model-recovery-id">原模型操作ID</label><input id="capture-model-recovery-id" maxLength={160} value={recoveryId} disabled={busy || unknown} onChange={(event) => setRecoveryId(event.target.value)}/><button type="button" disabled={busy || unknown || !recoveryId.trim()} onClick={() => { setEnabled(true); setMessage(''); void flow.restore(recoveryId.trim()); }}><RefreshCw size={16} aria-hidden="true"/>只读核验原操作</button></details>}
    {(message || operation.message) && <p role="status" className="capture-notice">{message || operation.message}</p>}
  </section>;
}
