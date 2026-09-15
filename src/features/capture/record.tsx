import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { Candidate, Conversation, TaskContext } from '../../contracts/domain';
import { apiRequest } from '../../app/api-client';
import type { DeliveryReceipt } from './delivery';
import { handoffHref, manualHandoffHref } from './links';
import type { CaptureStatus } from './status';
import { safeDisplayText } from './redaction';
import { ModelPanel } from './model-panel';
import { checkDeliveryReceipt } from './model-send';
import type { NavigationProps } from '../../contracts/navigation';

export const deliveryMessage: Record<DeliveryReceipt['state'], string> = {
  saved: '候选已保存并读回核验，等待人工审核。', existing: '已保存候选已读回核验。',
  empty: '本次提取已完成，无候选；空批次已保存，不再次发送模型。',
  missing: '尚未发现候选批次；这不能证明模型请求从未执行。',
  expired: '候选批次已过期，正文不再提供；原现场仍保留，不重新提取覆盖。',
  unverified: '候选批次状态尚未核验；不能把空列表当作已完成提取。',
};

const kinds: Record<Candidate['kind'], string> = { concept: '概念', fact: '事实候选', claim: '主张', principle: '原则', method: '方法', decision: '决策', question: '问题' };
export function CandidateList({ candidates }: { candidates: Candidate[] }) {
  return candidates.length ? <div aria-label="待审候选">{candidates.map((candidate, i) => <article key={candidate.id} className="capture-candidate">
    <p className="capture-candidate-state">待审 · {kinds[candidate.kind]} · {i + 1}</p><h3>{candidate.title}</h3><p>{candidate.question}</p><p>{candidate.claim}</p>
    <p><strong>保留理由：</strong>{candidate.whyKeep}</p>
    <details><summary>来源与不确定项</summary>
      <p>引文匹配不等于主张成立；尚未获得人的正式确认。</p>
      {candidate.spans.map((span) => <div key={span.id} className="capture-segment"><blockquote>{safeDisplayText(span.quote)}</blockquote><p>片段 <code>{span.segmentId}</code>，字符{span.start}至{span.end}</p></div>)}
      <ul>{candidate.uncertainties.map((text, index) => <li key={index}>{text}</li>)}</ul>
      <dl className="capture-purpose"><div><dt>模型</dt><dd>{candidate.modelId}</dd></div><div><dt>提示版本</dt><dd>{candidate.promptVersion}</dd></div><div><dt>生成时间</dt><dd><time dateTime={candidate.generatedAt}>{candidate.generatedAt}</time></dd></div></dl>
    </details>
    <a className="capture-command" href={handoffHref(candidate.conversationId, candidate.id)}>审阅此候选<ArrowRight size={16} aria-hidden="true"/></a>
  </article>)}</div> : <p>当前没有待审候选；可以直接进入人工交接。</p>;
}

export function CaptureRecord({ conversation, task, status, onLock = () => {}, registerLeaveGuard, recoveryApprovalId, allowInitialExtraction = false }: { conversation: Conversation; task?: TaskContext; status: CaptureStatus | null; onLock?: (value: boolean) => void; recoveryApprovalId?: string; allowInitialExtraction?: boolean } & NavigationProps) {
  const [delivery, setDelivery] = useState<DeliveryReceipt | null>(null);
  const [message, setMessage] = useState('尚未读取候选。');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  async function refresh() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller; setBusy(true); setDelivery(null);
    try {
      const result = await apiRequest<DeliveryReceipt>(`/api/capture/${encodeURIComponent(conversation.id)}/candidates`, { signal: controller.signal });
      if (active.current !== controller) return;
      const checked = result.ok ? await checkDeliveryReceipt(result.data, conversation) : result;
      if (active.current !== controller || controller.signal.aborted) return;
      if (checked.ok) { setDelivery(checked.data); setMessage(deliveryMessage[checked.data.state]); }
      else { setDelivery(null); setMessage(checked.error.message); }
    } catch { if (active.current === controller) setMessage('候选读取失败；现场仍可访问和手动交接。'); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  useEffect(() => { void refresh(); return () => { active.current?.abort(); active.current = null; }; }, [conversation.id, conversation.contentHash]);
  return <section className="capture-record" aria-labelledby="capture-record-title">
    <header className="capture-heading"><h2 id="capture-record-title">已保存现场</h2><a className="capture-command" href={handoffHref(conversation.id)}>人工交接<ArrowRight size={16} aria-hidden="true"/></a></header>
    <dl className="capture-purpose"><div><dt>现场ID</dt><dd><code>{conversation.id}</code></dd></div><div><dt>CNB Issue</dt><dd>#{conversation.issueNumber}</dd></div><div><dt>保存状态</dt><dd>已读回核验；未成为正式知识</dd></div></dl>
    <details><summary>已保存原文与来源</summary>{conversation.segments.map((s, i) => <article className="capture-segment" key={s.id}><h3>片段 {i + 1} · {s.role === 'user' ? '用户' : s.role === 'assistant' ? 'AI' : '来源'}</h3><pre>{safeDisplayText(s.text)}</pre><p><code>{s.id}</code></p></article>)}</details>
    <ModelPanel conversation={conversation} task={task} status={status} storedDelivery={delivery} recoveryApprovalId={recoveryApprovalId} allowInitialExtraction={allowInitialExtraction} registerLeaveGuard={registerLeaveGuard} onLock={onLock} onDelivery={(value) => { active.current?.abort(); active.current = null; setBusy(false); setDelivery(value); setMessage(deliveryMessage[value.state]); }} onUnknown={() => { active.current?.abort(); active.current = null; setBusy(false); setDelivery(null); setMessage('请核验原模型操作及候选保存状态；不要直接再次调用模型。'); }}/>
    <section className="capture-section" aria-labelledby="capture-candidates-title"><div className="capture-heading"><h2 id="capture-candidates-title">待审候选</h2><button type="button" className="capture-icon" title="核验候选状态" aria-label="核验候选状态" disabled={busy} onClick={() => void refresh()}><RefreshCw size={18}/></button></div>
      <p role="status">{message}</p>{delivery && <CandidateList candidates={delivery.candidates}/>}
      <a className="capture-command" href={manualHandoffHref(conversation.id)}>手动整理<ArrowRight size={16} aria-hidden="true"/></a>
    </section>
  </section>;
}
