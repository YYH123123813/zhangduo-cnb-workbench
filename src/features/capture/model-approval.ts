import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { Id, type Approval } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { SCOPES } from '../../contracts/scopes';
import { checkApprovalBinding } from './approval';
import { ModelScopeSchema, prepareModelInput } from './model-input';
import { failure } from './result';

export const ModelApprovalInputSchema = ModelScopeSchema.extend({ operationId: Id.optional(), expectedInputHash: Id, expectedConversationHash: Id, retentionDays: z.literal(7), confirmed: z.literal(true) });
export const MODEL_APPROVAL_SCOPES = [SCOPES.conversationRead, SCOPES.candidateRead, SCOPES.candidateWrite, SCOPES.modelExtract, SCOPES.settingsRead];

export async function approveModelInput(services: Services, ctx: RequestContext, id: string, input: z.infer<typeof ModelApprovalInputSchema>): Promise<Result<Approval>> {
  if (!MODEL_APPROVAL_SCOPES.every((scope) => ctx.scopes.includes(scope))) return failure('FORBIDDEN', '缺少模型提取或候选保存、读回权限。', 'check_permissions');
  if (!services.approveModel) return failure('NOT_CONFIGURED', '可信模型批准尚未连接；未发送模型，已有现场可手动交接。', 'continue_manually');
  const { operationId, expectedInputHash, expectedConversationHash, retentionDays: _retentionDays, confirmed, ...scope } = input;
  const preview = await prepareModelInput(services, ctx, id, scope);
  if (!preview.ok) return { ok: false, error: { ...preview.error, dataState: 'not_written' } };
  const expected = preview.data.approvalRequest;
  if (expected.contentHash !== expectedInputHash || expected.baseRevision !== expectedConversationHash) return failure('CONFLICT', '任务、来源或模型输入已改变，请重新预览并确认。', 'preview_again');
  try {
    const issued = await services.approveModel(ctx, { input: preview.data.input, objectIds: expected.objectIds, baseRevision: expected.baseRevision, conversationId: id, ...(operationId ? { operationId } : {}), confirmed });
    if (!issued.ok) return issued;
    const checked = checkApprovalBinding(issued.data, expected, ctx);
    return checked.ok ? checked : { ok: false, error: { ...checked.error, dataState: 'unknown', nextAction: 'read_approval_state' } };
  } catch { return failure('UNKNOWN_RESULT', '模型批准登记结果未知；未发送模型，需先核验原批准。', 'read_approval_state', 'unknown'); }
}
