import { z } from 'zod';
import { ApprovalSchema, EvidenceRecordSchema, Timestamp, type Approval, type EvidenceRecord } from '../../contracts/domain';
import { hashEvidence } from '../../contracts/hash';
import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import type { AttemptSession } from './attempt';
import type { FeedbackDraft } from './feedback';
import { inspectQuestion } from './question';
import { failure, success } from './errors';

export function attemptEvidence(attempt: AttemptSession, feedback: FeedbackDraft | null = null): Result<EvidenceRecord> {
  if (attempt.phase !== 'submitted' || !attempt.submission) return failure('CONFLICT', '本次作答尚未提交或已经退出，未生成证据。');
  if (feedback && (feedback.attemptId !== attempt.id || feedback.rubricVersion !== attempt.question.rubric.version || feedback.originalAnswer !== attempt.submission.answer)) return failure('CONFLICT', '评阅不属于当前作答及评分规则版本。');
  const result = feedback?.result === 'invalid_question' ? 'invalid_question' : attempt.question.review.status !== 'approved' ? 'unverified' : feedback?.result ?? 'unverified';
  const record = EvidenceRecordSchema.safeParse({
    id: attempt.id, workspaceId: attempt.workspaceId, taskId: attempt.taskId, kind: attempt.question.kind,
    nodeRefs: [attempt.question.nodeRef], relationRefs: [],
    answer: attempt.submission.answer, answerVisible: attempt.submission.answerVisible,
    hintLevel: attempt.submission.hintLevel, selfConfidence: attempt.submission.selfConfidence,
    result, rubricVersion: attempt.question.rubric.version,
    ...(feedback?.reviewedBy ? { reviewedBy: feedback.reviewedBy } : {}),
    recordedAt: feedback?.reviewedAt ?? attempt.submission.submittedAt,
  });
  return record.success ? success(record.data) : failure('VALIDATION', '证据不符合共享 schema，未保存。');
}

interface EvidenceReceipt {
  record: EvidenceRecord; persistence: 'saved'; verification: 'read_back'; indexing: 'excluded';
  scope: 'basic_evidence_only'; limitations: string[];
}
const receipt = (record: EvidenceRecord): Result<EvidenceReceipt> => success({
  record: structuredClone(record), persistence: 'saved', verification: 'read_back', indexing: 'excluded',
  scope: 'basic_evidence_only', limitations: ['当前契约未保存题目正文、完整条件、分项反馈及申诉历史；这不是完整的条件化学习档案。'],
});

async function readRecord(services: Services, ctx: RequestContext, record: EvidenceRecord): Promise<Result<EvidenceRecord | null>> {
  const response = await services.listEvidence(ctx, record.taskId);
  if (!response.ok) return response;
  const parsed = z.array(EvidenceRecordSchema).safeParse(response.data);
  if (!parsed.success) return failure('UPSTREAM', '证据读回格式错误，保存状态尚未确认。', 'check_storage', 'unknown');
  if (parsed.data.some((item) => item.workspaceId !== ctx.workspaceId || item.nodeRefs.some((ref) => ref.workspaceId !== ctx.workspaceId))) return failure('FORBIDDEN', '证据读回超出当前工作区，未展示记录。', 'check_storage', 'unknown');
  const matches = parsed.data.filter((item) => item.id === record.id);
  if (matches.length > 1) return failure('CONFLICT', '同一记录 ID 出现重复对象，需要检查存储。', 'check_storage', 'preserved');
  const found = matches[0];
  if (!found) return success(null);
  if (await hashEvidence(found) !== await hashEvidence(record)) return failure('CONFLICT', '该记录 ID 已关联不同内容，不能覆盖。', 'inspect_existing_record', 'preserved');
  return success(found);
}

// Called only with a server-owned attempt. No HTTP route accepts an AttemptSession from clients.
// The platform must provide registered/revocable approvals and atomic idempotency by record.id.
export async function saveAttemptEvidence(services: Services, ctx: RequestContext, attempt: AttemptSession, feedback: FeedbackDraft | null, input: { consent: boolean; approval: Approval }, now: string): Promise<Result<EvidenceReceipt>> {
  let writeStarted = false;
  try {
    if (!input.consent || !ctx.scopes.includes('evidence:write') || !ctx.scopes.includes('evidence:read') || !ctx.scopes.includes('knowledge:read') || ctx.actorId !== attempt.actorId || ctx.workspaceId !== attempt.workspaceId) return failure('FORBIDDEN', '未批准保存范围，或没有保存与读回权限。', 'confirm_save_scope');
    if (ctx.mode === 'unconfigured') return failure('NOT_CONFIGURED', '工作区未配置，未执行保存。', 'configure_workspace');
    const prepared = attemptEvidence(attempt, feedback);
    if (!prepared.ok) return prepared;
    const record = prepared.data;
    const approval = ApprovalSchema.safeParse(input.approval);
    if (!approval.success || !Timestamp.safeParse(now).success) return failure('VALIDATION', '保存批准或时间无效。');
    const approved = approval.data;
    if (approved.actorId !== ctx.actorId || approved.workspaceId !== ctx.workspaceId || approved.purpose !== 'save_evidence' || approved.baseRevision !== attempt.snapshotRevision || approved.objectIds.length !== 1 || approved.objectIds[0] !== record.id || Date.parse(approved.approvedAt) > Date.parse(now) || Date.parse(approved.approvedAt) < Date.parse(record.recordedAt) || Date.parse(approved.expiresAt) <= Date.parse(now) || approved.contentHash !== await hashEvidence(record)) return failure('FORBIDDEN', '批准已过期或不匹配本次内容、对象及基准版本。', 'preview_and_approve_again');
    const previous = await readRecord(services, ctx, record);
    if (!previous.ok) return previous;
    if (previous.data) return receipt(previous.data);
    const snapshot = await services.snapshot(ctx);
    if (!snapshot.ok) return snapshot;
    if (snapshot.data.workspaceId !== ctx.workspaceId || snapshot.data.revision !== attempt.snapshotRevision) return failure('CONFLICT', '保存前知识版本已变化，原作答保留。', 'review_question_again');
    const question = inspectQuestion(attempt.question, snapshot.data);
    if (!question.ok) return question;
    writeStarted = true;
    let written: Result<EvidenceRecord>;
    try { written = await services.appendEvidence(ctx, record, approved); }
    catch { written = failure('UNKNOWN_RESULT', '证据写入结果未知。', 'read_back', 'unknown'); }
    if (!written.ok && written.error.dataState === 'not_written') return written;
    if (written.ok) {
      const parsed = EvidenceRecordSchema.safeParse(written.data);
      if (!parsed.success || await hashEvidence(parsed.data) !== await hashEvidence(record)) return failure('UNKNOWN_RESULT', '写入回执与批准内容不一致，不能确认成功。', 'read_back', 'unknown');
    }
    const verified = await readRecord(services, ctx, record);
    if (verified.ok && verified.data) return receipt(verified.data);
    return failure('UNKNOWN_RESULT', '暂未读回一致记录，结果未知；不要新建操作重复保存。', 'read_back_same_record_id', 'unknown');
  } catch {
    return failure(writeStarted ? 'UNKNOWN_RESULT' : 'UPSTREAM', '证据处理未能确认完成；未返回内部错误内容。', writeStarted ? 'read_back_same_record_id' : 'check_service', writeStarted ? 'unknown' : 'not_written');
  }
}
