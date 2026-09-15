import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import { GovernanceOperationReceiptSchema, GovernanceOperationSaveRequestSchema, GovernanceOperationStateSchema, type GovernanceOperationKind, type GovernanceOperationReceipt, type GovernanceOperationSaveRequest, type GovernanceOperationState } from '../contracts/governance-operation';
import { Id } from '../contracts/domain';
import { canonicalJson, contentHash } from '../contracts/hash';
import type { OperationJournal } from './journal';
import type { SessionRegistry } from './identity';
import { failure } from './result';

const PayloadSchema = z.record(z.string(), z.unknown());
const InternalSchema = GovernanceOperationStateSchema.omit({ payload: true }).extend({ payload: PayloadSchema.nullable().optional(), request: z.unknown().optional() }).strict();
const ReceiptRecordSchema = GovernanceOperationReceiptSchema;
const scopeFor = (kind: GovernanceOperationKind, write: boolean) => {
  if (kind === 'change') return write ? 'knowledge:write' : 'knowledge:read';
  if (kind === 'settings') return write ? 'settings:write' : 'settings:read';
  return kind === 'delete' ? 'data:delete' : 'data:export';
};

export class GovernanceOperationStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal) {}
  private access(ctx: RequestContext, kind: GovernanceOperationKind, write: boolean) {
    const result = this.sessions.authorize(ctx, scopeFor(kind, write));
    if (!result.ok) return result;
    if (ctx.mode === 'live' && this.journal.fixture) return failure<never>('FORBIDDEN', 'Governance payload storage requires durable storage', 'configure_operation_storage');
    return result;
  }
  private parseRecord(ctx: RequestContext, id: string): { state: GovernanceOperationState; receipt: GovernanceOperationReceipt | null } | null {
    const record = this.journal.record(ctx.workspaceId, ctx.actorId, 'governance_operation', id);
    if (!record) return null;
    const state = InternalSchema.parse(record.value);
    const receiptRecord = this.journal.record(ctx.workspaceId, ctx.actorId, 'governance_operation_receipt', id);
    const receipt = receiptRecord ? ReceiptRecordSchema.parse(receiptRecord.value) : null;
    return { state: GovernanceOperationStateSchema.parse(state), receipt };
  }
  private bounded(state: GovernanceOperationState): GovernanceOperationState {
    if (state.state !== 'expired') return state;
    const { payload: _payload, ...withoutPayload } = state as GovernanceOperationState & { payload?: unknown | null };
    return GovernanceOperationStateSchema.parse(withoutPayload);
  }
  async save(ctx: RequestContext, supplied: unknown): Promise<Result<GovernanceOperationState>> {
    const parsed = GovernanceOperationSaveRequestSchema.safeParse(supplied);
    if (!parsed.success) return failure('VALIDATION', 'An explicit 30-day governance payload consent is required', 'preview_governance_operation');
    const input = parsed.data, access = this.access(ctx, input.kind, true); if (!access.ok) return access;
    if (!Id.safeParse(input.operationId).success) return failure('VALIDATION', 'A valid original governance operation ID is required', 'preview_governance_operation');
    let contentHashValue: string, requestHash: string;
    try { contentHashValue = await contentHash(input.payload); requestHash = await contentHash(input); }
    catch { return failure('VALIDATION', 'Governance payload must be plain bounded JSON', 'preview_governance_operation'); }
    if (Buffer.byteLength(canonicalJson(input.payload)) > 800_000) return failure('VALIDATION', 'Governance payload exceeds the private storage budget', 'reduce_governance_scope');
    const prior = this.parseRecord(ctx, input.operationId);
    if (prior) {
      if (prior.state.kind === input.kind && prior.state.baseRevision === input.baseRevision && prior.state.contentHash === contentHashValue && prior.state.requestHash === requestHash) return { ok: true, data: this.bounded(prior.state) };
      return failure('CONFLICT', 'This governance operation ID is bound to a different payload', 'read_governance_operation', 'preserved');
    }
    const now = new Date(), createdAt = now.toISOString(), expiresAt = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    const state: GovernanceOperationState = { operationId: input.operationId, kind: input.kind, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
      baseRevision: input.baseRevision, contentHash: contentHashValue, requestHash, state: 'available', payload: input.payload, expiresAt, createdAt };
    const receipt: GovernanceOperationReceipt = { operationId: input.operationId, kind: input.kind, actorId: ctx.actorId, workspaceId: ctx.workspaceId,
      baseRevision: input.baseRevision, contentHash: contentHashValue, requestHash, outcome: 'saved', savedAt: createdAt };
    try {
      this.journal.transaction(() => {
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'governance_operation', input.operationId, state, null)) throw Error('Governance operation CAS lost');
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'governance_operation_receipt', input.operationId, receipt, null)) throw Error('Governance operation receipt insert failed');
        this.journal.addAudit(ctx.workspaceId, ctx.actorId, 'governance_operation_saved', [], 'private_governance_payload');
      });
      return { ok: true, data: state };
    } catch { return failure('UNKNOWN_RESULT', 'Governance payload persistence is unknown; read the original operation', 'read_governance_operation', 'unknown'); }
  }
  read(ctx: RequestContext, operationId: string): Result<GovernanceOperationState | null> {
    if (!Id.safeParse(operationId).success) return failure('VALIDATION', 'A valid original governance operation ID is required', 'read_governance_operation');
    const record = this.journal.record(ctx.workspaceId, ctx.actorId, 'governance_operation', operationId);
    if (!record) return { ok: true, data: null };
    try { const internal = InternalSchema.parse(record.value); const { payload, ...rest } = internal; const state = GovernanceOperationStateSchema.parse(payload === null ? rest : { ...rest, ...(payload === undefined ? {} : { payload }) }); const access = this.access(ctx, state.kind, false); if (!access.ok) return access; return { ok: true, data: this.bounded(state) }; }
    catch { return failure('INTERNAL', 'Stored governance payload could not be verified', 'repair_operation_storage', 'preserved'); }
  }
  readReceipt(ctx: RequestContext, operationId: string): Result<GovernanceOperationReceipt | null> {
    if (!Id.safeParse(operationId).success) return failure('VALIDATION', 'A valid original governance operation ID is required', 'read_governance_operation');
    const record = this.journal.record(ctx.workspaceId, ctx.actorId, 'governance_operation_receipt', operationId);
    if (!record) return { ok: true, data: null };
    try { const receipt = ReceiptRecordSchema.parse(record.value); const access = this.access(ctx, receipt.kind, false); if (!access.ok) return access; return { ok: true, data: receipt }; }
    catch { return failure('INTERNAL', 'Stored governance operation receipt could not be verified', 'repair_operation_storage', 'preserved'); }
  }
}
