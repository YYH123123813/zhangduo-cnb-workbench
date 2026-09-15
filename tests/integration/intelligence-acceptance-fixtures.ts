import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { ApiResponse, Result } from '../../src/contracts/api';
import { CONTRACT_VERSION, type Approval, type Candidate, type ChangeSet, type CommitReceipt, type Conversation,
  type HandoffDraft, type KnowledgeNode, type Relation, type TaskContext } from '../../src/contracts/domain';
import { hashChangeSet } from '../../src/contracts/hash';
import { ChatSchema, IntelligenceCommandSchema, IntelligenceOverviewSchema, type IntelligenceCommand,
  type IntelligenceSettings, type TrainingRun } from '../../src/contracts/intelligence';
import { SCOPES } from '../../src/contracts/scopes';
import { WorkspaceSessionSchema, type WorkspaceSession } from '../../src/contracts/session';
import { bindIntelligenceSession } from '../../src/app/api-client';
import { IntelligenceClient } from '../../src/app/intelligence-client';
import type { ChatGateway } from '../../src/platform/ai-providers';
import type { TrainingExecutor } from '../../src/platform/training-runner';
import { createServices } from '../../src/platform/services';
import { createApp } from '../../src/server/app';
import { platformFixture } from './platform-fixture';

export const syntheticMetrics: NonNullable<TrainingRun['metrics']> = {
  beforeLoss: 4, afterLoss: 2, heldOutBefore: 4, heldOutAfter: 3,
  parameterDelta: 0.5, trainableParameters: 8, totalParameters: 80,
  steps: 5, weightEffect: 0.25, reloadVerified: true, validationGroups: 1,
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function resultData<T>(result: Result<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error(result.error.message);
  return result.data;
}

// Isolate storage in memory. Only external Issue/Git, model and worker boundaries are synthetic.
export async function intelligenceFixture() {
  const runtimeId = `synthetic-d-${randomUUID()}`;
  const f = await platformFixture();
  const issues: { number: number; body: string; title: string; invisible: boolean; created_at: string }[] = [];
  const upstream = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/-/issues') && init?.method === 'POST') {
      const issue = { ...JSON.parse(String(init.body)), number: 100 + issues.length, created_at: new Date().toISOString() };
      issues.push(issue);
      return Response.json(issue, { status: 201 });
    }
    if (path.endsWith('/-/issues')) return Response.json(issues);
    const match = /\/-\/issues\/(\d+)$/.exec(path);
    if (match) {
      const issue = issues.find((row) => row.number === Number(match[1]));
      return Response.json(issue ?? {}, { status: issue ? 200 : 404 });
    }
    return upstream(input, init);
  });
  const send = vi.fn<ChatGateway['send']>(async () => ({ ok: true, data: {
    text: 'Synthetic reply. Human review is still required.', modelId: 'synthetic-d-gateway',
  } }));
  const gateway = { status: vi.fn<ChatGateway['status']>(() => [{ id: 'local', ready: true, model: 'synthetic-d-gateway' }]), send };
  const executor = {
    ready: vi.fn(() => true), pretrainedReady: vi.fn(() => true),
    run: vi.fn<TrainingExecutor['run']>(async () => structuredClone(syntheticMetrics)),
    infer: vi.fn<TrainingExecutor['infer']>(async () => ({ candidates: [] })),
    remove: vi.fn<NonNullable<TrainingExecutor['remove']>>(),
  };
  const options = { ...f.options, aiGateway: gateway, trainingExecutor: executor };
  const services = createServices(options);
  let app = createApp(services);
  const request = (path: string, body?: unknown, headers: HeadersInit = f.headers, method = body === undefined ? 'GET' : 'POST') =>
    app.request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function ok<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await request(path, body, f.headers, method);
    const envelope = await response.json() as ApiResponse<T>;
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(envelope.meta).toMatchObject({ mode: 'fixture', contractVersion: CONTRACT_VERSION, requestId: expect.any(String) });
    expect(response.status, JSON.stringify(envelope)).toBe(200);
    return resultData(envelope);
  }
  async function command<T = unknown>(input: IntelligenceCommand): Promise<T> {
    return ok<T>('/api/intelligence', IntelligenceCommandSchema.parse(input));
  }
  const overview = async () => IntelligenceOverviewSchema.parse(await ok('/api/intelligence'));
  const readChat = async (id: string) => ChatSchema.parse(await ok(`/api/intelligence/chats/${encodeURIComponent(id)}`));
  const createChat = async () => ChatSchema.parse(await command({ action: 'create_chat', operationId: randomUUID(), confirmed: true,
    title: runtimeId, retentionDays: 30 }));
  async function settings(next: IntelligenceSettings) {
    return command<{ revision: number; settings: IntelligenceSettings }>({ action: 'settings', operationId: randomUUID(), confirmed: true,
      expectedRevision: (await overview()).revision, settings: next });
  }
  async function trainingCommand(mode: 'smoke' | 'lora' = 'smoke', nodeIds: string[] = []): Promise<Extract<IntelligenceCommand, { action: 'train' }>> {
    const current = await overview();
    return { action: 'train', operationId: randomUUID(), confirmed: true, trainingConsent: true, mode, nodeIds,
      expectedRevision: current.revision, nodeRevisions: Object.fromEntries(current.samples.filter((s) => nodeIds.includes(s.id)).map((s) => [s.id, s.revision])) };
  }
  async function terminal(id: string, state: TrainingRun['state']) {
    await vi.waitFor(async () => expect((await overview()).runs.find((r) => r.id === id)?.state).toBe(state));
    return (await overview()).runs.find((r) => r.id === id)!;
  }
  function identity(actorId: string, workspaceId = f.ctx.workspaceId, scopes: string[] = Object.values(SCOPES)) {
    const token = f.sessions.issue({ actorId, workspace: { id: workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes });
    return { ...f.headers, Authorization: `Bearer ${token}` };
  }
  async function commit(changes: ChangeSet) {
    changes.contentHash = await hashChangeSet(changes);
    const approval = await ok<Approval>('/api/workspace/approvals/knowledge', { changes, confirmed: true });
    return resultData(await services.commit(f.ctx, changes, approval));
  }
  async function changeNode(id: string, patch: Partial<KnowledgeNode> = {}, withdraw = false) {
    const snapshot = resultData(await services.snapshot(f.ctx));
    const node = snapshot.nodes.find((n) => n.id === id)!;
    return commit({ id: randomUUID(), workspaceId: f.ctx.workspaceId, baseRevision: snapshot.revision,
      nodes: withdraw ? [] : [{ ...node, ...patch, authorship: 'human_edited', confirmedBy: f.ctx.actorId,
        confirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      relations: [], withdrawnIds: withdraw ? [id] : [], reason: 'Synthetic D human-reviewed revision', contentHash: '' });
  }
  // Independent existing capture path lets training tests run even if new chat archival is broken.
  async function captureKnowledge(title: string, dependency?: KnowledgeNode) {
    const id = randomUUID();
    const text = `Synthetic evidence for ${title}. Verify the original source before reuse.`;
    const preview = await ok<{ conversation: Conversation; task: TaskContext }>('/api/capture/preview', {
      conversationId: `synthetic-${id}`, task: { id: `task-${id}`, question: title, constraints: [], intent: 'propose' },
      source: { origin: 'paste' }, segments: [{ id: `segment-${id}`, role: 'user', text }], personalInfoReviewed: true, scopeConfirmed: true,
    });
    const approval = await ok<Approval>('/api/capture/approve', { conversation: preview.conversation, baseRevision: 'new', confirmed: true });
    const saved = await ok<Conversation>('/api/capture/save', { conversation: preview.conversation, approval, confirmed: true });
    const published = await handoff(saved, title, dependency);
    return { ...published, saved, task: preview.task, text };
  }
  async function handoff(saved: Conversation, title: string, dependency?: KnowledgeNode) {
    const path = `/api/handoff/${encodeURIComponent(saved.id)}`;
    const manual = await ok<{ items: { subject: Pick<Candidate, 'spans' | 'sources'>; draftId: string; nodeId: string }[] }>(`${path}/manual`, {
      segmentIds: saved.segments.map((s) => s.id), expectedConversationHash: saved.contentHash, confirmed: true,
    });
    const item = manual.items[0]!;
    const snapshot = resultData(await services.snapshot(f.ctx));
    const time = new Date().toISOString();
    const statement = saved.segments[0]!.text;
    const node: KnowledgeNode = { id: item.nodeId, workspaceId: f.ctx.workspaceId, schemaVersion: 1, revision: snapshot.revision,
      title, question: title, humanStatement: statement, authorship: 'human_written', candidateIds: [], conversationId: saved.id,
      kind: 'method', conditions: [{ id: 'synthetic-scope', text: 'Only the synthetic acceptance workspace is in scope.',
        status: 'confirmed', evidenceIds: [], confirmedBy: f.ctx.actorId }], boundaries: ['Synthetic D acceptance only.'],
      sources: item.subject.sources.map((s) => ({ ...s, support: 'supports', supportedClaim: statement })),
      confirmation: 'draft', evidenceStatus: 'supported', lifecycle: 'active', updatedAt: time };
    const relations: Relation[] = dependency ? [{ id: `relation-${randomUUID()}`, workspaceId: f.ctx.workspaceId,
      source: { workspaceId: f.ctx.workspaceId, objectId: node.id, revision: node.revision },
      target: { workspaceId: f.ctx.workspaceId, objectId: dependency.id, revision: dependency.revision },
      type: 'depends_on', rationale: 'Synthetic human-confirmed dependency.', evidenceIds: [node.sources[0]!.id],
      state: 'confirmed', proposedBy: f.ctx.actorId, confirmedBy: f.ctx.actorId, confirmedAt: time, updatedAt: time }] : [];
    const draft: HandoffDraft = { id: item.draftId, conversationId: saved.id, candidateId: null, baseRevision: snapshot.revision, node, relations };
    await ok(`${path}/draft`, { draft, consent: true, options: { operationId: randomUUID(), source: { kind: 'manual', spans: item.subject.spans },
      expectedConversationHash: saved.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true } }, 'PUT');
    const prepared = await ok<{ draft: HandoffDraft; changes: ChangeSet }>(`${path}/preview`, { draft, reason: 'Synthetic D manual review' });
    const confirm = { draft: prepared.draft, changes: prepared.changes, confirmed: true };
    const approval = await ok<Approval>(`${path}/approval`, confirm);
    const receipt = await ok<CommitReceipt>(`${path}/commit`, { ...confirm, approval });
    const current = resultData(await services.snapshot(f.ctx));
    return { node: current.nodes.find((n) => n.id === node.id)!, relations: current.relations.filter((r) => relations.some((e) => e.id === r.id)), receipt };
  }
  return { ...f, runtimeId, issues, options, services, gateway, executor, request, ok, command, overview, readChat, createChat,
    settings, trainingCommand, terminal, identity, captureKnowledge, handoff, changeNode,
    restart: () => { app = createApp(createServices(options)); }, close: () => f.journal.close() };
}

export type IntelligenceFixture = Awaited<ReturnType<typeof intelligenceFixture>>;

// Exercise the actual shared client and Hono app; only the HTTP transport stays in process.
export async function boundPage(f: IntelligenceFixture) {
  const session = WorkspaceSessionSchema.parse(await f.ok('/api/workspace/session'));
  let cookie = f.token;
  const releases = [bindIntelligenceSession(session)];
  const response = vi.fn(async (value: Response): Promise<Response> => value);
  const transport = vi.fn<typeof fetch>(async (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Cookie', `zhangduo_session=${cookie}`);
    headers.set('Origin', 'http://localhost');
    return response(await f.request(String(path), init?.body === undefined ? undefined : JSON.parse(String(init.body)), headers, init?.method));
  });
  vi.stubGlobal('fetch', transport);
  const client = new IntelligenceClient();
  return { session, client, transport, response,
    switchCookie: (next: WorkspaceSession) => { cookie = f.sessions.issue(next); },
    bind: (next: WorkspaceSession) => { releases.push(bindIntelligenceSession(next)); },
    close: () => { client.dispose(); releases.reverse().forEach((release) => release()); },
  };
}
