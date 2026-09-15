import type { EvidenceRecord } from '../../contracts/domain';

export function ConfidenceFields({ value, disabled = false, onChange }: {
  value: EvidenceRecord['selfConfidence'] | null; disabled?: boolean;
  onChange: (value: EvidenceRecord['selfConfidence']) => void;
}) {
  return <fieldset disabled={disabled}><legend>作答前信心 · 自报</legend><div className="learning-options">{([
    ['low', '低'], ['medium', '中'], ['high', '高'], ['skipped', '跳过'],
  ] as const).map(([choice, label]) => <label key={choice}><input type="radio" name="pre-answer-confidence" value={choice} checked={value === choice} onChange={() => onChange(choice)}/><span>{label}</span></label>)}</div></fieldset>;
}
