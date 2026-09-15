import { z } from 'zod';
import type { RequestContext } from '../../contracts/api';
import { ApprovalRegistrationStateSchema, KnowledgeApprovalStateSchema } from '../../contracts/approval';
import { Id } from '../../contracts/domain';
import { EvidenceReceiptSchema } from '../../contracts/evidence';
import { SettingsReceiptSchema } from '../../contracts/governance';
import { SCOPES } from '../../contracts/scopes';
import type { Services } from '../../contracts/ports';
import { readDeletion, validatePlan } from './deletion';
import { fail, parse, readSnapshot, requireScope, unwrap } from './http';
import { receiptSchema } from './readback';
import { readSettingsSave } from './settings';

export const operationLookupSchema = z.object({ kind: z.enum(['knowledge', 'settings', 'delete', 'evidence', 'settings_approval', 'export_approval', 'delete_approval']), id: Id }).strict();
export type OperationLookup = z.infer<typeof operationLookupSchema>;
export const operationScope = (kind: string) => kind === 'settings' ? SCOPES.settingsRead : kind === 'settings_approval' ? SCOPES.settingsWrite
  : kind === 'export_approval' ? SCOPES.dataExport : kind === 'delete' || kind === 'delete_approval' ? SCOPES.dataDelete : kind === 'evidence' ? SCOPES.evidenceRead : SCOPES.knowledgeRead;
export async function readOperation(services: Services, ctx: RequestContext, input: OperationLookup) {
  requireScope(ctx, operationScope(input.kind));
  const base = { id: input.id, readOnly: true as const, originalPayloadAvailable: false as const, absenceIsFinal: false as const };
  if (input.kind === 'settings_approval' || input.kind === 'export_approval' || input.kind === 'delete_approval') {
    if (!services.readApprovalRegistration) fail('NOT_CONFIGURED', '原治理批准登记读回未配置。', 'configure_approval_registration_reader');
    const purpose = input.kind === 'settings_approval' ? 'settings' : input.kind === 'export_approval' ? 'export' : 'delete';
    const registration = parse(ApprovalRegistrationStateSchema, unwrap(await services.readApprovalRegistration(ctx, { purpose, operationId: input.id })));
    if (registration.actorId !== ctx.actorId || registration.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '原批准登记不属于当前身份。');
    if (registration.operationId !== input.id || registration.purpose !== purpose) fail('UNKNOWN_RESULT', '登记响应无法对应原操作或用途。', 'read_original_operation', 'unknown');
    return { ...base, kind: input.kind, registration, contentVerified: false as const };
  }
  if (input.kind === 'knowledge') {
    if (!services.readKnowledgeApproval || !services.readCommit) fail('NOT_CONFIGURED', '原知识操作读回未配置。', 'configure_knowledge_readback');
    const registration = parse(KnowledgeApprovalStateSchema, unwrap(await services.readKnowledgeApproval(ctx, input.id)));
    if (registration.actorId !== ctx.actorId || registration.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '原批准登记不属于当前身份。');
    if (registration.changeSetId !== input.id) fail('UNKNOWN_RESULT', '批准登记不是请求的原操作。', 'read_original_operation', 'unknown');
    if (registration.approval && (registration.approval.actorId !== ctx.actorId || registration.approval.workspaceId !== ctx.workspaceId || registration.approval.purpose !== 'commit_knowledge')) fail('FORBIDDEN', '原登记中的批准身份或用途不匹配，未读取提交。');
    const value = unwrap(await services.readCommit(ctx, input.id));
    const receipt = value ? parse(receiptSchema, value) : null;
    if (receipt && (receipt.changeSetId !== input.id || receipt.revision === registration.approval?.baseRevision)) fail('UNKNOWN_RESULT', '提交回执无法对应原操作。', 'read_original_operation', 'unknown');
    return { ...base, kind: 'knowledge' as const, registration, contentVerified: false as const,
      commit: receipt ? { changeSetId: receipt.changeSetId, revision: receipt.revision, indexing: receipt.indexing } : null };
  }
  if (input.kind === 'evidence') {
    if (!services.readEvidenceReceipt) fail('NOT_CONFIGURED', '原证据保存回执未配置。', 'configure_evidence_receipt_reader');
    const value = unwrap(await services.readEvidenceReceipt(ctx, input.id));
    if (!value) return { ...base, kind: 'evidence' as const, state: 'not_recorded' as const, receipt: null, contentVerified: false as const };
    const receipt = parse(EvidenceReceiptSchema, value);
    if (receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '证据保存回执不属于当前身份。');
    if (receipt.operationId !== input.id) fail('UNKNOWN_RESULT', '证据回执不是请求的原保存操作。', 'read_original_operation', 'unknown');
    return { ...base, kind: 'evidence' as const, state: 'recorded' as const, receipt, contentVerified: false as const };
  }
  if (input.kind === 'settings') {
    if (!services.readSettingsReceipt) fail('NOT_CONFIGURED', '原设置回执未配置。', 'configure_settings_receipt_reader');
    const value = unwrap(await services.readSettingsReceipt(ctx, input.id));
    if (!value) return { ...base, kind: 'settings' as const, state: 'not_recorded' as const, receipt: null, result: null };
    const receipt = parse(SettingsReceiptSchema, value);
    if (receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) fail('FORBIDDEN', '设置回执不属于当前身份。');
    if (receipt.approvalId !== input.id) fail('UNKNOWN_RESULT', '设置回执不是请求的原批准。', 'read_original_operation', 'unknown');
    const result = await readSettingsSave(services, ctx, await readSnapshot(services, ctx), { action: 'verify', approvalId: input.id, contentHash: receipt.contentHash, baseRevision: receipt.baseRevision, expectedSettingsRevision: receipt.previousRevision });
    return { ...base, kind: 'settings' as const, state: result.state, receipt: result.receipt, result };
  }
  if (!services.readDeletePlan || !services.readDeleteReport) fail('NOT_CONFIGURED', '原删除计划和独立报告未配置。', 'configure_delete_reader');
  const stored = unwrap(await services.readDeletePlan(ctx, input.id));
  if (!stored) return { ...base, kind: 'delete' as const, plan: null, result: null };
  if (stored.id !== input.id) fail('UNKNOWN_RESULT', '删除计划不是请求的原操作。', 'read_original_delete_plan', 'unknown');
  const plan = await validatePlan(ctx, stored, stored.objectIds, stored.baseRevision);
  const result = await readDeletion(services, ctx, await readSnapshot(services, ctx), { planId: input.id, objectIds: plan.objectIds });
  return { ...base, kind: 'delete' as const, plan, result };
}
export type OperationInspection = Awaited<ReturnType<typeof readOperation>>;
