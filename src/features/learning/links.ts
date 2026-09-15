import { Id, VersionRefSchema, type EvidenceRecord, type VersionRef } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import type { OutcomeDraft } from './outcome';
import { failure, success } from './errors';

export function taskHref(taskId: string) {
  return taskId.trim() && Id.safeParse(taskId).success ? `#retrieval?${new URLSearchParams({ taskId })}` : '#retrieval';
}
export function savedOutcomeLinks(record: EvidenceRecord) {
  if (record.kind !== 'outcome' || record.outcome?.status !== 'failed') return [];
  return record.nodeRefs.map((nodeRef) => ({ nodeRef, href: `#governance?${new URLSearchParams({ nodeId: nodeRef.objectId,
    revision: nodeRef.revision, useId: record.outcome!.useRecordId, evidenceId: record.id, taskId: record.taskId })}` }));
}
export interface RevisionClue { href: string; nodeRef: VersionRef; origin: 'user_report'; useRecordId: string; taskHref: string }
export function revisionClues(outcome: OutcomeDraft, ctx: RequestContext): Result<RevisionClue[]> {
  if (outcome.workspaceId !== ctx.workspaceId || outcome.nodeRefs.some((ref) => ref.workspaceId !== ctx.workspaceId)) return failure('FORBIDDEN', '修订线索不属于当前工作区。');
  if (outcome.status !== 'failed' || !outcome.revisionSuggested) return success([]);
  if (!outcome.failureReason.trim() || !Id.safeParse(outcome.useRecordId).success || outcome.nodeRefs.some((ref) => !VersionRefSchema.safeParse(ref).success)) return failure('VALIDATION', '失败线索缺少原记录或版本引用。');
  return success(outcome.nodeRefs.map((nodeRef) => ({
    href: `#governance?${new URLSearchParams({ nodeId: nodeRef.objectId, revision: nodeRef.revision, useId: outcome.useRecordId, taskId: outcome.taskId })}`,
    nodeRef: structuredClone(nodeRef), origin: 'user_report', useRecordId: outcome.useRecordId,
    taskHref: taskHref(outcome.taskId),
  })));
}
