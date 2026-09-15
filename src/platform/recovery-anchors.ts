import { createHash } from 'node:crypto';
import type { RequestContext, Result } from '../contracts/api';
import { canonicalJson } from '../contracts/hash';
import { OperationRecoverySchema, type OperationRecovery } from '../contracts/operation-recovery';
import { RecoveryAnchorRequestSchema, RecoveryAnchorSchema, type RecoveryAnchor, type RecoveryAnchorRead } from '../contracts/recovery-anchor';
import type { Services } from '../contracts/ports';
import type { SessionRegistry } from './identity';
import type { OperationJournal } from './journal';
import { failure } from './result';

const scope = (v: RecoveryAnchor['operation']) => v.kind === 'model' ? `model:${v.modelPurpose}` : v.kind === 'task' ? 'task:read' : v.kind === 'evidence' ? 'evidence:write' : 'evidence:read';
function compare(anchor: Pick<RecoveryAnchor, 'binding' | 'operation' | 'actorId' | 'workspaceId'>, original: OperationRecovery): RecoveryAnchorRead['binding'] {
  if (anchor.actorId !== original.actorId || anchor.workspaceId !== original.workspaceId || anchor.operation.operationId !== original.operationId
    || anchor.operation.kind !== original.kind || (anchor.operation.kind === 'model' && original.purpose !== anchor.operation.modelPurpose && original.stage !== 'not_registered')) return 'mismatch';
  let unknown = false;
  for (const [key, value] of Object.entries(anchor.binding)) {
    const actual = original[key as keyof RecoveryAnchor['binding']];
    if (actual === null || actual === undefined) unknown = true;
    else if (actual !== value) return 'mismatch';
  }
  return unknown || ['unknown', 'not_registered'].includes(original.stage) ? 'unknown' : 'matched';
}

export class RecoveryAnchorStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal,
    private readonly lookup: NonNullable<Services['readOperationRecovery']>, private readonly now: () => number = Date.now) {}
  private access(ctx: RequestContext) {
    const access = this.sessions.authorize(ctx, 'workspace:read'); if (!access.ok) return access;
    return access.data.visibility !== 'private' || (ctx.mode === 'live' && this.journal.fixture)
      ? failure<never>('FORBIDDEN', 'Private durable recovery storage is required', 'connect_workspace') : access;
  }
  async save(ctx: RequestContext, input: unknown): Promise<Result<RecoveryAnchor>> {
    const parsed = RecoveryAnchorRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Only the confirmed original operation identity and an explicit expiry are accepted', 'confirm_recovery_retention');
    const request = parsed.data, access = this.access(ctx); if (!access.ok) return access;
    if (request.actorId !== ctx.actorId || request.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'The confirmed recovery identity changed', 'connect_original_workspace');
    const expiry = Date.parse(request.expiresAt);
    if (expiry <= this.now() || expiry > this.now() + 86_400_000) return failure('VALIDATION', 'Recovery identity retention must end within 24 hours', 'confirm_recovery_retention');
    const allowed = this.sessions.authorize(ctx, scope(request.operation)); if (!allowed.ok) return allowed;
    try {
      const original = await this.lookup(ctx, request.operation); if (!original.ok) return original;
      if (compare(request, OperationRecoverySchema.parse(original.data)) === 'mismatch') return failure('CONFLICT', 'The original operation binding does not match', 'read_original_operation', 'preserved');
      return this.journal.transaction(() => {
        const final = this.access(ctx); if (!final.ok) return final;
        const permission = this.sessions.authorize(ctx, scope(request.operation)); if (!permission.ok) return permission;
        if (expiry <= this.now()) return failure('CONFLICT', 'Recovery retention expired before save', 'confirm_recovery_retention', 'preserved');
        const id = createHash('sha256').update(canonicalJson([request.feature, request.operation])).digest('hex');
        const prior = this.journal.record(ctx.workspaceId, ctx.actorId, 'recovery_anchor', id);
        if (prior) {
          const saved = RecoveryAnchorSchema.parse(prior.value);
          return canonicalJson(saved.binding) === canonicalJson(request.binding) && saved.expiresAt === request.expiresAt
            ? { ok: true, data: saved } : failure('CONFLICT', 'The original recovery identity is immutable', 'read_original_operation', 'preserved');
        }
        if (this.journal.records(ctx.workspaceId, ctx.actorId, 'recovery_anchor').length >= 100) return failure('VALIDATION', 'Recovery identity capacity is exhausted', 'wait_for_recovery_expiry');
        const anchor = RecoveryAnchorSchema.parse({ id, actorId: ctx.actorId, workspaceId: ctx.workspaceId, feature: request.feature,
          operation: request.operation, binding: request.binding, createdAt: new Date(this.now()).toISOString(), expiresAt: request.expiresAt, readOnly: true });
        if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'recovery_anchor', id, anchor, null)) throw Error('Recovery identity conflict');
        return { ok: true, data: anchor };
      });
    } catch { return failure('UNKNOWN_RESULT', 'Recovery identity save could not be verified', 'list_original_recovery_identities', 'unknown'); }
  }
  list(ctx: RequestContext): Result<RecoveryAnchor[]> {
    const access = this.access(ctx); if (!access.ok) return access;
    try {
      return { ok: true, data: this.journal.records(ctx.workspaceId, ctx.actorId, 'recovery_anchor').map((r) => RecoveryAnchorSchema.parse(r.value))
        .filter((a) => a.actorId === ctx.actorId && a.workspaceId === ctx.workspaceId && Date.parse(a.expiresAt) > this.now() && this.sessions.authorize(ctx, scope(a.operation)).ok) };
    } catch { return failure('INTERNAL', 'Recovery identity list could not be verified', 'read_original_operation'); }
  }
  async read(ctx: RequestContext, id: string): Promise<Result<RecoveryAnchorRead | null>> {
    const access = this.access(ctx); if (!access.ok) return access;
    if (!/^[a-f0-9]{64}$/.test(id)) return failure('VALIDATION', 'Invalid recovery identity', 'list_original_recovery_identities');
    try {
      const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'recovery_anchor', id);
      if (!row) return { ok: true, data: null };
      const identity = RecoveryAnchorSchema.parse(row.value);
      if (identity.actorId !== ctx.actorId || identity.workspaceId !== ctx.workspaceId || Date.parse(identity.expiresAt) <= this.now()) return { ok: true, data: null };
      const original = await this.lookup(ctx, identity.operation); if (!original.ok) return original;
      const final = this.access(ctx); if (!final.ok) return final;
      const permission = this.sessions.authorize(ctx, scope(identity.operation)); if (!permission.ok) return permission;
      if (Date.parse(identity.expiresAt) <= this.now()) return { ok: true, data: null };
      const parsed = OperationRecoverySchema.parse(original.data), binding = compare(identity, parsed);
      return { ok: true, data: { identity, original: binding === 'mismatch' ? null : parsed, binding, readOnly: true, retryAllowed: false } };
    } catch { return failure('UNKNOWN_RESULT', 'The original recovery binding could not be verified', 'read_original_operation', 'unknown'); }
  }
}
