import { useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Eye, Lightbulb, List, Play, X } from 'lucide-react';
import { ConfidenceFields } from './confidence-fields';
import type { AttemptEvent, PublicAttemptView } from './attempt';

export const evidenceLabels = {
  not_submitted: '尚未提交', practice_only: '练习记录 · 题目未审核', unverified_exposure: '答案暴露状态未知',
  assisted_restatement: '有提示或看过答案后的作答', unassisted_recall: '本次无提示回忆', unassisted_near_transfer: '本次无提示近迁移',
};

export function AttemptPanel({ view, busy, onAction, returnHref, onReturnToQueue }: { view: PublicAttemptView; busy: boolean; onAction: (event: AttemptEvent) => void; returnHref: string; onReturnToQueue?: () => void }) {
  const [answer, setAnswer] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); onAction({ type: 'submit', answer }); };
  return <section className="learning-attempt" aria-label="学习验证作答"><div className="learning-section-heading"><h2>{view.question.kind === 'recall' ? '回忆作答' : '近迁移作答'}</h2><span>{evidenceLabels[view.evidenceClass]}</span></div>
    <p className="learning-question">{view.question.prompt}</p><p>题目版本 <code>{view.question.revision}</code> · 评分规则 <code>{view.question.rubricVersion}</code></p>
    <ConfidenceFields value={view.confidence.value} disabled={busy || view.phase !== 'confidence'} onChange={(value) => onAction({ type: 'confidence', value })}/>
    {view.phase === 'confidence' && <div className="learning-actions"><button type="button" disabled={busy || !view.confidence.value} onClick={() => onAction({ type: 'begin' })}><Play size={18}/>开始作答</button></div>}
    {view.phase === 'answering' && <form onSubmit={submit}><label>本次作答<textarea required rows={6} maxLength={16000} value={answer} onChange={(event) => setAnswer(event.target.value)}/></label><div className="learning-actions"><button type="submit" disabled={busy || !answer.trim()}><Check size={18}/>提交本次作答</button><button type="button" className="learning-secondary" disabled={busy || view.hintLevel >= 3} onClick={() => onAction({ type: 'hint', level: view.hintLevel + 1 })}><Lightbulb size={18}/>提示 {view.hintLevel}/3</button><button type="button" className="learning-secondary" disabled={busy || !!view.standardAnswer} onClick={() => onAction({ type: 'reveal' })}><Eye size={18}/>查看答案</button></div></form>}
    {view.hints.map((hint, index) => <p key={index}>提示 {index + 1}：{hint}</p>)}
    {view.submission && <section className="learning-preview"><h3>已提交的原始作答</h3><p className="learning-answer">{view.submission.answer}</p><p>提交时提示等级：{view.submission.hintLevel} · {view.submission.answerVisible ? '已暴露或暴露状态未知' : '未暴露答案'}</p></section>}
    {view.standardAnswer && <section className="learning-preview"><h3>审核答案</h3><p className="learning-answer">{view.standardAnswer}</p></section>}
    <div className="learning-actions">{view.phase !== 'cancelled' && <button type="button" className="learning-secondary" disabled={busy} onClick={() => onAction({ type: 'cancel' })}><X size={18}/>退出本次验证</button>}{onReturnToQueue && (view.phase === 'submitted' || view.phase === 'cancelled') && <button type="button" className="learning-secondary" disabled={busy} onClick={onReturnToQueue}><List size={18}/>返回回顾队列</button>}<a href={returnHref}><ArrowLeft size={18}/>返回原任务</a></div>
  </section>;
}
