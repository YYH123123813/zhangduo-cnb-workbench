import { Undo2 } from 'lucide-react';
import type { Disposition } from './model';

export const dispositions = [
  { value: 'handoff', label: '开始交接', consequence: '进入审阅，尚未写入正式知识。' },
  { value: 'archive', label: '只保留现场', consequence: '不产生正式知识；不新增远程保存。' },
  { value: 'reject', label: '拒绝候选', consequence: '不产生正式知识；原现场保持不变。' },
  { value: 'later', label: '稍后处理', consequence: '本次暂不交接；尚未保存这一选择。' },
] as const;

export function DispositionPicker({ id, value, onChange }: {
  id: string; value: Disposition; onChange: (value: Disposition) => void;
}) {
  return <fieldset className="handoff-disposition">
    <legend>本条候选</legend>
    <div className="handoff-choices">{dispositions.map((choice) => <label key={choice.value}>
      <input type="radio" name={`disposition-${id}`} value={choice.value}
        checked={value === choice.value} onChange={() => onChange(choice.value)} />{choice.label}
    </label>)}</div>
    {value && <p role="status">{dispositions.find((choice) => choice.value === value)?.consequence}</p>}
    {value && <button type="button" className="handoff-icon" title="取消选择" aria-label="取消选择" onClick={() => onChange(null)}><Undo2 size={18} /></button>}
  </fieldset>;
}
