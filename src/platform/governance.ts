import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { Id, type Approval, type DeletePlan, type DeleteReport, type EvidenceRecord, type KnowledgeSnapshot, type Settings } from '../contracts/domain';
import { DeletePlanSchema, DeleteReportSchema, GovernanceApprovalRequestSchema, ObjectIdsSchema, SettingsSchema, SettingsReceiptSchema, type SettingsState, type SettingsReceipt } from '../contracts/governance';
import { canonicalJson, contentHash, hashDeletePlan, hashExport, hashSettings } from '../contracts/hash';
import type { OperationJournal } from './journal';
import type { SessionRegistry } from './identity';
import type { ApprovalAuthority } from './approvals';
import { failure } from './result';
import { knowledgeFiles } from './cnb/knowledge-document';
import type { EvidenceStore } from './evidence';

type SnapshotPort = (ctx: RequestContext, revision?: string) => Promise<Result<KnowledgeSnapshot>>;
const defaults: Settings = { aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false };
const conflict = <T>(): Result<T> => failure('CONFLICT', 'Settings changed after preview; current settings were preserved', 'reload_settings_and_preview', 'preserved');
const SettingsConstraintSchema = z.object({ purpose: z.literal('settings'), expectedRevision: z.number().int().nonnegative() }).strict();
const LegacySettingsReceiptSchema = z.object({ settings: SettingsSchema, revision: z.number().int().positive() }).strict();

export function applyDeletionBarrier(journal: OperationJournal, ctx: RequestContext, snapshot: KnowledgeSnapshot): KnowledgeSnapshot {
  const blocked = new Set(journal.blocked(ctx.workspaceId));
  const hiddenEdges = new Set(snapshot.relations.filter((edge) => blocked.has(edge.id) || blocked.has(edge.source.objectId) || blocked.has(edge.target.objectId)).map((edge) => edge.id));
  return { ...snapshot, nodes: snapshot.nodes.filter((node) => !blocked.has(node.id)), relations: snapshot.relations.filter((edge) => !hiddenEdges.has(edge.id)),
    excludedIds: [...new Set([...snapshot.excludedIds, ...blocked, ...hiddenEdges])] };
}

export class GovernanceStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly approvals: ApprovalAuthority, private readonly snapshot: SnapshotPort,
    private readonly evidence?: Pick<EvidenceStore, 'list' | 'eraseSelected'>) {}

  private access(ctx: RequestContext, scope: string) {
    const access = this.sessions.authorize(ctx, scope);
    if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure<never>('FORBIDDEN', 'Live governance requires durable storage', 'configure_operation_storage');
    return access;
  }

  private currentSettings(workspace: string): SettingsState {
    const stored = this.journal.record(workspace, '@workspace', 'settings', workspace);
    return { settings: stored ? SettingsSchema.parse(stored.value) : { ...defaults }, revision: stored?.version ?? 0 };
  }

  settingsState(ctx: RequestContext): Result<SettingsState> {
    const access = this.access(ctx, 'settings:read');
    if (!access.ok) return access;
    try { return { ok: true, data: this.currentSettings(ctx.workspaceId) }; }
    catch { return failure('INTERNAL', 'Stored settings cannot be verified', 'repair_settings_storage'); }
  }

  private checkedSettingsReceipt(approval: Approval, value: unknown): SettingsReceipt {
    const constraint = SettingsConstraintSchema.parse(this.journal.record(approval.workspaceId, approval.actorId, 'approval_constraint', approval.id)?.value);
    const parsed = z.union([SettingsReceiptSchema, LegacySettingsReceiptSchema]).parse(value);
    const receipt = SettingsReceiptSchema.parse('approvalId' in parsed ? parsed : {
      ...parsed, approvalId: approval.id, actorId: approval.actorId, workspaceId: approval.workspaceId,
      contentHash: approval.contentHash, baseRevision: approval.baseRevision, previousRevision: constraint.expectedRevision, outcome: 'saved',
    });
    if (receipt.approvalId !== approval.id || receipt.actorId !== approval.actorId || receipt.workspaceId !== approval.workspaceId
      || receipt.contentHash !== approval.contentHash || receipt.baseRevision !== approval.baseRevision || receipt.previousRevision !== constraint.expectedRevision) throw new Error('Settings receipt identity mismatch');
    return receipt;
  }

  async readSettingsReceipt(ctx: RequestContext, approvalId: string): Promise<Result<SettingsReceipt | null>> {
    const access = this.access(ctx, 'settings:read'); if (!access.ok) return access;
    if (!Id.safeParse(approvalId).success) return failure('VALIDATION', 'A valid original approval ID is required', 'read_settings_receipt');
    try {
      const registered = this.journal.approval(approvalId);
      if (!registered) return { ok: true, data: null };
      const approval = registered.value;
      if (approval.actorId !== ctx.actorId || approval.workspaceId !== ctx.workspaceId || approval.purpose !== 'settings') return failure('FORBIDDEN', 'Settings operation is unavailable to this identity', 'select_authorized_workspace');
      const stored = this.journal.record(ctx.workspaceId, ctx.actorId, 'settings_receipt', approvalId);
      if (!stored) return { ok: true, data: null };
      // Revocation stops new writes; it does not erase a previously committed operation.
      const receipt = this.checkedSettingsReceipt(approval, stored.value);
      if (await hashSettings(ctx.workspaceId, receipt.baseRevision, receipt.settings) !== receipt.contentHash) throw new Error('Settings receipt digest mismatch');
      const stillAuthorized = this.access(ctx, 'settings:read'); if (!stillAuthorized.ok) return stillAuthorized;
      return { ok: true, data: receipt };
    } catch { return failure('INTERNAL', 'Stored settings operation could not be verified', 'repair_settings_storage', 'preserved'); }
  }

  async approve(ctx: RequestContext, input: unknown): Promise<Result<Approval>> {
    const parsed = GovernanceApprovalRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Explicit confirmation of a valid governance preview is required', 'preview_and_confirm');
    const request = parsed.data;
    const scope = request.purpose === 'settings' ? 'settings:write' : request.purpose === 'export' ? 'data:export' : 'data:delete';
    const access = this.access(ctx, scope);
    if (!access.ok) return access;
    const registration = { operationId: request.operationId, requestHash: await contentHash(request) };
    const previous = this.approvals.previousRegistration(ctx, request.purpose, registration);
    if (!previous.ok) return previous;
    if (previous.data) return { ok: true, data: previous.data };
    if (request.purpose === 'export') {
      const selection = await this.exportSelection(ctx, request.objectIds, request.baseRevision);
      if (!selection.ok) return selection;
      return this.approvals.registerOperation(ctx, { purpose: 'export', objectIds: request.objectIds, baseRevision: request.baseRevision, contentHash: await hashExport(ctx.workspaceId, request.baseRevision, request.objectIds) }, registration);
    }
    if (request.purpose === 'delete') {
      const stored = this.readDeletePlan(ctx, request.planId);
      if (!stored.ok) return stored;
      if (!stored.data) return failure('VALIDATION', 'The deletion plan is not registered', 'preview_delete');
      const current = await this.snapshot(ctx);
      if (!current.ok) return current;
      if (current.data.revision !== stored.data.baseRevision) return failure('CONFLICT', 'The deletion base changed', 'preview_delete', 'preserved');
      return this.approvals.registerOperation(ctx, { purpose: 'delete', contentHash: stored.data.contentHash, objectIds: stored.data.objectIds, baseRevision: stored.data.baseRevision }, registration);
    }
    const current = this.settingsState(ctx);
    if (!current.ok) return current;
    const snapshot = await this.snapshot(ctx);
    if (!snapshot.ok) return snapshot;
    if (snapshot.data.revision !== request.baseRevision || current.data.revision !== request.expectedSettingsRevision
      || await hashSettings(ctx.workspaceId, request.baseRevision, current.data.settings) !== request.expectedSettingsHash) return conflict();
    const targetHash = await hashSettings(ctx.workspaceId, request.baseRevision, request.settings);
    return this.approvals.registerOperation(ctx, { purpose: 'settings', contentHash: targetHash, baseRevision: request.baseRevision, objectIds: [ctx.workspaceId] }, {
      ...registration, constraint: { kind: 'approval_constraint', value: { purpose: 'settings', expectedRevision: request.expectedSettingsRevision } },
      beforeRegister: () => this.currentSettings(ctx.workspaceId).revision !== request.expectedSettingsRevision ? conflict() : { ok: true, data: true },
    });
  }

  async saveSettings(ctx: RequestContext, input: Settings, approval: Approval): Promise<Result<Settings>> {
    const access = this.access(ctx, 'settings:write');
    if (!access.ok) return access;
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Invalid settings', 'preview_and_confirm');
    const contentHash = await hashSettings(ctx.workspaceId, approval.baseRevision, parsed.data);
    const expected = { purpose: 'settings' as const, contentHash, baseRevision: approval.baseRevision, objectIds: [ctx.workspaceId] };
    const valid = this.approvals.validate(ctx, 'settings:write', approval, expected);
    if (!valid.ok) return valid;
    const snapshot = await this.snapshot(ctx);
    if (!snapshot.ok) return snapshot;
    if (snapshot.data.revision !== approval.baseRevision) return conflict();
    try {
      return this.journal.transaction(() => {
        const currentApproval = this.approvals.validate(ctx, 'settings:write', approval, expected);
        if (!currentApproval.ok) return currentApproval;
        const current = this.currentSettings(ctx.workspaceId);
        const receipt = this.journal.record(ctx.workspaceId, ctx.actorId, 'settings_receipt', approval.id);
        if (receipt) {
          const saved = this.checkedSettingsReceipt(approval, receipt.value);
          if (canonicalJson(saved.settings) !== canonicalJson(parsed.data)) throw new Error('Settings receipt target mismatch');
          return current.revision === saved.revision ? { ok: true, data: saved.settings } : conflict<Settings>();
        }
        const constraint = SettingsConstraintSchema.safeParse(this.journal.record(ctx.workspaceId, ctx.actorId, 'approval_constraint', approval.id)?.value);
        if (!constraint.success || constraint.data.expectedRevision !== current.revision) return conflict<Settings>();
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'settings', ctx.workspaceId, parsed.data, current.revision || null)) return conflict<Settings>();
        const saved: SettingsReceipt = { approvalId: approval.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, contentHash, baseRevision: approval.baseRevision,
          settings: parsed.data, previousRevision: current.revision, revision: current.revision + 1, outcome: 'saved' };
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'settings_receipt', approval.id, saved, null)) throw new Error('Settings receipt was not atomically inserted');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'settings_saved', [ctx.workspaceId], 'done', { kind: 'settings', id: approval.id });
        return { ok: true, data: parsed.data };
      });
    } catch { return failure('INTERNAL', 'Settings transaction failed without committing changes', 'check_operation_storage', 'preserved'); }
  }

  audit(ctx: RequestContext) {
    const access = this.access(ctx, 'audit:read');
    if (!access.ok) return access;
    try { return { ok: true as const, data: this.journal.audit(ctx.workspaceId, ctx.actorId) }; }
    catch { return failure<never>('INTERNAL', 'Audit metadata could not be verified', 'check_operation_storage', 'unknown'); }
  }

  blockSnapshot(ctx: RequestContext, snapshot: KnowledgeSnapshot): KnowledgeSnapshot {
    return applyDeletionBarrier(this.journal, ctx, snapshot);
  }

  async previewDelete(ctx: RequestContext, input: string[]): Promise<Result<DeletePlan>> {
    const access = this.access(ctx, 'data:delete');
    if (!access.ok) return access;
    const parsed = ObjectIdsSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Select a nonempty unique deletion scope', 'review_delete_scope');
    const snapshot = await this.snapshot(ctx);
    if (!snapshot.ok) return snapshot;
    const known = new Set([...snapshot.data.nodes, ...snapshot.data.relations].map((object) => object.id));
    const privateIds = parsed.data.filter((id) => !known.has(id));
    if (privateIds.length) {
      const records = await this.evidence?.list(ctx);
      if (!records) return failure('NOT_IMPLEMENTED', 'Private evidence deletion requires its storage adapter', 'connect_evidence_storage');
      if (!records.ok) return records;
      if (privateIds.some((id) => !records.data.some((record) => record.id === id))) return failure('VALIDATION', 'Deletion scope includes unavailable objects; private Issues are not implicitly selected', 'review_delete_scope');
    }
    const layers: DeletePlan['layers'] = [
      { name: 'application', supported: true, capability: 'supported', reversible: false, consequence: 'Persistently blocks selected objects and incident relations from application retrieval, history and export. Ordinary restore cannot remove this block.' },
      { name: 'review_private_state', supported: true, capability: 'supported', reversible: false,
        consequence: 'Clears private reviewed questions, attempts and exposure records referencing the selected knowledge. Minimal original receipts remain. SQLite pages, WAL, import source files and backup copies are not proven erased.' },
      { name: 'worktree', supported: false, capability: 'unsupported', reversible: false, consequence: 'This adapter does not physically remove Git files. Existing files remain until a separately authorized cleanup.' },
      ...['git_history', 'issue', 'index', 'cache', 'backup', 'shared_copies'].map((name) => ({ name, supported: false, capability: 'unknown' as const, reversible: false, consequence: 'Physical cleanup and residual copies have not been verified for this layer. No deletion request will be sent.' })),
      ...(privateIds.length ? [{ name: 'private_state', supported: true, capability: 'supported' as const, reversible: false,
        consequence: 'Clears only the explicitly selected evidence row payloads after installing their barrier. Original IDs, hashes and receipts remain; SQLite pages, WAL and backup copies are not proven erased.' }] : []),
    ];
    const objectIds = [...parsed.data].sort();
    const id = `delete:${await contentHash({ workspaceId: ctx.workspaceId, actorId: ctx.actorId, baseRevision: snapshot.data.revision, objectIds, layers })}`;
    const plan: DeletePlan = { id, workspaceId: ctx.workspaceId, objectIds, baseRevision: snapshot.data.revision, layers, contentHash: 'pending' };
    plan.contentHash = await hashDeletePlan(plan);
    const currentAccess = this.access(ctx, 'data:delete');
    if (!currentAccess.ok) return currentAccess;
    try {
      this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'delete_plan', id, plan, null);
      return this.readDeletePlan(ctx, id) as Result<DeletePlan>;
    } catch { return failure('INTERNAL', 'Deletion preview could not be registered; no retrieval block was applied', 'check_operation_storage'); }
  }

  readDeletePlan(ctx: RequestContext, id: string): Result<DeletePlan | null> {
    const access = this.access(ctx, 'data:delete');
    if (!access.ok) return access;
    try {
      const stored = this.journal.record(ctx.workspaceId, ctx.actorId, 'delete_plan', id);
      return { ok: true, data: stored ? DeletePlanSchema.parse(stored.value) : null };
    } catch { return failure('INTERNAL', 'Stored deletion plan could not be verified', 'check_operation_storage'); }
  }

  readDeleteReport(ctx: RequestContext, id: string): Result<DeleteReport | null> {
    const access = this.access(ctx, 'data:delete');
    if (!access.ok) return access;
    const plan = this.readDeletePlan(ctx, id);
    if (!plan.ok) return plan;
    if (!plan.data) return { ok: true, data: null };
    try {
      const stored = this.journal.record(ctx.workspaceId, ctx.actorId, 'delete_report', id);
      if (!stored) return { ok: true, data: null };
      const report = DeleteReportSchema.parse(stored.value);
      const blocked = new Set(this.journal.blocked(ctx.workspaceId));
      return { ok: true, data: { ...report, retrievalBlocked: plan.data.objectIds.every((objectId) => blocked.has(objectId)) } };
    } catch { return failure('INTERNAL', 'Deletion report could not be verified; previous blocks remain', 'check_operation_storage', 'unknown'); }
  }

  async executeDelete(ctx: RequestContext, input: DeletePlan, approval: Approval): Promise<Result<DeleteReport>> {
    const access = this.access(ctx, 'data:delete');
    if (!access.ok) return access;
    const parsed = DeletePlanSchema.safeParse(input);
    if (!parsed.success || parsed.data.workspaceId !== ctx.workspaceId) return failure('VALIDATION', 'Invalid deletion plan', 'preview_delete');
    const plan = parsed.data;
    const registered = this.readDeletePlan(ctx, plan.id);
    if (!registered.ok) return registered;
    if (!registered.data || canonicalJson(registered.data) !== canonicalJson(plan) || await hashDeletePlan(plan) !== plan.contentHash) return failure('CONFLICT', 'Deletion plan changed or was not registered', 'preview_delete', 'preserved');
    const expected = { purpose: 'delete' as const, objectIds: plan.objectIds, contentHash: plan.contentHash, baseRevision: plan.baseRevision };
    const valid = this.approvals.validate(ctx, 'data:delete', approval, expected);
    if (!valid.ok) return valid;
    const prior = this.readDeleteReport(ctx, plan.id);
    if (!prior.ok) return prior;
    if (prior.data) return { ok: true, data: prior.data };
    const current = await this.snapshot(ctx);
    if (!current.ok) return current;
    if (current.data.revision !== plan.baseRevision) return failure('CONFLICT', 'Deletion base changed before execution', 'preview_delete', 'preserved');
    try {
      return this.journal.transaction(() => {
        const stillValid = this.approvals.validate(ctx, 'data:delete', approval, expected);
        if (!stillValid.ok) return stillValid;
        const existing = this.readDeleteReport(ctx, plan.id);
        if (!existing.ok) return existing;
        if (existing.data) return { ok: true, data: existing.data };
        this.journal.block(ctx.workspaceId, plan.objectIds, plan.id);
        if (plan.layers.some((layer) => layer.name === 'review_private_state')) this.journal.eraseReviewPayloads(ctx.workspaceId, plan.objectIds);
        const cleanup = plan.layers.some((layer) => layer.name === 'private_state') ? this.evidence?.eraseSelected(ctx, plan.objectIds) : undefined;
        const report: DeleteReport = { planId: plan.id, retrievalBlocked: true, layers: plan.layers.map((layer) => ({ name: layer.name,
          state: ['application', 'review_private_state'].includes(layer.name) ? 'done' : layer.name === 'private_state' ? cleanup?.ok ? 'done' : 'failed' : layer.capability === 'unknown' ? 'unknown' : 'unsupported',
          detail: layer.name === 'application' ? 'Durable application retrieval barrier is active; physical copies are not claimed deleted.'
            : layer.name === 'private_state' && !cleanup?.ok ? 'Local payload cleanup did not complete. The retrieval block remains active; physical remnants are unverified.' : layer.consequence })) };
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'delete_report', plan.id, report, null)) throw Error('Deletion report was not atomically inserted');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'retrieval_blocked', plan.objectIds, 'physical_cleanup_unverified', { kind: 'delete', id: plan.id });
        return { ok: true, data: report };
      });
    } catch { return failure('INTERNAL', 'Deletion barrier transaction failed; read back the same plan before further action', 'read_delete_report', 'unknown'); }
  }

  private async exportSelection(ctx: RequestContext, ids: string[], baseRevision: string): Promise<Result<KnowledgeSnapshot & { records: EvidenceRecord[] }>> {
    const parsed = ObjectIdsSchema.safeParse(ids);
    if (!parsed.success) return failure('VALIDATION', 'Export scope must contain unique object IDs', 'review_export_scope');
    const current = await this.snapshot(ctx);
    if (!current.ok) return current;
    if (current.data.revision !== baseRevision) return failure('CONFLICT', 'Export base changed', 'preview_export', 'preserved');
    const snapshot = this.blockSnapshot(ctx, current.data);
    const nodes = snapshot.nodes.filter((node) => parsed.data.includes(node.id));
    const relations = snapshot.relations.filter((edge) => parsed.data.includes(edge.id));
    const known = new Set([...nodes, ...relations].map((object) => object.id));
    const privateIds = parsed.data.filter((id) => !known.has(id));
    let records: EvidenceRecord[] = [];
    if (privateIds.length) {
      const evidence = await this.evidence?.list(ctx);
      if (!evidence) return failure('NOT_IMPLEMENTED', 'Evidence export requires private storage', 'connect_evidence_storage');
      if (!evidence.ok) return evidence;
      records = evidence.data.filter((record) => privateIds.includes(record.id));
      if (privateIds.some((id) => !records.some((record) => record.id === id))) return failure('VALIDATION', 'Selected object is unavailable; private Issue and draft data are not implicitly included', 'review_export_scope');
      const references = records.flatMap((record) => [...record.nodeRefs.map((ref) => ref.objectId), ...record.relationRefs,
        ...(record.useContext?.knowledge.map((node) => node.id) ?? []), ...(record.useContext?.task.conditionChecks?.map((check) => check.nodeRef.objectId) ?? []),
        ...(record.outcome ? [record.outcome.useRecordId] : [])]);
      if (references.some((id) => !parsed.data.includes(id))) return failure('VALIDATION', 'Explicitly select every knowledge, relation and original-use object referenced by the evidence', 'review_export_scope');
    }
    if (relations.some((edge) => !nodes.some((node) => node.id === edge.source.objectId) || !nodes.some((node) => node.id === edge.target.objectId))) return failure('VALIDATION', 'Select both relation endpoints explicitly', 'review_export_scope');
    return { ok: true, data: { ...snapshot, nodes, relations, records, excludedIds: snapshot.excludedIds.filter((id) => parsed.data.includes(id)) } };
  }

  async exportData(ctx: RequestContext, input: string[], approval: Approval): Promise<Result<{ files: { path: string; content: string }[]; limitations: string[] }>> {
    const access = this.access(ctx, 'data:export');
    if (!access.ok) return access;
    const parsed = ObjectIdsSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Invalid export selection', 'review_export_scope');
    const ids = parsed.data;
    const expected = { purpose: 'export' as const, objectIds: ids, baseRevision: approval.baseRevision, contentHash: await hashExport(ctx.workspaceId, approval.baseRevision, ids) };
    const valid = this.approvals.validate(ctx, 'data:export', approval, expected);
    if (!valid.ok) return valid;
    const selected = await this.exportSelection(ctx, ids, approval.baseRevision);
    if (!selected.ok) return selected;
    const files = Object.entries(knowledgeFiles({ schemaVersion: 1, workspaceId: ctx.workspaceId, nodes: selected.data.nodes, relations: selected.data.relations, excludedIds: selected.data.excludedIds }))
      .map(([path, content]) => ({ path, content }));
    files.push(...selected.data.records.map((record, index) => ({ path: `evidence/${index + 1}.json`, content: canonicalJson(record) })));
    files.push({ path: 'manifest.json', content: canonicalJson({ workspaceId: ctx.workspaceId, baseRevision: approval.baseRevision, objectIds: ids, includesPrivateIssues: false }) });
    if (files.length > 1000 || files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 5_000_000) return failure('VALIDATION', 'Export exceeds its size budget', 'reduce_export_scope');
    const current = await this.exportSelection(ctx, ids, approval.baseRevision); if (!current.ok) return current;
    if (canonicalJson({ nodes: current.data.nodes, relations: current.data.relations, records: current.data.records })
      !== canonicalJson({ nodes: selected.data.nodes, relations: selected.data.relations, records: selected.data.records })) return failure('CONFLICT', 'Selected export content changed while generating files', 'preview_export', 'preserved');
    const stillValid = this.approvals.validate(ctx, 'data:export', approval, expected);
    if (!stillValid.ok) return stillValid;
    if (ids.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return failure('FORBIDDEN', 'Selected data has been blocked from export', 'review_delete_report');
    this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'data_exported', ids, 'generated_not_published');
    return { ok: true, data: { files, limitations: ['Only explicitly selected formal knowledge, relationships and private evidence are included. Evidence retains its original context and version, not the current conclusion.', 'Private Issues, conversations, candidates, drafts, unselected evidence, Git history, caches, backups and shared copies are not included.'] } };
  }
}
