import type { RequestContext, Result } from '../../contracts/api';
import { Id } from '../../contracts/domain';
import { ModelOperationReceiptSchema, type ModelOperationReceipt } from '../../contracts/model';
import type { Services } from '../../contracts/ports';
import { SCOPES } from '../../contracts/scopes';
import { readSavedConversation } from './save';
import { failure } from './result';

export async function readModelOperation(services: Services, ctx: RequestContext, conversationId: string, approvalId: string): Promise<Result<ModelOperationReceipt | null>> {
  if (![SCOPES.workspaceRead, SCOPES.conversationRead, SCOPES.modelExtract].every((scope) => ctx.scopes.includes(scope))) return failure('FORBIDDEN', '缺少原提取操作读取权限。', 'check_permissions', 'preserved');
  if (!Id.safeParse(approvalId).success) return failure('VALIDATION', '原批准ID无效。', 'read_model_operation', 'preserved');
  if (!services.readModelOperation) return failure('NOT_CONFIGURED', '模型操作读回尚未连接；不能确认请求未执行。', 'read_model_operation', 'unknown');
  const source = await readSavedConversation(services, ctx, conversationId); if (!source.ok) return source;
  const result = await services.readModelOperation(ctx, approvalId); if (!result.ok || result.data === null) return result;
  const parsed = ModelOperationReceiptSchema.safeParse(result.data);
  if (!parsed.success || parsed.data.approvalId !== approvalId || parsed.data.actorId !== ctx.actorId || parsed.data.workspaceId !== ctx.workspaceId || parsed.data.purpose !== 'extract' || parsed.data.baseRevision !== source.data.contentHash) return failure('CONFLICT', '操作回执不属于原现场、批准或身份；没有再次发送模型。', 'read_model_operation', 'unknown');
  return { ok: true, data: parsed.data };
}
