import { useState } from 'react';
import type { AuditOperation } from '../../contracts/audit';
import type { auditView } from './audit';
import { label } from './client-model';

type Entry = ReturnType<typeof auditView>['entries'][number];
type Filters = { action: string; objectId: string; outcome: string };
const actions: Record<string, string> = { commit_knowledge: '知识提交', 'knowledge.commit': '知识提交', delete: '删除', 'delete.execute': '删除执行', export: '导出', data_exported: '数据导出',
  settings: '设置', settings_saved: '设置保存', 'settings.save': '设置保存', save_conversation: '保存对话', 'conversation.save': '保存对话', save_evidence: '保存证据', model_input: '模型输入',
  model_extract: 'AI提取', model_answer: 'AI回答', model_review: 'AI评阅', candidates_saved: '候选保存', draft_saved: '草稿保存', evidence_saved: '证据保存', approval_revoke: '批准撤回', 'approval.revoke': '批准撤回', retrieval_blocked: '检索阻断', unknown: '未知动作' };
const outcomes: Record<string, string> = { partial: '部分完成', done: '平台记录完成', saved: '已保存', verified: '已核验', not_configured: '未配置', conflict: '版本冲突',
  failed: '失败', cancelled: '已取消', unknown: '未知', sending: '发送中', private_not_indexed: '私有保存，未索引', private_temporary_not_indexed: '临时私有保存，未索引', physical_cleanup_unverified: '物理清理未核验', generated_not_published: '已生成，未公开' };
const operationLabels: Record<AuditOperation['kind'], string> = { knowledge: '原ChangeSet', settings: '原批准', delete: '原计划', evidence: '原保存操作' };
const inspectableOutcomes = new Set(['success', 'partial', 'done', 'saved', 'verified', 'private_not_indexed', 'private_temporary_not_indexed', 'physical_cleanup_unverified', 'generated_not_published']);
export function auditOperationHref(operation: AuditOperation) {
  if (operation.kind === 'evidence') return undefined;
  const key = operation.kind === 'knowledge' ? 'changeSetId' : operation.kind === 'settings' ? 'approvalId' : 'planId';
  return `#governance?${new URLSearchParams({ [key]: operation.id }).toString()}`;
}
export function auditOperationIsInspectable(outcome: string) { return inspectableOutcomes.has(outcome); }
export function filterAuditEntries(entries: Entry[], filters: Filters) {
  return entries.filter((entry) => (!filters.action || entry.action === filters.action) && (!filters.outcome || entry.outcome === filters.outcome)
    && (!filters.objectId.trim() || entry.objectIds.includes(filters.objectId.trim())));
}
export function AuditLog({ entries, onInspectOperation }: { entries: Entry[]; onInspectOperation?: (operation: AuditOperation) => void }) {
  const [filters, setFilters] = useState<Filters>({ action: '', objectId: '', outcome: '' });
  const filtered = filterAuditEntries(entries, filters);
  const operationControl = (entry: Entry) => {
    if (!entry.operation) return null;
    const operation = entry.operation;
    if (!auditOperationIsInspectable(entry.outcome)) return <span className="gov-meta">{operationLabels[operation.kind]} <code>{operation.id}</code> · 结果{outcomes[entry.outcome] ?? label(entry.outcome)}，未视为成功</span>;
    if (operation.kind === 'evidence') return onInspectOperation ? <button type="button" className="gov-link-button" onClick={() => onInspectOperation(operation)}><span>{operationLabels[operation.kind]}</span> <code>{operation.id}</code></button> : <span>{operationLabels[operation.kind]} <code>{operation.id}</code></span>;
    const href = auditOperationHref(operation)!;
    return <a className="gov-link" href={href}>{operationLabels[operation.kind]} <code>{operation.id}</code></a>;
  };
  return <><p className="gov-meta">仅显示平台已记录活动，不构成不可篡改保证。</p>
    <div className="gov-fields"><label>动作筛选<select value={filters.action} onChange={(event) => setFilters({ ...filters, action: event.target.value })}><option value="">全部动作</option>{[...new Set(entries.map((entry) => entry.action))].map((action) => <option key={action} value={action}>{actions[action] ?? '未知动作'}</option>)}</select></label>
      <label>对象ID筛选<input value={filters.objectId} maxLength={160} onChange={(event) => setFilters({ ...filters, objectId: event.target.value })}/></label>
      <label>结果筛选<select value={filters.outcome} onChange={(event) => setFilters({ ...filters, outcome: event.target.value })}><option value="">全部结果</option>{[...new Set(entries.map((entry) => entry.outcome))].map((outcome) => <option key={outcome} value={outcome}>{outcomes[outcome] ?? label(outcome)}</option>)}</select></label></div>
    <div className="gov-table-wrap"><table><caption>活动记录 · {filtered.length} 项</caption><thead><tr><th scope="col">时间</th><th scope="col">动作</th><th scope="col">对象</th><th scope="col">结果</th><th scope="col">原操作</th></tr></thead><tbody>{filtered.map((entry, index) => <tr key={`${entry.occurredAt}-${index}`}><td><time dateTime={entry.occurredAt}>{entry.occurredAt}</time></td><td>{actions[entry.action] ?? '未知动作'}</td><td>{entry.objectIds.join(', ')}</td><td>{outcomes[entry.outcome] ?? label(entry.outcome)}</td><td>{operationControl(entry) ?? <span className="gov-meta">未提供可信原操作关联</span>}</td></tr>)}</tbody></table></div>
    {!filtered.length && <p role="status" className="gov-empty">{entries.length ? '没有符合筛选条件的活动。' : '平台尚无可显示活动。'}</p>}</>;
}
