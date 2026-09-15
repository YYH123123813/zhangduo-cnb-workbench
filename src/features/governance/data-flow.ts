import { z } from 'zod';
import { GovernanceApprovalRequestSchema, type SettingsReceipt } from '../../contracts/governance';
import { ApprovalRegistrationStateSchema } from '../../contracts/approval';
import { contentHash } from '../../contracts/hash';
import { ApprovalFlow, post, type ApprovalState, type RequestApi } from './approval-flow';
import type { changeSettings, settingsStatus, readSettingsSave } from './settings';
import type { exportPreview } from './export';
import type { previewDeletion, readDeletion } from './deletion';
import type { demoPreview } from './demo';
import { DemoExportRecoverySchema, DemoExportReceiptSchema, DemoExportRequestSchema } from '../../contracts/demo-export';
import { OperationRecoverySchema } from '../../contracts/operation-recovery';
import type { ApiResponse } from '../../contracts/api';

export type SettingsPreview = Extract<Awaited<ReturnType<typeof changeSettings>>, { contentHash: string }>;
export type SettingsData = Awaited<ReturnType<typeof settingsStatus>>;
export type DeleteVerification = Awaited<ReturnType<typeof readDeletion>>;
export type DemoPreview = Awaited<ReturnType<typeof demoPreview>>;
export type DataAction = { workspaceId: string } & (
  { kind: 'settings'; preview: SettingsPreview } | { kind: 'export'; preview: Awaited<ReturnType<typeof exportPreview>> } | { kind: 'delete'; preview: Awaited<ReturnType<typeof previewDeletion>> }
  | { kind: 'demo'; preview: DemoPreview }
);
export const exportBundleSchema = z.object({ files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1), limitations: z.array(z.string()) });
export type DataResult = { kind: 'settings'; value: SettingsData; receipt: SettingsReceipt; currentMatchesSaved: boolean } | { kind: 'delete'; value: DeleteVerification } | { kind: 'export'; value: z.infer<typeof exportBundleSchema> } | { kind: 'demo'; value: z.infer<typeof DemoExportReceiptSchema> };
type PreparedDataAction = DataAction & { operationId: string };
export type DataState = ApprovalState<PreparedDataAction, DataResult>;
export function dataApprovalRequest(p: PreparedDataAction) {
  const identity = { operationId: p.operationId, confirmed: true as const };
  if (p.kind === 'demo') return DemoExportRequestSchema.parse({ ...p.preview.request, operationId: p.operationId, confirmed: true });
  return GovernanceApprovalRequestSchema.parse(p.kind === 'delete' ? { ...identity, purpose: 'delete', planId: p.preview.plan.id }
    : p.kind === 'export' ? { ...identity, purpose: 'export', objectIds: p.preview.objectIds, baseRevision: p.preview.baseRevision }
      : { ...identity, purpose: 'settings', settings: p.preview.settings, baseRevision: p.preview.baseRevision, expectedSettingsHash: p.preview.expectedSettingsHash, expectedSettingsRevision: p.preview.expectedSettingsRevision });
}
export function dataBinding(p: DataAction) {
  if (p.kind === 'demo') return { purpose: 'demo_export' as const, workspaceId: p.workspaceId, contentHash: p.preview.contentHash,
    baseRevision: p.preview.request.baseRevision, objectIds: p.preview.request.items.map((item) => item.nodeId) };
  const value = p.kind === 'delete' ? p.preview.plan : p.preview;
  return { purpose: p.kind, workspaceId: p.workspaceId, contentHash: value.contentHash, baseRevision: value.baseRevision, objectIds: value.objectIds };
}
export class DataFlow extends ApprovalFlow<PreparedDataAction, DataResult> {
  override prepare(action: DataAction, actorId: string) {
    if (this.locked || this.getSnapshot().approval || this.getSnapshot().stage === 'succeeded') return false;
    return super.prepare({ ...action, operationId: action.kind === 'demo' ? action.preview.request.operationId : crypto.randomUUID() }, actorId);
  }
  constructor(request: RequestApi) {
    super(request, {
      binding: dataBinding,
      available: (p) => p.preview.approvalStatus !== 'unavailable' && (p.kind !== 'settings' || p.preview.expectedSettingsRevision !== null)
        && (p.kind !== 'demo' || p.preview.executionEnabled),
      verifyAfterUnknown: (p) => p.kind === 'demo',
      approve: (p) => p.kind === 'demo' ? ['/api/workspace/approvals/demo-export', post(dataApprovalRequest(p))]
        : ['/api/workspace/approvals/governance', post(dataApprovalRequest(p))],
      recoverApproval: async (api, p) => {
        const purpose = p.kind === 'demo' ? 'demo_export' : p.kind;
        const response = await api(`/api/workspace/approval-registrations/${purpose}/${encodeURIComponent(p.operationId)}`);
        if (!response.ok) return response;
        const checked = ApprovalRegistrationStateSchema.safeParse(response.data);
        if (!checked.success || checked.data.operationId !== p.operationId || checked.data.purpose !== purpose
          || checked.data.approval && checked.data.requestHash !== await contentHash(dataApprovalRequest(p))) return { ...response, data: null };
        return { ...response, data: checked.data };
      },
      execute: (p, approval) => p.kind === 'demo' ? ['/api/workspace/demo-exports', post({ ...dataApprovalRequest(p), approval })]
        : p.kind === 'delete' ? ['/api/governance/delete/execute', post({ action: 'execute', plan: p.preview.plan, approval })]
        : p.kind === 'export' ? ['/api/governance/export', post({ action: 'execute', objectIds: p.preview.objectIds, baseRevision: p.preview.baseRevision, approval })]
          : ['/api/governance/settings', { ...post({ action: 'execute', settings: p.preview.settings, baseRevision: p.preview.baseRevision, expectedSettingsHash: p.preview.expectedSettingsHash, expectedSettingsRevision: p.preview.expectedSettingsRevision, approval }), method: 'PATCH' }],
      verify: async (api, p, approval, executionResponse) => {
        if (p.kind === 'demo') return verifyDemoExport(api, p, approval);
        if (p.kind === 'settings') {
          const checked = await api('/api/governance/settings/verify', post({ action: 'verify', approvalId: approval.id, baseRevision: p.preview.baseRevision, contentHash: p.preview.contentHash, expectedSettingsRevision: p.preview.expectedSettingsRevision }));
          if (checked.ok) {
            const verified = checked.data as Awaited<ReturnType<typeof readSettingsSave>> | null;
            return { ...checked, data: verified?.state === 'verified' && verified.receipt.approvalId === approval.id && verified.current
              ? { kind: 'settings' as const, value: verified.current, receipt: verified.receipt, currentMatchesSaved: verified.currentMatchesSaved } : null };
          }
          return checked;
        }
        if (p.kind === 'delete') {
          const response = await api('/api/governance/delete/verify', post({ action: 'verify', objectIds: p.preview.plan.objectIds, planId: p.preview.plan.id }));
          if (!response.ok) return response;
          const value = response.data as DeleteVerification | null;
          return { ...response, data: value?.reportAvailable && value.retrievalBlocked && value.report?.planId === p.preview.plan.id ? { kind: 'delete' as const, value } : null };
        }
        // Ordinary export has no durable file receipt reader. Losing its response must never replay execution.
        if (!executionResponse) throw new Error('Original export response unavailable');
        const response = executionResponse;
        if (!response.ok) return response;
        const files = exportBundleSchema.safeParse(response.data);
        return { ...response, data: files.success ? { kind: 'export' as const, value: files.data } : null };
      },
    });
  }
}

const unknownDemo = (response: ApiResponse<unknown>, message: string): ApiResponse<never> => ({ ...response, ok: false,
  error: { code: 'UNKNOWN_RESULT', message, dataState: 'unknown', retryable: false, nextAction: 'read_demo_export' } });
const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => id === right[index]);

async function verifyDemoExport(api: RequestApi, prepared: PreparedDataAction, approval: import('../../contracts/domain').Approval): Promise<ApiResponse<DataResult | null>> {
  if (prepared.kind !== 'demo') return unknownDemo({ ok: true, data: null, meta: { requestId: 'invalid', mode: 'unconfigured', contractVersion: 'unknown' } }, '演示导出操作类型不匹配。');
  const expected = prepared.preview;
  const recoveryResponse = await api(`/api/workspace/operation-recovery/demo_export/${encodeURIComponent(prepared.operationId)}`);
  if (!recoveryResponse.ok) return recoveryResponse;
  const recovery = OperationRecoverySchema.safeParse(recoveryResponse.data);
  const objectIds = expected.request.items.map((item) => item.nodeId);
  if (!recovery.success || recovery.data.kind !== 'demo_export' || recovery.data.operationId !== prepared.operationId
    || recovery.data.actorId !== approval.actorId || recovery.data.workspaceId !== prepared.workspaceId || recovery.data.purpose !== 'demo_export'
    || recovery.data.requestHash !== expected.requestHash || recovery.data.contentHash !== expected.contentHash
    || recovery.data.baseRevision !== expected.request.baseRevision || !sameIds(recovery.data.objectIds, objectIds)
    || recovery.data.approvalId !== approval.id || recovery.data.stage !== 'executed' || recovery.data.readOnly !== true || recovery.data.absenceIsFinal !== false)
    return unknownDemo(recoveryResponse, '演示导出原操作元数据无法对应本次请求，未读取或下载副本。');

  const readback = await api(`/api/workspace/demo-exports/${encodeURIComponent(prepared.operationId)}`);
  if (!readback.ok) return readback;
  const parsed = DemoExportRecoverySchema.safeParse(readback.data);
  const receipt = parsed.success && parsed.data.status === 'executed' ? DemoExportReceiptSchema.safeParse(parsed.data.receipt) : null;
  if (!parsed.success || parsed.data.operationId !== prepared.operationId || parsed.data.actorId !== approval.actorId || parsed.data.workspaceId !== prepared.workspaceId
    || parsed.data.status !== 'executed' || parsed.data.requestHash !== expected.requestHash || parsed.data.approval?.id !== approval.id
    || !receipt?.success || receipt.data.operationId !== prepared.operationId || receipt.data.approvalId !== approval.id
    || receipt.data.actorId !== approval.actorId || receipt.data.workspaceId !== prepared.workspaceId || receipt.data.baseRevision !== expected.request.baseRevision
    || receipt.data.requestHash !== expected.requestHash || receipt.data.contentHash !== expected.contentHash || !sameIds(receipt.data.objectIds, objectIds)
    || receipt.data.destination !== 'local_download' || receipt.data.published !== false
    || receipt.data.authorizationBinding.purpose !== 'demo_export' || receipt.data.authorizationBinding.operationId !== prepared.operationId
    || receipt.data.authorizationBinding.actorId !== approval.actorId || receipt.data.authorizationBinding.workspaceId !== prepared.workspaceId
    || receipt.data.authorizationBinding.baseRevision !== expected.request.baseRevision || receipt.data.authorizationBinding.destination !== 'local_download'
    || receipt.data.authorizationBinding.requestHash !== expected.requestHash || receipt.data.authorizationBinding.contentHash !== expected.contentHash
    || !sameIds(receipt.data.authorizationBinding.objectIds, objectIds)
    || receipt.data.files.length !== expected.files.length || receipt.data.files.some((file, index) => file.path !== expected.files[index]?.path || file.content !== expected.files[index]?.content)
    || !receipt.data.files.some((file) => file.path === 'manifest.json' && file.content.includes('"published": false')))
    return unknownDemo(readback, '演示导出回执、文件字节或发布状态无法核验，未显示为成功。');
  return { ...readback, data: { kind: 'demo', value: receipt.data } };
}
