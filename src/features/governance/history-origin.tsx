import { useEffect, useState } from 'react';
import { ArrowLeft, FilePenLine, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { ApiError } from '../../contracts/api';
import type { EvidenceRecord, VersionRef } from '../../contracts/domain';
import type { readHistoryNotices } from './history';
import type { HistorySelection } from './history-selection';
import { ErrorNotice, HistoryList } from './views';

type HistoryData = Awaited<ReturnType<typeof readHistoryNotices>>;
function recordParams(record: EvidenceRecord) {
  return { taskId: record.taskId, evidenceId: record.id, ...(record.kind === 'use' ? { useId: record.id } : record.outcome ? { useId: record.outcome.useRecordId } : {}) };
}
export function originalRecordLink(record: EvidenceRecord, ref?: VersionRef) {
  return `#${ref ? 'governance' : 'learning'}?${new URLSearchParams({ ...recordParams(record), ...(ref ? { nodeId: ref.objectId, revision: ref.revision } : {}) })}`;
}
export function originalHistoryReady(data: HistoryData, selection: HistorySelection, revision?: string) {
  const records = data.entries.flatMap((entry) => entry.record && !entry.restricted ? [entry.record] : []);
  if (!records.length || data.entries.some((entry) => entry.restricted)) return false;
  if (selection.taskId && records.some((record) => record.taskId !== selection.taskId)) return false;
  const use = records.find((record) => record.id === selection.useId);
  const evidence = records.find((record) => record.id === selection.evidenceId);
  if (selection.useId && use?.kind !== 'use' || selection.evidenceId && !evidence) return false;
  if (use && evidence && (use.taskId !== evidence.taskId || evidence.id !== use.id && evidence.outcome?.useRecordId !== use.id)) return false;
  return !selection.nodeId || records.some((record) => [...record.nodeRefs, ...(record.useContext?.task.conditionChecks?.map((check) => check.nodeRef) ?? [])]
    .some((ref) => ref.objectId === selection.nodeId && (!revision || ref.revision === revision)));
}
export function OriginalHistoryResult({ data }: { data: HistoryData }) {
  return <><HistoryList data={data}/>{data.entries.filter((entry) => !entry.restricted && entry.record).map((entry) => {
    const record = entry.record!;
    return <div className="gov-actions" key={record.id}><a className="gov-link" href={originalRecordLink(record)}><ArrowLeft size={16} aria-hidden="true"/>返回{record.kind === 'outcome' ? '此结果' : record.kind === 'use' ? '原使用记录' : '原证据记录'}</a>
      {record.nodeRefs.map((ref) => <a className="gov-link" key={`${ref.objectId}:${ref.revision}`} href={originalRecordLink(record, ref)}><FilePenLine size={16} aria-hidden="true"/>修订引用知识 {ref.objectId}</a>)}
    </div>;
  })}</>;
}

export function HistoryOriginPanel({ selection, revision, disabled = false, onReady }: { selection: HistorySelection; revision?: string; disabled?: boolean; onReady: (ready: boolean) => void }) {
  const query = new URLSearchParams(Object.entries(selection).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString();
  const identity = `${query}:${revision ?? ''}`;
  const [loaded, setLoaded] = useState<{ identity: string; data: HistoryData } | null>(null);
  const [error, setError] = useState<ApiError | null>(null), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false);
  const data = !disabled && loaded?.identity === identity ? loaded.data : null;
  useEffect(() => {
    const abort = new AbortController(); onReady(false); setLoaded(null); setError(null); setLoading(!disabled);
    if (!disabled) void apiRequest<HistoryData>(`/api/governance/history?${query}`, { signal: abort.signal }).then((result) => {
      if (abort.signal.aborted) return;
      if (!result.ok) { setError(result.error); return; }
      setLoaded({ identity, data: result.data }); onReady(originalHistoryReady(result.data, selection, revision));
    }).catch(() => { if (!abort.signal.aborted) setError({ code: 'UPSTREAM', message: '原记录读取中断，未恢复载荷或重新执行。', dataState: 'preserved', retryable: true, nextAction: 'retry_read' }); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [query, revision, identity, disabled, refresh, onReady]);
  return <section className="gov-band" aria-label="原使用与结果" aria-busy={loading}><h2>原使用与结果</h2>
    <p className="gov-meta">{selection.useId && <>原使用 <code>{selection.useId}</code> </>}{selection.evidenceId && <>证据 <code>{selection.evidenceId}</code> </>}{selection.taskId && <>任务 <code>{selection.taskId}</code></>}</p>
    {loading && <p role="status">正在读取原记录...</p>}{error && <ErrorNotice error={error}/>}
    {data && <><OriginalHistoryResult data={data}/>{!originalHistoryReady(data, selection, revision) && <p className="gov-notice">原记录受限、缺失或引用版本不匹配，未启用关联修订。</p>}</>}
    <button type="button" disabled={disabled || loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} aria-hidden="true"/>重新读取原记录</button>
  </section>;
}
