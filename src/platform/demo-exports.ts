import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { ApprovalSchema, Id, type Approval, type KnowledgeSnapshot } from '../contracts/domain';
import { canonicalJson, contentHash } from '../contracts/hash';
import {
  DemoExportAuthorizationBindingSchema,
  DemoExportExecutionRequestSchema,
  DemoExportReceiptSchema,
  DemoExportRecoverySchema,
  DemoExportRequestSchema,
  type DemoExportAuthorizationBinding,
  type DemoExportExecutionRequest,
  type DemoExportReceipt,
  type DemoExportRecovery,
  type DemoExportRequest,
} from '../contracts/demo-export';
import type { ApprovalRegistrationState } from '../contracts/approval';
import type { OperationJournal } from './journal';
import type { SessionRegistry } from './identity';
import type { ApprovalAuthority } from './approvals';
import { applyDeletionBarrier } from './governance';
import { failure } from './result';

const DemoExportReceiptRecordSchema = z.object({ receipt: DemoExportReceiptSchema }).strict();
const limitations = [
  '仅包含用户明确填写的脱敏演示文案，不包含原始Issue、对话、账号、仓库标识或私人来源摘录。',
  '副本只生成到本次本地下载响应，不代表公开、部署、仓库可见性变更或评委访问已完成。',
];

type SnapshotPort = (ctx: RequestContext, revision?: string) => Promise<Result<KnowledgeSnapshot>>;

export class DemoExportStore {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly journal: OperationJournal,
    private readonly approvals: ApprovalAuthority,
    private readonly snapshot: SnapshotPort,
  ) {}

  private access(ctx: RequestContext, scope: string) {
    const access = this.sessions.authorize(ctx, scope);
    if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure<never>('FORBIDDEN', 'Live demo export requires durable storage', 'configure_operation_storage');
    return access;
  }

  private async material(ctx: RequestContext, input: DemoExportRequest): Promise<Result<{
    requestHash: string;
    contentHash: string;
    objectIds: string[];
    files: DemoExportReceipt['files'];
    binding: DemoExportAuthorizationBinding;
  }>> {
    const exportAccess = this.access(ctx, 'data:export');
    if (!exportAccess.ok) return exportAccess;
    const knowledgeAccess = this.sessions.authorize(ctx, 'knowledge:read');
    if (!knowledgeAccess.ok) return knowledgeAccess;

    const current = await this.snapshot(ctx);
    if (!current.ok) return current;
    if (current.data.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'Demo objects belong to another workspace', 'select_authorized_workspace');
    if (current.data.revision !== input.baseRevision) return failure('CONFLICT', 'Demo export base changed', 'preview_demo_export', 'preserved');

    // Apply the barrier before looking up selected nodes. A blocked object is never used to produce a public copy.
    const visible = applyDeletionBarrier(this.journal, ctx, current.data);
    const visibleIds = new Set(visible.nodes.map((node) => node.id));
    for (const item of input.items) {
      if (this.journal.blocked(ctx.workspaceId).includes(item.nodeId)) return failure('FORBIDDEN', 'Selected demo object is blocked by the deletion barrier', 'read_delete_report', 'preserved');
      if (!visibleIds.has(item.nodeId)) return failure('VALIDATION', 'Selected demo object is unavailable at the requested revision', 'review_demo_scope');
    }

    const objectIds = input.items.map((item) => item.nodeId);
    const entries = input.items.map((item, index) => ({
      id: `demo-node-${index + 1}`,
      objectId: item.nodeId,
      title: item.publicTitle,
      statement: item.publicStatement,
      conditions: item.publicConditions,
      sourceLabels: item.publicSourceLabels,
      modelDeclaration: input.modelDeclaration,
    }));
    const manifest = {
      format: 'governance-demo-export-v1',
      modelDeclaration: input.modelDeclaration,
      destination: input.destination,
      generatedMaterial: 'user_supplied_redacted_copy',
      account: 'not_included',
      workspace: 'not_included',
      originalConversation: 'not_included',
      privateSources: 'not_included',
      published: false,
    };
    const files = [
      { path: 'demo/knowledge.json', content: JSON.stringify(entries, null, 2) },
      { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
    ];
    const requestHash = await contentHash(input);
    const materialHash = await contentHash({
      purpose: 'demo_export', destination: input.destination, baseRevision: input.baseRevision,
      objectIds, items: input.items, modelDeclaration: input.modelDeclaration, files,
    });
    const binding = DemoExportAuthorizationBindingSchema.parse({
      purpose: 'demo_export', destination: input.destination, operationId: input.operationId,
      actorId: ctx.actorId, workspaceId: ctx.workspaceId, baseRevision: input.baseRevision,
      objectIds, requestHash, contentHash: materialHash,
    });
    return { ok: true, data: { requestHash, contentHash: materialHash, objectIds, files, binding } };
  }

  async approve(ctx: RequestContext, supplied: unknown): Promise<Result<Approval>> {
    const parsed = DemoExportRequestSchema.safeParse(supplied);
    if (!parsed.success) return failure('VALIDATION', 'A strict demo export scope and explicit confirmation are required', 'preview_demo_export');
    const input = parsed.data;
    const material = await this.material(ctx, input);
    if (!material.ok) return material;
    const previous = this.approvals.previousRegistration(ctx, 'demo_export', { operationId: input.operationId, requestHash: material.data.requestHash });
    if (!previous.ok) return previous;
    if (previous.data) return { ok: true, data: previous.data };
    const stillAuthorized = this.access(ctx, 'data:export');
    if (!stillAuthorized.ok) return stillAuthorized;
    return this.approvals.registerOperation(ctx, {
      purpose: 'demo_export', objectIds: material.data.objectIds,
      contentHash: material.data.contentHash, baseRevision: input.baseRevision,
    }, { operationId: input.operationId, requestHash: material.data.requestHash });
  }

  private readReceipt(ctx: RequestContext, operationId: string): Result<DemoExportReceipt | null> {
    if (!Id.safeParse(operationId).success) return failure('VALIDATION', 'A valid original demo export operation ID is required', 'read_demo_export');
    try {
      const stored = this.journal.record(ctx.workspaceId, ctx.actorId, 'demo_export_receipt', operationId);
      if (!stored) return { ok: true, data: null };
      const receipt = DemoExportReceiptRecordSchema.parse(stored.value).receipt;
      const approval = this.journal.approval(receipt.approvalId)?.value;
      if (!approval || receipt.operationId !== operationId || receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId
        || receipt.authorizationBinding.purpose !== 'demo_export' || receipt.authorizationBinding.destination !== receipt.destination
        || receipt.authorizationBinding.operationId !== receipt.operationId || receipt.authorizationBinding.actorId !== receipt.actorId
        || receipt.authorizationBinding.workspaceId !== receipt.workspaceId || receipt.authorizationBinding.baseRevision !== receipt.baseRevision
        || canonicalJson(receipt.authorizationBinding.objectIds) !== canonicalJson(receipt.objectIds)
        || receipt.authorizationBinding.requestHash !== receipt.requestHash || receipt.authorizationBinding.contentHash !== receipt.contentHash
        || new Set(receipt.objectIds).size !== receipt.objectIds.length
        || approval.actorId !== receipt.actorId || approval.workspaceId !== receipt.workspaceId || approval.purpose !== 'demo_export'
        || approval.contentHash !== receipt.contentHash || approval.baseRevision !== receipt.baseRevision
        || canonicalJson(approval.objectIds) !== canonicalJson(receipt.objectIds)) throw new Error('Demo export receipt identity mismatch');
      return { ok: true, data: receipt };
    } catch { return failure('UNKNOWN_RESULT', 'Demo export receipt could not be verified; read the same operation ID after storage repair', 'read_demo_export', 'unknown'); }
  }

  async execute(ctx: RequestContext, supplied: unknown): Promise<Result<DemoExportReceipt>> {
    const parsed = DemoExportExecutionRequestSchema.safeParse(supplied);
    if (!parsed.success) return failure('VALIDATION', 'A strict demo export request and original approval are required', 'preview_demo_export');
    const input: DemoExportExecutionRequest = parsed.data;
    const request: DemoExportRequest = {
      operationId: input.operationId, baseRevision: input.baseRevision, destination: input.destination,
      items: input.items, modelDeclaration: input.modelDeclaration, confirmed: input.confirmed,
    };
    const material = await this.material(ctx, request);
    if (!material.ok) return material;
    const approval = this.approvals.validate(ctx, 'data:export', input.approval, {
      purpose: 'demo_export', objectIds: material.data.objectIds,
      contentHash: material.data.contentHash, baseRevision: request.baseRevision,
    });
    if (!approval.ok) return approval;

    const prior = this.readReceipt(ctx, request.operationId);
    if (!prior.ok) return { ok: false, error: prior.error };
    if (prior.data) {
      if (prior.data.approvalId !== approval.data.id || prior.data.requestHash !== material.data.requestHash || prior.data.contentHash !== material.data.contentHash
        || canonicalJson(prior.data.authorizationBinding) !== canonicalJson(material.data.binding))
        return failure('CONFLICT', 'Demo export operation ID is bound to a different request or approval', 'read_demo_export', 'preserved');
      return { ok: true, data: prior.data };
    }
    if (material.data.objectIds.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return failure('FORBIDDEN', 'Selected demo object was blocked before execution', 'read_delete_report', 'preserved');

    const receipt: DemoExportReceipt = {
      operationId: request.operationId, approvalId: approval.data.id, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
      baseRevision: request.baseRevision, objectIds: material.data.objectIds, requestHash: material.data.requestHash,
      contentHash: material.data.contentHash, destination: request.destination, files: material.data.files,
      limitations, published: false, authorizationBinding: material.data.binding,
    };
    try {
      return this.journal.transaction(() => {
        const currentApproval = this.approvals.validate(ctx, 'data:export', input.approval, {
          purpose: 'demo_export', objectIds: material.data.objectIds,
          contentHash: material.data.contentHash, baseRevision: request.baseRevision,
        });
        if (!currentApproval.ok) return currentApproval;
        const existing = this.readReceipt(ctx, request.operationId);
        if (!existing.ok) return { ok: false, error: existing.error };
        if (existing.data) return { ok: true, data: existing.data };
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'demo_export_receipt', request.operationId, { receipt }, null)) throw new Error('Demo export receipt insertion failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'demo_exported', material.data.objectIds, 'generated_not_published');
        return { ok: true, data: receipt };
      });
    } catch { return failure('UNKNOWN_RESULT', 'Demo export result could not be durably recorded; read the same operation ID', 'read_demo_export', 'unknown', true); }
  }

  read(ctx: RequestContext, operationId: string): Result<DemoExportRecovery> {
    const exportAccess = this.access(ctx, 'data:export');
    if (!exportAccess.ok) return exportAccess;
    const knowledgeAccess = this.sessions.authorize(ctx, 'knowledge:read');
    if (!knowledgeAccess.ok) return knowledgeAccess;
    if (!Id.safeParse(operationId).success) return failure('VALIDATION', 'A valid original demo export operation ID is required', 'read_demo_export');
    const state = (status: DemoExportRecovery['status'], approval: Approval | null = null, requestHash: string | null = null, receipt: DemoExportReceipt | null = null): Result<DemoExportRecovery> => ({
      ok: true,
      data: DemoExportRecoverySchema.parse({ operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, status, approval, requestHash, receipt, absenceIsFinal: false }),
    });
    try {
      const registration = this.approvals.readRegistration(ctx, { purpose: 'demo_export', operationId });
      if (!registration.ok) return registration;
      const receipt = this.readReceipt(ctx, operationId);
      if (!receipt.ok) return receipt;
      if (receipt.data) {
        const approval = registration.data.approval;
        if (receipt.data.objectIds.some((id) => this.journal.blocked(ctx.workspaceId).includes(id)))
          return failure('FORBIDDEN', 'Demo export is blocked by the deletion barrier; read the deletion report before continuing', 'read_delete_report', 'preserved');
        if (!approval || approval.id !== receipt.data.approvalId || registration.data.requestHash !== receipt.data.requestHash) return state('unknown');
        return state('executed', approval, receipt.data.requestHash, receipt.data);
      }
      if (registration.data.approval?.objectIds.some((id) => this.journal.blocked(ctx.workspaceId).includes(id)))
        return failure('FORBIDDEN', 'Demo export is blocked by the deletion barrier; read the deletion report before continuing', 'read_delete_report', 'preserved');
      if (registration.data.status === 'registered') return state('approved', registration.data.approval, registration.data.requestHash);
      if (registration.data.status === 'revoked') return state('revoked', registration.data.approval, registration.data.requestHash);
      if (registration.data.status === 'expired') return state('expired', registration.data.approval, registration.data.requestHash);
      if (registration.data.status === 'unknown') return state('unknown');
      return state('not_registered');
    } catch { return state('unknown'); }
  }
}
