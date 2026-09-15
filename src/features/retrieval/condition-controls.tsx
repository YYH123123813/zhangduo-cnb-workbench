import { useId } from 'react';
import { Check, SkipForward } from 'lucide-react';
import type { KnowledgeNode, TaskConditionCheck } from '../../contracts/domain';

export const conditionLabels = { satisfied: '满足', not_satisfied: '不满足', unknown: '未知' } as const;

export function ConditionChoices({ node, conditionId, status, disabled = false, onChange, onConfirm, onSkip }: {
  node: KnowledgeNode; conditionId: string; status?: TaskConditionCheck['status']; disabled?: boolean;
  onChange: (status: TaskConditionCheck['status']) => void; onConfirm: () => void; onSkip: () => void;
}) {
  const name = useId(); const condition = node.conditions.find((item) => item.id === conditionId);
  if (!condition) return null;
  return <section className="clarification" aria-label="本次适用条件">
    <p>{condition.text}</p><p className="metadata">{node.title} · {node.id} / {conditionId}</p>
    <p className="metadata">节点版本 <code>{node.revision}</code></p>
    <fieldset className="mode-choice" disabled={disabled}><legend>本次是否满足？</legend>
      {(Object.keys(conditionLabels) as TaskConditionCheck['status'][]).map((value) => <label key={value}>
        <input type="radio" name={name} value={value} checked={status === value} onChange={() => onChange(value)}/>{conditionLabels[value]}
      </label>)}
    </fieldset><div className="query-actions">
      <button type="button" className="primary-command" disabled={disabled || status === undefined} onClick={onConfirm}><Check size={17} aria-hidden="true"/>确认并重查</button>
      <button type="button" className="text-command" disabled={disabled} onClick={onSkip}><SkipForward size={17} aria-hidden="true"/>跳过本次</button>
    </div>
  </section>;
}
