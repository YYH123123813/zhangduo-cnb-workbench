import { z } from 'zod';
import { Id, type KnowledgeSnapshot } from '../../contracts/domain';
import type { RequestContext } from '../../contracts/api';
import { contentHash } from '../../contracts/hash';
import { DemoExportAuthorizationBindingSchema, DemoExportRequestSchema, type DemoExportRequest } from '../../contracts/demo-export';
import { cancelSchema, checkBase, fail } from './http';
import { currentNode } from './revisions';

const publicText = z.string().trim().min(1).max(20000);
const demoInputSchema = z.object({ action: z.literal('preview'), operationId: Id, baseRevision: Id,
  items: z.array(z.object({ nodeId: Id, publicTitle: publicText.max(120), publicStatement: publicText, publicConditions: z.array(publicText).max(40), publicSourceLabels: z.array(publicText).max(40) }).strict()).min(1).max(20),
  modelDeclaration: z.enum(['not_used', 'used', 'unknown']),
}).strict().refine((input) => new Set(input.items.map((item) => item.nodeId)).size === input.items.length);
export const demoRequestSchema = z.discriminatedUnion('action', [demoInputSchema, cancelSchema]);
export async function demoPreview(ctx: RequestContext, snapshot: KnowledgeSnapshot, input: z.infer<typeof demoInputSchema>, options: { approvalAvailable?: boolean } = {}) {
  checkBase(snapshot, input.baseRevision);
  if (snapshot.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '演示对象不属于当前工作区。');
  const { action: _action, ...demoFields } = input;
  const request: DemoExportRequest = DemoExportRequestSchema.parse({ ...demoFields, confirmed: true, destination: 'local_download' });
  const objectIds = request.items.map((item) => item.nodeId);
  request.items.forEach((item) => {
    if (snapshot.excludedIds.includes(item.nodeId)) fail('FORBIDDEN', '选中的知识受删除屏障保护，不能生成演示副本。', 'read_delete_report', 'preserved');
    const original = currentNode(snapshot, item.nodeId);
    if (original.lifecycle === 'withdrawn') fail('FORBIDDEN', '已撤回知识不能生成演示副本。', 'read_delete_report', 'preserved');
    if (request.modelDeclaration === 'not_used' && original.authorship === 'ai_accepted') fail('VALIDATION', '原知识包含接受的AI原文，不能标记未使用模型。');
  });
  // Keep the preview byte-for-byte aligned with DemoExportStore so the approval binds the content the user reviewed.
  const entries = request.items.map((item, index) => ({ id: `demo-node-${index + 1}`, objectId: item.nodeId, title: item.publicTitle,
    statement: item.publicStatement, conditions: item.publicConditions, sourceLabels: item.publicSourceLabels, modelDeclaration: request.modelDeclaration }));
  const manifest = { format: 'governance-demo-export-v1', modelDeclaration: request.modelDeclaration, destination: request.destination,
    generatedMaterial: 'user_supplied_redacted_copy', account: 'not_included', workspace: 'not_included', originalConversation: 'not_included',
    privateSources: 'not_included', published: false };
  const files = [{ path: 'demo/knowledge.json', content: JSON.stringify(entries, null, 2) }, { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }];
  const requestHash = await contentHash(request);
  const previewHash = await contentHash({ purpose: 'demo_export', destination: request.destination, baseRevision: request.baseRevision,
    objectIds, items: request.items, modelDeclaration: request.modelDeclaration, files });
  const authorizationBinding = DemoExportAuthorizationBindingSchema.parse({ purpose: 'demo_export', destination: request.destination,
    operationId: request.operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, baseRevision: request.baseRevision, objectIds, requestHash, contentHash: previewHash });
  return { request, requestHash, contentHash: previewHash, files, published: false, accessVerified: false,
    approvalStatus: options.approvalAvailable ? 'required' as const : 'unavailable' as const, executionEnabled: !!options.approvalAvailable,
    authorizationBinding,
    previewHash,
    omissions: ['原账号与仓库标识', '原始对话与Issue', '原文、来源摘录和私人链接', '未选择的知识和学习记录'],
    warnings: ['演示文案为用户填写的脱敏副本，不是新的正式知识或真实用户实验。', '副本只允许本地下载；published=false，不代表公开、部署或评委可访问。'] };
}
