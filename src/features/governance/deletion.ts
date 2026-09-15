import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { ApprovalSchema, Id, type DeletePlan, type DeleteReport, type KnowledgeSnapshot } from '../../contracts/domain';
import { hashDeletePlan } from '../../contracts/hash';
import type { Services } from '../../contracts/ports';
import { cancelSchema, checkBase, fail, readSnapshot, unwrap } from './http';
import { objectIdsSchema } from './impact';
import { checkConsent, sameIds } from './consent';
import { DeletePlanSchema, DeleteReportSchema } from '../../contracts/governance';

export const deletePlanSchema = DeletePlanSchema.refine((plan) => new Set(plan.layers.map((layer) => layer.name)).size === plan.layers.length);
export const deletePreviewRequestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('preview'), objectIds: objectIdsSchema, baseRevision: Id }).strict(), cancelSchema]);
export const deleteExecuteRequestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('execute'), plan: deletePlanSchema, approval: ApprovalSchema }).strict(), cancelSchema]);
export const deleteVerifyRequestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('verify'), objectIds: objectIdsSchema, planId: Id.optional() }).strict(), cancelSchema]);
export const deletionLayers = [
  { name: 'worktree', label: '当前工作树' }, { name: 'git_history', label: 'Git历史' },
  { name: 'issue', label: '原始Issue' }, { name: 'index', label: '语义索引' },
  { name: 'cache', label: '缓存' }, { name: 'backup', label: '备份' }, { name: 'shared_copies', label: '分享副本' },
] as const;
const reviewPrivateLayer = {
  label: '审核题、作答与答案暴露记录',
  consequence: '清理关联审核题（含标准答案与提示）、作答正文和答案暴露记录的行内状态；最小原操作回执继续保留。导入源文件、SQLite 页/WAL、备份的物理清除未核验。应用检索阻断不等于物理清除，普通 Git 版本恢复不能解除删除屏障。',
};
export function displayLayers(plan: DeletePlan) {
  const known = deletionLayers.map((layer) => {
    const capability = plan.layers.find((item) => item.name === layer.name);
    return { ...layer, capability: capability ? capability.capability ?? (capability.supported ? 'supported' as const : 'unsupported' as const) : 'unknown' as const,
      consequence: capability?.consequence ?? '平台未提供这一层的清理能力与残留核验。', reversible: capability?.reversible ?? null };
  });
  // Localize only the display projection; the registered plan and its approval hash stay intact.
  return [...known, ...plan.layers.filter((layer) => !deletionLayers.some((known) => known.name === layer.name)).map((layer) => ({ ...layer,
    label: layer.name === 'application' ? '应用检索阻断' : layer.name === 'private_state' ? '私有运行状态正文' : layer.name,
    ...(layer.name === 'review_private_state' ? reviewPrivateLayer : {}),
    capability: layer.capability ?? (layer.supported ? 'supported' as const : 'unsupported' as const) }))];
}
export async function validatePlan(ctx: RequestContext, plan: DeletePlan, objectIds: string[], revision: string) {
  const parsed = deletePlanSchema.safeParse(plan);
  if (!parsed.success) fail('UPSTREAM', '平台删除计划格式无效，未执行删除。', 'reload_delete_plan');
  if (plan.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '删除计划不属于当前工作区。');
  if (plan.baseRevision !== revision || !sameIds(plan.objectIds, objectIds)) fail('CONFLICT', '删除计划范围或基准版本已变化。', 'reload_delete_plan', 'preserved');
  if (await hashDeletePlan(plan) !== plan.contentHash) fail('CONFLICT', '删除计划摘要无法核验。', 'reload_delete_plan', 'preserved');
  return parsed.data;
}
export async function previewDeletion(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: { objectIds: string[]; baseRevision: string }) {
  checkBase(snapshot, input.baseRevision);
  const plan = await validatePlan(ctx, unwrap(await services.previewDelete(ctx, input.objectIds)), input.objectIds, snapshot.revision);
  return { plan, layers: displayLayers(plan), physicalDeletionComplete: false, retrievalBlocked: false,
    approvalStatus: services.approveGovernance && services.readDeletePlan && services.readDeleteReport ? 'required' as const : 'unavailable' as const, executionEnabled: false,
    warnings: ['仅生成删除计划，尚未删除或阻断检索。', 'Git回滚不等于历史物理抹除；分享副本与备份需分别核验。'] };
}
export function checkedDeleteReport(plan: DeletePlan, report: DeleteReport): DeleteReport {
  if (!DeleteReportSchema.safeParse(report).success || report.planId !== plan.id || new Set(report.layers.map((l) => l.name)).size !== report.layers.length) fail('UNKNOWN_RESULT', '删除回执不完整或无法对应计划。', 'read_delete_report', 'unknown');
  return { ...report, layers: displayLayers(plan).map((layer) => {
    const actual = report.layers.find((item) => item.name === layer.name);
    if (layer.capability === 'unsupported') return { name: layer.name, state: 'unsupported', detail: layer.consequence };
    if (layer.capability === 'unknown') return { name: layer.name, state: 'unknown', detail: layer.consequence };
    return actual ?? { name: layer.name, state: 'pending', detail: '尚未收到该层的执行及读回证据。' };
  }) };
}
export async function executeDeletion(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: Extract<z.infer<typeof deleteExecuteRequestSchema>, { action: 'execute' }>) {
  const plan = await validatePlan(ctx, input.plan, input.plan.objectIds, input.plan.baseRevision);
  checkConsent(ctx, input.approval, { purpose: 'delete', contentHash: plan.contentHash, baseRevision: plan.baseRevision, objectIds: plan.objectIds });
  // The platform must return the same stable plan until its capabilities or scope change.
  const stored = services.readDeletePlan ? unwrap(await services.readDeletePlan(ctx, plan.id)) : unwrap(await services.previewDelete(ctx, plan.objectIds));
  if (!stored) fail('CONFLICT', '原删除计划尚未登记，不能执行。', 'reload_delete_plan', 'preserved');
  const currentPlan = await validatePlan(ctx, stored, plan.objectIds, plan.baseRevision);
  if (currentPlan.id !== plan.id || currentPlan.contentHash !== plan.contentHash) fail('CONFLICT', '平台删除计划已变化，旧批准失效。', 'reload_delete_plan', 'preserved');
  const prior = services.readDeleteReport ? unwrap(await services.readDeleteReport(ctx, plan.id)) : null;
  if (!prior) checkBase(snapshot, plan.baseRevision);
  let result;
  try { result = await services.executeDelete(ctx, currentPlan, input.approval); }
  catch { fail('UNKNOWN_RESULT', '删除响应中断，保留原计划并先读取报告。', 'read_delete_report', 'unknown'); }
  const report = checkedDeleteReport(plan, unwrap(result));
  if (!report.retrievalBlocked) fail('UPSTREAM', '平台未建立检索阻断，不能报告删除成功。', 'stop_and_verify_retrieval_block', 'partial');
  let latest: KnowledgeSnapshot | undefined;
  try { latest = await readSnapshot(services, ctx); } catch { /* The completed portion must not be described as unwritten. */ }
  const retrievalVerified = !!latest && plan.objectIds.every((id) => latest.excludedIds.includes(id));
  return { planId: plan.id, report, retrievalVerified, physicalDeletionComplete: false,
    state: retrievalVerified ? 'blocked_cleanup_pending' as const : 'block_verification_pending' as const,
    checkedRevision: latest?.revision ?? null,
    warnings: ['执行回执不等于物理清理读回；未核验层继续保留。', ...(!retrievalVerified ? ['检索阻断尚未从新快照核验，不能自动重试删除。'] : [])] };
}
export async function readDeletion(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: { objectIds: string[]; planId?: string }) {
  const view = verifyDeletion(snapshot, input);
  if (!input.planId || !services.readDeletePlan || !services.readDeleteReport) return { ...view, report: null as DeleteReport | null };
  const stored = unwrap(await services.readDeletePlan(ctx, input.planId));
  if (!stored) fail('VALIDATION', '当前操作者没有这一删除计划。', 'select_registered_plan');
  if (stored.id !== input.planId) fail('UNKNOWN_RESULT', '返回的计划不是原操作，未用同对象的其他删除替代本次核验。', 'read_original_delete_plan', 'unknown');
  const plan = await validatePlan(ctx, stored, input.objectIds, stored.baseRevision);
  const value = unwrap(await services.readDeleteReport(ctx, plan.id));
  const plannedLayers = displayLayers(plan);
  if (!value) return { ...view, report: null as DeleteReport | null,
    layers: plannedLayers.map((layer) => ({ ...layer, state: 'unknown' as const, nextAction: '原计划报告尚未读回，不能认定未执行或已清理；仅按原计划ID只读核验。' })) };
  const report = checkedDeleteReport(plan, value);
  return { ...view, reportAvailable: true, report, retrievalBlocked: view.retrievalBlocked && report.retrievalBlocked,
    layers: report.layers.map((layer) => ({ ...plannedLayers.find((item) => item.name === layer.name), ...layer, nextAction: layer.detail })) };
}
export function verifyDeletion(snapshot: KnowledgeSnapshot, input: { objectIds: string[]; planId?: string }) {
  const objects = input.objectIds.map((id) => {
    const node = snapshot.nodes.find((item) => item.id === id);
    const edge = snapshot.relations.find((item) => item.id === id);
    const state = snapshot.excludedIds.includes(id) ? 'excluded'
      : node?.lifecycle === 'withdrawn' || edge?.state === 'withdrawn' ? 'withdrawn'
      : node || edge ? 'not_blocked' : 'not_present';
    return { id, state, blocked: state === 'excluded' || state === 'withdrawn' };
  });
  return { planId: input.planId ?? null, snapshotRevision: snapshot.revision, checkedAt: snapshot.generatedAt,
    objects, retrievalBlocked: objects.every((item) => item.blocked), physicalDeletionComplete: false,
    reportAvailable: false, layers: deletionLayers.map((layer) => ({ ...layer, state: 'unknown' as const, nextAction: '平台执行结果读回或人工核验' })),
    warnings: ['当前仅核验应用快照的排除/撤回状态。', '物理清理、备份与分享副本尚无独立读回证据；不要盲目重复删除。'] };
}
