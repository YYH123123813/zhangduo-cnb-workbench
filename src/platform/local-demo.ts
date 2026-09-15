import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { z } from 'zod';
import { KnowledgeNodeSchema, type KnowledgeNode } from '../contracts/domain';
import { LOCAL_DEMO_KEY } from '../contracts/runtime';
import { SCOPES } from '../contracts/scopes';
import { canonicalJson } from '../contracts/hash';
import { ReviewQuestionSchema } from '../contracts/review-session';
import { createRuntime, type ServerRuntime, type RuntimeFixtures } from './runtime';
import { OperationJournal } from './journal';
import { GitKnowledgeDocumentSchema } from './cnb/snapshot';
import { indexFiles, gitKnowledgeFiles } from './cnb/knowledge-document';
import type { GitPublisher } from './cnb/git-publisher';
import { failure } from './result';

export { LOCAL_DEMO_KEY } from '../contracts/runtime';
const REPO = 'synthetic/zhangduo', WORKSPACE = 'cnb-repo:local-demo', ACTOR = 'cnb-user:local-demo';
const hash = (text: string, algorithm = 'sha256') => createHash(algorithm).update(text).digest('hex');
const Commit = z.object({ sha: z.string(), parents: z.array(z.string()), message: z.string(), paths: z.array(z.string()), stagingKey: z.string() });
const Issue = z.object({ number: z.number().int().positive(), title: z.string(), body: z.string(), invisible: z.literal(true), created_at: z.string() });
const Build = z.object({ sn: z.string(), sha: z.string(), include: z.string(), model: z.literal('synthetic-local'), state: z.enum(['running', 'success', 'failed']), startedAt: z.number() });

export function localDemoFiles(id = 'interactive'): string[] {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw Error('Invalid local fixture identity');
  const prefix = `.local/fixture/local-demo-${id}`;
  return [`${prefix}.sqlite`, `${prefix}-transport.sqlite`, `${prefix}.review.json`];
}

function initialKnowledge() {
  const time = '2026-09-01T00:00:00Z';
  const source = { id: 'demo-source', kind: 'user_observation' as const, title: '合成案例：缓存与时效', excerpt: '合成案例仅用于验证流程，不能作为外部研究证据。',
    accessedAt: time, support: 'supports' as const, supportedClaim: '当前任务允许短暂旧数据时，缓存复用可以作为一个选项。', limitation: '无真实测量或平台调用。' };
  const node: KnowledgeNode = KnowledgeNodeSchema.parse({ id: 'demo-cache', workspaceId: WORKSPACE, schemaVersion: 1, revision: '@snapshot', title: '有条件的缓存复用',
    question: '什么时候可以使用缓存？', humanStatement: '当前任务允许短暂旧数据时，可以使用缓存；实时一致的页面应重新读取。', authorship: 'human_written', candidateIds: [],
    conversationId: 'synthetic-seed', kind: 'method', conditions: [{ id: 'allow-stale', text: '当前任务允许短暂旧数据', status: 'confirmed', evidenceIds: ['demo-source'], confirmedBy: ACTOR }],
    boundaries: ['合成场景，不代表对真实业务的建议。'], sources: [source], confirmation: 'confirmed', evidenceStatus: 'supported', lifecycle: 'active', confirmedBy: ACTOR, confirmedAt: time, updatedAt: time });
  const premise = KnowledgeNodeSchema.parse({ ...node, id: 'demo-premise', title: '允许短暂旧数据', question: '缓存复用依赖哪个前提？',
    humanStatement: '任务必须允许短暂旧数据；不允许时，这个缓存方案不适用。', kind: 'principle', conditions: [] });
  return GitKnowledgeDocumentSchema.parse({ schemaVersion: 1, workspaceId: WORKSPACE, nodes: [node, premise], excludedIds: [], relations: [{ id: 'demo-dependency', workspaceId: WORKSPACE,
    source: { workspaceId: WORKSPACE, objectId: node.id, revision: '@snapshot' }, target: { workspaceId: WORKSPACE, objectId: premise.id, revision: '@snapshot' }, type: 'depends_on',
    rationale: '缓存方案必须先核验时效前提。', evidenceIds: ['demo-source'], state: 'confirmed', proposedBy: ACTOR, confirmedBy: ACTOR, confirmedAt: time, updatedAt: time }] });
}

// This implements only the synthetic external boundary. All business rules, approvals and navigation remain shared.
export function createLocalDemoRuntime(id = 'interactive', adapters: Pick<RuntimeFixtures, 'aiGateway' | 'trainingExecutor'> = {}): ServerRuntime {
  const [stateFile, transportFile, catalogFile] = localDemoFiles(id) as [string, string, string];
  const remote = new OperationJournal(transportFile, { fixture: true });
  const record = (kind: string, key: string) => remote.record('@synthetic', '@synthetic', kind, key);
  function save(kind: string, key: string, value: unknown) {
    const prior = record(kind, key);
    if (!remote.putRecord('@synthetic', '@synthetic', kind, key, value, prior?.version ?? null)) throw Error('Synthetic CAS conflict');
  }
  const initial = initialKnowledge(), initialFiles = gitKnowledgeFiles(initial), initialSha = hash(canonicalJson(initialFiles), 'sha1');
  remote.transaction(() => {
    if (record('head', 'main')) return;
    for (const [path, text] of Object.entries(initialFiles)) save('file', `${initialSha}:${path}`, { content: text });
    save('commit', initialSha, { sha: initialSha, parents: [], message: 'Synthetic initial knowledge', paths: Object.keys(initialFiles), stagingKey: '0'.repeat(64) });
    save('head', 'main', { sha: initialSha });
  });
  if (!existsSync(catalogFile)) {
    const questions = initial.nodes.map((node) => ReviewQuestionSchema.parse({ id: `review-${node.id}`, workspaceId: WORKSPACE, revision: 'synthetic-reviewed-v1',
      nodeRef: { workspaceId: WORKSPACE, objectId: node.id, revision: initialSha }, kind: 'recall', prompt: '缓存复用的必要前提是什么？', standardAnswer: '当前任务允许短暂旧数据。',
      hints: ['考虑数据的时间条件。', '检查当前任务对数据时效的要求。', '前提是当前任务允许短暂旧数据。'],
      rubric: { version: 'synthetic-rubric-v1', criteria: [{ id: 'required-condition', description: '说出时效前提', expectedEvidence: '当前任务允许短暂旧数据', required: true }], necessaryConditions: [] },
      review: { status: 'approved', reviewedBy: 'synthetic-server-reviewer', reviewedAt: '2026-09-01T00:00:00Z' } }));
    writeFileSync(catalogFile, JSON.stringify({ operationId: 'synthetic-catalog-v1', workspaceId: WORKSPACE, questions, retentionDays: 30, confirmed: true }), { mode: 0o600, flag: 'wx' });
  }
  const head = () => z.object({ sha: z.string() }).parse(record('head', 'main')?.value).sha;
  const commit = (sha: string) => { const value = record('commit', sha); return value ? Commit.parse(value.value) : null; };
  const file = (sha: string, path: string) => { const value = record('file', `${sha}:${path}`); return value ? z.object({ content: z.string() }).parse(value.value).content : null; };
  function verifyIndex(sha: string, include: string) {
    const snapshot = file(sha, 'knowledge/snapshot.json'); if (!snapshot) return false;
    const files = indexFiles(GitKnowledgeDocumentSchema.parse(JSON.parse(snapshot)));
    return Object.keys(files).sort().join(',') === include && Object.entries(files).every(([path, text]) => file(sha, path) === text);
  }
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    if (url.origin !== 'https://api.cnb.cool') return Response.json({}, { status: 403 });
    if (url.pathname === '/user' && method === 'GET') return Response.json({ id: 'local-demo', username: 'synthetic-local-user' });
    if (!url.pathname.startsWith(`/${REPO}`)) return Response.json({}, { status: 403 });
    const path = url.pathname.slice(REPO.length + 1);
    if (path === '' && method === 'GET') return Response.json({ id: 'local-demo', path: REPO, visibility_level: 'Private' });
    if (path === '/-/git/head') return Response.json({ name: 'main' });
    if (path.startsWith('/-/git/commits/')) { const selected = decodeURIComponent(path.slice('/-/git/commits/'.length)), value = commit(selected === 'main' ? head() : selected); return value ? Response.json({ sha: value.sha, parents: value.parents.map((sha) => ({ sha })), commit: { message: value.message } }) : Response.json({}, { status: 404 }); }
    if (path === '/-/git/commits') {
      const values = []; let current: string | undefined = head();
      while (current && values.length < 100) { const value = commit(current); if (!value) break; values.push({ sha: value.sha, parents: value.parents.map((sha) => ({ sha })), commit: { message: value.message } }); current = value.parents[0]; }
      return Response.json(values);
    }
    if (path.startsWith('/-/git/contents/')) {
      const requestedPath = decodeURIComponent(path.slice('/-/git/contents/'.length)), text = file(url.searchParams.get('ref') ?? head(), requestedPath);
      if (text === null) return Response.json({}, { status: 404 });
      const bytes = Buffer.from(text); return Response.json({ type: 'blob', path: requestedPath, encoding: 'base64', content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
    }
    if (path === '/-/issues' && method === 'POST') {
      const input = z.object({ title: z.string(), body: z.string(), invisible: z.literal(true) }).strict().parse(JSON.parse(String(init?.body)));
      const issue = remote.transaction(() => {
        const number = remote.records('@synthetic', '@synthetic', 'issue').length + 1;
        const value = { ...input, number, created_at: new Date().toISOString() }; save('issue', String(number), value); return value;
      });
      return Response.json(issue);
    }
    if (path === '/-/issues' && method === 'GET') return Response.json(remote.records('@synthetic', '@synthetic', 'issue').map((r) => Issue.parse(r.value)).filter((v) => v.title.includes(url.searchParams.get('keyword') ?? '')).map((v) => ({ number: v.number })));
    if (/^\/-\/issues\/[1-9]\d*$/.test(path)) { const value = record('issue', path.split('/').at(-1)!); return value ? Response.json(Issue.parse(value.value)) : Response.json({}, { status: 404 }); }
    if (path === '/-/knowledge/embedding/models') return Response.json([{ name: 'synthetic-local', dimension: 1 }]);
    if (path === '/-/build/start' && method === 'POST') {
      const request = z.object({ sha: z.string(), config: z.string(), event: z.literal('api_trigger_zhangduo_index'), title: z.string(), sync: z.literal('false') }).strict().parse(JSON.parse(String(init?.body)));
      const config = JSON.parse(request.config), options = config['**']?.api_trigger_zhangduo_index?.[0]?.stages?.at(-1)?.options;
      if (!options || options.issueSyncEnabled !== false || options.forceRebuild !== false || options.ignoreProcessFailures !== false || options.embeddingModel !== 'synthetic-local' || !verifyIndex(request.sha, options.include)) return Response.json({ success: false });
      const sn = `synthetic-${hash(request.title).slice(0, 20)}`;
      if (!record('build', sn)) save('build', sn, { sn, sha: request.sha, include: options.include, model: 'synthetic-local', state: 'running', startedAt: Date.now() });
      return Response.json({ success: true, sn, buildLogUrl: `https://cnb.cool/${REPO}/-/build/${sn}` });
    }
    if (path.startsWith('/-/build/status/')) {
      const sn = decodeURIComponent(path.slice('/-/build/status/'.length)), value = record('build', sn); if (!value) return Response.json({}, { status: 404 });
      let build = Build.parse(value.value);
      if (build.state === 'running' && Date.now() - build.startedAt > 500) remote.transaction(() => {
        build = { ...build, state: verifyIndex(build.sha, build.include) ? 'success' : 'failed' }; save('build', sn, build);
        if (build.state === 'success') save('index', 'current', { id: 'synthetic-index', last_commit_sha: build.sha, include: build.include, exclude: '', issue_sync_enabled: false,
          embedding_model: { name: build.model, dimension: 1 }, statistics: { count: build.include.split(',').length, size: 0 } });
      });
      return Response.json({ status: build.state });
    }
    if (path === '/-/knowledge/base') { const value = record('index', 'current'); return value ? Response.json(value.value) : Response.json({}, { status: 404 }); }
    if (path === '/-/knowledge/base/query') {
      const index = record('index', 'current'); if (!index) return Response.json([]);
      const info = z.object({ last_commit_sha: z.string(), include: z.string() }).parse(index.value), query = url.searchParams.get('query')?.trim() ?? '';
      const terms = [...new Set([...query].filter((s) => !/\s/.test(s)))];
      return Response.json(info.include.split(',').map((path) => {
        const text = file(info.last_commit_sha, path) ?? ''; const score = terms.length ? terms.filter((term) => text.includes(term)).length / terms.length : 0;
        return { score, chunk: text, metadata: { path } };
      }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, 20));
    }
    return Response.json({ message: 'Synthetic transport does not implement this capability' }, { status: 404 });
  };
  const git: GitPublisher = { mode: 'fixture', prepare: async (input) => {
    const parent = commit(input.baseRevision); if (!parent || input.repository !== REPO || input.branch !== 'main') return failure('CONFLICT', 'Synthetic Git base is unavailable', 'preview_again', 'preserved');
    const files = { ...Object.fromEntries(parent.paths.map((path) => [path, file(parent.sha, path)!])), ...input.files };
    const sha = hash(canonicalJson({ parent: parent.sha, files, message: input.message }), 'sha1'), stagingKey = hash(sha);
    remote.transaction(() => {
      for (const [path, text] of Object.entries(files)) save('file', `${sha}:${path}`, { content: text });
      save('commit', sha, { sha, parents: [parent.sha], message: input.message, paths: Object.keys(files), stagingKey });
    });
    return { ok: true, data: { revision: sha, stagingKey } };
  }, publish: async (input) => remote.transaction(() => {
    const value = commit(input.revision);
    if (input.repository !== REPO || input.branch !== 'main' || head() !== input.baseRevision || value?.parents[0] !== input.baseRevision || value.stagingKey !== input.stagingKey)
      return failure('CONFLICT', 'Synthetic Git compare-and-swap rejected', 'preview_again', 'not_written');
    save('head', 'main', { sha: value.sha }); return { ok: true, data: null };
  }) };
  const environment = { CNB_REPO_SLUG: REPO, CNB_TOKEN: 'synthetic-token-not-a-credential', CNB_TOKEN_SCOPES: 'account-profile:r,repo-basic-info:r,repo-code:rw,repo-issue:rw,repo-cnb-trigger:rw',
    CNB_LIVE_READS_FOR: REPO, CNB_LIVE_WRITES_FOR: REPO, CNB_LIVE_QUERIES_FOR: REPO, CNB_LIVE_INDEX_FOR: REPO, CNB_INDEX_EMBEDDING_MODEL: 'synthetic-local',
    ZHANGDUO_MODE: 'live', ZHANGDUO_BOOTSTRAP_KEY: LOCAL_DEMO_KEY, ZHANGDUO_STATE_FILE: stateFile, ZHANGDUO_APP_SCOPES: Object.values(SCOPES).join(','),
    ZHANGDUO_STORAGE_CONFIRMED: 'true', ZHANGDUO_REVIEW_CATALOG_FILE: catalogFile };
  // An opt-in loopback-only profile is separate from private production .env files.
  const localProfile = '.local/fixture/intelligence-runtime.json';
  let localAI: NodeJS.ProcessEnv = {};
  if (id === 'interactive' && existsSync(localProfile)) {
    const info = lstatSync(localProfile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4000 || (info.mode & 0o077)) throw Error('Unsafe local AI profile');
    const profile = z.object({ confirmed: z.literal(true), model: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
      baseUrl: z.literal('http://127.0.0.1:11434/v1') }).strict().parse(JSON.parse(readFileSync(localProfile, 'utf8')));
    localAI = { ZHANGDUO_LOCAL_AI_URL: profile.baseUrl, ZHANGDUO_LOCAL_AI_MODEL: profile.model };
  }
  const runtime = createRuntime(() => ({ ...environment, ...localAI }), { transport, git, ...adapters }); let closed = false;
  return { ...runtime, close: () => { if (!closed) { closed = true; runtime.close(); remote.close(); } } };
}
