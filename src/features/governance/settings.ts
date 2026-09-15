import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { ApprovalSchema, Id, type KnowledgeSnapshot } from '../../contracts/domain';
import { hashSettings } from '../../contracts/hash';
import type { Services } from '../../contracts/ports';
import { cancelSchema, checkBase, fail, parse, unwrap } from './http';
import { checkConsent } from './consent';
import { SettingsSchema, SettingsReceiptSchema } from '../../contracts/governance';

export const settingsSchema = SettingsSchema;
const settingsVersion = z.number().int().nonnegative();
export const settingsVerifySchema = z.discriminatedUnion('action', [z.object({ action: z.literal('verify'), approvalId: Id, baseRevision: Id, contentHash: Id, expectedSettingsRevision: settingsVersion }).strict(), cancelSchema]);
export const settingsRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), baseRevision: Id, expectedSettingsHash: Id, expectedSettingsRevision: settingsVersion.optional(), patch: settingsSchema.partial().refine((p) => Object.keys(p).length > 0) }).strict(),
  z.object({ action: z.literal('execute'), baseRevision: Id, expectedSettingsHash: Id, expectedSettingsRevision: settingsVersion.optional(), settings: settingsSchema, approval: ApprovalSchema }).strict(), cancelSchema,
]);
export async function settingsStatus(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot) {
  const state = services.settingsState ? parse(z.object({ settings: settingsSchema, revision: settingsVersion }).strict(), unwrap(await services.settingsState(ctx))) : null;
  const settings = state?.settings ?? parse(settingsSchema, unwrap(await services.settings(ctx)));
  return { settings, settingsRevision: state?.revision ?? null, baseRevision: snapshot.revision, currentHash: await hashSettings(ctx.workspaceId, snapshot.revision, settings),
    approvalStatus: services.approveGovernance && state ? 'required' as const : 'unavailable' as const };
}
export async function readSettingsSave(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: Extract<z.infer<typeof settingsVerifySchema>, { action: 'verify' }>) {
  if (!services.readSettingsReceipt) fail('NOT_CONFIGURED', '平台尚未提供按原批准读取设置回执的能力。', 'configure_settings_receipt_reader');
  const value = unwrap(await services.readSettingsReceipt(ctx, input.approvalId));
  if (!value) return { state: 'not_recorded' as const, receipt: null, current: null, currentMatchesSaved: false };
  const parsed = SettingsReceiptSchema.safeParse(value);
  if (!parsed.success) fail('UNKNOWN_RESULT', '设置回执格式无效，原操作保留。', 'read_settings_receipt', 'unknown');
  const receipt = parsed.data;
  if (receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '设置回执不属于当前操作者和工作区。');
  if (receipt.approvalId !== input.approvalId || receipt.baseRevision !== input.baseRevision || receipt.contentHash !== input.contentHash
    || receipt.previousRevision !== input.expectedSettingsRevision || await hashSettings(ctx.workspaceId, receipt.baseRevision, receipt.settings) !== input.contentHash) fail('UNKNOWN_RESULT', '设置回执不能对应原批准和目标内容，未替换原操作。', 'read_settings_receipt', 'unknown');
  const current = await settingsStatus(services, ctx, snapshot);
  if (current.settingsRevision === null || current.settingsRevision < receipt.revision) fail('UNKNOWN_RESULT', '当前设置版本早于已保存回执，需再次读回。', 'read_settings_receipt', 'unknown');
  const sameValue = await hashSettings(ctx.workspaceId, receipt.baseRevision, current.settings) === receipt.contentHash;
  if (current.settingsRevision === receipt.revision && !sameValue) fail('UNKNOWN_RESULT', '当前设置与同版本回执不一致。', 'read_settings_receipt', 'unknown');
  return { state: 'verified' as const, receipt, current, currentMatchesSaved: current.settingsRevision === receipt.revision && sameValue };
}
export async function changeSettings(services: Services, ctx: RequestContext, snapshot: KnowledgeSnapshot, input: Exclude<z.infer<typeof settingsRequestSchema>, { action: 'cancel' }>) {
  checkBase(snapshot, input.baseRevision);
  const current = await settingsStatus(services, ctx, snapshot);
  if (current.settingsRevision !== null && input.expectedSettingsRevision === undefined) fail('VALIDATION', '缺少独立设置版本，请重新读取设置。');
  if ((input.action === 'preview' || current.settingsRevision === null) && (current.currentHash !== input.expectedSettingsHash
    || (current.settingsRevision !== null && current.settingsRevision !== input.expectedSettingsRevision))) fail('CONFLICT', '设置已在另一处修改，未覆盖当前设置。', 'reload_settings_and_preview', 'preserved');
  const settings = input.action === 'preview' ? { ...current.settings, ...input.patch } : input.settings;
  const changedKeys = (Object.keys(settings) as (keyof typeof settings)[]).filter((key) => settings[key] !== current.settings[key]);
  if (!changedKeys.length && input.action === 'preview') fail('VALIDATION', '设置没有变化。');
  const contentHash = await hashSettings(ctx.workspaceId, snapshot.revision, settings);
  const preview = { before: current.settings, settings, changedKeys, contentHash, baseRevision: snapshot.revision, expectedSettingsHash: current.currentHash,
    expectedSettingsRevision: current.settingsRevision, objectIds: [ctx.workspaceId], approvalStatus: current.approvalStatus, executionEnabled: false,
    warnings: ['开关影响后续操作；关闭不会删除已有文本、关系或版本。', '关闭查询历史不等于删除此前记录。', '服务端模型端口必须再次检查开关，已发出的请求不能保证撤回。'] };
  if (input.action === 'preview') return preview;
  checkConsent(ctx, input.approval, { purpose: 'settings', contentHash, baseRevision: snapshot.revision, objectIds: [ctx.workspaceId] });
  let savedResult;
  try { savedResult = await services.saveSettings(ctx, settings, input.approval); }
  catch { fail('UNKNOWN_RESULT', '设置保存响应中断，保留原批准并先读回。', 'reload_settings_before_retry', 'unknown'); }
  const saved = unwrap(savedResult);
  let readback;
  try { readback = await settingsStatus(services, ctx, snapshot); }
  catch { fail('UNKNOWN_RESULT', '设置保存后读回未完成，不能声称开关已生效。', 'reload_settings_before_retry', 'unknown'); }
  if (readback.currentHash !== contentHash || await hashSettings(ctx.workspaceId, snapshot.revision, saved) !== contentHash
    || (readback.settingsRevision !== null && readback.settingsRevision !== input.expectedSettingsRevision! + 1)) fail('UNKNOWN_RESULT', '保存回执与实际设置不一致，请读回核验。', 'reload_settings_before_retry', 'unknown');
  return { ...readback, verified: true, modelEnforcementVerified: false };
}
