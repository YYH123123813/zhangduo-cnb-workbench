import type { ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import type { HandoffPreview } from './preview';

export function PreviewPanel({ preview, onEdit, locked = false, readOnly = false, gitState = 'not_submitted', children }: {
  preview: HandoffPreview; onEdit?: () => void; locked?: boolean; readOnly?: boolean; gitState?: 'not_submitted' | 'pending' | 'unknown' | 'saved'; children?: ReactNode;
}) {
  return <section className="handoff-preview" aria-labelledby="handoff-preview-title">
    <header className="handoff-heading"><div><h2 id="handoff-preview-title" tabIndex={-1}>{readOnly ? '原提交预览（只读）' : '入库差异预览'}</h2><p>{({ not_submitted: '未写入 Git', pending: 'Git 提交待回执', unknown: 'Git 写入结果未知', saved: 'Git 已保存' })[gitState]} · 基准版本 <code>{preview.changes.baseRevision}</code></p></div>
      {!readOnly && <button type="button" disabled={locked} onClick={onEdit}><Pencil size={17} />返回修改</button>}</header>
    <p>本次新增/更新 {preview.changes.nodes.length} 条知识、{preview.changes.relations.length} 条关系，撤回 {preview.changes.withdrawnIds.length} 个正式对象。</p>
    <dl className="handoff-diff">{preview.diff.rows.map((row, index) => <div key={index}>
      <dt><span>{({ add: '新增', remove: '移除', change: '修改' })[row.action]}</span> {row.label}</dt>
      <dd className="handoff-comparison"><div><strong>当前 / 原始</strong><p>{row.before}</p></div><div><strong>提交后</strong><p>{row.after}</p></div></dd>
    </div>)}</dl>
    <h3>后续检索影响</h3><ul>{preview.diff.impacts.map((impact) => <li key={impact}>{impact}</li>)}</ul>
    <p>内容摘要：<code>{preview.changes.contentHash}</code></p><p>操作 ID：<code>{preview.changes.id}</code></p>
    {children}
  </section>;
}
