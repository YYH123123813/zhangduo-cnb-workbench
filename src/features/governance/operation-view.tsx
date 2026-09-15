import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { ApiError } from '../../contracts/api';
import type { OperationInspection, OperationLookup } from './operation-readback';
import { label } from './client-model';
import { ErrorNotice, LayerTable, SettingsFields } from './views';

export function OperationSummary({ data }: { data: OperationInspection }) {
  return <div aria-live="polite"><p className="gov-meta">原操作 <code>{data.id}</code> · 只读核验</p>
    {(data.kind === 'settings_approval' || data.kind === 'export_approval' || data.kind === 'delete_approval') && <><p>批准登记：{label(data.registration.status)}</p>
      {data.registration.approval && <p className="gov-meta">原批准 <code>{data.registration.approval.id}</code> · 原请求摘要 <code>{data.registration.requestHash}</code></p>}
      <p className="gov-notice">原载荷未恢复，登记事实不等于执行成功；未启用批准重发或执行。</p></>}
    {data.kind === 'knowledge' && <><p>批准登记：{label(data.registration.status)}</p>
      {data.registration.approval && <p className="gov-meta">批准 <code>{data.registration.approval.id}</code> · 摘要 <code>{data.registration.approval.contentHash}</code></p>}
      {data.commit ? <p>原提交 <code>{data.commit.revision}</code> · 索引 {label(data.commit.indexing)}</p> : <p>尚未查到原提交回执，不能认定未写入。</p>}
      <p className="gov-notice">原变更正文未恢复，尚未逐项核验内容；未启用提交重试。</p></>}
    {data.kind === 'evidence' && (data.receipt ? <><p>原保存操作 <code>{data.receipt.operationId}</code> · 原记录 <code>{data.receipt.recordId}</code></p>
      <p>原批准 <code>{data.receipt.approvalId}</code> · 结果 {label(data.receipt.outcome)}</p>
      <p className="gov-meta">保存版本 <code>{data.receipt.baseRevision}</code> · 内容摘要 <code>{data.receipt.contentHash}</code></p>
      <p className="gov-notice">仅核验原保存回执；未恢复私有正文，未启用批准重发或证据写入。</p>
    </> : <p>尚未查到原证据保存回执，不能认定未保存。</p>)}
    {data.kind === 'settings' && (data.result?.state === 'verified' ? <><p>原保存版本 {data.result.receipt.revision} · 当前设置版本 {data.result.current.settingsRevision}</p>
      <fieldset disabled><legend>本次已保存设置</legend><SettingsFields value={data.result.receipt.settings} onChange={() => {}}/></fieldset>
      {!data.result.currentMatchesSaved && <><p>后续设置已变化，未覆盖后续操作。</p><fieldset disabled><legend>当前设置</legend><SettingsFields value={data.result.current.settings} onChange={() => {}}/></fieldset></>}
    </> : <p>尚未查到原批准的保存回执，当前值不能证明本次操作成功。</p>)}
    {data.kind === 'delete' && (data.result ? <><p>原计划范围：{data.plan!.objectIds.join(', ')}</p>
      <p>{data.result.reportAvailable ? '原计划报告已读回' : '原计划报告尚未读回，不能据此认定未执行'} · {data.result.retrievalBlocked ? '当前应用阻断已核验' : '当前应用阻断尚未全部核验'}</p>
      <p className="gov-notice">物理清理仍未核验。</p><LayerTable layers={data.result.layers}/>
    </> : <p>未查到原删除计划，不能据此认定未执行。</p>)}
  </div>;
}

export function OperationInspector({ initial, disabled = false }: { initial?: OperationLookup; disabled?: boolean }) {
  const initialKind = initial?.kind ?? 'knowledge', initialId = initial?.id ?? '';
  const [kind, setKind] = useState<OperationLookup['kind']>(initialKind), [id, setId] = useState(initialId);
  const [data, setData] = useState<OperationInspection | null>(null), [error, setError] = useState<ApiError | null>(null), [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  function clear() { controller.current?.abort(); setData(null); setError(null); setLoading(false); }
  async function inspect(input: OperationLookup) {
    if (disabled || !input.id.trim()) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError(null); setData(null);
    try {
      const response = await apiRequest<OperationInspection>(`/api/governance/operations/${input.kind}/${encodeURIComponent(input.id)}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!response.ok) setError(response.error);
      else if (response.data.id === input.id && response.data.kind === input.kind && response.data.readOnly) setData(response.data);
      else throw new Error('Mismatched operation');
    } catch { if (!abort.signal.aborted) setError({ code: 'UNKNOWN_RESULT', message: '原操作只读核验未完成，未重新执行。', dataState: 'unknown', retryable: false, nextAction: 'read_original_operation' }); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    setKind(initialKind); setId(initialId); clear();
    if (initialId && !disabled) void inspect({ kind: initialKind, id: initialId });
    return () => controller.current?.abort();
  }, [initialKind, initialId, disabled]);
  return <section className="gov-band" aria-label="原操作核验"><h2>原操作核验</h2>
    <form onSubmit={(event) => { event.preventDefault(); void inspect({ kind, id }); }}><fieldset className="gov-fields" disabled={disabled}>
      <label>操作类型<select value={kind} onChange={(event) => { clear(); setKind(event.target.value as OperationLookup['kind']); }}><option value="knowledge">知识提交</option><option value="settings">设置保存</option><option value="delete">删除计划</option><option value="evidence">证据保存</option><option value="settings_approval">设置批准登记</option><option value="export_approval">导出批准登记</option><option value="delete_approval">删除批准登记</option></select></label>
      <label>{kind === 'knowledge' ? '原ChangeSet ID' : kind === 'settings' ? '原批准ID' : kind === 'delete' ? '原计划ID' : kind === 'evidence' ? '原保存操作ID' : '原登记操作ID'}<input value={id} maxLength={160} required onChange={(event) => { clear(); setId(event.target.value); }}/></label>
      <button type="submit" disabled={loading || !id.trim()}><RefreshCw size={16} aria-hidden="true"/>读取原操作</button>
    </fieldset></form>
    {loading && <p role="status">正在只读核验原操作...</p>}{error && <ErrorNotice error={error}/>} {data && <OperationSummary data={data}/>}
  </section>;
}
