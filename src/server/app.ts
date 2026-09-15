import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CONTRACT_VERSION } from '../contracts/domain';
import type { Services } from '../contracts/ports';
import { createServices } from '../platform/services';
import { respond } from './respond';
import { ApprovalRegistrationQuerySchema, ConversationApprovalRequestSchema, KnowledgeApprovalRequestSchema } from '../contracts/approval';
import { GovernanceApprovalRequestSchema } from '../contracts/governance';
import { ModelApprovalRequestSchema } from '../contracts/model';
import { EvidenceApprovalRequestSchema } from '../contracts/evidence';
import { TaskSaveRequestSchema } from '../contracts/task-record';
import { HandoffOperationSaveRequestSchema } from '../contracts/handoff-operation';
import { WorkspaceSessionSchema } from '../contracts/session';
import { DemoExportExecutionRequestSchema, DemoExportRequestSchema } from '../contracts/demo-export';
import { OperationRecoveryQuerySchema } from '../contracts/operation-recovery';
import { RecoveryAnchorRequestSchema } from '../contracts/recovery-anchor';
import { IndexApprovalRequestSchema, IndexExecutionRequestSchema, IndexPreviewRequestSchema } from '../contracts/indexing';
import type { ServerRuntime } from '../platform/runtime';
import { unavailable } from '../contracts/api';
import { returnedKnowledgeRefs } from './review-exposure';
import { IntelligenceCommandSchema } from '../contracts/intelligence';
import { registerRoutes as capture } from '../features/capture/server';
import { registerRoutes as handoff } from '../features/handoff/server';
import { registerRoutes as retrieval } from '../features/retrieval/server';
import { registerRoutes as learning } from '../features/learning/server';
import { registerRoutes as governance } from '../features/governance/server';

export function createApp(services: Services = createServices(), options: { trustedOrigins?: string[]; runtime?: ServerRuntime } = {}) {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    const url = new URL(c.req.url);
    const origin = c.req.header('Origin');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const trusted = new Set([url.origin, ...(options.trustedOrigins ?? [])]);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && !options.trustedOrigins?.includes(url.origin)) || (unsafe && ((origin && !trusted.has(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site' || (!origin && c.req.header('Cookie'))))) {
      return respond(c, { ok: false, error: { code: 'FORBIDDEN', message: 'Request origin is not authorized', retryable: false, dataState: 'not_written', nextAction: 'use_same_origin_workspace' } });
    }
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 2_000_000, onError: (c) => respond(c, { ok: false, error: { code: 'VALIDATION', message: 'Request payload exceeds the allowed size', retryable: false, dataState: 'not_written', nextAction: 'reduce_capture_scope' } }) }));
  app.get('/api/intelligence', async (c) => {
    const ctx = await services.context(c.req.raw); if (!ctx.ok) return respond(c, ctx);
    return respond(c, await services.intelligenceCommand?.(ctx.data, { action: 'overview' }) ?? unavailable(), ctx.data);
  });
  app.get('/api/intelligence/chats/:id', async (c) => {
    const ctx = await services.context(c.req.raw); if (!ctx.ok) return respond(c, ctx);
    return respond(c, await services.intelligenceCommand?.(ctx.data, { action: 'read_chat', id: c.req.param('id') }) ?? unavailable(), ctx.data);
  });
  app.get('/api/intelligence/operations/:id', async (c) => {
    const ctx = await services.context(c.req.raw); if (!ctx.ok) return respond(c, ctx);
    return respond(c, await services.intelligenceCommand?.(ctx.data, { action: 'read_operation', id: c.req.param('id') }) ?? unavailable(), ctx.data);
  });
  app.post('/api/intelligence', async (c) => {
    const ctx = await services.context(c.req.raw); if (!ctx.ok) return respond(c, ctx);
    const input = IntelligenceCommandSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: '操作需要完整参数及独立确认。', retryable: false, dataState: 'not_written', nextAction: 'review_input' } }, ctx.data);
    return respond(c, await services.intelligenceCommand?.(ctx.data, input.data) ?? unavailable(), ctx.data);
  });
  app.use('/api/retrieval/*', async (c, next) => {
    await next();
    if (!services.recordReviewExposure || c.res.status !== 200 || !c.res.headers.get('Content-Type')?.includes('application/json')) return;
    try {
      const body = await c.res.clone().json() as { ok?: boolean; data?: unknown };
      if (!body.ok) return;
      const refs = returnedKnowledgeRefs(body.data); if (!refs.length) return;
      const context = await services.context(c.req.raw);
      if (!context.ok) { c.res = respond(c, context); return; }
      const result = await services.recordReviewExposure(context.data, refs);
      if (!result.ok) c.res = respond(c, result, context.data);
    } catch { c.res = respond(c, { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Knowledge exposure could not be recorded; content was withheld', retryable: false, dataState: 'unknown', nextAction: 'read_review_operation' } }); }
  });
  app.get('/api/workspace/review-runtime', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readReviewRuntime?.(context.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/index/status', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readIndexStatus?.(context.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/index/operations/:id', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readIndexOperation?.(context.data, c.req.param('id')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/index/preview', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = IndexPreviewRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'Original operation and base Commit are required', retryable: false, dataState: 'not_written', nextAction: 'preview_index_update' } }, context.data);
    return respond(c, await services.previewIndexUpdate?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/index/approve', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = IndexApprovalRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'Independent index approval is required', retryable: false, dataState: 'not_written', nextAction: 'confirm_index_update' } }, context.data);
    return respond(c, await services.approveIndexUpdate?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/index/execute', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = IndexExecutionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'Original index operation and approval are required', retryable: false, dataState: 'not_written', nextAction: 'read_index_operation' } }, context.data);
    return respond(c, await services.executeIndexUpdate?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/health', (c) => {
    const status = options.runtime?.status();
    return c.json({ ok: true, data: { status: status?.state ?? 'unconfigured', cnbConnected: status?.cnbConnected ?? false,
      storage: status?.storage ?? 'not_configured', features: ['capture', 'handoff', 'retrieval', 'learning', 'governance'] },
      meta: { requestId: crypto.randomUUID(), mode: status?.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION } });
  });
  app.get('/api/workspace/connection', (c) => {
    const status = options.runtime?.status() ?? { state: 'unconfigured', mode: 'unconfigured', storage: 'not_configured', cnbConnected: false, missing: ['SERVER_RUNTIME'] };
    return c.json({ ok: true, data: status, meta: { requestId: crypto.randomUUID(), mode: status.mode, contractVersion: CONTRACT_VERSION } });
  });
  app.post('/api/workspace/connect', async (c) => {
    if (!c.req.header('Origin') || !c.req.header('Content-Type')?.startsWith('application/json')) return respond(c, { ok: false, error: { code: 'FORBIDDEN', message: 'Same-origin JSON connection is required', retryable: false, dataState: 'not_written', nextAction: 'use_workspace_connection' } });
    const result = await options.runtime?.connect(await c.req.json().catch(() => null), c.req.raw) ?? unavailable();
    if (!result.ok) return respond(c, result);
    c.header('Set-Cookie', `zhangduo_session=${result.data.sessionToken}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=3600${new URL(c.req.url).protocol === 'https:' ? '; Secure' : ''}`);
    return c.json({ ok: true, data: result.data.session, meta: { requestId: crypto.randomUUID(), mode: result.data.session.workspace.mode, contractVersion: CONTRACT_VERSION } });
  });
  app.post('/api/workspace/disconnect', (c) => {
    if (!c.req.header('Origin')) return respond(c, { ok: false, error: { code: 'FORBIDDEN', message: 'Same-origin logout is required', retryable: false, dataState: 'not_written', nextAction: 'use_workspace_connection' } });
    const result = options.runtime?.disconnect(c.req.raw) ?? unavailable();
    if (result.ok) c.header('Set-Cookie', 'zhangduo_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0');
    return respond(c, result);
  });
  app.get('/api/workspace', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.workspace(context.data), context.data);
  });
  app.get('/api/workspace/session', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    const workspace = await services.workspace(context.data);
    if (!workspace.ok) return respond(c, workspace, context.data);
    const data = WorkspaceSessionSchema.parse({ actorId: context.data.actorId, workspace: workspace.data, scopes: [...context.data.scopes] });
    return respond(c, { ok: true, data }, context.data);
  });
  app.post('/api/workspace/tasks', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = TaskSaveRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'An explicit task storage scope and original CAS are required', retryable: false, dataState: 'not_written', nextAction: 'preview_task_storage' } }, context.data);
    return respond(c, await services.saveTask?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/tasks/:taskId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readTaskState?.(context.data, c.req.param('taskId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/task-receipts/:operationId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readTaskReceipt?.(context.data, c.req.param('operationId')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/approvals/conversations', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    const input = ConversationApprovalRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'A valid capture preview and explicit confirmation are required', retryable: false, dataState: 'not_written', nextAction: 'preview_and_confirm' } }, context.data);
    return respond(c, await services.approveConversation?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/approvals/:id/revoke', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.revokeApproval?.(context.data, c.req.param('id')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/approvals/knowledge', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    const input = KnowledgeApprovalRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'A confirmed ChangeSet is required', retryable: false, dataState: 'not_written', nextAction: 'preview_and_confirm' } }, context.data);
    return respond(c, await services.approveKnowledge?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/commits/:id', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readCommit?.(context.data, c.req.param('id')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/approvals/knowledge/:changeSetId', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readKnowledgeApproval?.(context.data, c.req.param('changeSetId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/approval-registrations/:purpose/:operationId', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    const params = new URL(c.req.url).searchParams;
    const validQuery = [...params.keys()].every((key) => key === 'modelPurpose' && params.getAll(key).length === 1);
    const input = ApprovalRegistrationQuerySchema.safeParse({ purpose: c.req.param('purpose'), operationId: c.req.param('operationId'),
      ...(params.has('modelPurpose') ? { modelPurpose: params.get('modelPurpose') } : {}) });
    if (!validQuery || !input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'The original approval identity and exact purpose are required', retryable: false, dataState: 'not_written', nextAction: 'read_approval_registration' } }, context.data);
    return respond(c, await services.readApprovalRegistration?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/approvals/model', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    const input = ModelApprovalRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'A confirmed bounded model preview is required', retryable: false, dataState: 'not_written', nextAction: 'preview_model_scope' } }, context.data);
    return respond(c, await services.approveModel?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/model-operations/:approvalId', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readModelOperation?.(context.data, c.req.param('approvalId')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/model-operations/:approvalId/close', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const body = await c.req.json().catch(() => null);
    return respond(c, await services.closeModelOperation?.(context.data, { ...(body && typeof body === 'object' ? body : {}), approvalId: c.req.param('approvalId') }) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/extraction-operations/:operationId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readExtractionOperation?.(context.data, c.req.param('operationId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/conversations/:conversationId/extractions', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.discoverExtractionOperations?.(context.data, c.req.param('conversationId')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/governance-operations', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.saveGovernanceOperation?.(context.data, await c.req.json().catch(() => null)) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/governance-operations/:operationId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readGovernanceOperation?.(context.data, c.req.param('operationId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/governance-operation-receipts/:operationId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readGovernanceOperationReceipt?.(context.data, c.req.param('operationId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/drafts/:id', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readDraftState?.(context.data, c.req.param('id')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/handoff-operations', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = HandoffOperationSaveRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'An original preview and explicit private retention consent are required', retryable: false, dataState: 'not_written', nextAction: 'preview_original_operation' } }, context.data);
    return respond(c, await services.saveHandoffOperation?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/handoff-operations/:changeSetId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readHandoffOperation?.(context.data, c.req.param('changeSetId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/handoff-operation-receipts/:changeSetId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readHandoffOperationReceipt?.(context.data, c.req.param('changeSetId')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/approvals/evidence', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = EvidenceApprovalRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'Explicit evidence retention approval is required', retryable: false, dataState: 'not_written', nextAction: 'preview_evidence_storage' } }, context.data);
    return respond(c, await services.approveEvidence?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/evidence/:recordId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readEvidence?.(context.data, c.req.param('recordId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/evidence-receipts/:operationId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readEvidenceReceipt?.(context.data, c.req.param('operationId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/draft-receipts/:operationId', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readDraftReceipt?.(context.data, c.req.param('operationId')) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/approvals/governance', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    const input = GovernanceApprovalRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'A valid governance preview and explicit confirmation are required', retryable: false, dataState: 'not_written', nextAction: 'preview_and_confirm' } }, context.data);
    return respond(c, await services.approveGovernance?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/approvals/demo-export', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = DemoExportRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'A strict demo export scope and explicit confirmation are required', retryable: false, dataState: 'not_written', nextAction: 'preview_demo_export' } }, context.data);
    return respond(c, await services.approveDemoExport?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/demo-exports', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = DemoExportExecutionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'A strict demo export request and original approval are required', retryable: false, dataState: 'not_written', nextAction: 'preview_demo_export' } }, context.data);
    return respond(c, await services.executeDemoExport?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/demo-exports/:operationId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readDemoExport?.(context.data, c.req.param('operationId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/operation-recovery/:kind/:operationId', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const params = new URL(c.req.url).searchParams;
    const validQuery = [...params.keys()].every((key) => key === 'modelPurpose' && params.getAll(key).length === 1);
    const input = OperationRecoveryQuerySchema.safeParse({ kind: c.req.param('kind'), operationId: c.req.param('operationId'), ...(params.has('modelPurpose') ? { modelPurpose: params.get('modelPurpose') } : {}) });
    if (!validQuery || !input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'The original operation kind, ID and model purpose are required', retryable: false, dataState: 'not_written', nextAction: 'read_operation_recovery' } }, context.data);
    return respond(c, await services.readOperationRecovery?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.post('/api/workspace/recovery-identities', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    const input = RecoveryAnchorRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return respond(c, { ok: false, error: { code: 'VALIDATION', message: 'Only an explicitly confirmed minimal recovery identity is accepted', retryable: false, dataState: 'not_written', nextAction: 'confirm_recovery_retention' } }, context.data);
    return respond(c, await services.saveRecoveryAnchor?.(context.data, input.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/recovery-identities', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.listRecoveryAnchors?.(context.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/recovery-identities/:id', async (c) => {
    const context = await services.context(c.req.raw); if (!context.ok) return respond(c, context);
    return respond(c, await services.readRecoveryAnchor?.(context.data, c.req.param('id')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/settings', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.settingsState?.(context.data) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/settings/receipts/:approvalId', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readSettingsReceipt?.(context.data, c.req.param('approvalId')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/delete-plans/:id', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readDeletePlan?.(context.data, c.req.param('id')) ?? unavailable(), context.data);
  });
  app.get('/api/workspace/delete-plans/:id/report', async (c) => {
    const context = await services.context(c.req.raw);
    if (!context.ok) return respond(c, context);
    return respond(c, await services.readDeleteReport?.(context.data, c.req.param('id')) ?? unavailable(), context.data);
  });
  capture(app, services);
  handoff(app, services);
  retrieval(app, services);
  learning(app, services);
  governance(app, services);
  app.notFound((c) => c.json({ ok: false, error: { code: 'VALIDATION', message: 'Route not found', retryable: false, dataState: 'not_written', nextAction: 'check_route' }, meta: { requestId: crypto.randomUUID(), mode: 'unconfigured', contractVersion: CONTRACT_VERSION } }, 404));
  app.onError((_error, c) => c.json({ ok: false, error: { code: 'INTERNAL', message: 'Request failed', retryable: false, dataState: 'unknown', nextAction: 'check_server_status' }, meta: { requestId: crypto.randomUUID(), mode: 'unconfigured', contractVersion: CONTRACT_VERSION } }, 500));
  return app;
}
