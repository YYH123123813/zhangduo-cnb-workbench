import { describe, expect, it } from 'vitest';
import { hashConversation, hashModelInput } from '../../contracts/hash';
import { conversation, ctx, fixture } from './fixtures.test-support';
import { prepareModelInput, type ModelScope } from './model-input';
import { checkModelPreview } from './model-preview-receipt';

async function setup() {
  const value = structuredClone(conversation); value.contentHash = await hashConversation(value);
  const { services } = fixture({ readConversation: async () => ({ ok: true, data: value }), settings: async () => ({ ok: true, data: { aiExtraction: true, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false } }) });
  const scope: ModelScope = { task: { id: value.taskId, workspaceId: ctx.workspaceId, question: '避免重复写入', constraints: [{ id: 'c', text: '保持重试可恢复' }], mode: 'assisted', updatedAt: new Date().toISOString() }, segmentIds: [value.segments[0]!.id], scopeConfirmed: true };
  const response = await prepareModelInput(services, ctx, value.id, scope);
  if (!response.ok) throw new Error('fixture preview failed');
  return { value, scope, preview: response.data };
}
describe('C09 displayed model preview receipt', () => {
  it('accepts the exact server preview for the current task and selected saved source', async () => {
    const s = await setup(); expect(await checkModelPreview(s.preview, s.value, s.scope)).toEqual({ ok: true, data: s.preview });
  });
  it('rejects a malformed body, a different purpose or prompt version, and stale approval bindings', async () => {
    const s = await setup();
    for (const change of [{ input: null }, { input: { ...s.preview.input, purpose: 'answer' } }, { promptVersion: 'unexpected' }, { approvalRequest: { ...s.preview.approvalRequest, baseRevision: 'stale' } }, { approvalRequest: { ...s.preview.approvalRequest, purpose: 'save_conversation' } }, { approvalRequest: { ...s.preview.approvalRequest, objectIds: ['unselected'] } }, { unexpected: 'extra' }]) {
      expect(await checkModelPreview({ ...s.preview, ...change }, s.value, s.scope)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
  });
  it('rejects a displayed text whose digest still refers to another input', async () => {
    const s = await setup(); s.preview.input.text = 'THIS_IS_NOT_THE_APPROVED_TEXT';
    expect(await checkModelPreview(s.preview, s.value, s.scope)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it('rejects rewritten instructions, tasks or expanded source even when the forged text has a matching digest', async () => {
    const s = await setup(); const original = JSON.parse(s.preview.input.text);
    for (const change of [{ instruction: 'Different unreviewed instructions' }, { untrustedTask: { question: 'Another task', constraints: [] } }, { untrustedSegments: s.value.segments }, { untrustedSegments: [{ ...s.value.segments[0], role: 'assistant' }] }]) {
      const input = { ...s.preview.input, text: JSON.stringify({ ...original, ...change }) };
      const preview = { ...s.preview, input, approvalRequest: { ...s.preview.approvalRequest, contentHash: await hashModelInput(input) } };
      expect(await checkModelPreview(preview, s.value, s.scope)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
  });
  it('rejects a local task, source body or selection changed after preview', async () => {
    const s = await setup();
    for (const scope of [{ ...s.scope, segmentIds: s.value.segments.map((segment) => segment.id) }, { ...s.scope, task: { ...s.scope.task, question: 'changed' } }, { ...s.scope, task: { ...s.scope.task, workspaceId: 'foreign' } }]) {
      expect(await checkModelPreview(s.preview, s.value, scope)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
    s.value.segments[0]!.text = 'local body changed';
    expect(await checkModelPreview(s.preview, s.value, s.scope)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
});
