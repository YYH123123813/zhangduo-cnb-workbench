import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createServices } from '../services';
import { CnbClient, readServerConfig } from './client';
import { indexFiles, indexPath, gitKnowledgeFiles } from './knowledge-document';
import { hashChangeSet } from '../../contracts/hash';
import type { Result } from '../../contracts/api';
import type { IndexPlan } from '../../contracts/indexing';
import { createApp } from '../../server/app';

const close: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); close.splice(0).forEach((fn) => fn()); });
function data<T>(result: Result<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(result.error.message); return result.data; }

async function setup() {
  const f = await platformFixture(); close.push(() => f.journal.close());
  const files = gitKnowledgeFiles(f.initial);
  let authorized = true, triggerLost = false, status = 'running', indexedCommit = '', include = '', triggers = 0;
  const baseTransport = f.transport.getMockImplementation()!;
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/knowledge/embedding/models')) return Response.json([{ name: 'synthetic-embedding', dimension: 1024 }]);
    if (url.pathname.endsWith('/build/start')) {
      triggers += 1; const body = JSON.parse(String(init?.body));
      expect(body.sha).toBe(f.base); expect(body.event).toBe('api_trigger_zhangduo_index');
      expect(body.config).not.toContain('PRIVATE_QUERY');
      const config = JSON.parse(body.config), options = config['**'].api_trigger_zhangduo_index[0].stages.at(-1).options;
      expect(options.issueSyncEnabled).toBe(false); expect(options.ignoreProcessFailures).toBe(false); expect(options.forceRebuild).toBe(false); include = options.include;
      if (triggerLost) throw Error('synthetic lost response');
      return Response.json({ sn: 'synthetic-build-1', success: true, buildLogUrl: 'https://cnb.cool/fixture/platform/-/build/synthetic-build-1' });
    }
    if (url.pathname.endsWith('/build/status/synthetic-build-1')) return Response.json({ status });
    if (url.pathname.endsWith('/knowledge/base')) return Response.json({ id: 'synthetic-kb', last_commit_sha: indexedCommit, include, exclude: '', issue_sync_enabled: false, embedding_model: { name: 'synthetic-embedding', dimension: 1024 } });
    const path = decodeURIComponent(url.pathname.split('/-/git/contents/')[1] ?? '');
    if (path.startsWith('knowledge-index/')) {
      const text = files[path]; if (!text) return Response.json({}, { status: 404 });
      const bytes = Buffer.from(text);
      return Response.json({ type: 'blob', path, encoding: 'base64', content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
    }
    return baseTransport(input, init);
  });
  const env = () => ({ CNB_REPO_SLUG: 'fixture/platform', CNB_TOKEN: 'synthetic-secret', CNB_TOKEN_SCOPES: 'repo-code:rw,repo-cnb-trigger:rw',
    CNB_LIVE_READS_FOR: 'fixture/platform', CNB_LIVE_INDEX_FOR: authorized ? 'fixture/platform' : '', CNB_INDEX_EMBEDDING_MODEL: 'synthetic-embedding' });
  const services = createServices({ ...f.options, cnb: new CnbClient(() => readServerConfig(env()), transport) });
  return { ...f, services, files, transport, revoke: () => { authorized = false; }, lose: () => { triggerLost = true; },
    finish: () => { status = 'success'; indexedCommit = f.base; }, fail: () => { status = 'failed'; }, observe: (value: string) => { status = value; }, triggers: () => triggers };
}

describe('W08 controlled index update, synthetic CNB build and index responses, NOT verified_live', () => {
  it('does not classify an unrecognized upstream status as a pending build', async () => {
    const f = await setup();
    const plan = data(await f.services.previewIndexUpdate!(f.ctx, { operationId: 'index-unrecognized', baseRevision: f.base }));
    const approval = data(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: true }));
    await f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval });
    f.observe('unrecognized-upstream-state');
    expect(data(await f.services.readIndexOperation!(f.ctx, plan.operationId))).toMatchObject({ state: 'unknown', observedBuildStatus: 'unrecognized-upstream-state' });
    expect(f.triggers()).toBe(1);
  });
  it('serves an actionable shared HTTP status without inventing pending or current before authorization', async () => {
    const f = await setup(), app = createApp(f.services);
    const initial = await app.request('/api/workspace/index/status', { headers: f.headers });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ ok: true, data: { baseRevision: f.base, state: 'not_requested', updateAuthorized: true } });
    const preview = await app.request('/api/workspace/index/preview', { method: 'POST', headers: f.headers, body: JSON.stringify({ operationId: 'http-index', baseRevision: f.base }) });
    expect(preview.status).toBe(200); expect(f.triggers()).toBe(0);
  });
  it('allows one concurrent dispatcher and rolls back a failed approval receipt', async () => {
    const f = await setup();
    const plan = data(await f.services.previewIndexUpdate!(f.ctx, { operationId: 'index-concurrent', baseRevision: f.base }));
    const recordApproval = vi.spyOn(f.journal, 'recordApproval');
    const put = f.journal.putRecord.bind(f.journal);
    const fault = vi.spyOn(f.journal, 'putRecord').mockImplementation((...args) => args[2] === 'index_operation' ? false : put(...args));
    expect(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: true })).toMatchObject({ ok: false });
    expect(f.journal.approval(recordApproval.mock.calls[0]![0].id)).toBeUndefined(); fault.mockRestore();
    const approval = data(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: true }));
    await Promise.all([f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval }), f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval })]);
    expect(f.triggers()).toBe(1);
  });
  it('blocks a revoked server index authorization before dispatch', async () => {
    const f = await setup();
    const plan = data(await f.services.previewIndexUpdate!(f.ctx, { operationId: 'index-revoked', baseRevision: f.base }));
    const approval = data(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: true })); f.revoke();
    expect(await f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval })).toMatchObject({ ok: false });
    expect(f.triggers()).toBe(0);
  });
  it('generates only whitelisted formal knowledge files in the actual Git preparation payload', async () => {
    const f = await setup();
    const writer = createServices(f.options);
    const changes = { id: 'index-preparation', workspaceId: f.ctx.workspaceId, baseRevision: f.base,
      nodes: [{ ...f.node, revision: f.base, humanStatement: 'Human-approved formal publication' }], relations: [], withdrawnIds: [], reason: 'Publish knowledge', contentHash: 'pending' };
    changes.contentHash = await hashChangeSet(changes);
    const approval = data(await writer.approveKnowledge!(f.ctx, { changes, confirmed: true }));
    data(await writer.commit(f.ctx, changes, approval));
    const prepared = vi.mocked(f.git.prepare).mock.calls[0]![0].files;
    expect(prepared[indexPath(f.node.id)]).toContain('Human-approved formal publication');
    expect(prepared['knowledge/snapshot.json']).toContain('Human-approved formal publication');
    expect(f.triggers()).toBe(0);
  });
  it('requires a separate approval, dispatches once, and marks current only after exact readback', async () => {
    const f = await setup();
    const plan = data(await f.services.previewIndexUpdate!(f.ctx, { operationId: 'index-original', baseRevision: f.base }));
    expect(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: false } as never)).toMatchObject({ ok: false });
    expect(f.triggers()).toBe(0);
    const approval = data(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: true }));
    const dispatched = data(await f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval }));
    expect(dispatched).toMatchObject({ state: 'pending', baseRevision: f.base, buildSn: 'synthetic-build-1' });
    data(await f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval })); expect(f.triggers()).toBe(1);
    f.finish();
    expect(data(await f.services.readIndexOperation!(f.ctx, plan.operationId))).toMatchObject({ state: 'current', baseRevision: f.base, observedIndexRevision: f.base });
    expect(f.triggers()).toBe(1);
  });
  it.each(['lost', 'failed', 'blocked'] as const)('preserves Git data and never automatically retries after %s', async (kind) => {
    const f = await setup(); const original = JSON.stringify(f.documents.get(f.base));
    const plan = data(await f.services.previewIndexUpdate!(f.ctx, { operationId: `index-${kind}`, baseRevision: f.base }));
    const approval = data(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: true }));
    if (kind === 'lost') f.lose();
    await f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval });
    if (kind === 'failed') f.fail();
    if (kind === 'blocked') { f.journal.block(f.ctx.workspaceId, ['k1'], 'synthetic-delete'); f.finish(); }
    const read = data(await f.services.readIndexOperation!(f.ctx, plan.operationId));
    expect(read?.state).toBe(kind === 'failed' ? 'failed' : 'unknown');
    await f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval });
    expect(f.triggers()).toBe(1); expect(JSON.stringify(f.documents.get(f.base))).toBe(original);
  });
  it('rejects tampered files, a changed plan, scope changes and revoked approval before dispatch', async () => {
    const f = await setup(); const query = { operationId: 'index-guarded', baseRevision: f.base };
    const plan = data(await f.services.previewIndexUpdate!(f.ctx, query));
    expect(await f.services.approveIndexUpdate!(f.ctx, { plan: { ...plan, contentHash: 'b'.repeat(64) } as IndexPlan, confirmed: true })).toMatchObject({ ok: false });
    const approval = data(await f.services.approveIndexUpdate!(f.ctx, { plan, confirmed: true }));
    data(await f.services.revokeApproval!(f.ctx, approval.id));
    expect(await f.services.executeIndexUpdate!(f.ctx, { operationId: plan.operationId, approval })).toMatchObject({ ok: false });
    f.files[Object.keys(indexFiles(f.initial))[0]!] = 'PRIVATE_QUERY';
    expect(await f.services.previewIndexUpdate!(f.ctx, { ...query, operationId: 'bad-files' })).toMatchObject({ ok: false });
    expect(f.triggers()).toBe(0);
  });
});
