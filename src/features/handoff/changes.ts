import type { RequestContext, Result } from '../../contracts/api';
import { ChangeSetSchema } from '../../contracts/domain';
import type { ChangeSet, HandoffDraft, KnowledgeSnapshot } from '../../contracts/domain';
import { hashChangeSet } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import { validateDraft } from './draft';
import { failure } from './model';
import type { Review } from './model';
import { validateRelations } from './relations';

export async function buildChangeSet(draft: HandoffDraft, review: Review, snapshot: KnowledgeSnapshot, ctx: RequestContext,
  operationId: string, reason: string, confirmedAt: string): Promise<Result<ChangeSet>> {
  if (!ctx.scopes.includes(SCOPES.knowledgeWrite)) return failure('缺少正式知识提交权限。', 'FORBIDDEN', 'request_access');
  if (!review.conversation.sourceAlreadyPersisted || review.conversation.state !== 'saved') return failure('原始现场尚未确认保存，请先核验 Issue 保存结果。', 'VALIDATION', 'verify_conversation', 'preserved');
  const checked = validateDraft(draft, review, snapshot, ctx);
  if (!checked.ok) return checked;
  const relations = validateRelations(checked.data.relations, checked.data.node, snapshot);
  if (!relations.ok) return relations;
  if (!reason.trim() || reason.length > 4000) return failure('请填写本次入库理由，最多 4000 字。');
  if (snapshot.nodes.some((node) => node.id === draft.node.id) ||
    snapshot.relations.some((relation) => draft.relations.some((entry) => entry.id === relation.id))) {
    return failure('该对象已在正式知识中；请读取提交结果，或从版本控制发起修订。', 'CONFLICT', 'open_existing_knowledge', 'preserved');
  }
  const payload: Omit<ChangeSet, 'contentHash'> = { id: operationId, workspaceId: ctx.workspaceId, baseRevision: checked.data.baseRevision,
    nodes: [{ ...checked.data.node, confirmation: 'confirmed', confirmedBy: ctx.actorId, confirmedAt, updatedAt: confirmedAt }],
    relations: structuredClone(checked.data.relations), withdrawnIds: [], reason: reason.trim() };
  const parsed = ChangeSetSchema.safeParse({ ...payload, contentHash: 'pending-shared-hash' });
  if (!parsed.success) return failure('变更集类型、引用或时间格式无效。');
  parsed.data.contentHash = await hashChangeSet(parsed.data);
  return { ok: true, data: parsed.data };
}
