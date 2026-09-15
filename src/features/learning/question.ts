import { z } from 'zod';
import { Id, Timestamp, VersionRefSchema, type KnowledgeSnapshot } from '../../contracts/domain';
import type { Result } from '../../contracts/api';
import { failure, success } from './errors';

const Text = z.string().trim().min(1).max(8000);
export const ReviewQuestionSchema = z.object({
  id: Id, workspaceId: Id, revision: Id, nodeRef: VersionRefSchema,
  kind: z.enum(['recall', 'near_transfer']), prompt: Text, standardAnswer: Text,
  hints: z.tuple([Text, Text, Text]),
  rubric: z.object({ version: Id, criteria: z.array(z.object({ id: Id, description: Text, expectedEvidence: Text, required: z.boolean() }).strict()).min(1).max(12), necessaryConditions: z.array(Text).max(20) }).strict(),
  review: z.object({ status: z.enum(['pending', 'approved', 'rejected']), reviewedBy: Id.optional(), reviewedAt: Timestamp.optional() }).strict(),
  transfer: z.object({ dimension: z.enum(['scenario', 'constraints', 'representation', 'numbers_only']), change: Text }).strict().optional(),
}).strict();
export type ReviewQuestion = z.infer<typeof ReviewQuestionSchema>;

export function inspectQuestion(input: unknown, snapshot: KnowledgeSnapshot, forExperiment = false): Result<ReviewQuestion> {
  const parsed = ReviewQuestionSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '题目、提示或评分规则不完整。');
  const question = parsed.data;
  if (question.workspaceId !== snapshot.workspaceId || question.nodeRef.workspaceId !== snapshot.workspaceId) return failure('FORBIDDEN', '审核题不属于当前工作区。');
  const node = snapshot.nodes.find((node) => node.id === question.nodeRef.objectId);
  if (!node || node.workspaceId !== snapshot.workspaceId || node.revision !== question.nodeRef.revision || snapshot.excludedIds.includes(node.id) || node.confirmation !== 'confirmed' || node.lifecycle !== 'active') return failure('CONFLICT', '题目引用的知识版本已变化或不可使用。', 'review_question_again');
  if (new Set(question.rubric.criteria.map((criterion) => criterion.id)).size !== question.rubric.criteria.length) return failure('VALIDATION', '评分项 ID 不能重复。');
  if (question.review.status === 'rejected') return failure('VALIDATION', '题目审核已拒绝，不启动验证。', 'choose_another_question');
  const reviewed = question.review.status === 'approved' && !!question.review.reviewedBy && !!question.review.reviewedAt;
  if ((forExperiment || question.kind === 'near_transfer' || question.review.status === 'approved') && !reviewed) return failure('VALIDATION', '该题需要有效的人工审核记录。', 'request_question_review');
  if (question.kind === 'near_transfer' && (!question.transfer || !question.rubric.necessaryConditions.length)) return failure('VALIDATION', '近迁移题必须写明变化维度与必要条件。');
  if (forExperiment && question.transfer?.dimension === 'numbers_only') return failure('VALIDATION', '仅更换数字不能作为迁移效果实验题。', 'review_question_again');
  if (question.kind === 'recall' && question.transfer) return failure('VALIDATION', '回忆题不能混入迁移维度。');
  return success(structuredClone(question));
}

// Explicit allowlist: standard answers, hints and rubric evidence stay on the server.
export function publicQuestion(question: ReviewQuestion) {
  return structuredClone({ id: question.id, revision: question.revision, kind: question.kind, nodeRef: question.nodeRef,
    prompt: question.prompt, rubricVersion: question.rubric.version, reviewStatus: question.review.status,
    transfer: question.transfer ? { dimension: question.transfer.dimension, change: question.transfer.change } : null,
  });
}
export type PublicReviewQuestion = ReturnType<typeof publicQuestion>;
