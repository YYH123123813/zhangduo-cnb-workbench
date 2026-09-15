import { Check, Trash2, X } from 'lucide-react';
import type { ApiError } from '../../contracts/api';
import type { KnowledgeSnapshot, Relation } from '../../contracts/domain';
import { relationEvidence, validateRelations } from './relations';
import type { RelationSubject } from './relations';
import type { RelationInput } from './model';

export const relationLabels: Record<Relation['type'], string> = { supports: '支持', depends_on: '依赖', contradicts: '冲突', supersedes: '替代' };
const emptyInput: RelationInput = { targetId: '', type: '', direction: '', rationale: '', evidenceIds: [] };
export function RelationEditor({ subject, snapshot, actorId, value, input: form, onInputChange, onChange, onError }: {
  subject: RelationSubject; snapshot: KnowledgeSnapshot; actorId: string; value: Relation[];
  input: RelationInput; onInputChange: (input: RelationInput) => void;
  onChange: (relations: Relation[], input?: RelationInput) => void; onError: (error: ApiError) => void;
}) {
  const targets = snapshot.nodes.filter((node) => node.id !== subject.id && node.confirmation === 'confirmed' && node.lifecycle === 'active' && !snapshot.excludedIds.includes(node.id));
  const target = targets.find((node) => node.id === form.targetId);
  const { sources, ambiguousIds } = relationEvidence([...subject.sources, ...(target?.sources ?? [])]);
  function patch(change: Partial<RelationInput>) { onInputChange({ ...form, ...change }); }
  function confirm() {
    if (!target || !form.type || !form.direction) return;
    const now = new Date().toISOString();
    const self = { workspaceId: subject.workspaceId, objectId: subject.id, revision: subject.revision };
    const other = { workspaceId: target.workspaceId, objectId: target.id, revision: target.revision };
    const relation: Relation = { id: crypto.randomUUID(), workspaceId: subject.workspaceId,
      source: form.direction === 'outgoing' ? self : other, target: form.direction === 'outgoing' ? other : self,
      type: form.type, rationale: form.rationale.trim(), evidenceIds: form.evidenceIds, state: 'confirmed',
      proposedBy: actorId, confirmedBy: actorId, confirmedAt: now, updatedAt: now };
    const result = validateRelations([...value, relation], subject, snapshot, true);
    if (result.ok) onChange(result.data, emptyInput); else onError(result.error);
  }
  return <section className="handoff-relations" aria-label="正式关系">
    <h3>正式关系</h3><p>基准版本：<code>{snapshot.revision}</code> · 已确认 {value.filter((relation) => relation.state === 'confirmed').length} 条关系</p>
    {value.length === 0 && <p>当前无关系。</p>}
    <ul className="handoff-relation-list">{value.map((relation) => <li key={relation.id}>
      <strong>{relation.source.objectId} → {relationLabels[relation.type]} → {relation.target.objectId}</strong>
      <p>{relation.rationale}</p><p>目标版本：{relation.target.revision} · 依据：{relation.evidenceIds.join('、')}</p>
      <p>{relation.state === 'confirmed' ? '已确认，尚未入库' : '陈述或条件已变化，关系待重新确认'}</p>
      {relation.state !== 'confirmed' && <button type="button" onClick={() => {
        const now = new Date().toISOString();
        const confirmed: Relation = { ...relation, state: 'confirmed', confirmedBy: actorId, confirmedAt: now, updatedAt: now };
        const result = validateRelations([confirmed], subject, snapshot);
        if (result.ok) onChange(value.map((entry) => entry.id === relation.id ? confirmed : entry)); else onError(result.error);
      }}><Check size={17} />重新确认关系</button>}
      <button type="button" className="handoff-icon" title="移除本次新增关系" aria-label="移除本次新增关系" onClick={() => onChange(value.filter((entry) => entry.id !== relation.id))}><Trash2 size={18} /></button>
    </li>)}</ul>
    <details><summary>新增关系</summary><form className="handoff-fields" onSubmit={(event) => { event.preventDefault(); confirm(); }}>
      <label htmlFor="relation-target">目标知识与版本</label><select id="relation-target" value={form.targetId} required onChange={(event) => patch({ targetId: event.target.value, evidenceIds: [] })}>
        <option value="">未选择</option>{targets.map((node) => <option key={node.id} value={node.id}>{node.title} · {node.revision}</option>)}</select>
      <label htmlFor="relation-type">关系类型</label><select id="relation-type" value={form.type} required onChange={(event) => patch({ type: event.target.value as Relation['type'] })}>
        <option value="">未选择</option>{Object.entries(relationLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select>
      <fieldset className="handoff-disposition"><legend>关系方向</legend><div className="handoff-choices">
        <label><input type="radio" name="relation-direction" checked={form.direction === 'outgoing'} onChange={() => patch({ direction: 'outgoing' })} />本条 → 目标</label>
        <label><input type="radio" name="relation-direction" checked={form.direction === 'incoming'} onChange={() => patch({ direction: 'incoming' })} />目标 → 本条</label>
      </div></fieldset>
      <label htmlFor="relation-reason">关系理由</label><textarea id="relation-reason" value={form.rationale} maxLength={4000} required onChange={(event) => patch({ rationale: event.target.value })} />
      <fieldset className="handoff-disposition"><legend>关系依据</legend>
        {ambiguousIds.length > 0 && <p className="handoff-error" role="alert">来源 ID 对应不同原句或身份：{ambiguousIds.join('、')}。这些来源不能作为本次关系依据。</p>}
        <div className="handoff-choices">{sources.map((source) => <label key={source.id}>
        <input type="checkbox" checked={form.evidenceIds.includes(source.id)} onChange={(event) => patch({ evidenceIds: event.target.checked ? [...form.evidenceIds, source.id] : form.evidenceIds.filter((id) => id !== source.id) })} />{source.title}
      </label>)}</div></fieldset>
      <div className="handoff-actions"><button type="submit" disabled={!target || !form.type || !form.direction || !form.rationale.trim() || !form.evidenceIds.length}><Check size={17} />确认本条关系</button>
        <button type="button" className="handoff-icon" title="取消关系编辑" aria-label="取消关系编辑" onClick={() => patch(emptyInput)}><X size={18} /></button></div>
    </form></details>
  </section>;
}
