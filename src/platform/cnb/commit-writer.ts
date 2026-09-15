import { z } from 'zod';
import { ChangeSetSchema, type Approval, type ChangeSet, type CommitReceipt } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { contentHash, hashChangeSet } from '../../contracts/hash';
import type { SessionRegistry } from '../identity';
import type { OperationJournal, CommitOperation } from '../journal';
import type { ApprovalAuthority } from '../approvals';
import { failure } from '../result';
import type { CnbClient } from './client';
import type { GitPublisher } from './git-publisher';
import { GitBranch, GitSha, SnapshotReader } from './snapshot';
import { applyKnowledgeChanges, gitKnowledgeFiles, snapshotDocument } from './knowledge-document';
import { IndexOperationSchema } from '../../contracts/indexing';

const unknown = <T>(): Result<T> => failure('UNKNOWN_RESULT', 'Git publication is not verified; this operation will not be pushed again', 'read_commit', 'unknown');
export class CommitWriter {
  private readonly snapshots: SnapshotReader;
  constructor(private readonly sessions: SessionRegistry, private readonly cnb: CnbClient, private readonly journal: OperationJournal, private readonly approvals: ApprovalAuthority, private readonly git: GitPublisher) {
    this.snapshots = new SnapshotReader(sessions, cnb);
  }

  private access(ctx: RequestContext, write: boolean) {
    const access = this.sessions.authorize(ctx, write ? 'knowledge:write' : 'knowledge:read');
    if (!access.ok) return access;
    const config = this.cnb.config();
    if (!config.ok) return config;
    if (ctx.mode !== this.cnb.mode || ctx.mode !== this.git.mode || (ctx.mode === 'live' && this.journal.fixture)
      || access.data.slug !== config.data.repository || access.data.visibility !== 'private') return failure<never>('FORBIDDEN', 'Repository or transport binding does not match the trusted private workspace', 'configure_matching_transport');
    if (write && (!config.data.writesAuthorized || !config.data.tokenScopes.includes('repo-code:rw'))) return failure<never>('FORBIDDEN', 'Git publication has not been authorized', 'authorize_repository_writes');
    return access;
  }

  private receipt(operation: CommitOperation, repository: string): CommitReceipt {
    const observations = this.journal.records(operation.workspaceId, '@workspace', 'index_operation').flatMap((row) => {
      const parsed = z.object({ result: IndexOperationSchema }).safeParse(row.value);
      return parsed.success && parsed.data.result.baseRevision === operation.revision ? [parsed.data.result] : [];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const observation = observations[0];
    const indexing = observation?.state === 'current' && observation.observedIndexRevision === operation.revision && observation.observedBuildStatus === 'success' ? 'current'
      : observation?.state === 'failed' ? 'failed' : 'pending';
    return { changeSetId: operation.objectId, revision: operation.revision!, commitUrl: `https://cnb.cool/${repository}/-/commit/${operation.revision}`, indexing };
  }

  async read(ctx: RequestContext, id: string): Promise<Result<CommitReceipt | null>> {
    const access = this.access(ctx, false);
    if (!access.ok) return access;
    const operation = this.journal.commit(ctx.workspaceId, id);
    if (!operation) return { ok: true, data: null };
    if (operation.actorId !== ctx.actorId) return failure('FORBIDDEN', 'Commit operation belongs to another actor', 'check_operation_owner');
    if (operation.state === 'done') return { ok: true, data: this.receipt(operation, access.data.slug) };
    if (operation.state === 'conflict') return failure('CONFLICT', 'The remote branch rejected this base version; draft is preserved', 'preview_again', 'preserved');
    if (!operation.revision) return unknown();
    // A reachable commit, not a dangling object returned by SHA lookup, proves branch publication.
    const response = await this.cnb.read('repo-code:r', `/-/git/commits?sha=${encodeURIComponent(operation.branch)}&page=1&page_size=100`);
    if (!response.ok) return unknown();
    const commits = z.array(z.object({ sha: GitSha, parents: z.array(z.object({ sha: GitSha })), commit: z.object({ message: z.string() }) })).max(100).safeParse(response.data);
    const found = commits.success ? commits.data.find((commit) => commit.sha === operation.revision) : undefined;
    if (!found || found.parents.length !== 1 || found.parents[0]?.sha !== operation.baseRevision || found.commit.message.trim() !== operation.message) return unknown();
    const snapshot = await this.snapshots.read(ctx, operation.revision);
    if (!snapshot.ok || await contentHash(snapshotDocument(snapshot.data)) !== operation.documentHash) return unknown();
    const stillAuthorized = this.access(ctx, false);
    if (!stillAuthorized.ok) return { ok: false, error: { ...stillAuthorized.error, dataState: 'unknown' } };
    try { this.journal.finishCommit(operation); } catch { return unknown(); }
    return { ok: true, data: this.receipt(operation, access.data.slug) };
  }

  async commit(ctx: RequestContext, input: ChangeSet, approval: Approval): Promise<Result<CommitReceipt>> {
    const access = this.access(ctx, true);
    if (!access.ok) return access;
    const parsed = ChangeSetSchema.safeParse(input);
    if (!parsed.success || !GitSha.safeParse(parsed.data.baseRevision).success) return failure('VALIDATION', 'A valid ChangeSet based on a full Git SHA is required', 'preview_again');
    const changes = parsed.data;
    const affected = [...changes.nodes.map((node) => node.id), ...changes.relations.flatMap((edge) => [edge.id, edge.source.objectId, edge.target.objectId]), ...changes.withdrawnIds];
    const deletionBlocked = () => affected.some((id) => this.journal.blocked(ctx.workspaceId).includes(id));
    if (deletionBlocked()) return failure('FORBIDDEN', 'Deleted objects cannot be reactivated by an ordinary knowledge commit', 'review_delete_report');
    const hash = await hashChangeSet(changes);
    if (hash !== changes.contentHash) return failure('CONFLICT', 'ChangeSet changed since preview', 'preview_again', 'preserved');
    const expected = { purpose: 'commit_knowledge' as const, contentHash: hash, baseRevision: changes.baseRevision,
      objectIds: [...new Set([...changes.nodes.map((node) => node.id), ...changes.relations.map((edge) => edge.id), ...changes.withdrawnIds])] };
    const valid = this.approvals.validate(ctx, 'knowledge:write', approval, expected);
    if (!valid.ok) return valid;
    if (!expected.objectIds.length || changes.nodes.some((node) => !node.confirmedAt || Date.parse(node.confirmedAt) > Date.parse(valid.data.approvedAt))) return failure('VALIDATION', 'Confirmed knowledge must precede the submission approval', 'preview_and_confirm');
    const previous = this.journal.commit(ctx.workspaceId, changes.id);
    if (previous) {
      if (previous.contentHash !== hash || previous.actorId !== ctx.actorId) return failure('CONFLICT', 'ChangeSet ID was already used for different content', 'create_new_operation', 'preserved');
      const recovered = await this.read(ctx, changes.id);
      return recovered.ok ? recovered.data ? { ok: true, data: recovered.data } : unknown() : recovered;
    }
    const head = await this.cnb.read('repo-code:r', '/-/git/head');
    if (!head.ok) return head;
    const branch = z.object({ name: GitBranch }).safeParse(head.data);
    if (!branch.success) return failure('UPSTREAM', 'Default Git branch cannot be verified', 'check_repository');
    const snapshot = await this.snapshots.read(ctx);
    if (!snapshot.ok) return snapshot;
    const planned = applyKnowledgeChanges(ctx, snapshot.data, changes);
    if (!planned.ok) return planned;
    const operation: CommitOperation = { workspaceId: ctx.workspaceId, objectId: changes.id, actorId: ctx.actorId, contentHash: hash,
      baseRevision: changes.baseRevision, branch: branch.data.name, state: 'inflight', documentHash: await contentHash(planned.data), objectIds: expected.objectIds,
      message: `zhangduo-knowledge ${await contentHash({ workspaceId: ctx.workspaceId, changeSetId: changes.id, contentHash: hash })}` };
    if (!this.journal.claimCommit(operation)) return unknown();
    const beforePrepare = this.approvals.validate(ctx, 'knowledge:write', approval, expected);
    if (!beforePrepare.ok) { this.journal.releaseUnsentCommit(operation); return beforePrepare; }
    let prepared: Awaited<ReturnType<GitPublisher['prepare']>>;
    try { prepared = await this.git.prepare({ repository: access.data.slug, branch: operation.branch, baseRevision: changes.baseRevision, files: gitKnowledgeFiles(planned.data), message: operation.message }); }
    catch { this.journal.releaseUnsentCommit(operation); return failure('UPSTREAM', 'Git preparation failed before publication', 'retry_preparation', 'preserved'); }
    if (!prepared.ok) { this.journal.releaseUnsentCommit(operation); return prepared; }
    if (!GitSha.safeParse(prepared.data.revision).success || !/^[a-f0-9]{64}$/.test(prepared.data.stagingKey)) { this.journal.releaseUnsentCommit(operation); return failure('UPSTREAM', 'Prepared Git object could not be verified', 'check_git_transport'); }
    const beforePublish = this.access(ctx, true);
    const finalApproval = this.approvals.validate(ctx, 'knowledge:write', approval, expected);
    if (deletionBlocked()) { this.journal.releaseUnsentCommit(operation); return failure('FORBIDDEN', 'An application deletion barrier was applied during preparation', 'review_delete_report'); }
    if (!beforePublish.ok || !finalApproval.ok) { this.journal.releaseUnsentCommit(operation); return !beforePublish.ok ? beforePublish : finalApproval as Result<never>; }
    const sending: CommitOperation = { ...operation, ...prepared.data, state: 'sending' };
    this.journal.updateCommit(sending);
    try {
      const published = await this.git.publish({ repository: access.data.slug, branch: operation.branch, baseRevision: changes.baseRevision, ...prepared.data });
      if (!published.ok) {
        if (published.error.dataState === 'not_written' && published.error.code !== 'CONFLICT') {
          this.journal.updateCommit(operation); this.journal.releaseUnsentCommit(operation);
          return { ok: false, error: { ...published.error, dataState: 'preserved' } };
        }
        this.journal.updateCommit({ ...sending, state: published.error.code === 'CONFLICT' && published.error.dataState === 'not_written' ? 'conflict' : 'unknown' });
        return published.error.code === 'CONFLICT' && published.error.dataState === 'not_written'
          ? { ok: false, error: { ...published.error, dataState: 'preserved' } } : unknown();
      }
    } catch { this.journal.updateCommit({ ...sending, state: 'unknown' }); return unknown(); }
    const recovered = await this.read(ctx, changes.id);
    return recovered.ok ? recovered.data ? { ok: true, data: recovered.data } : unknown() : { ok: false, error: { ...recovered.error, dataState: 'unknown' } };
  }
}
