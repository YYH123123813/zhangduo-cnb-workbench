import type { Hono } from 'hono';
import type { Services } from '../../contracts/ports';
import { z } from 'zod';
import { failure, success } from './errors';
import { guarded, readJson, respond } from './http';
import { previewUse, UseSelectionSchema } from './use';
import { Id, type EvidenceRecord } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { buildUseDraft, describeHistory, validateEvidenceList } from './history';
import { OutcomeInputSchema, previewOutcome } from './outcome';
import { revisionClues } from './links';
import { TrustedReviewRequestSchema, ReviewQuerySchema } from './review-api';
import { readHistoricalKnowledge } from './history-reader';
import { prepareRetrievedUse, RetrievedUseInputSchema } from './retrieval-bridge';
import { ApplicationExecuteSchema, EvidenceStoragePreviewSchema } from './application-api';
import { buildOutcomeEvidence, buildUseEvidence } from './application-record';
import { executeApplicationSave, readApplicationEvidence, readApplicationSelection } from './application-save';
import { validateTaskContext } from '../../contracts/task';
import { applyTrustedReviewRequest, readTrustedReviewRuntime, readTrustedReviewOperation, readTrustedReviewQuestions, readTrustedReviewReceipt } from './review-services';

function storagePreview(record: Result<EvidenceRecord>, baseRevision: string, ctx: RequestContext) {
  if (!record.ok) return { storage: null, storageNotice: record.error.message };
  const parsed = EvidenceStoragePreviewSchema.safeParse({ operationId: record.data.id, actorId: ctx.actorId, record: record.data,
    baseRevision, retention: 'until_deleted', persistence: 'not_saved', indexing: 'excluded' });
  return parsed.success ? { storage: parsed.data, storageNotice: null } : { storage: null, storageNotice: '当前版本不能生成长期保存预览。' };
}

const UseRequest = z.discriminatedUnion('action', [
  ApplicationExecuteSchema,
  z.object({ action: z.literal('preview'), selection: UseSelectionSchema }).strict(),
  RetrievedUseInputSchema.extend({ action: z.literal('preview_retrieved') }),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('save'), selection: UseSelectionSchema, consent: z.boolean() }).strict(),
]);
const OutcomeRequest = z.discriminatedUnion('action', [
  ApplicationExecuteSchema,
  z.object({ action: z.literal('preview'), outcome: OutcomeInputSchema }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
]);

export function registerRoutes(app: Hono, services: Services) {
  app.get('/api/learning/status', guarded(services, 'knowledge:read', async (c, ctx) => {
    const workspace = await services.workspace(ctx);
    if (!workspace.ok) return respond(c, workspace, ctx);
    if (workspace.data.id !== ctx.workspaceId || workspace.data.mode !== ctx.mode) return respond(c, failure('FORBIDDEN', '工作区身份不匹配。'), ctx);
    const runtime = await readTrustedReviewRuntime(services, ctx);
    return respond(c, success({ workspaceId: ctx.workspaceId, actorId: ctx.actorId,
      applicationStorage: 'shared_services', trustedReview: runtime.ok && runtime.data.catalog === 'ready' ? 'shared_services' : 'not_connected', persistence: 'not_checked' }), ctx);
  }));
  app.get('/api/learning/context', guarded(services, 'knowledge:read', async (c, ctx) => {
    const snapshot = await services.snapshot(ctx);
    if (!snapshot.ok) return respond(c, snapshot, ctx);
    if (snapshot.data.workspaceId !== ctx.workspaceId) return respond(c, failure('FORBIDDEN', '工作区身份不匹配。'), ctx);
    return respond(c, success({ workspaceId: ctx.workspaceId, actorId: ctx.actorId, revision: snapshot.data.revision,
      nodes: snapshot.data.nodes.filter((node) => node.workspaceId === ctx.workspaceId && !snapshot.data.excludedIds.includes(node.id) && node.confirmation === 'confirmed' && !['withdrawn', 'superseded'].includes(node.lifecycle))
        .map((node) => ({ id: node.id, revision: node.revision, title: node.title, conditions: node.conditions, boundaries: node.boundaries })),
    }), ctx);
  }));
  app.post('/api/learning/use', guarded(services, 'knowledge:read', async (c, ctx) => {
    const parsed = UseRequest.safeParse(await readJson(c));
    if (!parsed.success) return respond(c, failure('VALIDATION', '应用请求格式不正确，请检查必填项。'), ctx);
    if (parsed.data.action === 'execute') return respond(c, await executeApplicationSave(parsed.data, 'use', services, ctx), ctx);
    if (parsed.data.action === 'cancel') return respond(c, success({ cancelled: true, persistence: 'not_saved' }), ctx);
    if (parsed.data.action === 'preview_retrieved') {
      const { action: _action, ...input } = parsed.data;
      if (input.task.workspaceId !== ctx.workspaceId) return respond(c, failure('FORBIDDEN', '任务不属于当前工作区。'), ctx);
      const snapshot = await services.snapshot(ctx);
      if (!snapshot.ok) return respond(c, snapshot, ctx);
      const prepared = prepareRetrievedUse({ ...input, recordId: crypto.randomUUID(), recordedAt: new Date().toISOString() }, snapshot.data, ctx);
      return respond(c, prepared.ok ? success({ ...prepared.data.preview, draft: prepared.data.draft, handoffTrust: prepared.data.handoffTrust,
        ...storagePreview(buildUseEvidence(prepared.data.draft, snapshot.data), snapshot.data.revision, ctx) }) : prepared, ctx);
    }
    if (parsed.data.selection.task.workspaceId !== ctx.workspaceId) return respond(c, failure('FORBIDDEN', '任务不属于当前工作区。'), ctx);
    if (parsed.data.action === 'save') {
      if (!ctx.scopes.includes('evidence:write') || !parsed.data.consent) return respond(c, failure('FORBIDDEN', '尚未批准保存；当前决定未写入。', 'confirm_save_scope'), ctx);
      return respond(c, failure('NOT_IMPLEMENTED', '旧 save 请求不含精确批准；请重新预览并分别登记批准、执行保存。', 'preview_evidence_storage'), ctx);
    }
    const snapshot = await services.snapshot(ctx);
    if (!snapshot.ok) return respond(c, snapshot, ctx);
    const task = validateTaskContext(parsed.data.selection.task, snapshot.data, ctx.actorId);
    if (!task.ok) return respond(c, task, ctx);
    const preview = previewUse(parsed.data.selection, snapshot.data);
    if (!preview.ok) return respond(c, preview, ctx);
    const draft = buildUseDraft(parsed.data.selection, snapshot.data, crypto.randomUUID(), new Date().toISOString());
    return respond(c, draft.ok ? success({ ...preview.data, draft: draft.data,
      ...storagePreview(buildUseEvidence(draft.data, snapshot.data), snapshot.data.revision, ctx) }) : draft, ctx);
  }));
  app.get('/api/learning/records', guarded(services, 'evidence:read', async (c, ctx) => {
    const query = z.object({ taskId: z.array(Id).length(1).optional(), useId: z.array(Id).length(1).optional(), evidenceId: z.array(Id).length(1).optional() }).strict().safeParse(c.req.queries());
    if (!query.success) return respond(c, failure('VALIDATION', '记录入口仅接受唯一任务、原应用和证据 ID。'), ctx);
    const taskId = query.data.taskId?.[0], useId = query.data.useId?.[0], evidenceId = query.data.evidenceId?.[0];
    if (useId || evidenceId) {
      const records = await readApplicationSelection(services, ctx, { taskId, useId, evidenceId });
      return respond(c, records.ok ? success({ records: records.data.map((record) => describeHistory(record)), indexing: 'excluded' }) : records, ctx);
    }
    const result = await services.listEvidence(ctx, taskId);
    if (!result.ok) return respond(c, result, ctx);
    const records = validateEvidenceList(result.data, ctx.workspaceId);
    if (!records.ok) return respond(c, records, ctx);
    return respond(c, success({ records: records.data.filter((record) => !taskId || record.taskId === taskId).map((record) => describeHistory(record)), indexing: 'excluded' }), ctx);
  }));
  app.get('/api/learning/records/:id/knowledge', guarded(services, 'evidence:read', async (c, ctx) => {
    const query = z.object({ nodeId: z.array(Id).length(1) }).strict().safeParse(c.req.queries());
    if (!query.success) return respond(c, failure('VALIDATION', '历史读取仅接受一个原记录节点 ID。'), ctx);
    return respond(c, await readHistoricalKnowledge(services, ctx, c.req.param('id') ?? '', query.data.nodeId[0]!), ctx);
  }));
  app.get('/api/learning/records/:id', guarded(services, 'evidence:read', async (c, ctx) => {
    const id = c.req.param('id');
    if (!Id.safeParse(id).success) return respond(c, failure('VALIDATION', '原记录 ID 无效。'), ctx);
    const result = await readApplicationEvidence(services, ctx, id!);
    return respond(c, result.ok ? success(describeHistory(result.data)) : result, ctx);
  }));
  app.post('/api/learning/attempts', guarded(services, 'evidence:write', async (c, ctx) => {
    const input = TrustedReviewRequestSchema.safeParse(await readJson(c));
    if (!input.success) return respond(c, failure('VALIDATION', '作答请求格式不正确；不能上传私有会话、标准答案或暴露证明。'), ctx);
    if (input.data.action === 'start' && input.data.nodeRef.workspaceId !== ctx.workspaceId) return respond(c, failure('FORBIDDEN', '不能使用其他工作区的审核题。'), ctx);
    const cancellation = input.data.action === 'event' && input.data.event.type === 'cancel';
    if (!cancellation && !ctx.scopes.includes('knowledge:read')) return respond(c, failure('FORBIDDEN', '继续作答或评阅需要当前知识读取权限。', 'request_access'), ctx);
    return respond(c, await applyTrustedReviewRequest(services, ctx, input.data), ctx);
  }));
  app.get('/api/learning/reviews', guarded(services, 'knowledge:read', async (c, ctx) => {
    const query = ReviewQuerySchema.safeParse(c.req.query());
    if (!query.success) return respond(c, failure('VALIDATION', '请指定节点 ID 和原知识版本。'), ctx);
    return respond(c, await readTrustedReviewQuestions(services, ctx, query.data), ctx);
  }));
  app.get('/api/learning/attempts/:id', guarded(services, 'evidence:read', async (c, ctx) => {
    if (!Id.safeParse(c.req.param('id')).success) return respond(c, failure('VALIDATION', '作答操作 ID 无效。'), ctx);
    const query = z.object({ projection: z.literal('receipt').optional(), requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(c.req.query());
    if (!query.success) return respond(c, failure('VALIDATION', '原作答恢复参数无效。'), ctx);
    if (query.data.projection === 'receipt') {
      const receipt = await readTrustedReviewReceipt(services, ctx, c.req.param('id') ?? '');
      return respond(c, receipt.ok && query.data.requestHash && receipt.data.requestHash !== query.data.requestHash
        ? failure('UNKNOWN_RESULT', '原作答回执摘要不匹配。', 'read_review_operation', 'unknown') : receipt, ctx);
    }
    if (!ctx.scopes.includes('knowledge:read')) return respond(c, failure('FORBIDDEN', '读取题目和作答状态需要当前知识读取权限。', 'request_access'), ctx);
    return respond(c, await readTrustedReviewOperation(services, ctx, c.req.param('id') ?? '', query.data.requestHash), ctx);
  }));
  app.post('/api/learning/outcomes', guarded(services, 'evidence:read', async (c, ctx) => {
    const input = OutcomeRequest.safeParse(await readJson(c));
    if (!input.success) return respond(c, failure('VALIDATION', '结果请求格式不正确。'), ctx);
    if (input.data.action === 'execute') return respond(c, await executeApplicationSave(input.data, 'outcome', services, ctx), ctx);
    if (input.data.action === 'cancel') return respond(c, success({ cancelled: true, persistence: 'not_saved' }), ctx);
    const id = input.data.outcome.useRecordId;
    const original = services.readEvidence ? await readApplicationEvidence(services, ctx, id) : null;
    if (original && !original.ok) return respond(c, original, ctx);
    const records = original?.ok ? success([original.data]) : await services.listEvidence(ctx);
    if (!records.ok) return respond(c, records, ctx);
    const validated = validateEvidenceList(records.data, ctx.workspaceId);
    if (!validated.ok) return respond(c, validated, ctx);
    const record = validated.data.find((item) => item.id === id);
    if (!record) return respond(c, failure('CONFLICT', '原应用记录不可读取，请返回记录列表。', 'reload_records'), ctx);
    const outcome = previewOutcome(input.data.outcome, record, ctx);
    if (!outcome.ok) return respond(c, outcome, ctx);
    const clues = revisionClues(outcome.data, ctx);
    return respond(c, clues.ok ? success({ ...outcome.data, revisionLinks: clues.data, originalUse: describeHistory(record),
      ...storagePreview(buildOutcomeEvidence(input.data.outcome, record, ctx, crypto.randomUUID(), new Date().toISOString()), record.useContext?.snapshotRevision ?? '', ctx) }) : clues, ctx);
  }));
}
