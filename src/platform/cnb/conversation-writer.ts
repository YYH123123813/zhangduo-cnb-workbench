import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { ConversationSchema, type Approval, type Conversation } from '../../contracts/domain';
import { canonicalJson, contentHash, hashConversation } from '../../contracts/hash';
import { isNewCaptureTarget, type ApprovalAuthority } from '../approvals';
import type { OperationJournal, ConversationOperation } from '../journal';
import type { SessionRegistry } from '../identity';
import { failure } from '../result';
import type { CnbClient } from './client';

const EnvelopeSchema = z.object({ format: z.literal('zhangduo.conversation/v1'), marker: z.string(), conversation: ConversationSchema }).strict();
const IssueSchema = z.object({ number: z.union([z.string().regex(/^[1-9]\d*$/).transform(Number), z.number().int().positive()]), body: z.string(), invisible: z.literal(true) });
const unknownResult = (): Result<Conversation> => failure('UNKNOWN_RESULT', 'Issue save result is not yet verified; no duplicate was created', 'read_back_same_conversation', 'unknown');

export class ConversationWriter {
  constructor(private readonly sessions: SessionRegistry, private readonly client: CnbClient, private readonly journal: OperationJournal, private readonly approvals: ApprovalAuthority) {}

  private access(ctx: RequestContext, write: boolean) {
    const access = this.sessions.authorize(ctx, write ? 'conversation:write' : 'conversation:read');
    if (!access.ok) return access;
    if (ctx.mode !== this.client.mode || (ctx.mode === 'live' && this.journal.fixture)) return failure<never>('FORBIDDEN', 'Session, transport or operation storage mode is incompatible', 'configure_matching_transport');
    const config = this.client.config();
    if (!config.ok) return config;
    if (config.data.repository !== access.data.slug || access.data.visibility !== 'private') return failure<never>('FORBIDDEN', 'Only the authorized private repository is supported', 'select_private_workspace');
    if (write && (!config.data.writesAuthorized || !config.data.tokenScopes.includes('repo-issue:rw'))) return failure<never>('FORBIDDEN', 'Private Issue writes are not authorized with the required scope', 'authorize_repository_writes');
    return access;
  }

  private marker(operation: ConversationOperation) { return contentHash({ workspaceId: operation.workspaceId, conversationId: operation.objectId }); }

  private async decode(ctx: RequestContext, operation: ConversationOperation, raw: unknown): Promise<Result<Conversation>> {
    const issue = IssueSchema.safeParse(raw);
    if (!issue.success || !Number.isSafeInteger(issue.data.number)) return unknownResult();
    if (operation.issueNumber && issue.data.number !== operation.issueNumber) return unknownResult();
    let value: unknown;
    try { value = JSON.parse(issue.data.body); } catch { return unknownResult(); }
    const envelope = EnvelopeSchema.safeParse(value);
    if (!envelope.success || envelope.data.marker !== await this.marker(operation)) return unknownResult();
    const conversation = envelope.data.conversation;
    if (conversation.id !== operation.objectId || conversation.workspaceId !== ctx.workspaceId || conversation.contentHash !== operation.contentHash || await hashConversation(conversation) !== operation.contentHash) return failure('CONFLICT', 'Saved Issue content no longer matches the approved capture', 'review_remote_issue', 'preserved');
    const access = this.access(ctx, false);
    if (!access.ok) return { ok: false, error: { ...access.error, dataState: 'preserved' } };
    const saved: Conversation = { ...conversation, sourceAlreadyPersisted: true, issueNumber: issue.data.number,
      issueUrl: `https://cnb.cool/${access.data.slug}/-/issues/${issue.data.number}`, state: 'saved' };
    this.journal.update({ ...operation, state: 'done', issueNumber: issue.data.number });
    return { ok: true, data: saved };
  }

  async readConversation(ctx: RequestContext, id: string): Promise<Result<Conversation> | undefined> {
    const access = this.access(ctx, false);
    if (!access.ok) return access;
    const operation = this.journal.conversation(ctx.workspaceId, id);
    if (!operation) return undefined;
    if (operation.actorId !== ctx.actorId) return failure('FORBIDDEN', 'Capture is unavailable to this actor', 'check_capture_owner');
    if (operation.issueNumber) {
      const response = await this.client.read('repo-issue:r', `/-/issues/${operation.issueNumber}`);
      return response.ok ? this.decode(ctx, operation, response.data) : { ok: false, error: { ...response.error, dataState: 'unknown', nextAction: 'read_back_same_conversation' } };
    }
    const marker = await this.marker(operation);
    const response = await this.client.read('repo-issue:r', `/-/issues?keyword=${marker.slice(0, 12)}&page_size=100&page=1`);
    if (!response.ok || !Array.isArray(response.data) || response.data.length >= 100) return unknownResult();
    const matching: z.infer<typeof IssueSchema>[] = [];
    for (const item of response.data) {
      const summary = z.object({ number: IssueSchema.shape.number }).safeParse(item);
      if (!summary.success || !Number.isSafeInteger(summary.data.number)) return unknownResult();
      const detail = await this.client.read('repo-issue:r', `/-/issues/${summary.data.number}`);
      if (!detail.ok) return unknownResult();
      const issue = IssueSchema.safeParse(detail.data);
      if (!issue.success || issue.data.number !== summary.data.number) return unknownResult();
      try {
        const envelope = EnvelopeSchema.safeParse(JSON.parse(issue.data.body));
        if (envelope.success && envelope.data.marker === marker) matching.push(issue.data);
      } catch { /* Unrelated Issue bodies are not conversation envelopes. */ }
    }
    // No result is never treated as proof of non-existence; more than one requires manual reconciliation.
    if (matching.length !== 1) return unknownResult();
    const issue = IssueSchema.parse(matching[0]);
    return this.decode(ctx, { ...operation, issueNumber: issue.number }, issue);
  }

  async save(ctx: RequestContext, input: Conversation, approval: Approval): Promise<Result<Conversation>> {
    const access = this.access(ctx, true);
    if (!access.ok) return access;
    const readAccess = this.sessions.authorize(ctx, 'conversation:read');
    if (!readAccess.ok) return readAccess;
    const parsed = ConversationSchema.safeParse(input);
    if (!parsed.success || input.workspaceId !== ctx.workspaceId) return failure('VALIDATION', 'Invalid conversation capture', 'preview_again');
    input = parsed.data;
    const hash = await hashConversation(parsed.data);
    if (hash !== input.contentHash) return failure('CONFLICT', 'Conversation changed since preview', 'preview_again');
    const valid = this.approvals.validateConversation(ctx, approval, { objectId: input.id, contentHash: hash, baseRevision: 'new' });
    if (!valid.ok) return valid;
    const operation: ConversationOperation = { workspaceId: ctx.workspaceId, objectId: input.id, actorId: ctx.actorId, contentHash: hash, state: 'inflight' };
    const marker = await this.marker(operation);
    const body = canonicalJson({ format: 'zhangduo.conversation/v1', marker, conversation: parsed.data });
    if (Buffer.byteLength(body, 'utf8') > 1_000_000) return failure('VALIDATION', 'Capture envelope exceeds the allowed size', 'reduce_capture_scope');
    const previous = this.journal.conversation(ctx.workspaceId, input.id);
    if (!previous && !isNewCaptureTarget(input)) return failure('CONFLICT', 'A new capture must not reuse the original Issue identity or destination', 'create_new_capture_preview');
    if (previous && (previous.contentHash !== hash || previous.actorId !== ctx.actorId)) return failure('CONFLICT', 'Conversation ID has already been used for a different capture', 'create_new_capture_id', 'preserved');
    if (previous || !this.journal.claim(operation)) {
      const current = this.journal.conversation(ctx.workspaceId, input.id);
      if (!current || current.contentHash !== hash || current.actorId !== ctx.actorId) return failure('CONFLICT', 'Concurrent capture used this operation ID differently', 'create_new_capture_id', 'preserved');
      return await this.readConversation(ctx, input.id) ?? unknownResult();
    }
    const stillValid = this.approvals.validateConversation(ctx, approval, { objectId: input.id, contentHash: hash, baseRevision: 'new' });
    if (!stillValid.ok) { this.journal.releaseUnsent(operation); return stillValid; }
    const response = await this.client.createIssue({ title: `Captured conversation ${marker.slice(0, 12)}`, invisible: true,
      body });
    if (!response.ok) {
      if (response.error.dataState === 'not_written') { this.journal.releaseUnsent(operation); return response; }
      this.journal.update({ ...operation, state: 'unknown' });
      return unknownResult();
    }
    const issue = IssueSchema.safeParse(response.data);
    if (!issue.success) { this.journal.update({ ...operation, state: 'unknown' }); return unknownResult(); }
    this.journal.update({ ...operation, state: 'unknown', issueNumber: issue.data.number });
    const readback = await this.readConversation(ctx, input.id) ?? unknownResult();
    return readback.ok ? readback : { ok: false, error: { ...readback.error, dataState: readback.error.dataState === 'not_written' ? 'unknown' : readback.error.dataState } };
  }
}
