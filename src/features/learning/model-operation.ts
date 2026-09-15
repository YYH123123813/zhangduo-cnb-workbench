import type { RequestContext, Result } from '../../contracts/api';
import { ApprovalSchema, Id } from '../../contracts/domain';
import { canonicalJson } from '../../contracts/hash';
import { OperationRecoverySchema, type OperationRecovery } from '../../contracts/operation-recovery';
import type { ModelOperationReceipt } from '../../contracts/model';
import type { Services } from '../../contracts/ports';
import { failure, success } from './errors';

interface ReviewModelOperationView {
  state: ModelOperationReceipt['state']; receipt: null; recovery: OperationRecovery;
  scope: 'operation_metadata_only'; reviewResult: 'not_recovered'; retryAllowed: false;
}

const modelStates = new Set<ModelOperationReceipt['state']>(['sending', 'done', 'unknown', 'discarded', 'not_sent']);

function modelState(stage: OperationRecovery['stage']): ModelOperationReceipt['state'] {
  return modelStates.has(stage as ModelOperationReceipt['state']) ? stage as ModelOperationReceipt['state'] : 'unknown';
}

// Old operation facts remain readable after approval expiry, AI shutdown or source changes.
export async function inspectReviewModelOperation(input: unknown, services: Services, ctx: RequestContext, operationId: string): Promise<Result<ReviewModelOperationView>> {
  const approval = ApprovalSchema.safeParse(input);
  if (!approval.success) return failure('VALIDATION', '需要原模型批准，未重新申请或发送。', 'inspect_original_model_approval', 'unknown');
  if (!operationId || !Id.safeParse(operationId).success) return failure('VALIDATION', '模型审核恢复需要原批准登记的 operationId，不能用批准 ID 猜测原操作。', 'provide_original_model_operation_id', 'unknown');
  if (approval.data.actorId !== ctx.actorId || approval.data.workspaceId !== ctx.workspaceId || approval.data.purpose !== 'model_input'
    || !ctx.scopes.includes('workspace:read') || !ctx.scopes.includes('model:review')) return failure('FORBIDDEN', '不能读取该操作者、工作区或用途的模型操作。', 'restore_original_authorized_session', 'unknown');
  if (!services.readOperationRecovery) return failure('NOT_IMPLEMENTED', '统一模型审核操作恢复端口未接入；不能确认没有发送。', 'connect_model_operation_recovery', 'unknown');
  try {
    const result = await services.readOperationRecovery(ctx, { kind: 'model', operationId, modelPurpose: 'review' });
    if (!result.ok) return { ok: false, error: { ...result.error, retryable: false, dataState: 'unknown' } };
    const checked = OperationRecoverySchema.safeParse(result.data);
    if (!checked.success) return failure('UNKNOWN_RESULT', '统一模型审核操作元数据无法核验，仍保留原操作。', 'inspect_original_model_approval', 'unknown');
    const recovery = checked.data;
    if (recovery.kind !== 'model' || recovery.operationId !== operationId || recovery.actorId !== ctx.actorId
      || recovery.workspaceId !== ctx.workspaceId || recovery.readOnly !== true || recovery.absenceIsFinal !== false
      || (recovery.approvalId !== null && recovery.approvalId !== approval.data.id)
      || (recovery.purpose !== null && recovery.purpose !== 'review')
      || (recovery.contentHash !== null && recovery.contentHash !== approval.data.contentHash)
      || (recovery.baseRevision !== null && recovery.baseRevision !== approval.data.baseRevision)
      || (recovery.approvalId !== null && canonicalJson([...recovery.objectIds].sort()) !== canonicalJson([...approval.data.objectIds].sort()))) {
      return failure('UNKNOWN_RESULT', '模型元数据不匹配原批准及审核用途，未认定本次操作成功。', 'inspect_original_model_approval', 'unknown');
    }
    return success({ state: modelState(recovery.stage), receipt: null, recovery, scope: 'operation_metadata_only', reviewResult: 'not_recovered', retryAllowed: false });
  } catch { return failure('UNKNOWN_RESULT', '原模型操作暂时无法读回；没有再次发送，不推断未计费。', 'inspect_original_model_approval', 'unknown'); }
}
