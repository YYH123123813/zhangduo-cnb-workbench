import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { EvidenceKnowledgeSchema, EvidenceRecordSchema, Id, type Approval, type EvidenceRecord } from '../contracts/domain';
import { EvidenceApprovalRequestSchema, EvidenceReceiptSchema, type EvidenceReceipt } from '../contracts/evidence';
import { canonicalJson, contentHash, hashEvidence } from '../contracts/hash';
import type { Services } from '../contracts/ports';
import type { SessionRegistry } from './identity';
import type { OperationJournal } from './journal';
import type { ApprovalAuthority } from './approvals';
import { failure } from './result';
import { validateTaskContext } from '../contracts/task';

const ConstraintSchema = z.object({ purpose: z.literal('save_evidence'), operationId: Id, recordId: Id, retention: z.literal('until_deleted') }).strict();
const StoredSchema = z.object({ actorId: Id, state: z.enum(['available', 'deleted']).default('available'), record: EvidenceRecordSchema.nullable(), receipt: EvidenceReceiptSchema }).strict()
  .refine((stored) => (stored.state === 'deleted') === (stored.record === null));
const conflict = <T>(message: string): Result<T> => failure('CONFLICT', message, 'read_original_evidence', 'preserved');
const sameIds = (a: string[], b: string[]) => a.length === new Set(a).size && b.length === new Set(b).size && canonicalJson([...a].sort()) === canonicalJson([...b].sort());
const evidenceIds = (record: EvidenceRecord) => [...new Set([record.id, ...record.nodeRefs.map((ref) => ref.objectId), ...record.relationRefs,
  ...(record.outcome ? [record.outcome.useRecordId] : []), ...(record.useContext?.knowledge.flatMap((node) => [node.id, ...node.conditions.flatMap((condition) => condition.evidenceIds)]) ?? []),
  ...(record.useContext?.relations.flatMap((edge) => [edge.id, edge.source.objectId, edge.target.objectId, ...edge.evidenceIds]) ?? []),
  ...(record.useContext?.task.conditionChecks?.map((check) => check.nodeRef.objectId) ?? []),
])];

export class EvidenceStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal,
    private readonly approvals: ApprovalAuthority, private readonly snapshot: Services['snapshot']) {}

  private access(ctx: RequestContext, scope: 'evidence:read' | 'evidence:write', ids: string[] = [], body = true) {
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)) return failure<never>('FORBIDDEN', 'Private durable evidence storage is required', 'configure_private_storage');
    if (body) { const knowledge = this.sessions.authorize(ctx, 'knowledge:read'); if (!knowledge.ok) return knowledge; }
    const blocked = new Set(this.journal.blocked(ctx.workspaceId));
    if (ids.some((id) => blocked.has(id))) return failure<never>('FORBIDDEN', 'Evidence or its original context is blocked', 'review_delete_report', 'preserved');
    return access;
  }

  private accessRecord(ctx: RequestContext, scope: 'evidence:read' | 'evidence:write', record: EvidenceRecord) {
    const access = this.access(ctx, scope, evidenceIds(record));
    if (!access.ok || !record.outcome) return access;
    const readable = this.access(ctx, 'evidence:read', [record.outcome.useRecordId]); if (!readable.ok) return readable;
    const row = this.journal.record(ctx.workspaceId, '@workspace', 'evidence', record.outcome.useRecordId);
    const original = row ? StoredSchema.parse(row.value) : null;
    if (!original?.record || original.record.kind !== 'use' || original.actorId !== ctx.actorId || original.record.workspaceId !== ctx.workspaceId)
      return failure<never>('FORBIDDEN', 'Original use is unavailable to this identity', 'read_original_evidence', 'preserved');
    // Outcomes inherit the full saved path, not only the adopted nodes and direct references.
    return this.access(ctx, scope, evidenceIds(original.record));
  }

  private async validate(ctx: RequestContext, record: EvidenceRecord, baseRevision: string): Promise<Result<true>> {
    const access = this.accessRecord(ctx, 'evidence:write', record); if (!access.ok) return access;
    if (record.workspaceId !== ctx.workspaceId || record.nodeRefs.some((ref) => ref.workspaceId !== ctx.workspaceId)) return failure('FORBIDDEN', 'Evidence belongs to another workspace', 'select_workspace');
    if (Buffer.byteLength(canonicalJson(record)) > 500_000 || Date.parse(record.recordedAt) > Date.now()) return failure('VALIDATION', 'Evidence exceeds its storage or timestamp boundary', 'review_evidence');
    if (record.kind === 'recall' || record.kind === 'near_transfer') return failure('NOT_IMPLEMENTED', 'Trusted attempt storage must be connected before saving learning evidence', 'connect_trusted_attempts');
    if (!record.answerVisible || record.hintLevel !== 0 || record.selfConfidence !== 'skipped' || record.rubricVersion || record.reviewedBy)
      return failure('VALIDATION', 'Application and self-reported outcomes cannot attest independent learning or rubric review', 'review_evidence');
    const snapshot = await this.snapshot(ctx); if (!snapshot.ok) return snapshot;
    if (snapshot.data.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'Knowledge snapshot belongs to another workspace', 'select_workspace');
    if ([...snapshot.data.nodes, ...snapshot.data.relations].some((object) => object.id === record.id)) return conflict('Evidence ID cannot collide with a formal knowledge object');
    if (record.kind === 'outcome') {
      if (!record.outcome || record.decision !== undefined || record.result !== 'self_reported' || record.outcome.useRecordId === record.id
        || (record.outcome.status === 'failed' && !record.outcome.failureReason.trim())) return failure('VALIDATION', 'An outcome requires a separate self-reported result tied to its original use', 'review_outcome');
      const original = await this.read(ctx, record.outcome.useRecordId); if (!original.ok) return original;
      if (!original.data || original.data.kind !== 'use' || !original.data.useContext) return conflict('Original structured use is unavailable; historical context cannot be reconstructed');
      if (original.data.taskId !== record.taskId || original.data.useContext.snapshotRevision !== baseRevision || Date.parse(record.recordedAt) < Date.parse(original.data.recordedAt)
        || canonicalJson(record.nodeRefs) !== canonicalJson(original.data.nodeRefs) || canonicalJson(record.relationRefs) !== canonicalJson(original.data.relationRefs))
        return conflict('Outcome must retain the original task, references and version');
      return { ok: true, data: true };
    }
    const context = record.useContext;
    if (!context || !record.decision || record.result !== 'unverified' || context.snapshotRevision !== baseRevision || context.task.id !== record.taskId
      || context.task.workspaceId !== ctx.workspaceId || !record.nodeRefs.length || record.nodeRefs.length > 20)
      return failure('VALIDATION', 'Saving use requires its full original task and fixed knowledge context', 'review_evidence');
    const task = validateTaskContext(context.task, snapshot.data, ctx.actorId); if (!task.ok) return task;
    if (snapshot.data.revision !== baseRevision || snapshot.data.workspaceId !== ctx.workspaceId) return conflict('Knowledge changed after the evidence preview');
    if (!sameIds(record.relationRefs, context.relations.map((edge) => edge.id)) || !sameIds(record.nodeRefs.map((ref) => ref.objectId), record.nodeRefs.map((ref) => ref.objectId)))
      return failure('VALIDATION', 'Evidence references must be unique and retain their complete original relationships', 'review_evidence');
    const nodes = new Map(snapshot.data.nodes.map((node) => [node.id, node])), edges = new Map(snapshot.data.relations.map((edge) => [edge.id, edge]));
    const excluded = new Set(snapshot.data.excludedIds), contextIds = new Set(record.nodeRefs.map((ref) => ref.objectId));
    for (const ref of record.nodeRefs) {
      const node = nodes.get(ref.objectId);
      if (!node || node.revision !== ref.revision || node.confirmation !== 'confirmed' || excluded.has(node.id)
        || (record.decision === 'adopt' && ['withdrawn', 'superseded'].includes(node.lifecycle))) return conflict('Selected knowledge is not the original available formal version');
    }
    for (const edge of context.relations) {
      const original = edges.get(edge.id);
      if (!original || canonicalJson(original) !== canonicalJson(edge) || edge.state !== 'confirmed' || excluded.has(edge.id)) return conflict('Evidence relationship differs from its formal snapshot');
      for (const ref of [edge.source, edge.target]) {
        const node = nodes.get(ref.objectId);
        if (!node || node.revision !== ref.revision || node.confirmation !== 'confirmed' || excluded.has(node.id)) return conflict('Evidence relationship endpoint changed or is unavailable');
        contextIds.add(node.id);
      }
    }
    const seenRelations = new Set<string>();
    for (const path of context.paths) {
      if (path.nodeIds[0] !== path.seedId || path.nodeIds.length !== path.relationIds.length + 1 || new Set(path.nodeIds).size !== path.nodeIds.length
        || new Set(path.relationIds).size !== path.relationIds.length || path.nodeIds.some((id) => !contextIds.has(id))) return failure('VALIDATION', 'Evidence path is incomplete or outside its selected context', 'review_paths');
      for (const [index, id] of path.relationIds.entries()) {
        const edge = context.relations.find((value) => value.id === id), from = path.nodeIds[index], to = path.nodeIds[index + 1];
        if (!edge || !((edge.source.objectId === from && edge.target.objectId === to) || (edge.source.objectId === to && edge.target.objectId === from))) return conflict('Evidence path does not follow its formal relationship');
        seenRelations.add(id);
      }
    }
    if (record.relationRefs.some((id) => !seenRelations.has(id)) || !sameIds(context.knowledge.map((node) => node.id), [...contextIds]))
      return failure('VALIDATION', 'Evidence omits original path endpoints or relationship explanations', 'review_paths');
    for (const saved of context.knowledge) {
      const original = nodes.get(saved.id); if (!original) return conflict('Knowledge context is missing');
      const { id, revision, title, humanStatement, conditions, boundaries, evidenceStatus } = original;
      if (canonicalJson(saved) !== canonicalJson(EvidenceKnowledgeSchema.parse({ id, revision, title, humanStatement, conditions, boundaries, evidenceStatus }))) return conflict('Saved conditions or statements differ from the original Git snapshot');
    }
    if (record.decision === 'adopt' && !context.reason.trim() && (context.retrievalContext.coverage !== 'current' || context.retrievalContext.missingConditions.length
      || context.retrievalContext.warnings.length || context.knowledge.some((node) => node.boundaries.length || node.conditions.some((condition) => condition.status !== 'confirmed') || node.evidenceStatus !== 'supported')))
      return failure('VALIDATION', 'A limited adoption requires the original reason and known gaps', 'review_evidence');
    return { ok: true, data: true };
  }

  async approve(ctx: RequestContext, input: unknown): Promise<Result<Approval>> {
    const access = this.access(ctx, 'evidence:write'); if (!access.ok) return access;
    const parsed = EvidenceApprovalRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Evidence requires explicit private retention consent and an original operation ID', 'preview_evidence_storage');
    const request = parsed.data;
    try {
      const registration = { operationId: request.operationId, requestHash: await contentHash(request) };
      const previous = this.approvals.previousRegistration(ctx, 'save_evidence', registration); if (!previous.ok) return previous;
      if (previous.data) return { ok: true, data: previous.data };
      const valid = await this.validate(ctx, request.record, request.baseRevision); if (!valid.ok) return valid;
      const hash = await hashEvidence(request.record);
      return this.approvals.registerOperation(ctx, { purpose: 'save_evidence', objectIds: [request.record.id], contentHash: hash, baseRevision: request.baseRevision }, {
        ...registration, constraint: { kind: 'evidence_constraint', value: { purpose: 'save_evidence', operationId: request.operationId, recordId: request.record.id, retention: request.retention } },
        beforeRegister: () => { const access = this.accessRecord(ctx, 'evidence:write', request.record); return access.ok ? { ok: true, data: true } : access; },
      });
    } catch { return failure('UNKNOWN_RESULT', 'Evidence approval could not be verified', 'read_approval_registration', 'unknown'); }
  }

  async append(ctx: RequestContext, input: EvidenceRecord, approval: Approval): Promise<Result<EvidenceRecord>> {
    const access = this.access(ctx, 'evidence:write'); if (!access.ok) return access;
    const parsed = EvidenceRecordSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Evidence does not match the shared schema', 'review_evidence');
    const record = parsed.data;
    try {
      const hash = await hashEvidence(record), expected = { purpose: 'save_evidence' as const, objectIds: [record.id], contentHash: hash, baseRevision: approval.baseRevision };
      const valid = this.approvals.validate(ctx, 'evidence:write', approval, expected); if (!valid.ok) return valid;
      const constraint = ConstraintSchema.safeParse(this.journal.record(ctx.workspaceId, ctx.actorId, 'evidence_constraint', approval.id)?.value);
      if (!constraint.success || constraint.data.recordId !== record.id) return failure('FORBIDDEN', 'Evidence storage has no matching retention approval', 'preview_evidence_storage');
      const match = (): Result<EvidenceRecord | null> => {
        const row = this.journal.record(ctx.workspaceId, '@workspace', 'evidence', record.id); if (!row) return { ok: true, data: null };
        const existing = StoredSchema.parse(row.value);
        if (existing.actorId !== ctx.actorId) return failure('FORBIDDEN', 'Evidence ID belongs to another actor', 'use_original_identity');
        if (!existing.record) return conflict('The original evidence was deleted; its identity cannot be reused');
        if (existing.receipt.contentHash !== hash || existing.receipt.approvalId !== approval.id || canonicalJson(existing.record) !== canonicalJson(record)) return conflict('Evidence ID already belongs to another exact operation');
        const allowed = this.accessRecord(ctx, 'evidence:write', record); if (!allowed.ok) return allowed;
        return { ok: true, data: existing.record };
      };
      const previous = match(); if (!previous.ok) return previous; if (previous.data) return { ok: true, data: previous.data };
      const checked = await this.validate(ctx, record, approval.baseRevision); if (!checked.ok) return checked;
      return this.journal.transaction((): Result<EvidenceRecord> => {
        const valid = this.approvals.validate(ctx, 'evidence:write', approval, expected); if (!valid.ok) return valid;
        const allowed = this.accessRecord(ctx, 'evidence:write', record); if (!allowed.ok) return allowed;
        const previous = match(); if (!previous.ok) return previous; if (previous.data) return { ok: true, data: previous.data };
        const receipt = EvidenceReceiptSchema.parse({ operationId: constraint.data.operationId, approvalId: approval.id, recordId: record.id, workspaceId: ctx.workspaceId,
          actorId: ctx.actorId, contentHash: hash, baseRevision: approval.baseRevision, recordedAt: record.recordedAt, storedAt: new Date().toISOString(), retention: 'until_deleted', outcome: 'saved' });
        const stored = { actorId: ctx.actorId, state: 'available', record, receipt };
        if (!this.journal.evidencePayloadFits(ctx.workspaceId, Buffer.byteLength(canonicalJson(stored)))) return failure('VALIDATION', 'Private evidence storage quota exceeded', 'review_storage_capacity');
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'evidence', record.id, stored, null)
          || !this.journal.putRecord(ctx.workspaceId, '@workspace', 'evidence_receipt', receipt.operationId, receipt, null)) throw new Error('Evidence transaction insertion failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'evidence_saved', [record.id], 'private_not_indexed', { kind: 'evidence', id: receipt.operationId });
        return { ok: true, data: record };
      });
    } catch { return failure('UNKNOWN_RESULT', 'Evidence storage transaction could not be verified', 'read_evidence_receipt', 'unknown'); }
  }

  async read(ctx: RequestContext, id: string): Promise<Result<EvidenceRecord | null>> {
    const access = this.access(ctx, 'evidence:read', [id]); if (!access.ok) return access;
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'Original evidence ID is required', 'read_original_evidence');
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', 'evidence', id); if (!row) return { ok: true, data: null };
      const stored = StoredSchema.parse(row.value);
      if (!stored.record) return failure('FORBIDDEN', 'Original evidence payload was deleted', 'review_delete_report', 'preserved');
      if (stored.actorId !== ctx.actorId || stored.record.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'Evidence is unavailable to this identity', 'use_original_identity');
      const valid = this.accessRecord(ctx, 'evidence:read', stored.record); if (!valid.ok) return valid;
      if (stored.record.id !== id || stored.receipt.recordId !== id || stored.receipt.actorId !== ctx.actorId || stored.receipt.workspaceId !== ctx.workspaceId
        || await hashEvidence(stored.record) !== stored.receipt.contentHash) throw new Error('Evidence integrity mismatch');
      const final = this.accessRecord(ctx, 'evidence:read', stored.record); if (!final.ok) return final;
      return { ok: true, data: stored.record };
    } catch { return failure('INTERNAL', 'Private evidence could not be verified', 'repair_private_storage', 'preserved'); }
  }

  async list(ctx: RequestContext, taskId?: string): Promise<Result<EvidenceRecord[]>> {
    const access = this.access(ctx, 'evidence:read'); if (!access.ok) return access;
    if (taskId !== undefined && !Id.safeParse(taskId).success) return failure('VALIDATION', 'Invalid task filter', 'read_original_evidence');
    try {
      const records: EvidenceRecord[] = [];
      for (const row of this.journal.records(ctx.workspaceId, '@workspace', 'evidence')) {
        const stored = StoredSchema.parse(row.value);
        if (!stored.record) continue;
        if (stored.actorId !== ctx.actorId || (taskId !== undefined && stored.record.taskId !== taskId)) continue;
        const readable = this.accessRecord(ctx, 'evidence:read', stored.record);
        if (!readable.ok) { if (readable.error.code === 'FORBIDDEN' && readable.error.nextAction === 'review_delete_report') continue; return readable; }
        const record = await this.read(ctx, row.id);
        if (!record.ok) { if (record.error.code === 'FORBIDDEN' && record.error.nextAction === 'review_delete_report') continue; return record; }
        if (record.data) records.push(record.data);
      }
      const final = this.access(ctx, 'evidence:read'); if (!final.ok) return final;
      const visible: EvidenceRecord[] = [];
      for (const record of records) {
        const readable = this.accessRecord(ctx, 'evidence:read', record);
        if (!readable.ok) { if (readable.error.code === 'FORBIDDEN' && readable.error.nextAction === 'review_delete_report') continue; return readable; }
        visible.push(record);
      }
      return { ok: true, data: visible };
    } catch { return failure('INTERNAL', 'Private evidence list could not be verified', 'repair_private_storage', 'preserved'); }
  }

  receipt(ctx: RequestContext, operationId: string): Result<EvidenceReceipt | null> {
    const access = this.access(ctx, 'evidence:read', [], false); if (!access.ok) return access;
    if (!Id.safeParse(operationId).success) return failure('VALIDATION', 'Original evidence operation ID is required', 'read_evidence_receipt');
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', 'evidence_receipt', operationId); if (!row) return { ok: true, data: null };
      const receipt = EvidenceReceiptSchema.parse(row.value);
      if (receipt.actorId !== ctx.actorId || receipt.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'Original receipt belongs to another identity', 'use_original_identity');
      const approval = this.journal.approval(receipt.approvalId)?.value;
      const constraint = ConstraintSchema.parse(this.journal.record(ctx.workspaceId, ctx.actorId, 'evidence_constraint', receipt.approvalId)?.value);
      if (!approval || approval.purpose !== 'save_evidence' || receipt.operationId !== operationId || constraint.operationId !== operationId || constraint.recordId !== receipt.recordId
        || approval.contentHash !== receipt.contentHash || approval.baseRevision !== receipt.baseRevision || approval.actorId !== ctx.actorId || approval.workspaceId !== ctx.workspaceId) throw new Error('Evidence receipt binding mismatch');
      return { ok: true, data: receipt };
    } catch { return failure('INTERNAL', 'Original evidence receipt could not be verified', 'read_evidence_receipt', 'unknown'); }
  }

  // Called only after the approved plan's durable block is installed, within its SQLite transaction.
  eraseSelected(ctx: RequestContext, ids: string[]): Result<{ clearedIds: string[] }> {
    const access = this.sessions.authorize(ctx, 'data:delete'); if (!access.ok) return access;
    const read = this.access(ctx, 'evidence:read', [], false); if (!read.ok) return read;
    const clearedIds: string[] = [];
    try {
      for (const id of ids) {
        const row = this.journal.record(ctx.workspaceId, '@workspace', 'evidence', id); if (!row) continue;
        const stored = StoredSchema.parse(row.value);
        if (stored.actorId !== ctx.actorId || stored.receipt.workspaceId !== ctx.workspaceId || !this.journal.blocked(ctx.workspaceId).includes(id))
          return failure('FORBIDDEN', 'Evidence cleanup requires its original identity and approved barrier', 'review_delete_report', 'preserved');
        if (stored.record && !this.journal.putRecord(ctx.workspaceId, '@workspace', 'evidence', id, { ...stored, state: 'deleted', record: null }, row.version))
          return conflict('Local evidence cleanup did not complete; retrieval remains blocked');
        clearedIds.push(id);
      }
      return { ok: true, data: { clearedIds } };
    } catch { return failure('INTERNAL', 'Local evidence cleanup failed; retrieval remains blocked', 'review_delete_report', 'preserved'); }
  }
}
