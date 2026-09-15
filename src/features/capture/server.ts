import type { Hono } from 'hono';
import { z } from 'zod';
import type { Services } from '../../contracts/ports';
import { ConversationSchema, Id } from '../../contracts/domain';
import { readBody, withContext } from './http';
import { failure } from './result';
import { SCOPES } from '../../contracts/scopes';
import { PreviewInputSchema, previewCapture } from './preview';
import { ConversationApprovalRequestSchema } from '../../contracts/approval';
import { checkConversation } from './conversation';
import { checkApprovalBinding } from './approval';
import { SaveInputSchema, readSavedConversation, saveCapture } from './save';
import { ExtractInputSchema, ModelScopeSchema, prepareModelInput } from './model-input';
import { extractCapture, readDelivery } from './delivery';
import { approveModelInput, MODEL_APPROVAL_SCOPES, ModelApprovalInputSchema } from './model-approval';
import { readModelOperation } from './model-operation';

export const IssueSelectionSchema = z.object({ issueNumber: z.number().int().positive(), selected: z.literal(true) }).strict();

export function registerRoutes(app: Hono, services: Services) {
  // This is only an in-flight concurrency guard; durable operation state belongs to Services.
  const extracting = new Set<string>();
  app.post('/api/capture/issue', (c) => withContext(c, services, async (ctx) => {
    if (!ctx.scopes.includes(SCOPES.conversationRead)) return failure('FORBIDDEN', '缺少Issue读取权限。');
    const input = await readBody(c, IssueSelectionSchema);
    if (!input.ok) return input;
    const result = await services.readIssue(ctx, input.data.issueNumber);
    if (!result.ok) return result;
    const parsed = ConversationSchema.safeParse(result.data);
    if (!parsed.success) return failure('UPSTREAM', 'Issue内容结构不完整；未生成现场。');
    if (parsed.data.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', '不能读取其他工作区的Issue。');
    if (parsed.data.issueNumber !== input.data.issueNumber || parsed.data.origin !== 'cnb_issue') return failure('CONFLICT', '返回的Issue与选择不一致，请重新选择。');
    return { ok: true, data: { ...parsed.data, sourceAlreadyPersisted: true } };
  }));
  app.get('/api/capture/status', (c) => withContext(c, services, async (ctx) => {
    if (!ctx.scopes.includes(SCOPES.workspaceRead)) return failure('FORBIDDEN', '缺少工作区读取权限。');
    const workspace = await services.workspace(ctx);
    if (!workspace.ok) return workspace;
    if (workspace.data.id !== ctx.workspaceId || workspace.data.mode !== ctx.mode) return failure('FORBIDDEN', '工作区身份不一致。');
    const settings = ctx.scopes.includes(SCOPES.settingsRead) ? await services.settings(ctx) : null;
    const modelApproval = services.approveModel && MODEL_APPROVAL_SCOPES.every((scope) => ctx.scopes.includes(scope)) ? 'available' : 'not_configured';
    return { ok: true, data: { state: 'available', workspace: workspace.data, aiExtraction: settings?.ok ? settings.data.aiExtraction ? 'enabled' : 'disabled' : 'unavailable', modelApproval } };
  }));
  app.post('/api/capture/preview', (c) => withContext(c, services, async (ctx) => {
    const input = await readBody(c, PreviewInputSchema);
    return input.ok ? previewCapture(input.data, ctx, services) : input;
  }));
  app.post('/api/capture/approve', (c) => withContext(c, services, async (ctx) => {
    if (!ctx.scopes.includes(SCOPES.conversationWrite)) return failure('FORBIDDEN', '缺少现场保存权限。');
    const input = await readBody(c, ConversationApprovalRequestSchema);
    if (!input.ok) return input;
    if (input.data.baseRevision !== 'new') return failure('CONFLICT', '捕获只能新增现场，不覆盖原Issue。');
    const checked = await checkConversation(input.data.conversation, ctx, 'preview');
    if (!checked.ok) return checked;
    if (!services.approveConversation) return failure('NOT_CONFIGURED', '可信批准服务尚未连接；未保存现场。', 'configure_approval_service');
    try {
      const issued = await services.approveConversation(ctx, input.data);
      if (!issued.ok) return issued;
      const binding = checkApprovalBinding(issued.data, { purpose: 'save_conversation', objectIds: [checked.data.id], contentHash: checked.data.contentHash, baseRevision: 'new' }, ctx);
      return binding.ok ? binding : { ok: false, error: { ...binding.error, dataState: 'unknown', nextAction: 'read_approval_state' } };
    } catch { return failure('UNKNOWN_RESULT', '保存批准登记结果未知；未发送现场写入，需先核验原批准。', 'read_approval_state', 'unknown'); }
  }));
  app.post('/api/capture/approvals/:id/revoke', (c) => withContext(c, services, async (ctx) => {
    if (![SCOPES.conversationWrite, SCOPES.modelExtract].some((scope) => ctx.scopes.includes(scope))) return failure('FORBIDDEN', '缺少批准撤回权限。');
    if (!Id.safeParse(c.req.param('id')).success) return failure('VALIDATION', '批准ID无效。');
    if (!services.revokeApproval) return failure('NOT_CONFIGURED', '批准撤回服务尚未连接；不能声称撤回成功。', 'configure_approval_service');
    return services.revokeApproval(ctx, c.req.param('id'));
  }, 'unknown'));
  app.post('/api/capture/save', (c) => withContext(c, services, async (ctx) => {
    const input = await readBody(c, SaveInputSchema);
    return input.ok ? saveCapture(services, ctx, input.data) : input;
  }, 'unknown'));
  app.get('/api/capture/:id', (c) => withContext(c, services, (ctx) => readSavedConversation(services, ctx, c.req.param('id'))));
  app.post('/api/capture/:id/model-preview', (c) => withContext(c, services, async (ctx) => {
    const input = await readBody(c, ModelScopeSchema);
    return input.ok ? prepareModelInput(services, ctx, c.req.param('id'), input.data) : input;
  }, 'preserved'));
  app.get('/api/capture/:id/candidates', (c) => withContext(c, services, (ctx) => readDelivery(services, ctx, c.req.param('id')), 'preserved'));
  app.get('/api/capture/:id/model-operations/:approvalId', (c) => withContext(c, services, (ctx) => readModelOperation(services, ctx, c.req.param('id'), c.req.param('approvalId')), 'preserved'));
  app.post('/api/capture/:id/model-approve', (c) => withContext(c, services, async (ctx) => {
    const input = await readBody(c, ModelApprovalInputSchema);
    return input.ok ? approveModelInput(services, ctx, c.req.param('id'), input.data) : input;
  }, 'preserved'));
  app.post('/api/capture/:id/extract', (c) => withContext(c, services, async (ctx) => {
    const input = await readBody(c, ExtractInputSchema);
    if (!input.ok) return input;
    const key = JSON.stringify([ctx.workspaceId, c.req.param('id')]);
    if (extracting.has(key)) return failure('CONFLICT', '该现场已有提取请求进行中；请核验现有候选。', 'read_candidates', 'preserved');
    extracting.add(key);
    try { return await extractCapture(services, ctx, c.req.param('id'), input.data, c.req.raw.signal); }
    finally { extracting.delete(key); }
  }, 'preserved'));
}
