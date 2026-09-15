import type { RequestContext, Result } from '../../contracts/api';
import {
  OperationRecoveryQuerySchema,
  OperationRecoverySchema,
  type OperationRecovery,
  type OperationRecoveryQuery,
} from '../../contracts/operation-recovery';
import type { EvidenceTransport } from './evidence-save-flow';
import { failure, success } from './errors';

export type LearningRecoveryTransport = EvidenceTransport;
export type LearningRecoveryIdentity = Pick<RequestContext, 'actorId' | 'workspaceId'>;
export type LearningRecoveryQuery = OperationRecoveryQuery & { kind: 'evidence' | 'task' };

const unknownRecovery = <T>(message: string): Result<T> => failure('UNKNOWN_RESULT', message, 'read_original_operation', 'unknown');

function recoveryPath(query: LearningRecoveryQuery): string {
  return `/api/workspace/operation-recovery/${query.kind}/${encodeURIComponent(query.operationId)}`;
}

/**
 * Reads only the shared operation metadata. The endpoint intentionally cannot
 * restore a task, evidence body, approval payload, or any other private text.
 */
export async function readLearningOperationRecovery(
  transport: LearningRecoveryTransport,
  identity: LearningRecoveryIdentity,
  input: unknown,
): Promise<Result<OperationRecovery>> {
  const parsed = OperationRecoveryQuerySchema.safeParse(input);
  if (!parsed.success) {
    return failure('VALIDATION', '学习原操作恢复需要 evidence/task 类型及原操作 ID。', 'read_original_operation');
  }
  if (!['evidence', 'task'].includes(parsed.data.kind)) return failure('VALIDATION', '学习原操作恢复需要 evidence/task 类型及原操作 ID。', 'read_original_operation');
  const query = parsed.data as LearningRecoveryQuery;
  try {
    const response = await transport(recoveryPath(query));
    if (!response.ok) return response;
    const recovery = OperationRecoverySchema.safeParse(response.data);
    if (!recovery.success || recovery.data.kind !== query.kind || recovery.data.operationId !== query.operationId
      || recovery.data.actorId !== identity.actorId || recovery.data.workspaceId !== identity.workspaceId
      || recovery.data.readOnly !== true || recovery.data.absenceIsFinal !== false) {
      return unknownRecovery('共享原操作元数据无法绑定当前身份、工作区或原操作；未展示正文。');
    }
    return success(recovery.data);
  } catch {
    return unknownRecovery('共享原操作读取中断；未发送任何写入，也未推定操作未执行。');
  }
}

export function readTaskOperationRecovery(
  transport: LearningRecoveryTransport,
  identity: LearningRecoveryIdentity,
  operationId: string,
): Promise<Result<OperationRecovery>> {
  return readLearningOperationRecovery(transport, identity, { kind: 'task', operationId });
}

export function readEvidenceOperationRecovery(
  transport: LearningRecoveryTransport,
  identity: LearningRecoveryIdentity,
  operationId: string,
): Promise<Result<OperationRecovery>> {
  return readLearningOperationRecovery(transport, identity, { kind: 'evidence', operationId });
}
