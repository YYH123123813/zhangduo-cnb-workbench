import type { Candidate } from '../../contracts/domain';
import { canonicalJson } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { readSavedConversation } from './save';
import { ExtractInputSchema, invokeExtraction, prepareModelInput } from './model-input';
import { checkApprovalBinding } from './approval';
import { decodeCandidates } from './candidates';
import { buildCandidates, checkStoredCandidates } from './spans';
import { failure } from './result';
import { handoffHref } from './links';
import type { CandidateState } from '../../contracts/candidates';
import { checkCandidateBatch } from './candidate-batch';
import { readModelOperation } from './model-operation';
export { handoffHref } from './links';

export interface DeliveryReceipt { conversationId: string; conversationHash: string; candidates: Candidate[]; state: 'saved' | 'empty' | 'existing' | 'missing' | 'expired' | 'unverified'; batch?: CandidateState; handoffHref: string }

export async function readDelivery(services: Services, ctx: RequestContext, id: string): Promise<Result<DeliveryReceipt>> {
  if (!ctx.scopes.includes(SCOPES.candidateRead)) return failure('FORBIDDEN', '缺少候选读取权限。', 'check_permissions', 'preserved');
  const conversation = await readSavedConversation(services, ctx, id);
  if (!conversation.ok) return conversation;
  if (services.readCandidateState) {
    const result = await services.readCandidateState(ctx, id); if (!result.ok) return result;
    const checked = await checkCandidateBatch(result.data, conversation.data); if (!checked.ok) return checked;
    const batch = checked.data;
    return { ok: true, data: { conversationId: id, conversationHash: conversation.data.contentHash, candidates: batch.candidates, batch, state: batch.state === 'available' ? batch.candidates.length ? 'existing' : 'empty' : batch.state, handoffHref: handoffHref(id) } };
  }
  const result = await services.readCandidates(ctx, id);
  if (!result.ok) return result;
  const candidates = await checkStoredCandidates(conversation.data, result.data);
  return candidates.ok ? { ok: true, data: { conversationId: id, conversationHash: conversation.data.contentHash, candidates: candidates.data, state: candidates.data.length ? 'existing' : 'unverified', handoffHref: handoffHref(id) } } : candidates;
}

export async function extractCapture(services: Services, ctx: RequestContext, id: string, input: unknown, signal?: AbortSignal): Promise<Result<DeliveryReceipt>> {
  const stopped = () => failure<DeliveryReceipt>('FORBIDDEN', '已停止后续候选保存；已发送的模型请求不保证撤回，现场仍保留。', 'continue_manually', 'preserved');
  if (signal?.aborted) return stopped();
  if (![SCOPES.candidateRead, SCOPES.candidateWrite].every((scope) => ctx.scopes.includes(scope))) return failure('FORBIDDEN', '缺少候选保存或读回权限。', 'check_permissions', 'preserved');
  const parsed = ExtractInputSchema.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '请预览并单独批准本次模型输入。', 'approve_model_input', 'preserved');
  const { approval, retentionDays, confirmed, ...scope } = parsed.data;
  const preview = await prepareModelInput(services, ctx, id, scope);
  if (!preview.ok) return preview;
  const valid = checkApprovalBinding(approval, preview.data.approvalRequest, ctx);
  if (!valid.ok) return valid;
  if (!services.readCandidateState || !services.readModelOperation) return failure('NOT_CONFIGURED', '候选批次或模型操作存储未连接；尚未发送模型。', 'configure_candidate_storage', 'preserved');
  const existing = await readDelivery(services, ctx, id);
  if (!existing.ok) return existing;
  if (existing.data.batch?.state === 'available') return existing;
  if (existing.data.batch?.state !== 'missing') return failure('CONFLICT', '候选批次已过期或状态未核验；不能重新提取覆盖原操作。', 'read_candidate_state', 'preserved');
  const expectedRevision = existing.data.batch.revision;
  const operation = await readModelOperation(services, ctx, id, approval.id);
  if (!operation.ok) return operation;
  if (operation.data) return failure('UNKNOWN_RESULT', '原模型操作已登记，候选尚未核验；不会再次发送模型。', 'read_model_operation', 'unknown');
  if (signal?.aborted) return stopped();
  let saving = false;
  try {
    const completion = await invokeExtraction(services, ctx, id, parsed.data, signal);
    if (!completion.ok) return completion;
    if (signal?.aborted) return stopped();
    const decoded = decodeCandidates(completion.data.response);
    if (!decoded.ok) return decoded;
    const candidates = await buildCandidates(completion.data.conversation, completion.data.sourceIds, decoded.data, completion.data.promptVersion, signal);
    if (!candidates.ok) return candidates;
    const current = await readSavedConversation(services, ctx, id);
    if (!current.ok) return current;
    if (current.data.contentHash !== completion.data.conversation.contentHash) return failure('CONFLICT', '模型运行期间来源已改变；旧候选未保存。', 'preview_again', 'preserved');
    const settings = await services.settings(ctx);
    if (!settings.ok) return settings;
    if (settings.data.aiExtraction !== true || signal?.aborted) return stopped();
    const latest = await readDelivery(services, ctx, id);
    if (!latest.ok) return latest;
    if (latest.data.conversationHash !== completion.data.conversation.contentHash) return failure('CONFLICT', '保存前来源版本已改变；旧候选未写入。', 'preview_again', 'preserved');
    if (latest.data.batch?.state !== 'missing' || latest.data.batch.revision !== expectedRevision) return failure('CONFLICT', '候选批次在模型运行期间已改变；未覆盖其他操作。', 'read_candidate_state', 'preserved');
    const finalSettings = await services.settings(ctx);
    if (!finalSettings.ok) return finalSettings;
    if (finalSettings.data.aiExtraction !== true) return stopped();
    if (signal?.aborted) return stopped();
    const stillValid = checkApprovalBinding(approval, preview.data.approvalRequest, ctx);
    if (!stillValid.ok) return { ok: false, error: { ...stillValid.error, dataState: 'preserved' } };
    saving = true;
    const saved = await services.saveCandidates(ctx, id, candidates.data, { modelApproval: approval, expectedConversationHash: completion.data.conversation.contentHash, expectedRevision, retentionDays, confirmed });
    if (!saved.ok) return { ok: false, error: { ...saved.error, nextAction: 'read_candidates', message: '现场已保存；候选保存未确认，请先核验候选状态。' } };
    if (canonicalJson(saved.data) !== canonicalJson(candidates.data)) return failure('UNKNOWN_RESULT', '候选保存回执不匹配；请核验现有候选。', 'read_candidates', 'unknown');
    const verified = await readDelivery(services, ctx, id);
    if (!verified.ok || verified.data.conversationHash !== current.data.contentHash || verified.data.batch?.state !== 'available' || verified.data.batch.modelApprovalId !== approval.id || verified.data.batch.revision !== expectedRevision + 1 || canonicalJson(verified.data.candidates) !== canonicalJson(candidates.data)) return failure('UNKNOWN_RESULT', '候选尚未按原批准和版本读回核验；没有再次调用模型。', 'read_candidates', 'unknown');
    return { ok: true, data: { ...verified.data, state: candidates.data.length ? 'saved' : 'empty' } };
  } catch {
    return failure(saving ? 'UNKNOWN_RESULT' : 'UPSTREAM', saving ? '现场已保存；候选写入结果未知，请先核验。' : '模型提取未完成；已有现场仍可手动交接。', saving ? 'read_candidates' : 'continue_manually', saving ? 'unknown' : 'preserved');
  }
}
