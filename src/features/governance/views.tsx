import { CheckCheck, Download, LockKeyhole, Plus, RefreshCw, Save, Trash2, TriangleAlert, X } from 'lucide-react';
import type { ApiError } from '../../contracts/api';
import type { KnowledgeNode, Settings } from '../../contracts/domain';
import type { GovernanceOperationKind } from '../../contracts/governance-operation';
import type { ChangePreview } from './revisions';
import type { historyNotices } from './history';
import { label, retrievalLink } from './client-model';
import type { ChangeState } from './change-flow';
import type { DataState } from './data-flow';
import type { GovernancePayloadSaveState } from './governance-operation';

export type { GovernancePayloadSaveState } from './governance-operation';

export function GovernancePayloadControl({ kind, operationId, state, disabled = false, saveDisabled = false, onSave, onRead }: { kind: GovernanceOperationKind; operationId: string; state: GovernancePayloadSaveState; disabled?: boolean; saveDisabled?: boolean; onSave: () => void; onRead: () => void }) {
  const name = { change: '修订', settings: '设置', delete: '删除计划', export: '导出', demo: '演示副本' }[kind];
  const status = { idle: '尚未保存', saving: '正在保存', reading: '正在只读读回', saved: '原载荷已保存', unknown: '保存结果未知', failed: '保存失败', conflict: '原操作ID已绑定其他载荷', expired: '原载荷已过期或已清除' }[state];
  return <section id="gov-payload-status" tabIndex={-1} className="gov-payload-control" aria-label="原载荷保存状态"><p><strong>原载荷恢复</strong> · {name} · <code>{operationId}</code></p><p className="gov-meta">私有保存期限 30 天；仅用于本身份的只读恢复，不代表批准、提交、删除或公开。</p><p role="status">{status}</p>
    <div className="gov-actions">{['idle', 'failed'].includes(state) && <button type="button" disabled={disabled || saveDisabled} onClick={onSave}><Save size={16} aria-hidden="true"/>保存原载荷（30天）</button>}{['unknown', 'conflict', 'expired'].includes(state) && <button type="button" disabled={disabled} onClick={onRead}><RefreshCw size={16} aria-hidden="true"/>按同一操作ID读回</button>}{state === 'saved' && <a className="gov-link" href={`#governance?${new URLSearchParams({ draftId: operationId }).toString()}`}>原载荷只读入口</a>}</div>
  </section>;
}

export function DataControls({ state, disabled = false, onApprove, onRecover, onCommit, onVerify, onRevoke, onCancel, onContinue }: {
  state: DataState; disabled?: boolean; onApprove: () => void; onRecover?: () => void; onCommit: () => void; onVerify: () => void; onRevoke: () => void; onCancel: () => void; onContinue: () => void;
}) {
  if (state.stage === 'idle' || !state.prepared) return null;
  const { stage, prepared, result } = state;
  const name = { settings: '设置', export: '导出', delete: '删除计划', demo: '演示副本' }[prepared.kind];
  const pending = ['approving', 'reading_approval', 'sending', 'verifying', 'revoking'].includes(stage);
  const messages = { ready: '待确认并登记批准', approving: '正在登记批准，尚未执行', approval_unknown: '批准登记未知，未发送执行', reading_approval: '正在只读核验原批准', approved: '批准已登记，尚未执行', sending: '执行已发送，正在等待回执', verifying: '正在读回核验', unknown: '执行结果未知，原操作保留', revoking: '正在撤回批准，输入保留', revoke_unknown: '批准撤回结果未核验', failed: '操作未完成，输入保留', succeeded: '操作结果已读回' };
  const hash = prepared.kind === 'delete' ? prepared.preview.plan.contentHash : prepared.preview.contentHash;
  return <section className="gov-band" id="gov-data-status" tabIndex={-1} aria-label={`${name}操作状态`} aria-busy={pending}>
    <h2>{name} · {messages[stage]}</h2><p className="gov-meta">摘要 <code>{hash}</code></p>
    <p className="gov-meta">登记操作 <code>{prepared.operationId}</code></p>
    {state.approval && <p className="gov-meta">批准 <code>{state.approval.id}</code></p>}
    {prepared.kind === 'delete' && <p className="gov-meta">计划 <code>{prepared.preview.plan.id}</code></p>}
    {prepared.kind === 'delete' && !result && <><p>批准范围：{prepared.preview.plan.objectIds.join(', ')}。批准绑定以上原计划及摘要，包含以下全部层级；范围变化后须重新预览和确认。</p><LayerTable layers={prepared.preview.layers}/></>}
    {state.error && <ErrorNotice error={state.error}/>}
    {prepared.preview.approvalStatus === 'unavailable' && <p className="gov-notice">本操作所需共享能力尚未就绪，未发送执行请求。</p>}
    {stage === 'unknown' && prepared.kind === 'export' && <p className="gov-notice">原导出文件结果无法核验，共享平台尚未提供普通导出文件回执读口。原操作ID与批准保留；不能重新生成文件、重新批准或将登记事实当作导出成功。</p>}
    {result?.kind === 'settings' && <><p>本次保存版本 <code>{result.receipt.revision}</code> · 原批准回执已核验</p>{!result.currentMatchesSaved && <p>设置后续已更新，当前版本 <code>{result.value.settingsRevision}</code>；未覆盖后续变更。</p>}<p className="gov-notice">实际模型调用的服务端开关执行尚未完成全系统验收。</p></>}
    {result?.kind === 'delete' && <><p>应用检索阻断已核验，物理清理尚未核验。</p><LayerTable layers={result.value.layers}/></>}
    {result?.kind === 'export' && <><FileList files={result.value.files} downloadable/><ul>{result.value.limitations.map((text) => <li key={text}>{text}</li>)}</ul><p className="gov-meta">未公开或部署。下载副本不受后续应用阻断控制。</p></>}
    {result?.kind === 'demo' && <><p>专用演示批准与本地副本回执已按同一 operationId、内容摘要和版本核验。</p><p className="gov-meta">目标 <code>{result.value.destination}</code> · published={String(result.value.published)} · 批准 <code>{result.value.approvalId}</code></p><FileList files={result.value.files} downloadable/><ul>{result.value.limitations.map((text) => <li key={text}>{text}</li>)}</ul><p className="gov-notice">这是本地脱敏副本；未公开、未部署、未改变仓库可见性或评委访问权限。</p></>}
    <div className="gov-actions">
      {stage === 'ready' && <button type="button" disabled={disabled || prepared.preview.approvalStatus === 'unavailable'} onClick={onApprove}><LockKeyhole size={16} aria-hidden="true"/>确认{name}并登记批准</button>}
      {stage === 'approval_unknown' && onRecover && <button type="button" disabled={disabled} onClick={onRecover}><RefreshCw size={16} aria-hidden="true"/>核验原批准登记</button>}
      {stage === 'approved' && <button type="button" disabled={disabled} onClick={onCommit}>{prepared.kind === 'delete' ? <Trash2 size={16} aria-hidden="true"/> : prepared.kind === 'export' || prepared.kind === 'demo' ? <Download size={16} aria-hidden="true"/> : <Save size={16} aria-hidden="true"/>}执行已批准{name}</button>}
      {stage === 'unknown' && prepared.kind !== 'export' && <button type="button" disabled={disabled} onClick={onVerify}><RefreshCw size={16} aria-hidden="true"/>{prepared.kind === 'demo' ? '重新读取原导出' : '核验原操作'}</button>}
      {stage === 'revoke_unknown' && <button type="button" disabled={disabled} onClick={onRevoke}><RefreshCw size={16} aria-hidden="true"/>重查并撤回原批准</button>}
      {['ready', 'approved', 'failed'].includes(stage) && <button type="button" disabled={disabled} onClick={onCancel}><X size={16} aria-hidden="true"/>取消并保留输入</button>}
      {stage === 'succeeded' && <button type="button" disabled={disabled} onClick={onContinue}><CheckCheck size={16} aria-hidden="true"/>继续处理下一项</button>}
    </div>
  </section>;
}

export function ChangeControls({ state, disabled = false, onApprove, onRecover, onCommit, onVerify, onRevoke, onCancel, onContinue }: {
  state: ChangeState; disabled?: boolean; onApprove: () => void; onRecover?: () => void; onCommit: () => void; onVerify: () => void; onRevoke: () => void; onCancel: () => void; onContinue: () => void;
}) {
  if (state.stage === 'idle' || !state.prepared) return null;
  const { stage, prepared, result } = state;
  const pending = ['approving', 'reading_approval', 'sending', 'verifying', 'revoking'].includes(stage);
  const messages = { ready: '待确认变更并登记批准', approving: '正在登记批准，尚未发送知识提交', approval_unknown: '批准登记未知，未发送知识提交', reading_approval: '正在只读核验原批准', approved: '本次变更批准已登记，尚未提交', sending: '提交已发送，正在等待回执', verifying: '正在核验固定提交中的对象与排除状态', unknown: '提交结果未知，原操作保留', revoking: '正在撤回批准，输入保留', revoke_unknown: '批准撤回结果未核验', failed: '提交未完成，输入保留', succeeded: '提交版本与变更对象已读回核验' };
  return <section className="gov-band" id="gov-change-status" tabIndex={-1} aria-label="提交状态" aria-busy={pending}>
    <h2>{messages[stage]}</h2><p className="gov-meta">操作 <code>{prepared.changes.id}</code></p><p className="gov-meta">摘要 <code>{prepared.changes.contentHash}</code></p>
    {state.error && <ErrorNotice error={state.error}/>}
    {prepared.approvalStatus === 'unavailable' && <p className="gov-notice">知识批准端口尚未提供，未发送提交。</p>}
    {result && <><p>提交版本 <code>{result.receipt.revision}</code> · 索引：{label(result.receipt.indexing)}</p><p>Git对象已核验；后续检索与索引覆盖仍需独立检查。</p><a className="gov-link" href={retrievalLink(prepared.changes.nodes[0]?.id ?? prepared.objectIds[0]!, result.receipt.revision)}>查看提交版本</a></>}
    <div className="gov-actions">
      {stage === 'approval_unknown' && onRecover && <button type="button" disabled={disabled} onClick={onRecover}><RefreshCw size={16}/>核验原批准登记</button>}
      {stage === 'ready' && <button type="button" disabled={disabled || prepared.approvalStatus === 'unavailable'} onClick={onApprove}><LockKeyhole size={16}/>确认变更并登记批准</button>}
      {stage === 'approved' && <button type="button" disabled={disabled} onClick={onCommit}><Save size={16}/>提交已批准变更</button>}
      {stage === 'unknown' && <button type="button" disabled={disabled} onClick={onVerify}><RefreshCw size={16}/>核验原操作</button>}
      {stage === 'revoke_unknown' && <button type="button" disabled={disabled} onClick={onRevoke}><RefreshCw size={16}/>重查并撤回原批准</button>}
      {['ready', 'approved', 'failed'].includes(stage) && <button type="button" disabled={disabled} onClick={onCancel}><X size={16}/>取消并保留输入</button>}
      {stage === 'succeeded' && <button type="button" disabled={disabled} onClick={onContinue}><CheckCheck size={16}/>继续处理下一项</button>}
    </div>
  </section>;
}

export function ErrorNotice({ error }: { error: ApiError }) {
  return <div className="gov-notice gov-error" role="alert"><TriangleAlert size={18} aria-hidden="true"/><div><strong>{error.message}</strong><p>{error.code} · {label(error.dataState)}</p><p>{error.code === 'CONFLICT' ? '当前输入未丢弃，请重新读取并预览。' : error.dataState === 'unknown' ? '请先核验结果，不要重复执行写入。' : '当前操作未获得成功确认。'}</p></div></div>;
}
export function ApprovalGate({ command = '确认提交', hash }: { command?: string; hash?: string }) {
  return <div className="gov-approval"><p><LockKeyhole size={16} aria-hidden="true"/>尚未写入。可信批准登记尚未接通。</p>{hash && <p className="gov-meta">预览摘要 <code>{hash}</code></p>}<button type="button" disabled title="等待共享批准登记接口"><LockKeyhole size={16} aria-hidden="true"/>{command}</button></div>;
}
export function SettingsFields({ value, onChange, disabled = false }: { value: Settings; onChange: (next: Settings) => void; disabled?: boolean }) {
  const fields: [keyof Settings, string][] = [['aiExtraction', 'AI候选提取'], ['aiAnswer', 'AI来源化回答'], ['aiReview', 'AI回顾反馈'], ['saveQueryHistory', '保存查询历史'], ['reviewReminders', '回顾提醒']];
  return <fieldset className="gov-settings" disabled={disabled}>{fields.map(([key, title]) => <label className="gov-toggle" key={key}><span>{title}</span><input type="checkbox" checked={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.checked })}/><span className="gov-meta">{value[key] ? '开启' : '关闭'}</span></label>)}</fieldset>;
}
export function NodeFields({ value, onChange, actorId, disabled }: { value: KnowledgeNode; onChange: (patch: Partial<KnowledgeNode>) => void; actorId: string; disabled: boolean }) {
  return <fieldset className="gov-fields" disabled={disabled}>
    <label>标题<input value={value.title} maxLength={4000} required onChange={(e) => onChange({ title: e.target.value })}/></label>
    <label>问题<textarea value={value.question} rows={2} maxLength={20000} required onChange={(e) => onChange({ question: e.target.value })}/></label>
    <label>人的陈述<textarea value={value.humanStatement} rows={5} maxLength={100000} required onChange={(e) => onChange({ humanStatement: e.target.value })}/></label>
    <div className="gov-section-heading"><h3>适用前提</h3><button type="button" className="gov-icon" aria-label="增加前提" title="增加前提" onClick={() => onChange({ conditions: [...value.conditions, { id: crypto.randomUUID(), text: '', status: 'unknown', evidenceIds: [] }] })}><Plus size={18}/></button></div>
    {value.conditions.map((condition, index) => <div className="gov-condition" key={condition.id}>
      <label>前提 {index + 1}<textarea rows={2} required value={condition.text} onChange={(e) => onChange({ conditions: value.conditions.map((c) => c.id === condition.id ? { ...c, text: e.target.value, status: 'unknown', evidenceIds: [], confirmedBy: undefined } : c) })}/></label>
      <label>人的判断<select value={condition.status} onChange={(e) => onChange({ conditions: value.conditions.map((c) => c.id === condition.id ? { ...c, status: e.target.value as typeof c.status, confirmedBy: e.target.value === 'confirmed' ? actorId : undefined } : c) })}><option value="unknown">尚未确认</option><option value="confirmed">已确认</option><option value="rejected">不成立</option></select></label>
      <button type="button" className="gov-icon gov-danger" aria-label={`移除前提 ${index + 1}`} title="移除前提" onClick={() => onChange({ conditions: value.conditions.filter((c) => c.id !== condition.id) })}><Trash2 size={17}/></button>
    </div>)}
    <label>适用边界<textarea rows={3} value={value.boundaries.join('\n')} onChange={(e) => onChange({ boundaries: e.target.value.split('\n').filter((text) => text.trim()) })}/></label>
    <div className="gov-two-col"><label>来源支持状态<select value={value.evidenceStatus} onChange={(e) => onChange({ evidenceStatus: e.target.value as KnowledgeNode['evidenceStatus'] })}>{['unverified', 'partial', 'supported', 'disputed'].map((state) => <option key={state} value={state}>{label(state)}</option>)}</select></label>
      <label>知识状态<select value={value.lifecycle} onChange={(e) => onChange({ lifecycle: e.target.value as KnowledgeNode['lifecycle'] })}>{['active', 'needs_review', 'superseded', 'withdrawn'].map((state) => <option key={state} value={state} disabled={state === 'superseded'}>{label(state)}</option>)}</select></label></div>
    <details><summary>来源记录（{value.sources.length}）</summary>{value.sources.map((source, index) => <div className="gov-source" key={source.id}><strong>{source.title}</strong><p>{source.excerpt}</p><label>对陈述的支持<select value={source.support} onChange={(e) => onChange({ sources: value.sources.map((s, i) => i === index ? { ...s, support: e.target.value as typeof s.support } : s) })}><option value="unverified">未核验</option><option value="supports">支持</option><option value="partial">部分支持</option><option value="does_not_support">不支持</option></select></label><label>支持哪一条陈述<input value={source.supportedClaim} onChange={(e) => onChange({ sources: value.sources.map((s, i) => i === index ? { ...s, supportedClaim: e.target.value } : s) })}/></label><label>限制<input value={source.limitation} onChange={(e) => onChange({ sources: value.sources.map((s, i) => i === index ? { ...s, limitation: e.target.value } : s) })}/></label></div>)}</details>
  </fieldset>;
}
const displayValue = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
const fieldLabels: Record<string, string> = { title: '标题', question: '问题', humanStatement: '人的陈述', authorship: '表达来源', conditions: '适用前提', boundaries: '适用边界', sources: '来源记录', evidenceStatus: '来源支持', lifecycle: '知识状态', source: '关系起点', target: '关系终点', type: '关系类型', rationale: '关系依据', evidenceIds: '证据引用', state: '关系状态' };
export function ChangesView({ preview }: { preview: ChangePreview }) {
  return <section className="gov-band" id="governance-preview" tabIndex={-1} aria-label="变更预览"><h2>变更预览</h2><p className="gov-meta">基准版本 <code>{preview.changes.baseRevision}</code></p><p><strong>修改理由：</strong>{preview.changes.reason}</p>
    {[...preview.changes.nodes, ...preview.changes.relations].map((after) => {
      const before = [...preview.before.nodes, ...preview.before.relations].find((item) => item.id === after.id);
      const fields = Object.keys(fieldLabels).filter((key) => key in after && JSON.stringify(before?.[key as keyof typeof before]) !== JSON.stringify(after[key as keyof typeof after]));
      return <article key={after.id} className="gov-change-object"><h3>对象 {after.id}</h3>{fields.map((key) => <div key={key}><h4>{fieldLabels[key]}</h4><div className="gov-diff"><div><h3>原版本</h3><pre>{displayValue(before?.[key as keyof typeof before])}</pre></div><div><h3>拟提交版本 · 待确认</h3><pre>{displayValue(after[key as keyof typeof after])}</pre></div></div></div>)}</article>;
    })}<ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>;
}
export function FileList({ files, downloadable = false }: { files: { path: string; content: string }[]; downloadable?: boolean }) {
  function download(file: { path: string; content: string }) {
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = file.path.replaceAll('/', '__');
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="gov-files">{files.map((file) => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre>{downloadable && <button type="button" onClick={() => download(file)}><Download size={16} aria-hidden="true"/>下载 {file.path}</button>}</details>)}</div>;
}
export function LayerTable({ layers }: { layers: { name: string; label?: string; capability?: string; state?: string; consequence?: string; nextAction?: string; reversible?: boolean | null }[] }) {
  return <div className="gov-table-wrap"><table><caption>分层清理与残留状态</caption><thead><tr><th scope="col">数据层</th><th scope="col">状态</th><th scope="col">后果 / 核验</th></tr></thead><tbody>{layers.map((layer) => <tr key={layer.name}><th scope="row">{layer.label ?? layer.name}</th><td>{!layer.state && layer.capability === 'supported' ? '支持自动处理' : label(layer.state ?? layer.capability ?? 'unknown')}{layer.reversible !== undefined && <small>{layer.reversible === null ? '可恢复性未知' : layer.reversible ? '可恢复' : '不可自动恢复'}</small>}</td><td>{layer.consequence ?? layer.nextAction ?? '待平台读回'}{layer.consequence && layer.nextAction && layer.nextAction !== layer.consequence && <p>原报告 / 核验：{layer.nextAction}</p>}</td></tr>)}</tbody></table></div>;
}
export function HistoryList({ data }: { data: ReturnType<typeof historyNotices> }) {
  return <div>
    {!data.entries.length && <p className="gov-empty">没有相应的历史记录。</p>}
    {data.entries.map((entry) => <article className="gov-history" key={entry.summary.id}>
      <div className="gov-section-heading"><h3>{entry.summary.kind} · {entry.summary.id}</h3><time>{entry.summary.recordedAt}</time></div>
      {entry.restricted ? <p className="gov-notice">历史内容受限，未返回已阻断对象的正文。</p> : <p className="gov-original">{entry.record?.answer}</p>}
      {!entry.restricted && entry.record?.kind === 'use' && <p>当时决定：{entry.record.decision ? ({ adopt: '采用', reject: '不采用', verify_later: '待验证' })[entry.record.decision] : '未记录'}</p>}
      {!entry.restricted && entry.record?.kind === 'use' && !entry.record.useContext && <p className="gov-notice">原任务、条件与路径未记录，不能用当前内容补写。</p>}
      {!entry.restricted && entry.record?.useContext && <details><summary>原使用上下文</summary>
        <p>原任务：{entry.record.useContext.task.question}</p><ul>{entry.record.useContext.task.constraints.map((constraint) => <li key={constraint.id}>{constraint.text}</li>)}</ul>
        <h4>原任务条件核对</h4>
        {entry.record.useContext.task.conditionChecks?.length ? <ul>{entry.record.useContext.task.conditionChecks.map((check) => <li key={`${check.nodeRef.objectId}:${check.nodeRef.revision}:${check.conditionId}`}>
          <strong>{({ satisfied: '当时满足', not_satisfied: '当时不满足', unknown: '当时未知' })[check.status]}</strong> · <code>{check.nodeRef.objectId} @ {check.nodeRef.revision}</code> · 条件 <code>{check.conditionId}</code>
          {check.confirmedBy && <span> · 确认人 <code>{check.confirmedBy}</code></span>}
        </li>)}</ul> : <p>{entry.record.useContext.task.conditionChecks ? '当时没有条件核对项。' : '当时的条件核对未记录。'}</p>}
        <p>当时理由：{entry.record.useContext.reason || '未记录'}</p><p className="gov-meta">原快照 <code>{entry.record.useContext.snapshotRevision}</code> · 客户端预览记录，不是服务端重新核验的检索结论。</p>
        {entry.record.useContext.paths.map((path, index) => <div key={index}><p>{path.nodeIds.join(' → ')} · {path.reason}</p><p className="gov-meta">关系ID：{path.relationIds.join(', ') || '无'}</p></div>)}
        {entry.record.useContext.knowledge.map((knowledge) => <div key={knowledge.id}><h4>{knowledge.title}</h4><p>{knowledge.humanStatement}</p><ul>{knowledge.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul></div>)}
        <p>当时检索覆盖：{label(entry.record.useContext.retrievalContext.coverage)}</p><ul>{[...entry.record.useContext.retrievalContext.missingConditions, ...entry.record.useContext.retrievalContext.warnings].map((text, index) => <li key={index}>{text}</li>)}</ul>
      </details>}
      {!entry.restricted && entry.record?.outcome && <><p>原使用记录 <code>{entry.record.outcome.useRecordId}</code> · {({ succeeded: '自述成功', failed: '自述失败', unclear: '结果未明' })[entry.record.outcome.status]}</p><p>{entry.record.outcome.summary}</p><p>{entry.record.outcome.failureReason}</p><p className="gov-meta">自述结果，不是无提示掌握证据。</p></>}
      {entry.nodes.map((item) => <div key={`${item.ref.objectId}:${item.ref.revision}`}>
        <p><strong>{label(item.state)}</strong> · <code>{item.ref.objectId} @ {item.ref.revision}</code></p>
        <p>{item.message}</p>
        {item.historicalConditions && <ul>{item.historicalConditions.map((condition) => <li key={condition.id}>{condition.text} · {label(condition.status)}</li>)}</ul>}
        {!entry.restricted && <a className="gov-link" href={retrievalLink(item.ref.objectId, item.ref.revision)}>查看引用版本</a>}
      </div>)}
      {entry.relations.map((edge) => <div key={edge.id}><p>{edge.id} · {label(edge.state)} · {edge.message}</p>{edge.historicalRelation && <p>原关系：{edge.historicalRelation.source.objectId} → {edge.historicalRelation.type} → {edge.historicalRelation.target.objectId} · {edge.historicalRelation.rationale}</p>}</div>)}
    </article>)}
  </div>;
}
