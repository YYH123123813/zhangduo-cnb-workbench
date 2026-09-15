import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { ApprovalSchema, Id, type Approval } from '../../contracts/domain';
import { canonicalJson, contentHash } from '../../contracts/hash';
import { IndexApprovalRequestSchema, IndexExecutionRequestSchema, IndexOperationSchema, IndexPlanSchema, IndexPreviewRequestSchema,
  type IndexOperation, type IndexPlan, type IndexStatus } from '../../contracts/indexing';
import type { Services } from '../../contracts/ports';
import type { SessionRegistry } from '../identity';
import type { OperationJournal } from '../journal';
import type { ApprovalAuthority } from '../approvals';
import { failure } from '../result';
import type { CnbClient } from './client';
import { GitSha } from './snapshot';
import { indexFiles, snapshotDocument } from './knowledge-document';

const Stored = z.object({ plan: IndexPlanSchema, approval: ApprovalSchema, result: IndexOperationSchema }).strict();
const expected = (plan: IndexPlan) => ({ purpose: 'update_index' as const, objectIds: plan.objectIds, baseRevision: plan.baseRevision, contentHash: plan.contentHash });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function indexBuildConfiguration(plan: IndexPlan): string {
  // Fixed server-owned code verifies checked-out bytes. No repository script or user-authored command is executed.
  const code = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');const p=${JSON.stringify({ files: plan.files, base: plan.baseRevision })};if(cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==p.base)throw Error('commit mismatch');for(const f of p.files){if(!fs.lstatSync(f.path).isFile()||crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256)throw Error('index bytes mismatch')}`;
  return JSON.stringify({ '**': { api_trigger_zhangduo_index: [{ name: 'zhangduo-controlled-index', docker: { image: 'node:24' }, stages: [
    { name: 'verify-approved-index-files', script: `node -e '${code.replaceAll("'", "'\\''")}'` },
    { name: 'update-approved-index', type: 'knowledge:update', options: { include: plan.files.map((f) => f.path).join(','), exclude: '',
      embeddingModel: plan.embeddingModel, issueSyncEnabled: false, forceRebuild: false, ignoreProcessFailures: false } },
  ] }] } });
}

export class IndexUpdateStore {
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal, private readonly approvals: ApprovalAuthority,
    private readonly cnb: CnbClient, private readonly snapshot: Services['snapshot']) {}
  private access(ctx: RequestContext, write: boolean) {
    const permission = this.sessions.authorize(ctx, write ? 'knowledge:index' : 'knowledge:read'); if (!permission.ok) return permission;
    const config = this.cnb.config(); if (!config.ok) return config;
    if (permission.data.visibility !== 'private' || permission.data.slug !== config.data.repository || ctx.mode !== this.cnb.mode || (ctx.mode === 'live' && this.journal.fixture))
      return failure<never>('FORBIDDEN', 'Index connection must match the private workspace', 'connect_workspace');
    if (write && (!config.data.indexAuthorized || !config.data.embeddingModel || !config.data.tokenScopes.includes('repo-cnb-trigger:rw')))
      return failure<never>('NOT_CONFIGURED', 'A separate index authorization, embedding model and trigger scope are required', 'configure_index_update');
    return permission;
  }
  async preview(ctx: RequestContext, input: unknown): Promise<Result<IndexPlan>> {
    const access = this.access(ctx, true); if (!access.ok) return access;
    const parsed = IndexPreviewRequestSchema.safeParse(input); if (!parsed.success) return failure('VALIDATION', 'An original index operation ID and base Commit are required', 'preview_index_update');
    const config = this.cnb.config(); if (!config.ok) return config;
    try {
      const snapshot = await this.snapshot(ctx); if (!snapshot.ok) return snapshot;
      if (snapshot.data.revision !== parsed.data.baseRevision) return failure('CONFLICT', 'The index base Commit changed', 'preview_index_update', 'preserved');
      const generated = indexFiles(snapshotDocument(snapshot.data)), paths = Object.keys(generated).sort();
      if (!paths.length || paths.length > 100) return failure('VALIDATION', 'Controlled indexing supports 1 to 100 eligible knowledge documents per snapshot', 'review_index_scope');
      const models = await this.cnb.read('repo-code:r', '/-/knowledge/embedding/models'); if (!models.ok) return models;
      const parsedModels = z.array(z.object({ name: z.string(), dimension: z.number().int().positive() })).safeParse(models.data);
      if (!parsedModels.success || !parsedModels.data.some((m) => m.name === config.data.embeddingModel)) return failure('NOT_CONFIGURED', 'The selected embedding model was not returned by CNB', 'verify_embedding_model');
      for (const path of paths) {
        const response = await this.cnb.read('repo-code:r', `/-/git/contents/${path}?ref=${snapshot.data.revision}`); if (!response.ok) return response;
        const blob = z.object({ type: z.literal('blob'), path: z.literal(path), encoding: z.literal('base64'), content: z.string().max(1_400_000), sha: GitSha }).safeParse(response.data);
        if (!blob.success) return failure('CONFLICT', 'Approved index files must exist in the selected Commit', 'commit_generated_index_files', 'preserved');
        const encoded = blob.data.content.replace(/\r?\n/g, ''), bytes = Buffer.from(encoded, 'base64');
        const gitHash = createHash(blob.data.sha.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (bytes.toString('base64') !== encoded || gitHash !== blob.data.sha || !bytes.equals(Buffer.from(generated[path]!)))
          return failure('CONFLICT', 'Git index files differ from the approved knowledge whitelist', 'commit_generated_index_files', 'preserved');
      }
      const current = await this.snapshot(ctx); if (!current.ok) return current;
      if (current.data.revision !== snapshot.data.revision || canonicalJson(indexFiles(snapshotDocument(current.data))) !== canonicalJson(generated))
        return failure('CONFLICT', 'Knowledge or deletion scope changed during index preview', 'preview_index_update', 'preserved');
      const final = this.access(ctx, true); if (!final.ok) return final;
      const files = paths.map((path) => ({ path, sha256: sha256(generated[path]!), bytes: Buffer.byteLength(generated[path]!) }));
      const base = { ...parsed.data, workspaceId: ctx.workspaceId, actorId: ctx.actorId, embeddingModel: config.data.embeddingModel!, files,
        objectIds: snapshot.data.nodes.filter((n) => n.confirmation === 'confirmed' && n.lifecycle === 'active' && !snapshot.data.excludedIds.includes(n.id)).map((n) => n.id).sort(),
        totalBytes: files.reduce((n, f) => n + f.bytes, 0), issueSyncEnabled: false as const, forceRebuild: false as const, ignoreProcessFailures: false as const };
      return { ok: true, data: IndexPlanSchema.parse({ ...base, contentHash: await contentHash(base) }) };
    } catch { return failure('UPSTREAM', 'Index input could not be verified; Git knowledge is unchanged', 'preview_index_update', 'preserved'); }
  }
  async approve(ctx: RequestContext, input: unknown): Promise<Result<Approval>> {
    const parsed = IndexApprovalRequestSchema.safeParse(input); if (!parsed.success) return failure('VALIDATION', 'Confirm the independent index scope and pipeline resource use', 'confirm_index_update');
    const plan = parsed.data.plan;
    const verified = await this.preview(ctx, { operationId: plan.operationId, baseRevision: plan.baseRevision }); if (!verified.ok) return verified;
    if (canonicalJson(verified.data) !== canonicalJson(plan)) return failure('CONFLICT', 'The index plan changed', 'preview_index_update', 'preserved');
    try {
      return this.journal.transaction(() => {
        const final = this.access(ctx, true); if (!final.ok) return final;
        if (plan.objectIds.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return failure('FORBIDDEN', 'Index scope was blocked', 'review_delete_report');
        const prior = this.journal.record(ctx.workspaceId, '@workspace', 'index_operation', plan.operationId);
        if (prior) {
          const original = Stored.parse(prior.value);
          if (canonicalJson(original.plan) !== canonicalJson(plan)) return failure('CONFLICT', 'Index operation ID already belongs to another plan', 'read_index_operation', 'preserved');
          return this.approvals.validate(ctx, 'knowledge:index', original.approval, expected(plan));
        }
        const approval = this.approvals.register(ctx, 'knowledge:index', expected(plan)); if (!approval.ok) return approval;
        const result = IndexOperationSchema.parse({ operationId: plan.operationId, workspaceId: ctx.workspaceId, actorId: ctx.actorId, baseRevision: plan.baseRevision,
          planHash: plan.contentHash, approvalId: approval.data.id, state: 'approved', reason: 'independent_approval_registered', buildSn: null,
          observedIndexRevision: null, observedBuildStatus: null, updatedAt: new Date().toISOString(), dispatchedAt: null, readOnly: true, retryAllowed: false, physicalPruning: 'unverified' });
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'index_operation', plan.operationId, { plan, approval: approval.data, result }, null)) throw Error('Index approval conflict');
        return approval;
      });
    } catch { return failure('UNKNOWN_RESULT', 'Original index approval could not be verified', 'read_index_operation', 'unknown'); }
  }
  async execute(ctx: RequestContext, input: unknown): Promise<Result<IndexOperation>> {
    const access = this.access(ctx, true); if (!access.ok) return access;
    const parsed = IndexExecutionRequestSchema.safeParse(input); if (!parsed.success) return failure('VALIDATION', 'The original index operation and approval are required', 'read_index_operation');
    const row = this.journal.record(ctx.workspaceId, '@workspace', 'index_operation', parsed.data.operationId);
    if (!row) return failure('CONFLICT', 'The original index approval is missing', 'read_index_operation', 'preserved');
    const stored = Stored.parse(row.value);
    if (stored.plan.actorId !== ctx.actorId || canonicalJson(stored.approval) !== canonicalJson(parsed.data.approval)) return failure('FORBIDDEN', 'The original index approval belongs to another operation', 'read_index_operation');
    if (stored.result.state !== 'approved') {
      const original = await this.read(ctx, stored.plan.operationId);
      return original.ok && original.data ? { ok: true, data: original.data } : original as Result<IndexOperation>;
    }
    const valid = this.approvals.validate(ctx, 'knowledge:index', parsed.data.approval, expected(stored.plan)); if (!valid.ok) return valid;
    const current = await this.preview(ctx, { operationId: stored.plan.operationId, baseRevision: stored.plan.baseRevision }); if (!current.ok) return current;
    if (canonicalJson(current.data) !== canonicalJson(stored.plan)) return failure('CONFLICT', 'Index scope changed after approval', 'preview_index_update', 'preserved');
    try {
      const claimed = this.journal.transaction((): Result<true> => {
        const final = this.access(ctx, true); if (!final.ok) return final;
        const approval = this.approvals.validate(ctx, 'knowledge:index', parsed.data.approval, expected(stored.plan)); if (!approval.ok) return approval;
        if (stored.plan.objectIds.some((id) => this.journal.blocked(ctx.workspaceId).includes(id))) return failure('FORBIDDEN', 'Index scope was blocked', 'review_delete_report');
        const operations = this.journal.records(ctx.workspaceId, '@workspace', 'index_operation').map((r) => Stored.parse(r.value));
        if (operations.some((o) => o.plan.operationId !== stored.plan.operationId && ['pending', 'unknown'].includes(o.result.state)))
          return failure('CONFLICT', 'Another index update remains pending or unknown', 'read_index_operation', 'preserved');
        if (operations.filter((o) => o.result.dispatchedAt?.slice(0, 10) === new Date().toISOString().slice(0, 10)).length >= 3)
          return failure('FORBIDDEN', 'The daily controlled index update budget is exhausted', 'wait_for_index_budget');
        const result: IndexOperation = { ...stored.result, state: 'pending', reason: 'dispatch_claimed', updatedAt: new Date().toISOString(), dispatchedAt: new Date().toISOString() };
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'index_operation', stored.plan.operationId, { ...stored, result }, row.version))
          return failure('CONFLICT', 'Index operation was claimed concurrently', 'read_index_operation', 'preserved');
        return { ok: true, data: true };
      });
      if (!claimed.ok) return claimed;
      const dispatched = await this.cnb.startIndexBuild({ sha: stored.plan.baseRevision, config: indexBuildConfiguration(stored.plan), title: `zhangduo-index ${stored.plan.contentHash}` });
      const trigger = dispatched.ok ? z.object({ success: z.boolean(), sn: Id.optional() }).safeParse(dispatched.data) : null;
      const finalRow = this.journal.record(ctx.workspaceId, '@workspace', 'index_operation', stored.plan.operationId)!;
      const result: IndexOperation = { ...Stored.parse(finalRow.value).result, state: trigger?.success && trigger.data.success && trigger.data.sn ? 'pending' : trigger?.success && !trigger.data.success ? 'failed' : 'unknown',
        reason: trigger?.success && trigger.data.success && trigger.data.sn ? 'build_accepted' : trigger?.success && !trigger.data.success ? 'trigger_rejected' : 'trigger_unverified', buildSn: trigger?.success ? trigger.data.sn ?? null : null, updatedAt: new Date().toISOString() };
      if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'index_operation', stored.plan.operationId, { ...stored, result }, finalRow.version)) throw Error('Index dispatch receipt conflict');
      return this.read(ctx, stored.plan.operationId) as Promise<Result<IndexOperation>>;
    } catch { return failure('UNKNOWN_RESULT', 'Index dispatch could not be verified; do not trigger it again', 'read_index_operation', 'unknown'); }
  }
  list(ctx: RequestContext): Result<IndexOperation[]> {
    const access = this.access(ctx, false); if (!access.ok) return access;
    try { return { ok: true, data: this.journal.records(ctx.workspaceId, '@workspace', 'index_operation').map((r) => Stored.parse(r.value).result).filter((r) => r.actorId === ctx.actorId) }; }
    catch { return failure('INTERNAL', 'Index operation records could not be verified', 'read_index_operation'); }
  }
  async status(ctx: RequestContext): Promise<Result<IndexStatus>> {
    const access = this.access(ctx, false); if (!access.ok) return access;
    const snapshot = await this.snapshot(ctx); if (!snapshot.ok) return snapshot;
    const listed = this.list(ctx); if (!listed.ok) return listed;
    const operations = [...listed.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const original = operations.find((o) => o.baseRevision === snapshot.data.revision);
    let state: IndexStatus['state'] = 'not_requested';
    if (original) {
      const observed = await this.read(ctx, original.operationId); if (!observed.ok) return observed;
      if (observed.data) { state = observed.data.state; operations[operations.indexOf(original)] = observed.data; }
    }
    const current = await this.snapshot(ctx); if (!current.ok) return current;
    if (current.data.revision !== snapshot.data.revision) return failure('CONFLICT', 'The current Git Commit changed during index readback', 'read_index_status', 'preserved');
    const config = this.cnb.config(); if (!config.ok) return config;
    return { ok: true, data: { baseRevision: snapshot.data.revision, state, operations,
      updateAuthorized: this.access(ctx, true).ok, embeddingModel: config.data.embeddingModel ?? null } };
  }
  async read(ctx: RequestContext, id: string): Promise<Result<IndexOperation | null>> {
    const access = this.access(ctx, false); if (!access.ok) return access;
    if (!Id.safeParse(id).success) return failure('VALIDATION', 'Invalid original index operation', 'read_index_operation');
    try {
      const row = this.journal.record(ctx.workspaceId, '@workspace', 'index_operation', id); if (!row) return { ok: true, data: null };
      const stored = Stored.parse(row.value); if (stored.result.actorId !== ctx.actorId) return failure('FORBIDDEN', 'Index operation is unavailable to this actor', 'connect_original_workspace');
      let result = stored.result;
      if (result.state === 'pending' && !result.buildSn) result = { ...result, state: 'unknown', reason: 'dispatch_result_unknown' };
      if (stored.plan.objectIds.some((objectId) => this.journal.blocked(ctx.workspaceId).includes(objectId))) result = { ...result, state: 'unknown', reason: 'deletion_barrier_active' };
      else if (result.buildSn && !['approved', 'failed'].includes(result.state)) {
        const build = await this.cnb.read('repo-cnb-trigger:r', `/-/build/status/${encodeURIComponent(result.buildSn)}`);
        const info = await this.cnb.read('repo-code:r', '/-/knowledge/base');
        const status = build.ok ? z.object({ status: z.string().max(160) }).safeParse(build.data) : null;
        const meta = info.ok ? z.object({ last_commit_sha: GitSha, include: z.string(), exclude: z.string(), issue_sync_enabled: z.boolean(), embedding_model: z.object({ name: z.string() }) }).safeParse(info.data) : null;
        const exact = meta?.success && meta.data.last_commit_sha === stored.plan.baseRevision && meta.data.include === stored.plan.files.map((f) => f.path).join(',')
          && meta.data.exclude === '' && !meta.data.issue_sync_enabled && meta.data.embedding_model.name === stored.plan.embeddingModel;
        result = { ...result, observedBuildStatus: status?.success ? status.data.status : null, observedIndexRevision: meta?.success ? meta.data.last_commit_sha : null,
          state: status?.success && ['failed', 'cancelled', 'canceled', 'error'].includes(status.data.status) ? 'failed'
            : status?.success && status.data.status === 'success' && exact ? 'current' : status?.success && ['pending', 'queued', 'waiting', 'running'].includes(status.data.status) ? 'pending' : 'unknown',
          reason: status?.success && status.data.status === 'success' && exact ? 'commit_scope_and_build_verified' : 'awaiting_exact_readback' };
      }
      const final = this.access(ctx, false); if (!final.ok) return final;
      if (stored.plan.objectIds.some((objectId) => this.journal.blocked(ctx.workspaceId).includes(objectId))) result = { ...result, state: 'unknown', reason: 'deletion_barrier_active' };
      if (canonicalJson(result) !== canonicalJson(stored.result)) {
        result = { ...result, updatedAt: new Date().toISOString() };
        if (!this.journal.putRecord(ctx.workspaceId, '@workspace', 'index_operation', id, { ...stored, result }, row.version)) return failure('CONFLICT', 'A competing read updated the index receipt', 'read_index_operation', 'preserved');
      }
      return { ok: true, data: result };
    } catch { return failure('UNKNOWN_RESULT', 'The original index result could not be verified', 'read_index_operation', 'unknown'); }
  }
}
