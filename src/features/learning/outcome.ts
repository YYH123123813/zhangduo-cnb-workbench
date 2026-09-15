import { z } from 'zod';
import { EvidenceRecordSchema, Id, type EvidenceRecord } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { failure, success } from './errors';

export const OutcomeInputSchema = z.object({
  useRecordId: Id, status: z.enum(['succeeded', 'failed', 'unclear']),
  summary: z.string().trim().min(1).max(4000), failureReason: z.string().trim().max(4000),
}).strict();
export type OutcomeInput = z.infer<typeof OutcomeInputSchema>;
export interface OutcomeDraft extends OutcomeInput {
  taskId: string; workspaceId: string; nodeRefs: EvidenceRecord['nodeRefs']; relationRefs: string[];
  verification: 'self_reported'; revisionSuggested: boolean; persistence: 'not_saved';
}

export function previewOutcome(input: unknown, original: EvidenceRecord, ctx: RequestContext): Result<OutcomeDraft> {
  const parsed = OutcomeInputSchema.safeParse(input);
  const record = EvidenceRecordSchema.safeParse(original);
  if (!parsed.success || !record.success) return failure('VALIDATION', '结果格式不正确；请填写简短结果和失败原因。');
  if (record.data.workspaceId !== ctx.workspaceId || record.data.nodeRefs.some((ref) => ref.workspaceId !== ctx.workspaceId)) return failure('FORBIDDEN', '不能读取其他工作区的应用记录。', 'return_to_workspace');
  if (record.data.id !== parsed.data.useRecordId || record.data.kind !== 'use') return failure('VALIDATION', '实际结果必须关联原应用记录。');
  if (parsed.data.status === 'failed' && !parsed.data.failureReason) return failure('VALIDATION', '请填写失败原因，未知原因可明确填写“尚不清楚”。');
  return success(structuredClone({ ...parsed.data, taskId: record.data.taskId, workspaceId: record.data.workspaceId,
    nodeRefs: record.data.nodeRefs, relationRefs: record.data.relationRefs, verification: 'self_reported' as const,
    revisionSuggested: parsed.data.status === 'failed', persistence: 'not_saved' as const,
  }));
}
