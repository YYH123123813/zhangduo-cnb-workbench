import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { ApprovalSchema, Id, type EvidenceRecord, type KnowledgeNode, type KnowledgeSnapshot, type Relation } from '../../contracts/domain';
import { canonicalJson, hashExport } from '../../contracts/hash';
import { SCOPES } from '../../contracts/scopes';
import type { Services } from '../../contracts/ports';
import { cancelSchema, checkBase, fail, readSnapshot, requireScope, unwrap } from './http';
import { checkedEvidence, evidenceObjectIds, restrictedEvidenceIds, unreadableExclusions } from './evidence-scope';
import { objectIdsSchema } from './impact';
import { checkConsent } from './consent';

const selection = { objectIds: objectIdsSchema, baseRevision: Id };
export const exportRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), ...selection }).strict(),
  z.object({ action: z.literal('execute'), ...selection, approval: ApprovalSchema }).strict(), cancelSchema,
]);
const literal = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/([\\`*_[\]#])/g, '\\$1');
// The public export wire format is checked independently against the selected snapshot, not trusted by filename.
export function knowledgeMarkdown(node: KnowledgeNode, relations: Relation[] = []): string {
  const edges = relations.filter((edge) => edge.source.objectId === node.id || edge.target.objectId === node.id);
  return [`# ${literal(node.title)}`, '', `Object: ${node.id}`, `Confirmation: ${node.confirmation}`, `Lifecycle: ${node.lifecycle}`, `Authorship: ${node.authorship}`, '',
    '## Question', literal(node.question), '', '## Statement', literal(node.humanStatement), '',
    '## Conditions', ...node.conditions.map((item) => `- [${item.status}] ${literal(item.text)}`), '',
    '## Boundaries', ...node.boundaries.map((text) => `- ${literal(text)}`), '',
    '## Sources', ...node.sources.map((source) => `- ${literal(source.title)} (${source.id}; ${source.support})\n  ${literal(source.excerpt)}\n  Limitation: ${literal(source.limitation)}`), '',
    '## Relations (Generated)', ...edges.map((edge) => `- ${edge.source.objectId} -> ${edge.type} -> ${edge.target.objectId} [${edge.state}]: ${literal(edge.rationale)}`), ''].join('\n');
}
async function knowledgePath(id: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return `knowledge/nodes/${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}.md`;
}
export async function exportPreview(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: { objectIds: string[]; baseRevision: string }) {
  checkBase(snapshot, input.baseRevision);
  const blockedIds = unreadableExclusions(snapshot);
  if (input.objectIds.some((id) => blockedIds.includes(id))) fail('FORBIDDEN', '选定范围包含已阻断对象，不能通过导出读取。', 'review_delete_report');
  const nodes = snapshot.nodes.filter((n) => input.objectIds.includes(n.id));
  const relations = snapshot.relations.filter((r) => input.objectIds.includes(r.id));
  const known = new Set([...nodes, ...relations].map((item) => item.id));
  const unknownIds = input.objectIds.filter((id) => !known.has(id));
  let records: EvidenceRecord[] = [];
  if (unknownIds.length) {
    requireScope(ctx, SCOPES.evidenceRead);
    const all = unwrap(await services.listEvidence(ctx));
    const checked = checkedEvidence(all, ctx.workspaceId);
    const restricted = restrictedEvidenceIds(checked, blockedIds);
    if (unknownIds.some((id) => restricted.has(id))) fail('FORBIDDEN', '选中记录涉及已阻断的原任务或路径，未提供导出。');
    records = checked.filter((record) => unknownIds.includes(record.id));
    if (unknownIds.some((id) => !records.some((r) => r.id === id))) fail('VALIDATION', '导出范围包含未知对象，原始Issue未纳入授权范围。');
  }
  const selectedNodeIds = new Set(nodes.map((node) => node.id));
  if (relations.some((r) => !selectedNodeIds.has(r.source.objectId) || !selectedNodeIds.has(r.target.objectId)) || records.some((r) => r.nodeRefs.some((ref) => !selectedNodeIds.has(ref.objectId)))) fail('VALIDATION', '请显式选择关系或记录所引用的知识对象。');
  if (records.some((record) => evidenceObjectIds(record).some((id) => !input.objectIds.includes(id)))) fail('VALIDATION', '请显式选择原任务路径、关系和结果所引用的原使用记录。');
  const files = [
    { path: 'knowledge/snapshot.json', content: canonicalJson({ schemaVersion: 1, workspaceId: ctx.workspaceId, nodes, relations, excludedIds: snapshot.excludedIds.filter((id) => input.objectIds.includes(id)) }) },
    ...await Promise.all(nodes.map(async (node) => ({ path: await knowledgePath(node.id), content: knowledgeMarkdown(node, relations) }))),
    ...records.map((record, i) => ({ path: `evidence/${i + 1}.json`, content: canonicalJson(record) })),
    { path: 'manifest.json', content: canonicalJson({ workspaceId: ctx.workspaceId, baseRevision: snapshot.revision, objectIds: input.objectIds, includesPrivateIssues: false }) },
  ];
  return { workspaceId: ctx.workspaceId, baseRevision: snapshot.revision, objectIds: input.objectIds,
    contentHash: await hashExport(ctx.workspaceId, snapshot.revision, input.objectIds), files,
    excludes: ['private_issues', 'conversations', 'candidates', 'drafts', 'unselected_evidence', 'git_history', 'backups'],
    limitations: ['仅包含显式选择的对象及其已保存来源；不包含原始私人Issue或完整Git历史，不是完整备份。', '完整版本、来源和关系保留在knowledge/snapshot.json；Markdown为所选知识的可读副本。', '未选中的关系与证据不会自动加入；源材料的远程可访问性未核验。'],
    approvalStatus: services.approveGovernance ? 'required' as const : 'unavailable' as const, executionEnabled: false,
  };
}
export function validateExportFiles(value: unknown, allowedRoots = ['knowledge', 'sources', 'relations', 'evidence']) {
  const parsed = z.object({ files: z.array(z.object({ path: z.string().min(1).max(512), content: z.string().max(5_000_000) }).strict()).min(1).max(1000), limitations: z.array(z.string().max(4000)).max(100) }).strict().safeParse(value);
  if (!parsed.success) fail('UPSTREAM', '导出文件清单无效，未提供下载。', 'review_export_manifest');
  if (parsed.data.files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0) > 5_000_000) fail('UPSTREAM', '导出超出文件总量限制，未提供下载。', 'reduce_export_scope');
  const paths = new Set<string>();
  for (const file of parsed.data.files) {
    const parts = file.path.split('/');
    if (file.path.startsWith('/') || /[\\%:\x00-\x1f\x7f?#]/.test(file.path) || parts.some((part) => !part || part === '.' || part === '..')
      || (!allowedRoots.includes(parts[0]!) && !['README.md', 'manifest.json'].includes(file.path)) || paths.has(file.path)) fail('UPSTREAM', '导出路径或授权分类不安全，未提供下载。', 'review_export_manifest');
    paths.add(file.path);
  }
  return parsed.data;
}
function validateContents(files: { path: string; content: string }[], expected: { path: string; content: string }[]) {
  const paths = new Map(expected.map((file) => [file.path, file.content]));
  if (files.length !== paths.size) fail('UPSTREAM', '导出缺少预期文件或包含额外文件，未提供下载。', 'review_export_manifest');
  for (const file of files) {
    if (file.path.endsWith('.json')) {
      try {
        // Canonical bytes also reject duplicate keys that JSON.parse alone would silently discard.
        if (canonicalJson(JSON.parse(file.content)) !== file.content) throw new Error('Noncanonical export');
      } catch { fail('UPSTREAM', '导出结构化文件无法核验，未提供下载。', 'review_export_manifest'); }
    }
    if (paths.get(file.path) !== file.content) fail('UPSTREAM', '导出内容、版本或对象范围与预览不一致，未提供下载。', 'review_export_manifest');
  }
}
export async function executeExport(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: Extract<z.infer<typeof exportRequestSchema>, { action: 'execute' }>) {
  const preview = await exportPreview(services, ctx, snapshot, input);
  checkConsent(ctx, input.approval, { purpose: 'export', contentHash: preview.contentHash, baseRevision: preview.baseRevision, objectIds: preview.objectIds });
  const result = unwrap(await services.exportData(ctx, input.objectIds, input.approval));
  const allowedRoots = [...new Set(preview.files.map((file) => file.path.split('/')[0]!))];
  const checked = validateExportFiles(result, allowedRoots);
  validateContents(checked.files, preview.files);
  const current = await exportPreview(services, ctx, await readSnapshot(services, ctx), input);
  if (canonicalJson(current.files) !== canonicalJson(preview.files)) fail('CONFLICT', '导出生成期间对象已变化，未提供下载。', 'preview_export_again', 'preserved');
  return { ...checked, limitations: [...preview.limitations, ...checked.limitations], objectIds: input.objectIds, baseRevision: snapshot.revision,
    includesPrivateIssues: false, completeBackup: false, verification: 'selected_objects_and_files' as const };
}
