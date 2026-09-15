import { useState, type FormEvent } from 'react';
import { Check, FileWarning, X } from 'lucide-react';
import type { FeedbackDraft, FeedbackInput } from './feedback';

export function FeedbackPanel({ feedback, busy, onReview, onCancel }: { feedback: FeedbackDraft; busy: boolean; onReview: (input: FeedbackInput) => void; onCancel: () => void }) {
  const [invalid, setInvalid] = useState(feedback.result === 'invalid_question');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    onReview({ invalidReason: invalid ? String(data.get('invalid-reason') ?? '') : null,
      criteria: invalid ? [] : feedback.criteria.map((criterion) => ({ criterionId: criterion.criterionId,
        finding: String(data.get(`finding-${criterion.criterionId}`)) as 'met' | 'partial' | 'not_met',
        answerQuote: String(data.get(`quote-${criterion.criterionId}`) ?? ''), rationale: String(data.get(`rationale-${criterion.criterionId}`) ?? ''),
      })),
    });
  };
  return <section aria-label="分项反馈与申诉"><div className="learning-section-heading"><h2>分项评阅</h2><span>人工自评 · 未保存</span></div><p>评分规则 <code>{feedback.rubricVersion}</code></p><details><summary>本次原始作答</summary><p className="learning-answer">{feedback.originalAnswer}</p></details>
    {feedback.persistence === 'shared_services' && <p>已保存反馈版本 {feedback.version} · {{ unverified: '尚未评阅', self_reported: '用户自报', partial: '部分满足', met_rubric: '满足本题评分项', not_met: '未满足本题评分项', invalid_question: '题目无效' }[feedback.result]}。当前编辑尚未保存。</p>}
    <form onSubmit={submit}><label className="learning-toggle"><input type="checkbox" checked={invalid} disabled={feedback.result === 'invalid_question' || busy} onChange={(event) => setInvalid(event.target.checked)}/><span>题目无效</span></label>
      {invalid ? <label>无效原因<textarea name="invalid-reason" required rows={3} maxLength={4000} defaultValue={feedback.invalidReason ?? ''}/></label> : feedback.criteria.map((criterion) => <fieldset key={criterion.criterionId} className="learning-criterion" disabled={busy}><legend>{criterion.description}</legend><p>审核依据：{criterion.expectedEvidence}</p><div className="learning-options">{([['met', '满足'], ['partial', '部分满足'], ['not_met', '未满足']] as const).map(([value, label]) => <label key={value}><input required type="radio" name={`finding-${criterion.criterionId}`} value={value} defaultChecked={criterion.finding === value}/><span>{label}</span></label>)}</div><label>原文引用<textarea name={`quote-${criterion.criterionId}`} rows={2} maxLength={16000} defaultValue={criterion.answerQuote}/></label><label>判断说明<textarea required name={`rationale-${criterion.criterionId}`} rows={2} maxLength={4000} defaultValue={criterion.rationale}/></label></fieldset>)}
      <div className="learning-actions"><button type="submit" disabled={busy}><Check size={18}/>确认本次评阅</button><button type="button" disabled={busy} className="learning-secondary" onClick={onCancel}><X size={18}/>取消评阅</button></div>
    </form>
  </section>;
}

export function AppealPanel({ busy, onAppeal }: { busy: boolean; onAppeal: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = reason.trim();
    if (value) onAppeal(value);
  };
  return <section aria-label="题目申诉"><div className="learning-section-heading"><h2>题目申诉</h2><span>独立操作回执</span></div>
    <form onSubmit={submit}><label>申诉理由<textarea required rows={3} maxLength={4000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <p>申诉只提交你的理由，不会上传标准答案或其他私有题库内容。</p>
      <div className="learning-actions"><button type="submit" disabled={busy || !reason.trim()}><FileWarning size={18}/>提交申诉</button></div>
    </form>
  </section>;
}
