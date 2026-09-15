import { useState } from 'react';
import { CheckCheck, X } from 'lucide-react';
import type { Conversation } from '../../contracts/domain';
import type { SourceDraft } from './parse';
import { selectSegments } from './scope';
import { safeDisplayText } from './redaction';

type Segment = Conversation['segments'][number];
export function ScopeEditor({ source, onChange }: { source: SourceDraft; onChange: (segments: Segment[]) => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, Segment['role']>>({});
  function update(next: string[], nextRoles = roles) {
    setIds(next); setRoles(nextRoles);
    const result = selectSegments(source.segments.map((s) => ({ ...s, role: nextRoles[s.id] ?? s.role })), next);
    onChange(result.ok ? result.data : []);
  }
  return <section className="capture-section" aria-labelledby="capture-scope-title">
    <h2 id="capture-scope-title">保存范围</h2>
    <p>{source.sourceAlreadyPersisted ? '原内容已在CNB保存，现场时间' : '原文仅在当前页面，导入时间'}：<time dateTime={source.createdAt}>{source.createdAt}</time></p>
    <p role="status">已选 {ids.length} / {source.segments.length} 段</p>
    <div className="capture-actions"><button type="button" disabled={ids.length === source.segments.length} onClick={() => update(source.segments.map((segment) => segment.id))}><CheckCheck size={16} aria-hidden="true"/>全选片段</button>
      <button type="button" disabled={!ids.length} onClick={() => update([])}><X size={16} aria-hidden="true"/>取消全部选择</button></div>
    {source.segments.map((segment, i) => <article key={segment.id} className="capture-segment">
      <label className="capture-choice"><input type="checkbox" checked={ids.includes(segment.id)} onChange={(e) => update(e.target.checked ? [...ids, segment.id] : ids.filter((id) => id !== segment.id))}/>片段 {i + 1}</label>
      <label htmlFor={`capture-role-${i}`}>角色</label>
      <select id={`capture-role-${i}`} value={roles[segment.id] ?? segment.role} onChange={(e) => update(ids, { ...roles, [segment.id]: e.target.value as Segment['role'] })}>
        <option value="user">用户</option><option value="assistant">AI</option><option value="source">来源 / 角色不明</option>
      </select>
      <pre>{safeDisplayText(segment.text)}</pre>
    </article>)}
  </section>;
}
