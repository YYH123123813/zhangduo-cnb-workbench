import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApprovalSchema, Id, type Approval, type Conversation } from '../contracts/domain';
import { ApprovalRegistrationQuerySchema, ApprovalRegistrationStateSchema, ConversationApprovalRequestSchema, KnowledgeApprovalRequestSchema, type ApprovalRegistrationQuery, type ApprovalRegistrationState, type KnowledgeApprovalState } from '../contracts/approval';
import { canonicalJson, contentHash, hashConversation, hashChangeSet } from '../contracts/hash';
import type { RequestContext, Result } from '../contracts/api';
import type { SessionRegistry } from './identity';
import type { OperationJournal } from './journal';
import { failure } from './result';

export const isNewCaptureTarget = (conversation: Conversation) => conversation.state === 'preview'
  && conversation.issueNumber === undefined && conversation.issueUrl === undefined && !conversation.id.startsWith('cnb-issue:');
const KnowledgeBindingSchema = z.object({ approvalId: Id, actorId: Id, contentHash: Id, baseRevision: Id }).strict();
const ConstraintBindingSchema = z.object({ kind: z.enum(['approval_constraint', 'model_constraint', 'evidence_constraint']), value: z.record(z.string(), z.unknown()) }).strict();
const RegistrationBindingSchema = z.object({ approval: ApprovalSchema, requestHash: Id,
  modelPurpose: z.enum(['extract', 'answer', 'review']).optional(), constraint: ConstraintBindingSchema.optional() }).strict();
export interface RegistrationOptions {
  operationId?: string; requestHash: string; modelPurpose?: 'extract' | 'answer' | 'review';
  constraint?: z.infer<typeof ConstraintBindingSchema>;
  beforeRegister?: () => Result<true>;
}
type RegistrationExpected = Pick<Approval, 'objectIds' | 'contentHash' | 'baseRevision'> & { purpose: ApprovalRegistrationQuery['purpose'] };
const registrationScope = (query: ApprovalRegistrationQuery) => query.purpose === 'model_input' ? `model:${query.modelPurpose}`
  : ({ save_conversation: 'conversation:write', settings: 'settings:write', export: 'data:export', delete: 'data:delete', save_evidence: 'evidence:write', demo_export: 'data:export' })[query.purpose];

export class ApprovalAuthority {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly now: () => number = Date.now) {}

  register(ctx: RequestContext, scope: string, expected: Pick<Approval, 'purpose' | 'objectIds' | 'contentHash' | 'baseRevision'>): Result<Approval> {
    const access = this.sessions.authorize(ctx, scope);
    if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure('FORBIDDEN', 'Live approval requires durable storage', 'configure_operation_storage');
    const time = this.now();
    const approval = ApprovalSchema.parse({ ...expected, id: randomUUID(), actorId: ctx.actorId, workspaceId: ctx.workspaceId,
      approvedAt: new Date(time).toISOString(), expiresAt: new Date(time + 15 * 60_000).toISOString() });
    this.journal.recordApproval(approval);
    return { ok: true, data: approval };
  }

  readRegistration(ctx: RequestContext, input: unknown): Result<ApprovalRegistrationState> {
    const parsed = ApprovalRegistrationQuerySchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'The original registration identity and exact purpose are required', 'read_approval_registration');
    const query = parsed.data;
    const access = this.sessions.authorize(ctx, registrationScope(query)); if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure('FORBIDDEN', 'Live approval recovery requires durable storage', 'configure_operation_storage');
    const state = (status: ApprovalRegistrationState['status'], binding?: z.infer<typeof RegistrationBindingSchema>): Result<ApprovalRegistrationState> => ({ ok: true,
      data: ApprovalRegistrationStateSchema.parse({ ...query, workspaceId: ctx.workspaceId, actorId: ctx.actorId, status,
        approval: binding?.approval ?? null, requestHash: binding?.requestHash ?? null, absenceIsFinal: false }) });
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', `approval_registration:${query.purpose}`, query.operationId);
      if (!row) return state('not_registered');
      const binding = RegistrationBindingSchema.parse(row.value);
      if (binding.approval.actorId !== ctx.actorId || binding.approval.workspaceId !== ctx.workspaceId || binding.modelPurpose !== query.modelPurpose)
        return failure('FORBIDDEN', 'Original registration is unavailable to this identity or purpose', 'use_original_identity');
      const stored = this.journal.approval(binding.approval.id);
      if (!stored || binding.approval.purpose !== query.purpose || canonicalJson(stored.value) !== canonicalJson(binding.approval)) return state('unknown');
      if (binding.constraint) {
        const constraint = this.journal.record(ctx.workspaceId, ctx.actorId, binding.constraint.kind, binding.approval.id);
        if (!constraint || canonicalJson(constraint.value) !== canonicalJson(binding.constraint.value)) return state('unknown');
      }
      if (stored.revoked) return state('revoked', binding);
      if (Date.parse(stored.value.approvedAt) > this.now()) return state('unknown');
      return state(Date.parse(stored.value.expiresAt) <= this.now() ? 'expired' : 'registered', binding);
    } catch { return state('unknown'); }
  }

  previousRegistration(ctx: RequestContext, purpose: ApprovalRegistrationQuery['purpose'], options: RegistrationOptions): Result<Approval | null> {
    if (options.operationId === undefined) return { ok: true, data: null };
    const state = this.readRegistration(ctx, { operationId: options.operationId, purpose, ...(options.modelPurpose ? { modelPurpose: options.modelPurpose } : {}) });
    if (!state.ok) return state;
    if (state.data.status === 'not_registered') return { ok: true, data: null };
    if (state.data.status === 'unknown') return failure('UNKNOWN_RESULT', 'Original approval registration cannot be verified', 'read_approval_registration', 'unknown');
    if (state.data.requestHash !== options.requestHash) return failure('CONFLICT', 'Operation ID is bound to a different complete approval request', 'preview_new_operation', 'preserved');
    if (state.data.status !== 'registered') return failure('FORBIDDEN', 'Original approval expired or was revoked; it will not be renewed', 'preview_new_operation', 'preserved');
    return { ok: true, data: state.data.approval };
  }

  registerOperation(ctx: RequestContext, expected: RegistrationExpected, options: RegistrationOptions): Result<Approval> {
    const query = { operationId: options.operationId ?? 'legacy', purpose: expected.purpose, ...(options.modelPurpose ? { modelPurpose: options.modelPurpose } : {}) };
    if (!ApprovalRegistrationQuerySchema.safeParse(query).success || !Id.safeParse(options.requestHash).success)
      return failure('VALIDATION', 'Invalid registration binding', 'preview_new_operation');
    const scope = registrationScope(query);
    try {
      return this.journal.transaction((): Result<Approval> => {
        const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
        const previous = this.previousRegistration(ctx, expected.purpose, options);
        if (!previous.ok) return previous;
        if (previous.data) return { ok: true, data: previous.data };
        const checked = options.beforeRegister?.(); if (checked && !checked.ok) return checked;
        const approval = this.register(ctx, scope, expected); if (!approval.ok) return approval;
        if (options.constraint && !this.journal.putRecord(ctx.workspaceId, ctx.actorId, options.constraint.kind, approval.data.id, options.constraint.value, null))
          throw new Error('Approval constraint insertion failed');
        if (options.operationId !== undefined) {
          const binding = RegistrationBindingSchema.parse({ approval: approval.data, requestHash: options.requestHash,
            ...(options.modelPurpose ? { modelPurpose: options.modelPurpose } : {}), ...(options.constraint ? { constraint: options.constraint } : {}) });
          if (!this.journal.putRecord(ctx.workspaceId, '@workspace', `approval_registration:${expected.purpose}`, options.operationId, binding, null))
            throw new Error('Approval registration insertion failed');
        }
        return approval;
      });
    } catch { return failure('UNKNOWN_RESULT', 'Approval registration transaction could not be verified', 'read_approval_registration', 'unknown'); }
  }

  async approveKnowledge(ctx: RequestContext, input: unknown): Promise<Result<Approval>> {
    const access = this.sessions.authorize(ctx, 'knowledge:write');
    if (!access.ok) return access;
    const parsed = KnowledgeApprovalRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'An explicitly confirmed ChangeSet is required', 'preview_and_confirm');
    const { changes } = parsed.data;
    if (changes.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'ChangeSet belongs to another workspace', 'select_authorized_workspace');
    const hash = await hashChangeSet(changes);
    if (hash !== changes.contentHash) return failure('CONFLICT', 'ChangeSet changed since preview', 'preview_again');
    const objectIds = [...new Set([...changes.nodes.map((node) => node.id), ...changes.relations.map((edge) => edge.id), ...changes.withdrawnIds])];
    if (!objectIds.length) return failure('VALIDATION', 'A nonempty change is required', 'preview_again');
    const expected = { purpose: 'commit_knowledge' as const, objectIds, contentHash: hash, baseRevision: changes.baseRevision };
    try {
      return this.journal.transaction((): Result<Approval> => {
        const stillAuthorized = this.sessions.authorize(ctx, 'knowledge:write'); if (!stillAuthorized.ok) return stillAuthorized;
        if (ctx.mode === 'live' && this.journal.fixture) return failure('FORBIDDEN', 'Live approval requires durable storage', 'configure_operation_storage');
        const row = this.journal.record(ctx.workspaceId, '@workspace', 'knowledge_approval', changes.id);
        if (row) {
          const binding = KnowledgeBindingSchema.parse(row.value);
          if (binding.actorId !== ctx.actorId) return failure('FORBIDDEN', 'Operation belongs to another actor', 'use_original_identity');
          if (binding.contentHash !== hash || binding.baseRevision !== changes.baseRevision) return failure('CONFLICT', 'Operation ID is bound to different approved content', 'preview_new_operation', 'preserved');
          const approval = this.journal.approval(binding.approvalId);
          if (!approval) return failure('UNKNOWN_RESULT', 'Original approval could not be verified', 'read_knowledge_approval', 'unknown');
          return this.validate(ctx, 'knowledge:write', approval.value, expected);
        }
        // Older approvals did not store changeSetId. Only one exact content hash can be safely adopted.
        const legacy = this.journal.matchingKnowledgeApprovals(ctx.workspaceId, ctx.actorId, hash);
        if (legacy.length > 1) return failure('UNKNOWN_RESULT', 'Multiple legacy approvals require explicit recovery', 'review_legacy_approvals', 'unknown');
        const registered: Result<Approval> = legacy.length ? { ok: true, data: legacy[0]! } : this.register(ctx, 'knowledge:write', expected);
        if (!registered.ok) return registered;
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'knowledge_approval', changes.id, { approvalId: registered.data.id,
          actorId: ctx.actorId, contentHash: hash, baseRevision: changes.baseRevision }, null)) throw new Error('Knowledge approval CAS failed');
        return this.validate(ctx, 'knowledge:write', registered.data, expected);
      });
    } catch { return failure('UNKNOWN_RESULT', 'Approval registration could not be verified', 'read_knowledge_approval', 'unknown'); }
  }

  readKnowledge(ctx: RequestContext, changeSetId: string): Result<KnowledgeApprovalState> {
    const access = this.sessions.authorize(ctx, 'knowledge:read'); if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure('FORBIDDEN', 'Live approval recovery requires durable storage', 'configure_operation_storage');
    if (!Id.safeParse(changeSetId).success) return failure('VALIDATION', 'A valid original changeSetId is required', 'read_original_operation');
    const state = (status: KnowledgeApprovalState['status'], approval: Approval | null = null): Result<KnowledgeApprovalState> => ({ ok: true,
      data: { changeSetId, workspaceId: ctx.workspaceId, actorId: ctx.actorId, status, approval, absenceIsFinal: false } });
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', 'knowledge_approval', changeSetId);
      if (!row) return state(this.journal.hasUnmappedKnowledgeApprovals(ctx.workspaceId, ctx.actorId) || this.journal.commit(ctx.workspaceId, changeSetId) ? 'unknown' : 'not_registered');
      const binding = KnowledgeBindingSchema.parse(row.value);
      if (binding.actorId !== ctx.actorId) return failure('FORBIDDEN', 'Original operation is unavailable for this identity', 'use_original_identity');
      const stored = this.journal.approval(binding.approvalId);
      if (!stored || stored.value.workspaceId !== ctx.workspaceId || stored.value.actorId !== ctx.actorId || stored.value.purpose !== 'commit_knowledge'
        || stored.value.contentHash !== binding.contentHash || stored.value.baseRevision !== binding.baseRevision) return state('unknown');
      return state(stored.revoked ? 'revoked' : Date.parse(stored.value.expiresAt) <= this.now() ? 'expired' : Date.parse(stored.value.approvedAt) > this.now() ? 'unknown' : 'registered',
        Date.parse(stored.value.approvedAt) > this.now() && !stored.revoked ? null : stored.value);
    } catch { return state('unknown'); }
  }

  validate(ctx: RequestContext, scope: string, supplied: Approval, expected: Pick<Approval, 'purpose' | 'objectIds' | 'contentHash' | 'baseRevision'>): Result<Approval> {
    const access = this.sessions.authorize(ctx, scope);
    if (!access.ok) return access;
    const parsed = ApprovalSchema.safeParse(supplied);
    if (!parsed.success) return failure('VALIDATION', 'Invalid approval', 'preview_and_confirm');
    const stored = this.journal.approval(parsed.data.id);
    if (!stored || stored.revoked || canonicalJson(stored.value) !== canonicalJson(parsed.data)) return failure('FORBIDDEN', 'Approval is not registered or was revoked', 'preview_and_confirm');
    const approval = stored.value;
    if (approval.actorId !== ctx.actorId || approval.workspaceId !== ctx.workspaceId || approval.purpose !== expected.purpose
      || approval.objectIds.length !== new Set(expected.objectIds).size || new Set(approval.objectIds).size !== approval.objectIds.length
      || expected.objectIds.some((id) => !approval.objectIds.includes(id))) return failure('FORBIDDEN', 'Approval does not cover this operation', 'preview_and_confirm');
    if (Date.parse(approval.expiresAt) <= this.now() || Date.parse(approval.approvedAt) > this.now()) return failure('FORBIDDEN', 'Approval expired or is not yet valid', 'preview_and_confirm');
    if (approval.contentHash !== expected.contentHash || approval.baseRevision !== expected.baseRevision) return failure('CONFLICT', 'Approved content or base version changed', 'preview_again');
    return { ok: true, data: approval };
  }

  async approveConversation(ctx: RequestContext, input: unknown): Promise<Result<Approval>> {
    const access = this.sessions.authorize(ctx, 'conversation:write');
    if (!access.ok) return access;
    const parsed = ConversationApprovalRequestSchema.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Explicit confirmation of a valid conversation is required', 'preview_and_confirm');
    const { conversation, baseRevision } = parsed.data;
    if (conversation.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'Conversation belongs to another workspace', 'select_authorized_workspace');
    if (baseRevision !== 'new' || !isNewCaptureTarget(conversation)) return failure('CONFLICT', 'This approval only supports a new selected conversation target, never the original Issue', 'create_new_capture_preview');
    const hash = await hashConversation(conversation);
    if (hash !== conversation.contentHash) return failure('CONFLICT', 'Conversation changed since preview', 'preview_again');
    const stillAuthorized = this.sessions.authorize(ctx, 'conversation:write');
    if (!stillAuthorized.ok) return stillAuthorized;
    return this.registerOperation(ctx, { purpose: 'save_conversation', objectIds: [conversation.id], contentHash: hash, baseRevision },
      { operationId: parsed.data.operationId, requestHash: await contentHash(parsed.data) });
  }

  validateConversation(ctx: RequestContext, supplied: Approval, expected: { objectId: string; contentHash: string; baseRevision: string }): Result<Approval> {
    return this.validate(ctx, 'conversation:write', supplied, { ...expected, purpose: 'save_conversation', objectIds: [expected.objectId] });
  }

  revoke(ctx: RequestContext, id: string): Result<{ revoked: boolean }> {
    const stored = this.journal.approval(id);
    const scopes = { save_conversation: 'conversation:write', commit_knowledge: 'knowledge:write', save_evidence: 'evidence:write', delete: 'data:delete', export: 'data:export', settings: 'settings:write', demo_export: 'data:export', model_input: 'workspace:read', update_index: 'knowledge:index' };
    const access = this.sessions.authorize(ctx, stored ? scopes[stored.value.purpose] : 'workspace:read');
    if (!access.ok) return access;
    if (!stored || stored.value.actorId !== ctx.actorId || stored.value.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', 'Approval is unavailable in this workspace', 'check_approval');
    this.journal.revokeApproval(id);
    return { ok: true, data: { revoked: true } };
  }
}
