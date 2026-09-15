import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { ChangeSetSchema, Id } from '../../contracts/domain';
import type { KnowledgeSnapshot } from '../../contracts/domain';
import { DraftStateSchema, HandoffSourceSchema } from '../../contracts/handoff';
import { canonicalJson, contentHash, hashChangeSet, hashConversation, hashSegment } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import { DraftInputSchema, HandoffSnapshotSchema } from './contracts';
import { toDraft, validateDraft } from './draft';
import { failure, sourceFor } from './model';
import type { Review } from './model';
import { restoreProgressState } from './progress';
import { readableDiff } from './preview';
import type { HandoffPreview } from './preview';
import { validateRelations } from './relations';

// Full-content checks after the shared 1.17 operation envelope and receipt are verified.
const OriginalPreviewKeySchema = z.object({ actorId: Id, workspaceId: Id, conversationId: Id,
  changeSetId: Id, contentHash: Id, baseRevision: Id, draftId: Id,
  draftRevision: z.number().int().positive(), draftContentHash: Id }).strict();
export type OriginalPreviewKey = z.infer<typeof OriginalPreviewKeySchema>;
export interface OriginalPreviewContent { draft: unknown; changes: unknown; source: unknown; savedDraft: unknown }

export async function verifyOriginalPreview(expected: OriginalPreviewKey, input: OriginalPreviewContent, review: Review,
  basis: KnowledgeSnapshot, ctx: RequestContext, now: number): Promise<Result<HandoffPreview>> {
  const key = OriginalPreviewKeySchema.safeParse(expected);
  const mismatch = () => failure<HandoffPreview>('Original preview or its pinned draft version could not be verified.', 'CONFLICT', 'read_original_preview', 'preserved');
  if (!key.success || !Number.isFinite(now)) return mismatch();
  if (key.data.actorId !== ctx.actorId || key.data.workspaceId !== ctx.workspaceId || review.actorId !== ctx.actorId ||
    review.conversation.workspaceId !== ctx.workspaceId ||
    ![SCOPES.draftRead, SCOPES.conversationRead, SCOPES.knowledgeRead].every((scope) => ctx.scopes.includes(scope))) {
    return failure('Original preview is not accessible to this identity.', 'FORBIDDEN', 'request_access', 'preserved');
  }
  const draft = DraftInputSchema.safeParse(input.draft), changes = ChangeSetSchema.safeParse(input.changes);
  const source = HandoffSourceSchema.safeParse(input.source), stored = DraftStateSchema.safeParse(input.savedDraft);
  const snapshot = HandoffSnapshotSchema.safeParse(basis);
  if (!draft.success || !changes.success || !source.success || !stored.success || !snapshot.success) return mismatch();
  if (source.data.kind === 'candidate' && !ctx.scopes.includes(SCOPES.candidateRead)) {
    return failure('Original candidate access has been revoked.', 'FORBIDDEN', 'request_access', 'preserved');
  }
  const state = stored.data;
  if (state.state !== 'available' || (state.expiresAt && Date.parse(state.expiresAt) <= now) ||
    state.id !== key.data.draftId || draft.data.id !== key.data.draftId || state.revision !== key.data.draftRevision ||
    state.contentHash !== key.data.draftContentHash || state.conversationHash !== review.conversation.contentHash ||
    draft.data.conversationId !== key.data.conversationId || review.conversation.id !== key.data.conversationId ||
    draft.data.baseRevision !== key.data.baseRevision || snapshot.data.revision !== key.data.baseRevision ||
    changes.data.id !== key.data.changeSetId || changes.data.contentHash !== key.data.contentHash ||
    changes.data.baseRevision !== key.data.baseRevision || changes.data.workspaceId !== key.data.workspaceId ||
    canonicalJson(source.data) !== canonicalJson(state.source) ||
    await contentHash({ document: state.document, source: state.source }) !== state.contentHash ||
    await hashChangeSet(changes.data) !== key.data.contentHash ||
    await hashConversation(review.conversation) !== state.conversationHash) return mismatch();

  const restored = await restoreProgressState(review, state);
  if (!restored.ok) return restored;
  const item = restored.data.items.find((entry) => entry.draftId === key.data.draftId);
  if (!item || canonicalJson(sourceFor(item)) !== canonicalJson(source.data)) return mismatch();
  for (const span of item.subject.spans) {
    const segment = restored.data.conversation.segments.find((entry) => entry.id === span.segmentId);
    if (!segment || span.contentHash !== await hashSegment(review.conversation.id, segment)) return mismatch();
  }
  const pinned = state.document!.kind === 'draft' ? { ok: true as const, data: state.document!.value }
    : toDraft(restored.data, item, key.data.baseRevision, draft.data.node.updatedAt);
  if (!pinned.ok || canonicalJson(pinned.data) !== canonicalJson(draft.data)) return mismatch();
  const checked = validateDraft(draft.data, restored.data, snapshot.data, ctx);
  if (!checked.ok) return checked;
  const relations = validateRelations(checked.data.relations, checked.data.node, snapshot.data);
  if (!relations.ok) return relations;

  const node = changes.data.nodes[0];
  if (!node?.confirmedAt || Date.parse(node.confirmedAt) > now || changes.data.nodes.length !== 1 || changes.data.withdrawnIds.length ||
    changes.data.reason !== changes.data.reason.trim() || !changes.data.reason.trim() ||
    snapshot.data.nodes.some((entry) => entry.id === checked.data.node.id) ||
    snapshot.data.relations.some((entry) => checked.data.relations.some((relation) => relation.id === entry.id))) return mismatch();
  // Compare the original formal projection, retaining its original time and reason; never build a new operation.
  const formal = { ...checked.data.node, confirmation: 'confirmed', confirmedBy: key.data.actorId, confirmedAt: node.confirmedAt, updatedAt: node.confirmedAt };
  if (canonicalJson(changes.data.nodes) !== canonicalJson([formal]) ||
    canonicalJson(changes.data.relations) !== canonicalJson(checked.data.relations)) return mismatch();
  return { ok: true, data: { draft: checked.data, changes: changes.data, diff: readableDiff(changes.data, snapshot.data, item.subject) } };
}
