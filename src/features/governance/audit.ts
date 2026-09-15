import { z } from 'zod';
import { AuditOperationSchema } from '../../contracts/audit';
import { Timestamp } from '../../contracts/domain';
import { fail } from './http';

const actions = new Set(['commit_knowledge', 'delete', 'export', 'settings', 'save_conversation', 'save_evidence', 'evidence_saved', 'model_input', 'model_extract', 'model_answer', 'model_review', 'candidates_saved', 'draft_saved', 'approval_revoke', 'knowledge.commit', 'delete.execute', 'settings.save', 'conversation.save', 'approval.revoke', 'settings_saved', 'retrieval_blocked', 'data_exported']);
const outcomes = new Set(['success', 'failed', 'cancelled', 'denied', 'unknown', 'sending', 'partial', 'pending', 'done', 'saved', 'verified', 'rejected', 'not_configured', 'conflict', 'discarded', 'private_not_indexed', 'private_temporary_not_indexed', 'physical_cleanup_unverified', 'generated_not_published']);
const safeId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) && !/^(sk-|bearer|token|authorization|cookie|secret)/i.test(value);
export function auditView(value: unknown) {
  // Strip unrelated upstream fields while validating the platform-owned association as a unit.
  const result = z.array(z.object({ action: z.string(), objectIds: z.array(z.string()).max(200), occurredAt: Timestamp, outcome: z.string(), operation: AuditOperationSchema.optional() })).max(10000).safeParse(value);
  if (!result.success) fail('UPSTREAM', '审计记录格式无效，未返回原始日志。', 'review_platform_audit');
  const entries = result.data.map((entry) => ({
    action: actions.has(entry.action) ? entry.action : 'unknown',
    objectIds: entry.objectIds.map((id) => safeId(id) ? id : '[redacted]'),
    occurredAt: entry.occurredAt,
    outcome: outcomes.has(entry.outcome.toLowerCase()) ? entry.outcome.toLowerCase() : 'unknown',
    ...(entry.operation && safeId(entry.operation.id) ? { operation: entry.operation } : {}),
  })).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return { entries, tamperProof: false, coverage: 'platform_records_only' as const,
    warnings: ['仅显示平台实际记录的活动，不构成不可篡改保证。', '未登记的预览与本地取消不会伪造为平台审计事件；未知动作不显示原始文本。', '原操作关联仅来自平台事务记录；objectIds只是业务范围，未知或发送中的结果不视为成功。'] };
}
