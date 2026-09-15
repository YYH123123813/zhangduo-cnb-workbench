import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CONTRACT_VERSION, Id } from '../../contracts/domain';
import type { ChangeSet, HandoffDraft, KnowledgeSnapshot } from '../../contracts/domain';
import { canonicalJson, contentHash, hashConversation, hashSegment } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import type { ApiError, RequestContext, Result } from '../../contracts/api';
import { unavailable } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { createReview, failure } from './model';
import { isManualDraftId, withManualSource } from './manual';
import type { Review } from './model';
import { ApprovalRequestSchema, CommitRequestSchema, DraftInputSchema, HandoffSnapshotSchema, ManualReviewRequestSchema, PreviewRequestSchema, SaveDraftRequestSchema, SaveProgressRequestSchema } from './contracts';
import { DraftReceiptSchema, DraftStateSchema } from '../../contracts/handoff';
import { KnowledgeApprovalStateSchema } from '../../contracts/approval';
import { restoreProgressState, validateProgress, verifyProgressReceipt, verifyProgressState } from './progress';
import { validateRelations } from './relations';
import { validateDraft, verifyDraftReadback } from './draft';
import { buildChangeSet } from './changes';
import { readableDiff } from './preview';
import { checkCommitApproval, validateIssuedApproval } from './commit';
import { validateReceipt } from './receipt';
import { verifyOperationEnvelope } from './operation';
import type { OriginalOperationView } from './operation';
import { verifyOriginalPreview } from './original-preview';
import { acceptOriginalPreview, beginOriginalRecovery, readOriginalFacts } from './original-recovery';

const statuses: Record<ApiError['code'], ContentfulStatusCode> = {
  NOT_IMPLEMENTED: 501, NOT_CONFIGURED: 503, UNAUTHORIZED: 401, FORBIDDEN: 403,
  VALIDATION: 422, CONFLICT: 409, UNKNOWN_RESULT: 409, UPSTREAM: 502, INTERNAL: 500,
};
export function respond<T>(c: Context, result: Result<T>, ctx?: RequestContext) {
  c.header('Cache-Control', 'no-store');
  return c.json({ ...result, meta: { requestId: ctx?.requestId ?? crypto.randomUUID(),
    mode: ctx?.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION } }, result.ok ? 200 : statuses[result.error.code]);
}
export async function withContext<T>(c: Context, services: Services, action: (ctx: RequestContext) => Promise<Result<T>>) {
  let ctx: RequestContext | undefined;
  try {
    const identity = await services.context(c.req.raw);
    if (!identity.ok) return respond(c, identity);
    ctx = identity.data;
    return respond(c, await action(ctx), ctx);
  } catch {
    return respond(c, failure('请求未能完成。当前编辑内容仍保留，请核对保存状态。', 'INTERNAL', 'check_status', 'unknown'), ctx);
  }
}

export async function loadReview(services: Services, ctx: RequestContext, id: string, manual = false): Promise<Result<Review>> {
  if (!(manual ? [SCOPES.conversationRead] : [SCOPES.conversationRead, SCOPES.candidateRead]).every((scope) => ctx.scopes.includes(scope))) {
    return failure('缺少现场或候选读取权限。', 'FORBIDDEN', 'request_access');
  }
  if (!Id.safeParse(id).success) return failure('现场 ID 无效。');
  const conversation = await services.readConversation(ctx, id);
  if (!conversation.ok) return conversation;
  if (conversation.data.workspaceId !== ctx.workspaceId || conversation.data.id !== id) {
    return failure('无权读取该工作区的现场。', 'FORBIDDEN', 'select_workspace');
  }
  const candidates = manual ? { ok: true as const, data: [] } : await services.readCandidates(ctx, id);
  if (!candidates.ok) return candidates;
  const review = createReview(conversation.data, candidates.data);
  if (!review.ok) return review;
  if (await hashConversation(conversation.data) !== conversation.data.contentHash) return failure('现场摘要不匹配，请重新读取。', 'VALIDATION', 'reload_source');
  for (const item of review.data.items) {
    for (const span of item.subject.spans) {
      const segment = conversation.data.segments.find((entry) => entry.id === span.segmentId)!;
      if (await hashSegment(id, segment) !== span.contentHash) return failure('来源片段摘要不匹配，请重新读取。', 'VALIDATION', 'reload_source');
    }
    const digest = await contentHash({ conversationId: id, candidateId: item.subject.id });
    item.draftId = `handoff-${digest}`;
    item.nodeId = `knowledge-${digest}`;
  }
  review.data.actorId = ctx.actorId;
  return review;
}

export async function loadSnapshot(services: Services, ctx: RequestContext, revision?: string): Promise<Result<KnowledgeSnapshot>> {
  if (!ctx.scopes.includes(SCOPES.knowledgeRead)) return failure('缺少知识读取权限。', 'FORBIDDEN', 'request_access');
  const result = await services.snapshot(ctx, revision);
  if (!result.ok) return result;
  const parsed = HandoffSnapshotSchema.safeParse(result.data);
  if (!parsed.success) return failure('知识快照格式无效。', 'UPSTREAM', 'reload_snapshot');
  if (revision && parsed.data.revision !== revision) return failure('无法读取原预览固定版本，未提交。', 'CONFLICT', 'refresh_preview', 'preserved');
  if (parsed.data.workspaceId !== ctx.workspaceId || parsed.data.nodes.some((node) => node.workspaceId !== ctx.workspaceId) ||
    parsed.data.relations.some((relation) => relation.workspaceId !== ctx.workspaceId)) return failure('快照不属于当前工作区。', 'FORBIDDEN', 'select_workspace');
  return { ok: true as const, data: parsed.data };
}

async function verifyReviewedChanges(services: Services, ctx: RequestContext, conversationId: string,
  draft: HandoffDraft, changes: ChangeSet): Promise<Result<ChangeSet>> {
  const review = await loadDraftReview(services, ctx, conversationId, draft);
  if (!review.ok) return review;
  const snapshot = await loadSnapshot(services, ctx, changes.baseRevision);
  if (!snapshot.ok) return snapshot;
  const expected = await buildChangeSet(draft, review.data, snapshot.data, ctx, changes.id, changes.reason, changes.nodes[0]?.confirmedAt ?? '');
  if (!expected.ok) return expected;
  if (canonicalJson(expected.data) !== canonicalJson(changes)) return failure('正式变更与审阅草稿不一致，请重新预览。', 'VALIDATION', 'refresh_preview', 'preserved');
  return expected;
}

async function loadDraftReview(services: Services, ctx: RequestContext, id: string, draft: HandoffDraft): Promise<Result<Review>> {
  const review = await loadReview(services, ctx, id, draft.candidateId === null);
  if (!review.ok || draft.candidateId !== null) return review;
  if (!ctx.scopes.includes(SCOPES.draftRead)) return failure('缺少手动来源草稿读取权限。', 'FORBIDDEN', 'request_access');
  if (!services.readDraftState) return unavailable('手动来源保存端口尚未接通。');
  const state = await services.readDraftState(ctx, draft.id);
  if (!state.ok) return state;
  if (state.data.state !== 'available' || state.data.source?.kind !== 'manual' || state.data.conversationHash !== review.data.conversation.contentHash ||
    state.data.document?.value.conversationId !== id) return failure('请先保存本条手动来源审阅，再生成正式预览。', 'CONFLICT', 'save_progress', 'preserved');
  return withManualSource(review.data, state.data.source, { id: draft.id, title: draft.node.title, question: draft.node.question, kind: draft.node.kind });
}

export async function loadOriginalOperation(services: Services, ctx: RequestContext,
  conversationId: string, changeSetId: string): Promise<Result<OriginalOperationView>> {
  if (!services.readHandoffOperation || !services.readHandoffOperationReceipt) return unavailable('原操作快照读取端口尚未接通。');
  const stored = await services.readHandoffOperation(ctx, changeSetId);
  if (!stored.ok) return stored;
  const receipt = await services.readHandoffOperationReceipt(ctx, changeSetId);
  if (!receipt.ok) return receipt;
  const verified = await verifyOperationEnvelope(stored.data, receipt.data, ctx, conversationId, changeSetId, Date.now());
  if (!verified.ok) return verified;
  const { key, snapshot } = verified.data;
  const review = await loadReview(services, ctx, conversationId, snapshot.source.kind === 'manual');
  if (!review.ok) return review;
  const basis = await loadSnapshot(services, ctx, key.baseRevision);
  if (!basis.ok) return basis;
  const preview = await verifyOriginalPreview(key, snapshot, review.data, basis.data, ctx, Date.now());
  if (!preview.ok) return preview;
  const recovery = await readOriginalFacts(acceptOriginalPreview(beginOriginalRecovery(key), preview), services, ctx, Date.now());
  if (recovery.phase === 'unavailable') return { ok: false, error: recovery.error! };
  // The preceding reads await external sources. Recheck the shared deletion/expiry barrier before exposing private content.
  const final = await services.readHandoffOperation(ctx, changeSetId);
  if (!final.ok) return final;
  const current = await verifyOperationEnvelope(final.data, receipt.data, ctx, conversationId, changeSetId, Date.now());
  if (!current.ok) return current;
  return { ok: true, data: { recovery, storage: current.data.receipt } };
}

export function registerRoutes(app: Hono, services: Services) {
  app.get('/api/handoff/status', (c) => withContext(c, services, async () => ({ ok: true, data: { feature: 'handoff', status: 'implemented_fixture' } })));
  app.get('/api/handoff/:id/operation', (c) => withContext(c, services, async (ctx) => {
    const id = c.req.param('id'), operationId = c.req.query('changeSetId'), queries = c.req.queries();
    if (!Id.safeParse(id).success || !Id.safeParse(operationId).success || Object.keys(queries).some((key) => key !== 'changeSetId') ||
      queries.changeSetId?.length !== 1) return failure('需要唯一的原提交操作 ID。');
    return loadOriginalOperation(services, ctx, id, operationId!);
  }));
  app.get('/api/handoff/:id', (c) => withContext(c, services, (ctx) => {
    const source = c.req.query('source');
    return source && !['manual', 'candidate'].includes(source) ? Promise.resolve(failure('来源类型无效。')) : loadReview(services, ctx, c.req.param('id'), source === 'manual');
  }));
  app.post('/api/handoff/:id/manual', (c) => withContext(c, services, async (ctx) => {
    const parsed = ManualReviewRequestSchema.safeParse(await readBody(c));
    if (!parsed.success) return failure('请明确选择本次手动审阅的来源范围。');
    const review = await loadReview(services, ctx, c.req.param('id'), true);
    if (!review.ok) return review;
    const { segmentIds, expectedConversationHash } = parsed.data;
    if (expectedConversationHash !== review.data.conversation.contentHash || new Set(segmentIds).size !== segmentIds.length ||
      segmentIds.some((id) => !review.data.conversation.segments.some((segment) => segment.id === id && segment.text.length))) return failure('来源范围或版本已变化。', 'CONFLICT', 'reload_source', 'preserved');
    const spans = await Promise.all(review.data.conversation.segments.filter((segment) => segmentIds.includes(segment.id)).map(async (segment) => ({
      id: `manual-span-${await contentHash({ conversationId: review.data.conversation.id, segmentId: segment.id, start: 0, end: segment.text.length })}`,
      conversationId: review.data.conversation.id, segmentId: segment.id, start: 0, end: segment.text.length, quote: segment.text,
      contentHash: await hashSegment(review.data.conversation.id, segment) })));
    return withManualSource(review.data, { kind: 'manual', spans }, { id: `handoff-manual-${crypto.randomUUID()}`, title: '', question: '', kind: 'claim' });
  }));
  app.get('/api/handoff/:id/snapshot', (c) => withContext(c, services, (ctx) => loadSnapshot(services, ctx)));
  app.get('/api/handoff/:id/approval', (c) => withContext(c, services, async (ctx) => {
    if (!ctx.scopes.includes(SCOPES.knowledgeRead)) return failure('缺少原批准读取权限。', 'FORBIDDEN', 'request_access');
    if (!services.readKnowledgeApproval) return unavailable('知识批准原登记读回端口尚未接通。');
    const changeSetId = c.req.query('changeSetId');
    if (!Id.safeParse(changeSetId).success) return failure('缺少原变更集 ID。');
    const result = await services.readKnowledgeApproval(ctx, changeSetId!);
    if (!result.ok) return result;
    const parsed = KnowledgeApprovalStateSchema.safeParse(result.data);
    if (!parsed.success || parsed.data.changeSetId !== changeSetId || parsed.data.actorId !== ctx.actorId || parsed.data.workspaceId !== ctx.workspaceId) {
      return failure('原批准登记读回无法核验，当前操作仍保留。', 'UNKNOWN_RESULT', 'check_approval', 'unknown');
    }
    return { ok: true, data: parsed.data };
  }));
  app.get('/api/handoff/:id/draft-state', (c) => withContext(c, services, async (ctx) => {
    if (!ctx.scopes.includes(SCOPES.draftRead)) return failure('缺少进度读取权限。', 'FORBIDDEN', 'request_access');
    if (!services.readDraftState) return unavailable('草稿版本与部分进度端口尚未接通。');
    const id = c.req.query('draftId');
    if (!Id.safeParse(id).success) return failure('缺少草稿 ID。');
    const state = await services.readDraftState(ctx, id!);
    if (!state.ok) return state;
    const parsed = DraftStateSchema.safeParse(state.data);
    if (!parsed.success || parsed.data.id !== id) return failure('已存版本不匹配。', 'UPSTREAM', 'read_draft_state');
    const review = await loadReview(services, ctx, c.req.param('id'), isManualDraftId(id!));
    if (!review.ok) return review;
    if (isManualDraftId(id!) && state.data.state !== 'available') return state;
    const checked = await restoreProgressState(review.data, state.data);
    return checked.ok ? state : checked;
  }));
  app.get('/api/handoff/:id/draft-receipt', (c) => withContext(c, services, async (ctx) => {
    if (!ctx.scopes.includes(SCOPES.draftRead)) return failure('缺少进度回执读取权限。', 'FORBIDDEN', 'request_access');
    if (!services.readDraftReceipt) return unavailable('原草稿保存操作读回尚未接通。');
    const draftId = c.req.query('draftId'), operationId = c.req.query('operationId');
    if (!Id.safeParse(draftId).success || !Id.safeParse(operationId).success) return failure('缺少原草稿与保存操作 ID。');
    const review = await loadReview(services, ctx, c.req.param('id'), isManualDraftId(draftId!));
    if (!review.ok) return review;
    if (!isManualDraftId(draftId!) && !review.data.items.some((item) => item.draftId === draftId)) return failure('草稿不属于本次审阅。', 'FORBIDDEN', 'select_draft');
    const result = await services.readDraftReceipt(ctx, operationId!);
    if (!result.ok) return result;
    const receipt = DraftReceiptSchema.safeParse(result.data);
    if (!receipt.success || receipt.data.operationId !== operationId || receipt.data.draftId !== draftId || receipt.data.actorId !== ctx.actorId || receipt.data.workspaceId !== ctx.workspaceId) {
      return failure('尚未核验原保存操作；空记录不能证明没有写入。', 'UNKNOWN_RESULT', 'read_back', 'unknown');
    }
    return { ok: true, data: receipt.data };
  }));
  app.put('/api/handoff/:id/progress', (c) => withContext(c, services, async (ctx) => {
    if (![SCOPES.draftRead, SCOPES.draftWrite].every((scope) => ctx.scopes.includes(scope))) return failure('缺少进度保存或读回权限。', 'FORBIDDEN', 'request_access');
    if (!services.saveReviewProgress || !services.readDraftState || !services.readDraftReceipt) return unavailable('部分进度保存、版本或原操作核验端口尚未接通。');
    const parsed = SaveProgressRequestSchema.safeParse(await readBody(c));
    if (!parsed.success) return failure('缺少明确保存同意、原操作 ID 或版本条件。');
    const pending = parsed.data;
    let review = await loadReview(services, ctx, c.req.param('id'), pending.options.source.kind === 'manual');
    if (!review.ok) return review;
    if (pending.options.source.kind === 'manual') review = await withManualSource(review.data, pending.options.source, pending.progress);
    if (!review.ok) return review;
    const progress = validateProgress(pending.progress, pending.options, review.data, ctx);
    if (!progress.ok) return progress;
    const snapshot = await loadSnapshot(services, ctx);
    if (!snapshot.ok) return snapshot;
    if (snapshot.data.revision !== progress.data.baseRevision) return failure('知识基准已变化，审阅内容未覆盖。', 'CONFLICT', 'reload_snapshot', 'preserved');
    const relations = validateRelations(progress.data.relations, { id: progress.data.nodeId, workspaceId: ctx.workspaceId,
      revision: progress.data.baseRevision, sources: progress.data.sources }, snapshot.data, true);
    if (!relations.ok) return relations;
    const saved = await services.saveReviewProgress(ctx, progress.data, pending.options);
    if (!saved.ok) return saved;
    const savedState = await verifyProgressState(pending, saved.data);
    if (!savedState.ok) return savedState;
    const readback = await services.readDraftState(ctx, progress.data.id);
    const checked = await verifyProgressState(pending, readback.ok ? readback.data : null);
    if (!checked.ok) return checked;
    const original = await services.readDraftReceipt(ctx, pending.options.operationId);
    const receipt = await verifyProgressReceipt(pending, original.ok ? original.data : null, ctx);
    return receipt.ok ? { ok: true, data: { state: checked.data, receipt: receipt.data } } : receipt;
  }));
  app.post('/api/handoff/:id/approval', (c) => withContext(c, services, async (ctx) => {
    if (!services.approveKnowledge) return unavailable('知识提交批准登记端口尚未接通，未执行 Git 提交。');
    if (!ctx.scopes.includes(SCOPES.knowledgeWrite)) return failure('缺少知识提交批准权限。', 'FORBIDDEN', 'request_access');
    const parsed = ApprovalRequestSchema.safeParse(await readBody(c));
    if (!parsed.success) return failure('缺少明确批准确认，或预览字段无效。');
    const checked = await verifyReviewedChanges(services, ctx, c.req.param('id'), parsed.data.draft, parsed.data.changes);
    if (!checked.ok) return checked;
    try {
      const result = await services.approveKnowledge(ctx, { changes: checked.data, confirmed: true });
      if (!result.ok) return result;
      return await validateIssuedApproval(checked.data, result.data, ctx, Date.now());
    } catch { return failure('批准登记响应中断，登记状态待核验；未发出 Git 提交。', 'UNKNOWN_RESULT', 'check_approval', 'unknown'); }
  }));
  app.get('/api/handoff/:id/receipt', (c) => withContext(c, services, async (ctx) => {
    if (!services.readCommit) return unavailable('提交读回端口尚未接通。请保留操作 ID；不要重复创建新的提交。');
    if (!ctx.scopes.includes(SCOPES.knowledgeRead)) return failure('缺少知识提交结果读取权限。', 'FORBIDDEN', 'request_access');
    const operationId = c.req.query('changeSetId');
    if (!Id.safeParse(operationId).success || !Id.safeParse(c.req.param('id')).success) return failure('缺少有效的现场或操作 ID。');
    try {
      const result = await services.readCommit(ctx, operationId!);
      if (!result.ok) return result;
      if (result.data === null) return failure('未读到已登记的提交记录，不能据此判断远端未写入。请保留原操作 ID 并继续核验。', 'UNKNOWN_RESULT', 'read_back', 'unknown');
      return validateReceipt(result.data, operationId!, ctx.mode);
    } catch { return failure('提交读回中断，原操作状态仍未知，请继续核验。', 'UNKNOWN_RESULT', 'read_back', 'unknown'); }
  }));
  app.post('/api/handoff/:id/approval/:approvalId/revoke', (c) => withContext(c, services, async (ctx) => {
    if (!services.revokeApproval) return unavailable('批准撤回端口尚未配置；撤回结果未确认。');
    if (!Id.safeParse(c.req.param('approvalId')).success) return failure('批准 ID 无效。');
    return services.revokeApproval(ctx, c.req.param('approvalId'));
  }));
  app.post('/api/handoff/:id/preview', (c) => withContext(c, services, async (ctx) => {
    const parsed = PreviewRequestSchema.safeParse(await readBody(c));
    if (!parsed.success) return failure('草稿或入库理由无效。');
    const review = await loadDraftReview(services, ctx, c.req.param('id'), parsed.data.draft);
    if (!review.ok) return review;
    const snapshot = await loadSnapshot(services, ctx);
    if (!snapshot.ok) return snapshot;
    const checked = validateDraft(parsed.data.draft, review.data, snapshot.data, ctx);
    if (!checked.ok) return checked;
    const changes = await buildChangeSet(checked.data, review.data, snapshot.data, ctx, crypto.randomUUID(), parsed.data.reason, new Date().toISOString());
    if (!changes.ok) return changes;
    const candidate = review.data.items.find((item) => item.draftId === checked.data.id)!.subject;
    return { ok: true, data: { draft: checked.data, changes: changes.data, diff: readableDiff(changes.data, snapshot.data, candidate) } };
  }));
  app.get('/api/handoff/:id/draft', (c) => withContext(c, services, async (ctx) => {
    if (!ctx.scopes.includes(SCOPES.draftRead)) return failure('缺少草稿读取权限。', 'FORBIDDEN', 'request_access');
    const id = c.req.query('draftId');
    if (!Id.safeParse(id).success) return failure('缺少草稿 ID。');
    const saved = await services.readDraft(ctx, id!);
    if (!saved.ok) return saved;
    const parsed = DraftInputSchema.safeParse(saved.data);
    if (!parsed.success) return failure('已存草稿格式无效。', 'UPSTREAM', 'export_local');
    if (parsed.data.id !== id || parsed.data.conversationId !== c.req.param('id') || parsed.data.node.conversationId !== c.req.param('id') ||
      parsed.data.node.workspaceId !== ctx.workspaceId || parsed.data.relations.some((relation) => relation.workspaceId !== ctx.workspaceId)) return failure('无权读取该草稿。', 'FORBIDDEN', 'select_draft');
    return { ok: true, data: parsed.data };
  }));
  app.put('/api/handoff/:id/draft', (c) => withContext(c, services, async (ctx) => {
    if (![SCOPES.draftRead, SCOPES.draftWrite].every((scope) => ctx.scopes.includes(scope))) return failure('缺少草稿保存或读回权限。', 'FORBIDDEN', 'request_access');
    const body = await readBody(c);
    const parsed = SaveDraftRequestSchema.safeParse(body);
    if (!parsed.success) return failure('未确认保存范围，或草稿字段无效。');
    let review = await loadReview(services, ctx, c.req.param('id'), parsed.data.options.source.kind === 'manual');
    if (!review.ok) return review;
    if (parsed.data.options.source.kind === 'manual') review = await withManualSource(review.data, parsed.data.options.source,
      { id: parsed.data.draft.id, title: parsed.data.draft.node.title, question: parsed.data.draft.node.question, kind: parsed.data.draft.node.kind });
    if (!review.ok) return review;
    const snapshot = await loadSnapshot(services, ctx);
    if (!snapshot.ok) return snapshot;
    const checked = validateDraft(parsed.data.draft, review.data, snapshot.data, ctx);
    if (!checked.ok) return checked;
    if ((parsed.data.options.source.kind === 'candidate' ? parsed.data.options.source.candidateId : null) !== checked.data.candidateId ||
      parsed.data.options.expectedConversationHash !== review.data.conversation.contentHash) return failure('保存选项不对应原候选或现场版本。', 'CONFLICT', 'reload_source', 'preserved');
    const saved = await services.saveDraft(ctx, checked.data, parsed.data.options);
    if (!saved.ok) return saved;
    const readback = await services.readDraft(ctx, checked.data.id);
    if (!readback.ok) return failure('草稿写入后未能核对；结果未知，请先恢复草稿核验。', 'UNKNOWN_RESULT', 'read_back', 'unknown');
    return verifyDraftReadback(checked.data, readback.data);
  }));
  app.post('/api/handoff/:id/commit', (c) => withContext(c, services, async (ctx) => {
    const parsed = CommitRequestSchema.safeParse(await readBody(c));
    if (!parsed.success) return failure('缺少明确提交确认，或提交字段无效。');
    const { draft, changes, approval } = parsed.data;
    const approvalCheck = await checkCommitApproval(changes, approval, ctx, Date.now());
    if (!approvalCheck.ok) return approvalCheck;
    const checked = await verifyReviewedChanges(services, ctx, c.req.param('id'), draft, changes);
    if (!checked.ok) return checked;
    // The platform owns registered approval, revocation, atomic HEAD checks and durable replay.
    try {
      const result = await services.commit(ctx, changes, approval);
      if (!result.ok) return result;
      return validateReceipt(result.data, changes.id, ctx.mode);
    }
    catch { return failure('提交响应中断，结果未知。请保留操作 ID 并先读回核验。', 'UNKNOWN_RESULT', 'read_back', 'unknown'); }
  }));
}

export async function readBody(c: Context): Promise<unknown> {
  try { const text = await c.req.text(); if (new TextEncoder().encode(text).length > 524288) return null; return JSON.parse(text); } catch { return null; }
}
