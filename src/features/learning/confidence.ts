import { EvidenceRecordSchema, Timestamp, type EvidenceRecord } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure, success } from './errors';

export interface ConfidenceChoice { value: EvidenceRecord['selfConfidence'] | null; recordedAt: string | null; locked: boolean }
export function initialConfidence(): ConfidenceChoice { return { value: null, recordedAt: null, locked: false }; }
export function chooseConfidence(state: ConfidenceChoice, input: unknown, now: string): Result<ConfidenceChoice> {
  if (state.locked) return failure('CONFLICT', '已经开始作答，不能补填或改变作答前信心。', 'keep_original_confidence');
  const parsed = EvidenceRecordSchema.shape.selfConfidence.safeParse(input);
  if (!parsed.success || !Timestamp.safeParse(now).success || (state.recordedAt && Date.parse(now) < Date.parse(state.recordedAt))) return failure('VALIDATION', '请选择低、中、高或跳过，并检查记录时间。');
  return success({ value: parsed.data, recordedAt: now, locked: false });
}
export function lockConfidence(state: ConfidenceChoice): Result<ConfidenceChoice> {
  if (state.value === null || state.recordedAt === null) return failure('VALIDATION', '开始前请选择信心，或明确跳过。', 'choose_confidence');
  return success({ ...state, locked: true });
}
