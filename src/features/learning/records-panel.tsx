import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, History, RefreshCw, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { HistoricalEvidenceView } from './history';
import type { OutcomeDraft, OutcomeInput } from './outcome';
import type { RevisionClue } from './links';
import { HistoricalKnowledgePanel } from './historical-knowledge-panel';
import type { NavigationProps } from '../../contracts/navigation';
import { useLearningLeaveGuard } from './leave-guard';
import { EvidenceSaveFlow } from './evidence-save-flow';
import { EvidenceSavePanel, useEvidenceSaveState } from './evidence-save-panel';
import { EvidenceRecordDetails } from './evidence-details';
import type { EvidenceStoragePreview } from './application-api';

type OutcomePreview = OutcomeDraft & { revisionLinks: RevisionClue[]; storage: EvidenceStoragePreview | null; storageNotice: string | null };

export function RecordsPanel({ taskId, useId, evidenceId, refreshKey = 0, registerLeaveGuard, onBlocked, retainOperationRecovery }: {
  taskId: string; useId?: string; evidenceId?: string; refreshKey?: number; onBlocked?: () => void;
} & NavigationProps) {
  const [records, setRecords] = useState<HistoricalEvidenceView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [loadedTaskId, setLoadedTaskId] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState<OutcomeInput['status']>('unclear');
  const [summary, setSummary] = useState('');
  const [failureReason, setFailureReason] = useState('');
  const [outcome, setOutcome] = useState<OutcomePreview | null>(null);
  const [saveFlow, setSaveFlow] = useState<EvidenceSaveFlow | null>(null);
  const saveState = useEvidenceSaveState(saveFlow);
  const busy = loading || previewing || !!saveFlow?.blocked;
  const explainBlocked = () => { setNotice('原结果保存操作仍需核验，未切换或丢弃该操作。'); onBlocked?.(); };
  useLearningLeaveGuard(registerLeaveGuard, () => saveFlow?.blocked ? 'blocked' : saveState?.phase === 'saved' || saveState?.phase === 'cancelled' ? 'clean'
    : summary.trim() || failureReason.trim() || status !== 'unclear' || outcome ? 'dirty' : 'clean', explainBlocked);
  const loadRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { loadRequest.current?.abort(); previewRequest.current?.abort(); }, []);
  useEffect(() => () => saveFlow?.interrupt(), [saveFlow]);
  const invalidate = () => {
    if (saveFlow?.blocked) { explainBlocked(); return false; }
    previewRequest.current?.abort(); previewRequest.current = null; setPreviewing(false); setOutcome(null); setSaveFlow(null); return true;
  };
  const load = async () => {
    if (saveFlow?.blocked) { explainBlocked(); return; }
    loadRequest.current?.abort(); const controller = new AbortController(); loadRequest.current = controller;
    const filter = taskId.trim(); setLoading(true); setNotice(''); setRecords([]); setLoaded(false);
    const query = new URLSearchParams({ ...(filter ? { taskId: filter } : {}), ...(useId ? { useId } : {}), ...(evidenceId ? { evidenceId } : {}) });
    try {
      const result = await apiRequest<{ records: HistoricalEvidenceView[] }>(`/api/learning/records${query.size ? `?${query}` : ''}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) { setRecords(result.data.records); setLoaded(true); setLoadedTaskId(filter); } else setNotice(result.error.message);
    } catch { if (!controller.signal.aborted) setNotice('历史记录读取失败；未更改任何记录。'); }
    finally { if (loadRequest.current === controller) setLoading(false); }
  };
  useEffect(() => { if (useId || evidenceId || refreshKey) void load(); }, [useId, evidenceId, refreshKey]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    const controller = new AbortController(); previewRequest.current = controller; setPreviewing(true); setNotice(''); setOutcome(null); setSaveFlow(null);
    try {
      const result = await apiRequest<OutcomePreview>('/api/learning/outcomes', { method: 'POST', body: JSON.stringify({ action: 'preview', outcome: { useRecordId: selected, status, summary, failureReason } }), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        const flow = result.data.storage ? new EvidenceSaveFlow(result.data.storage, apiRequest) : null;
        setOutcome(result.data); setSaveFlow(flow);
      } else setNotice(result.error.message);
    } catch { if (!controller.signal.aborted) setNotice('结果预览失败；输入已保留，未保存。'); }
    finally { if (previewRequest.current === controller) { setPreviewing(false); previewRequest.current = null; } }
  };
  return <section aria-label="应用记录与结果"><div className="learning-section-heading"><History size={20}/><h2>历史记录</h2><button type="button" className="icon-button" aria-label="读取应用记录" title="读取应用记录" disabled={busy} onClick={() => void load()}><RefreshCw size={18}/></button></div>
    {notice && <p role="status" className="learning-notice">{notice}</p>}
    {loaded && <p>已载入范围：{loadedTaskId || '当前工作区全部证据'}</p>}
    {loaded && !records.length && <p>当前范围没有已保存记录。</p>}
    <ul className="learning-records">{records.map(({ record }) => <li key={record.id}><EvidenceRecordDetails record={record}/>
      {record.nodeRefs.map((nodeRef) => <HistoricalKnowledgePanel key={`${nodeRef.objectId}@${nodeRef.revision}`} recordId={record.id} nodeRef={nodeRef}/>)}
      {record.kind === 'use' && <button type="button" className="learning-secondary" disabled={busy || !record.useContext} onClick={() => { if (!invalidate()) return; setSelected(record.id); setSummary(''); setFailureReason(''); setStatus('unclear'); }}><Check size={16}/>填写实际结果</button>}</li>)}</ul>
    {selected && <form onSubmit={(event) => void submit(event)} onChange={invalidate}><fieldset className="learning-form-fields" disabled={saveFlow?.blocked}><h3>实际结果 · 用户自报</h3><p>原应用：<code>{selected}</code></p><label>结果<select value={status} onChange={(event) => setStatus(event.target.value as OutcomeInput['status'])}><option value="unclear">尚不清楚</option><option value="succeeded">达到本次目标</option><option value="failed">未达到本次目标</option></select></label><label>简短结果<textarea rows={3} required maxLength={4000} value={summary} onChange={(event) => setSummary(event.target.value)}/></label><label>失败原因<textarea rows={2} required={status === 'failed'} maxLength={4000} value={failureReason} onChange={(event) => setFailureReason(event.target.value)}/></label><div className="learning-actions"><button type="submit" disabled={busy}><Check size={18}/>预览结果</button><button type="button" className="learning-secondary" onClick={() => { if (!invalidate()) return; setSelected(''); setSummary(''); setFailureReason(''); setNotice('已取消当前结果编辑；已保存记录不变。'); }}><X size={18}/>取消</button></div></fieldset></form>}
    {outcome && !saveFlow && <div className="learning-preview"><h3>自报结果预览 · 未保存</h3><p>{outcome.summary}</p>{outcome.failureReason && <p>原因：{outcome.failureReason}</p>}<p>{outcome.storageNotice || '当前结果缺少完整原应用情境，不能保存。'}</p></div>}
    {saveFlow && <EvidenceSavePanel key={saveFlow.preview.operationId} flow={saveFlow} retainOperationRecovery={retainOperationRecovery} onSaved={() => { setSelected(''); setSummary(''); setFailureReason(''); setStatus('unclear'); void load(); }}/>}
  </section>;
}
