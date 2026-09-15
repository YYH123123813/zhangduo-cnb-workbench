import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { ConversationSchema, type Conversation } from '../../contracts/domain';
import { contentHash, hashConversation, normalizeSourceText } from '../../contracts/hash';
import type { SessionRegistry } from '../identity';
import { failure } from '../result';
import type { CnbClient } from './client';

const IssueSchema = z.object({
  number: z.union([z.string().regex(/^[1-9]\d*$/).transform(Number), z.number().int().positive()]),
  title: z.string().max(4096), body: z.string().max(1_000_000), created_at: z.string().datetime({ offset: true }),
  invisible: z.boolean(),
});

export class IssueReader {
  constructor(private readonly sessions: SessionRegistry, private readonly client: CnbClient) {}

  private async idPrefix(workspaceId: string) { return `cnb-issue:${(await contentHash(workspaceId)).slice(0, 24)}:`; }

  async readIssue(ctx: RequestContext, issueNumber: number): Promise<Result<Conversation>> {
    const access = this.sessions.authorize(ctx, 'conversation:read');
    if (!access.ok) return access;
    if (ctx.mode !== this.client.mode) return failure('FORBIDDEN', 'Session and CNB transport modes do not match', 'configure_matching_transport');
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return failure('VALIDATION', 'Issue number must be a positive safe integer', 'check_issue_number');
    const config = this.client.config();
    if (!config.ok) return config;
    if (config.data.repository !== access.data.slug) return failure('FORBIDDEN', 'CNB connection belongs to another workspace', 'select_authorized_workspace');
    const response = await this.client.read('repo-issue:r', `/-/issues/${issueNumber}`);
    if (!response.ok) return response;
    const issue = IssueSchema.safeParse(response.data);
    if (!issue.success || issue.data.number !== issueNumber) return failure('UPSTREAM', 'CNB Issue response could not be verified', 'verify_issue_schema');
    const id = `${await this.idPrefix(ctx.workspaceId)}${issueNumber}`;
    const segments: Conversation['segments'] = [];
    for (const [part, raw] of [['title', issue.data.title], ['body', issue.data.body]] as const) {
      const text = normalizeSourceText(raw);
      segments.push({ id: `${part}:${(await contentHash({ id, part, text })).slice(0, 24)}`, role: 'source', text });
    }
    const conversation: Conversation = {
      id, workspaceId: ctx.workspaceId, taskId: `task:${id}`, origin: 'cnb_issue', issueNumber,
      issueUrl: `https://cnb.cool/${access.data.slug}/-/issues/${issueNumber}`, sourceAlreadyPersisted: true,
      segments, contentHash: 'pending', createdAt: issue.data.created_at, state: 'saved',
    };
    conversation.contentHash = await hashConversation(conversation);
    const stillAuthorized = this.sessions.authorize(ctx, 'conversation:read');
    if (!stillAuthorized.ok) return stillAuthorized;
    const parsed = ConversationSchema.safeParse(conversation);
    return parsed.success ? { ok: true, data: parsed.data } : failure('UPSTREAM', 'CNB Issue cannot be represented safely', 'verify_issue_schema');
  }

  async readConversation(ctx: RequestContext, id: string): Promise<Result<Conversation>> {
    const access = this.sessions.authorize(ctx, 'conversation:read');
    if (!access.ok) return access;
    const prefix = await this.idPrefix(ctx.workspaceId);
    if (!id.startsWith(prefix) || !/^[1-9]\d*$/.test(id.slice(prefix.length))) return failure('FORBIDDEN', 'Conversation is unavailable in this workspace', 'select_authorized_conversation');
    return this.readIssue(ctx, Number(id.slice(prefix.length)));
  }
}
