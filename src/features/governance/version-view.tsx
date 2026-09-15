import { useEffect, useState } from 'react';
import { apiRequest } from '../../app/api-client';
import type { ApiError } from '../../contracts/api';
import type { VersionComparison } from './versions';
import { ErrorNotice } from './views';

const fields: Record<VersionComparison['changedFields'][number], string> = { title: '标题', question: '问题', humanStatement: '人的陈述', conditions: '前提', boundaries: '边界', sources: '来源', evidenceStatus: '证据状态', confirmation: '确认状态', lifecycle: '生命周期' };
export function ComparisonResult({ value }: { value: VersionComparison }) {
  if (value.state === 'restricted') return <p role="status">该对象受删除阻断限制，原版本和当前正文均不可读。</p>;
  return <><p className="gov-meta">原快照 <code>{value.referenceRevision}</code> · 当前快照 <code>{value.currentSnapshotRevision}</code></p>
    {value.state === 'unavailable' ? <p role="status">原版本或当前对象不可读，无法核验完整差异。未恢复或改写草稿。</p> : value.changedFields.length ?
      <div className="gov-table-wrap"><table><caption>原版本与当前版本差异</caption><thead><tr><th scope="col">字段</th><th scope="col">原版本</th><th scope="col">当前版本</th></tr></thead><tbody>{value.changedFields.map((field) => <tr key={field}><th scope="row">{fields[field]}</th><td><pre>{typeof value.original?.[field] === 'string' ? value.original[field] as string : JSON.stringify(value.original?.[field], null, 2)}</pre></td><td><pre>{typeof value.current?.[field] === 'string' ? value.current[field] as string : JSON.stringify(value.current?.[field], null, 2)}</pre></td></tr>)}</tbody></table></div> : <p role="status">已核对的内容字段相同，版本身份仍不同。</p>}</>;
}
export function VersionComparisonPanel({ nodeId, revision }: { nodeId: string; revision: string }) {
  const [value, setValue] = useState<VersionComparison | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setValue(null); setError(null);
    void apiRequest<VersionComparison>(`/api/governance/nodes/${encodeURIComponent(nodeId)}/compare?${new URLSearchParams({ revision })}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { if (result.ok) setValue(result.data); else setError(result.error); } })
      .catch(() => { if (!controller.signal.aborted) setError({ code: 'UPSTREAM', message: '版本对照读取中断，编辑输入保留。', dataState: 'preserved', nextAction: 'retry_read', retryable: true }); });
    return () => controller.abort();
  }, [nodeId, revision]);
  return <section className="gov-comparison" aria-label="只读版本对照">{error ? <ErrorNotice error={error}/> : value ? <ComparisonResult value={value}/> : <p role="status">正在读取原版本与当前版本…</p>}</section>;
}
