import { z } from 'zod';
import type { Result } from '../../contracts/api';
import { ApprovalSchema, type Conversation } from '../../contracts/domain';
import { canonicalJson, hashModelInput } from '../../contracts/hash';
import { ModelInputSchema } from '../../contracts/model';
import { composeModelInput, ModelScopeSchema, PROMPT_VERSION, type ModelPreview, type ModelScope } from './model-input';
import { checkSavedReceipt } from './readback';
import { selectSegments } from './scope';
import { failure } from './result';

const ModelPreviewSchema = z.object({
  input: ModelInputSchema.extend({ purpose: z.literal('extract'), text: z.string().min(1).max(24000) }),
  approvalRequest: ApprovalSchema.pick({ purpose: true, objectIds: true, contentHash: true, baseRevision: true }),
  promptVersion: z.literal(PROMPT_VERSION),
}).strict();

export async function checkModelPreview(value: unknown, conversation: Conversation, scope: ModelScope): Promise<Result<ModelPreview>> {
  const invalid = () => failure<ModelPreview>('CONFLICT', '模型预览与当前任务、选中来源或正文摘要不一致；未申请批准，请重新预览。', 'preview_again', 'preserved');
  const parsed = ModelPreviewSchema.safeParse(value); const input = ModelScopeSchema.safeParse(scope);
  if (!parsed.success || !input.success || input.data.task.id !== conversation.taskId) return invalid();
  const saved = await checkSavedReceipt(conversation, { id: conversation.id, workspaceId: input.data.task.workspaceId });
  if (!saved.ok) return invalid();
  const selected = selectSegments(saved.data.segments, input.data.segmentIds);
  if (!selected.ok) return invalid();
  const expected = composeModelInput(input.data.task, selected.data);
  const { approvalRequest } = parsed.data;
  if (canonicalJson(parsed.data.input) !== canonicalJson(expected) || approvalRequest.purpose !== 'model_input' || approvalRequest.baseRevision !== saved.data.contentHash || canonicalJson(approvalRequest.objectIds) !== canonicalJson(expected.sourceIds) || approvalRequest.contentHash !== await hashModelInput(expected)) return invalid();
  return { ok: true, data: parsed.data };
}
