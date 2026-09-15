import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { DEFAULT_INTELLIGENCE, type TrainingRun } from '../contracts/intelligence';
import type { Conversation, KnowledgeSnapshot } from '../contracts/domain';
import type { RequestContext } from '../contracts/api';
import type { Services } from '../contracts/ports';
import { contentHash } from '../contracts/hash';
import type { ChatGateway } from './ai-providers';
import type { TrainingExecutor } from './training-runner';
import { IntelligenceStore } from './intelligence';
import { failure } from './result';

const metrics = { beforeLoss: 2, afterLoss: 1, heldOutBefore: 2, heldOutAfter: 1, parameterDelta: 1,
  trainableParameters: 8, totalParameters: 100, steps: 5, weightEffect: 0.1, reloadVerified: true, validationGroups: 1 };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await platformFixture();
  const nodes = ['k1', 'k2'].map((id, index) => ({ ...f.node, id, revision: f.base, conversationId: `c${index + 1}`,
    sources: [{ id: `source-${id}`, kind: 'conversation' as const, title: 'Synthetic source', excerpt: 'Verified synthetic source.',
      accessedAt: '2026-09-01T00:00:00Z', support: 'supports' as const, supportedClaim: f.node.humanStatement, limitation: '' }] }));
  const snapshot: KnowledgeSnapshot = { workspaceId: f.ctx.workspaceId, revision: f.base, nodes, relations: [], excludedIds: [], generatedAt: new Date().toISOString() };
  const conversations = new Map<string, Conversation>(nodes.map((node) => [node.conversationId, { id: node.conversationId, workspaceId: f.ctx.workspaceId,
    taskId: 'synthetic-task', origin: 'manual' as const, sourceAlreadyPersisted: true, segments: [{ id: `segment-${node.id}`, role: 'assistant' as const, text: node.sources[0]!.excerpt }],
    contentHash: 'synthetic-source-hash', state: 'saved' as const, createdAt: '2026-09-01T00:00:00Z' } satisfies Conversation]));
  const services = { ...f.services,
    snapshot: vi.fn<Services['snapshot']>(async () => ({ ok: true as const, data: snapshot })),
    listEvidence: vi.fn(async () => ({ ok: true as const, data: [] })),
    readConversation: vi.fn(async (_ctx: RequestContext, id: string) => ({ ok: true as const, data: conversations.get(id)! })),
  };
  const gateway: ChatGateway = { status: () => [{ id: 'local', ready: true, model: 'synthetic' }],
    send: vi.fn(async () => ({ ok: true as const, data: { text: 'Synthetic answer.', modelId: 'synthetic' } })) };
  const executor: TrainingExecutor = { ready: () => true, pretrainedReady: () => true,
    run: vi.fn(async () => metrics), infer: vi.fn(async () => ({ candidates: [] })), remove: vi.fn() };
  const store = new IntelligenceStore(f.sessions, f.journal, gateway, executor, () => services);
  const command = (input: Parameters<IntelligenceStore['command']>[1]) => store.command(f.ctx, input);
  const train = () => ({ action: 'train' as const, operationId: randomUUID(), confirmed: true as const, expectedRevision: 0,
    mode: 'lora' as const, nodeIds: nodes.map((n) => n.id), nodeRevisions: Object.fromEntries(nodes.map((n) => [n.id, n.revision])), trainingConsent: true as const });
  const seedRun = () => {
    const run: TrainingRun = { id: randomUUID(), state: 'completed', mode: 'lora', createdAt: new Date().toISOString(), datasetHash: 'synthetic',
      settingsRevision: 0, sampleCount: 2, nodeRefs: nodes.map(({ id, revision }) => ({ id, revision })), message: 'synthetic executor metrics', metrics };
    f.journal.putRecord(f.ctx.workspaceId, f.ctx.actorId, 'intelligence_run', run.id, run, null);
    return run;
  };
  return { ...f, services, snapshot, conversations, gateway, executor, store, command, train, seedRun };
}

describe('intelligence safety across asynchronous boundaries', () => {
  it('keeps conversation and provider settings available when formal knowledge is not initialized', async () => {
    const f = await fixture();
    f.services.snapshot.mockResolvedValueOnce(failure('NOT_CONFIGURED', 'Knowledge not initialized', 'initialize_knowledge'));
    try {
      expect(await f.command({ action: 'overview' })).toMatchObject({ ok: true, data: { settings: DEFAULT_INTELLIGENCE,
        samples: [], samplesStatus: { state: 'unavailable' }, providers: [{ id: 'local' }] } });
    } finally { f.journal.close(); }
  });
  it('does not restore expired chat payloads when the model returns late', async () => {
    const f = await fixture(), reply = deferred<Awaited<ReturnType<ChatGateway['send']>>>();
    vi.mocked(f.gateway.send).mockReturnValueOnce(reply.promise);
    try {
      const id = randomUUID();
      await f.command({ action: 'create_chat', operationId: id, title: 'Synthetic TTL', retentionDays: 30, confirmed: true });
      const sending = f.command({ action: 'send', operationId: randomUUID(), id, expectedRevision: 1, provider: 'local',
        text: 'Synthetic private text', confirmed: true, modelConsent: true });
      await vi.waitFor(() => expect(f.gateway.send).toHaveBeenCalledTimes(1));
      f.journal.expirePrivatePayloads(new Date(Date.now() + 31 * 86400000).toISOString());
      reply.resolve({ ok: true, data: { text: 'Late reply', modelId: 'synthetic' } });
      expect((await sending).ok).toBe(false);
      expect(f.journal.record(f.ctx.workspaceId, f.ctx.actorId, 'intelligence_chat', id)?.value).toBeNull();
    } finally { f.journal.close(); }
  });

  it('rejects malformed gateway output without persisting an unreadable conversation', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.send).mockResolvedValueOnce({ ok: true, data: { text: 'x'.repeat(24001), modelId: 'synthetic' } });
    try {
      const id = randomUUID();
      await f.command({ action: 'create_chat', operationId: id, title: 'Synthetic limit', retentionDays: 30, confirmed: true });
      expect((await f.command({ action: 'send', operationId: randomUUID(), id, expectedRevision: 1,
        provider: 'local', text: 'Synthetic', confirmed: true, modelConsent: true })).ok).toBe(false);
      expect(await f.command({ action: 'read_chat', id })).toMatchObject({ ok: true, data: { status: 'unknown', messages: [{ role: 'user' }] } });
    } finally { f.journal.close(); }
  });

  it('claims only one training job when concurrent requests finish source reads together', async () => {
    const f = await fixture(), result = deferred<typeof metrics>();
    vi.mocked(f.executor.run).mockReturnValue(result.promise);
    try {
      const results = await Promise.all([f.command(f.train()), f.command(f.train())]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(f.executor.run).toHaveBeenCalledTimes(1);
    } finally {
      result.resolve(metrics);
      await new Promise((resolve) => setImmediate(resolve));
      f.journal.close();
    }
  });

  it('rechecks the approved settings revision after asynchronous source eligibility checks', async () => {
    const f = await fixture(), checked = deferred<{ ok: true; data: KnowledgeSnapshot }>();
    f.services.snapshot.mockResolvedValueOnce({ ok: true, data: f.snapshot }).mockReturnValueOnce(checked.promise);
    try {
      const training = f.command(f.train());
      await vi.waitFor(() => expect(f.services.snapshot).toHaveBeenCalledTimes(2));
      expect((await f.command({ action: 'settings', operationId: randomUUID(), expectedRevision: 0,
        settings: { ...DEFAULT_INTELLIGENCE, steps: 40 }, confirmed: true })).ok).toBe(true);
      checked.resolve({ ok: true, data: f.snapshot });
      expect(await training).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(f.executor.run).not.toHaveBeenCalled();
    } finally { f.journal.close(); }
  });

  it('cannot reactivate an adapter deleted while eligibility was being checked', async () => {
    const f = await fixture(), checked = deferred<{ ok: true; data: KnowledgeSnapshot }>(), run = f.seedRun();
    f.services.snapshot.mockReturnValueOnce(checked.promise);
    try {
      const activation = f.command({ action: 'activate', operationId: randomUUID(), id: run.id, confirmed: true });
      expect((await f.command({ action: 'delete_run', operationId: randomUUID(), id: run.id, confirmed: true })).ok).toBe(true);
      checked.resolve({ ok: true, data: f.snapshot });
      expect((await activation).ok).toBe(false);
      expect(f.journal.record(f.ctx.workspaceId, f.ctx.actorId, 'intelligence_active', 'current')?.value ?? null).toBeNull();
    } finally { f.journal.close(); }
  });

  it('does not expose chat summaries through settings-only access', async () => {
    const f = await fixture();
    try {
      await f.command({ action: 'create_chat', operationId: randomUUID(), title: 'Private subject', retentionDays: 30, confirmed: true });
      const token = f.sessions.issue({ actorId: f.ctx.actorId, workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: ['settings:read'] });
      const context = f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
      if (!context.ok) throw Error('Expected fixture context');
      expect(await f.store.command(context.data, { action: 'overview' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    } finally { f.journal.close(); }
  });

  it('returns only original-operation metadata, bound to the exact request and actor', async () => {
    const f = await fixture();
    try {
      const original = { action: 'create_chat' as const, operationId: randomUUID(), title: 'Private synthetic subject', retentionDays: 30 as const, confirmed: true as const };
      await f.command(original);
      const result = await f.command({ action: 'read_operation', id: original.operationId });
      expect(result).toMatchObject({ ok: true, data: { operationId: original.operationId, action: original.action,
        requestHash: await contentHash(original), state: 'completed', result: { chatId: original.operationId }, readOnly: true, absenceIsFinal: false } });
      expect(JSON.stringify(result)).not.toContain(original.title);
      const token = f.sessions.issue({ actorId: 'other-actor', workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: ['workspace:read'] });
      const context = f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
      if (!context.ok) throw Error('Expected fixture context');
      expect(await f.store.command(context.data, { action: 'read_operation', id: original.operationId }))
        .toMatchObject({ ok: true, data: { state: 'not_found', action: null, requestHash: null, result: null, absenceIsFinal: false } });
    } finally { f.journal.close(); }
  });

  it('archives an exact chat revision only once when two operation IDs race', async () => {
    const f = await fixture(), saved = deferred<Conversation>();
    const save = vi.spyOn(f.services, 'saveConversation').mockImplementation(async () => ({ ok: true, data: await saved.promise }));
    try {
      const id = randomUUID();
      await f.command({ action: 'create_chat', operationId: id, title: 'Synthetic archive', retentionDays: 30, confirmed: true });
      await f.command({ action: 'send', operationId: randomUUID(), id, expectedRevision: 1, provider: 'local', text: 'All turns are retained.', confirmed: true, modelConsent: true });
      const first = f.command({ action: 'archive', operationId: randomUUID(), id, expectedRevision: 3, confirmed: true });
      const second = f.command({ action: 'archive', operationId: randomUUID(), id, expectedRevision: 3, confirmed: true });
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const conversation = save.mock.calls[0]![1];
      expect(conversation.segments.map((s) => s.text)).toEqual(['All turns are retained.', 'Synthetic answer.']);
      saved.resolve({ ...conversation, state: 'saved', sourceAlreadyPersisted: true, issueNumber: 1 });
      const outcomes = await Promise.all([first, second]);
      expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(await f.command({ action: 'archive', operationId: randomUUID(), id, expectedRevision: 4, confirmed: true }))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally { f.journal.close(); }
  });

  it('recovers a lost archive response by reading only the original saved conversation', async () => {
    const f = await fixture();
    const save = vi.spyOn(f.services, 'saveConversation').mockImplementation(async (ctx, conversation) => {
      f.journal.claim({ workspaceId: ctx.workspaceId, actorId: ctx.actorId, objectId: conversation.id, contentHash: conversation.contentHash, state: 'unknown' });
      f.conversations.set(conversation.id, { ...conversation, state: 'saved', sourceAlreadyPersisted: true });
      return failure('UNKNOWN_RESULT', 'Synthetic lost response', 'read_original', 'unknown');
    });
    try {
      const id = randomUUID(), operationId = randomUUID();
      await f.command({ action: 'create_chat', operationId: id, title: 'Synthetic recovery', retentionDays: 30, confirmed: true });
      await f.command({ action: 'send', operationId: randomUUID(), id, expectedRevision: 1, provider: 'local', text: 'Synthetic original.', confirmed: true, modelConsent: true });
      expect((await f.command({ action: 'archive', operationId, id, expectedRevision: 3, confirmed: true })).ok).toBe(false);
      expect(await f.command({ action: 'read_operation', id: operationId })).toMatchObject({ ok: true, data: {
        action: 'archive', state: 'completed', targetId: id, result: { conversationId: `chat-${operationId}` } } });
      expect(await f.command({ action: 'read_chat', id })).toMatchObject({ ok: true, data: { archivedConversationId: `chat-${operationId}`, revision: 4 } });
      await f.command({ action: 'read_operation', id: operationId });
      expect(save).toHaveBeenCalledTimes(1);
      expect(f.gateway.send).toHaveBeenCalledTimes(1);
    } finally { f.journal.close(); }
  });

  it.each([false, true])('does not let another actor reuse an existing artifact identity (uppercase=%s)', async (uppercase) => {
    const f = await fixture(), existing = f.seedRun();
    try {
      const token = f.sessions.issue({ actorId: 'other-trainer', workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: ['settings:write'] });
      const ctx = f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
      if (!ctx.ok) throw Error('Expected fixture context');
      expect(await f.store.command(ctx.data, { action: 'train', operationId: uppercase ? existing.id.toUpperCase() : existing.id, expectedRevision: 0, mode: 'smoke', nodeIds: [], nodeRevisions: {}, trainingConsent: true, confirmed: true }))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(f.executor.run).not.toHaveBeenCalled();
      expect(f.journal.record(f.ctx.workspaceId, 'other-trainer', 'intelligence_run', existing.id)).toBeUndefined();
    } finally { f.journal.close(); }
  });

  it('allows interrupted artifact cleanup only after worker termination is verified', async () => {
    const f = await fixture(), existing = f.seedRun();
    const inspect = vi.fn<NonNullable<TrainingExecutor['inspect']>>(() => 'unknown');
    f.executor.inspect = inspect;
    f.journal.putRecord(f.ctx.workspaceId, f.ctx.actorId, 'intelligence_run', existing.id, { ...existing, state: 'running' }, 1);
    try {
      expect(await f.command({ action: 'overview' })).toMatchObject({ ok: true, data: { runs: [{ state: 'interrupted', cleanupReady: false }] } });
      expect((await f.command({ action: 'delete_run', operationId: randomUUID(), id: existing.id, confirmed: true })).ok).toBe(false);
      expect(f.executor.remove).not.toHaveBeenCalled();
      inspect.mockReturnValue('stopped');
      expect(await f.command({ action: 'overview' })).toMatchObject({ ok: true, data: { runs: [{ state: 'interrupted', cleanupReady: true }] } });
      expect(f.journal.hasActiveIntelligenceTraining(f.ctx.workspaceId)).toBe(false);
      expect((await f.command({ action: 'delete_run', operationId: randomUUID(), id: existing.id, confirmed: true })).ok).toBe(true);
      expect(f.executor.remove).toHaveBeenCalledTimes(1);
    } finally { f.journal.close(); }
  });
});
