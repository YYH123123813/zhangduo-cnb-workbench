import { useEffect, useRef, useState } from 'react';
import { FileCheck, RefreshCw } from 'lucide-react';
import type { RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import { WorkspaceSessionSchema } from '../../contracts/session';
import { apiRequest } from '../../app/api-client';
import { recoverRetainedLearningOperation, type RetainedLearningOperation } from './retained-operation';
import { EvidenceRecordDetails, TaskConditionDetails } from './evidence-details';
import { taskHref } from './links';

export function RecoveryAnchorPanel({ supplied }: { supplied: RecoveryAnchorRead | null | undefined }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [view, setView] = useState<RetainedLearningOperation | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const read = async (readBody: boolean) => {
    if (request.current || !supplied) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setView(null); setNotice('');
    try {
      const transport = (path: string) => apiRequest<unknown>(path, { signal: controller.signal });
      const session = await transport('/api/workspace/session');
      const parsed = session.ok ? WorkspaceSessionSchema.safeParse(session.data) : null;
      if (controller.signal.aborted) return;
      if (!parsed?.success) { setNotice('当前身份未核验，未读取原操作或正文。'); return; }
      const result = await recoverRetainedLearningOperation(transport, { actorId: parsed.data.actorId, workspaceId: parsed.data.workspace.id }, supplied, readBody);
      if (controller.signal.aborted) return;
      if (result.ok) { setView(result.data); setNotice(result.data.message); } else setNotice(result.error.message);
    } catch { if (!controller.signal.aborted) setNotice('原操作读取中断；未发送任何业务写入。'); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  };
  return <section aria-label="保留的原操作核验"><div className="learning-section-heading"><h2>原操作核验</h2></div>
    {!supplied ? <p role="status">恢复身份不存在、已到期或当前不可读；没有恢复历史正文。</p> : <>
      <div className="learning-actions"><button type="button" disabled={busy} onClick={() => void read(false)}><RefreshCw size={18}/>只读核验原回执</button>
        {view?.receipt && !view.review && !view.task && !view.evidence?.record && <button type="button" disabled={busy} onClick={() => void read(true)}><FileCheck size={18}/>读取原记录正文（可能含已揭示答案）</button>}</div>
      {view && <><p>原操作 <code>{view.anchor.identity.operation.operationId}</code> · {view.anchor.identity.operation.kind}</p>
        <p>恢复身份到期：{new Date(view.anchor.identity.expiresAt).toLocaleString('zh-CN')}</p>
        {view.receipt && <p>专用回执已匹配原身份及摘要：<code>{view.receipt.operationId}</code></p>}
        {view.receipt && 'expectedVersion' in view.receipt && <p>事件 {view.receipt.kind} · 版本 {view.receipt.expectedVersion} → {view.receipt.resultingVersion} · 反馈版本 {view.receipt.feedbackVersion ?? '不适用'}</p>}
        {view.task?.task && <><p>{view.task.task.question}</p><TaskConditionDetails task={view.task.task}/><a href={taskHref(view.task.id)}>返回原任务</a></>}
        {view.evidence?.record && <EvidenceRecordDetails record={view.evidence.record}/>}
        {view.review && <><p>原任务 <code>{view.review.view.taskId}</code> · 当前会话版本 {view.review.view.version} · {view.review.view.phase}</p>
          <p>{view.review.view.question.prompt}</p><p>证据分类：{view.review.view.evidenceClass}；不构成掌握认证。</p>
          {view.review.view.hints.map((hint, index) => <p key={index}>提示 {index + 1}：{hint}</p>)}
          {view.review.view.submission && <p className="learning-answer">原作答：{view.review.view.submission.answer}</p>}
          {view.review.view.standardAnswer && <p className="learning-answer">已允许读取的参考答案：{view.review.view.standardAnswer}</p>}
          {view.review.feedback && <p>人工自评 · 反馈版本 {view.review.feedback.version} · {view.review.feedback.result}</p>}
          <a href={taskHref(view.review.view.taskId)}>返回原任务</a></>}
      </>}
    </>}{notice && <p role="status" className="learning-notice">{notice}</p>}
  </section>;
}
