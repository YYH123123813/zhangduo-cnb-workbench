import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { ApiResponse, ErrorCode } from '../../src/contracts/api';
import type { Approval, Conversation, EvidenceRecord, KnowledgeNode, Relation, RetrievalResult } from '../../src/contracts/domain';
import { contentHash, hashSettings } from '../../src/contracts/hash';
import { ChatSchema, DEFAULT_INTELLIGENCE, IntelligenceCommandSchema, IntelligenceOperationSchema, type MemoryChat, type TrainingRun } from '../../src/contracts/intelligence';
import { SCOPES } from '../../src/contracts/scopes';
import { SESSION_BINDING_HEADER, workspaceSessionBinding } from '../../src/contracts/session';
import { apiRequest } from '../../src/app/api-client';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/platform/services';
import { boundPage, deferred, intelligenceFixture, resultData, syntheticMetrics, type IntelligenceFixture } from './intelligence-acceptance-fixtures';
import { runIntelligenceAcceptance } from '../../tools/intelligence-acceptance';

const fixtures: IntelligenceFixture[] = [];
const pages: Awaited<ReturnType<typeof boundPage>>[] = [];
afterEach(() => {
  pages.splice(0).reverse().forEach((p) => p.close());
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  fixtures.splice(0).reverse().forEach((f) => f.close());
});
async function setup() { const f = await intelligenceFixture(); fixtures.push(f); return f; }
async function page(f: IntelligenceFixture) { const p = await boundPage(f); pages.push(p); return p; }
async function rejected(response: Response, status: number, code: ErrorCode) {
  const envelope = await response.json() as ApiResponse<unknown>;
  expect(response.status, JSON.stringify(envelope)).toBe(status);
  expect(envelope).toMatchObject({ ok: false, error: { code, retryable: false, dataState: expect.any(String), nextAction: expect.any(String) }, meta: { requestId: expect.any(String) } });
  expect(response.headers.get('cache-control')).toBe('no-store');
  return envelope;
}
async function trainingPair(f: IntelligenceFixture) {
  const first = await f.captureKnowledge('Synthetic primary source');
  const second = await f.captureKnowledge('Synthetic independent source');
  return [first.node.id, second.node.id];
}
const sendCommand = (chat: MemoryChat) => ({ action: 'send' as const, id: chat.id, operationId: randomUUID(), expectedRevision: chat.revision,
  provider: 'local' as const, text: 'Synthetic D message. Preserve every turn.', confirmed: true as const, modelConsent: true as const });

describe('D independent intelligence acceptance: synthetic HTTP/Services only, no real worker or CNB', () => {
  it('does not dispatch an intelligence request without the verified page binding', async () => {
    const transport = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', transport);
    expect(await apiRequest('/api/intelligence')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'not_written' } });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['actor', 'workspace', 'scopes', 'visibility'] as const)('rejects cookie %s changes through the real client and HTTP before writes', async (field) => {
    const f = await setup(), p = await page(f);
    expect(await p.client.refresh()).not.toBeNull();
    const changed = structuredClone(p.session);
    if (field === 'actor') changed.actorId = 'synthetic-other';
    if (field === 'workspace') changed.workspace.id = 'synthetic-other-workspace';
    if (field === 'scopes') changed.scopes = changed.scopes.filter((s) => s !== 'data:delete');
    if (field === 'visibility') changed.workspace.visibility = 'public';
    p.switchCookie(changed);
    const operationId = randomUUID();
    expect(await p.client.execute({ action: 'create_chat', operationId, title: 'Synthetic bound approval', retentionDays: 30, confirmed: true })).toBeNull();
    expect(p.client.getSnapshot()).toMatchObject({ denied: true, verified: false, data: null });
    expect(p.response.mock.calls.at(-1)?.[0].status).toBe(403);
    for (const identity of [p.session, changed]) {
      expect(f.journal.records(identity.workspace.id, identity.actorId, 'intelligence_chat')).toHaveLength(0);
      expect(f.journal.records(identity.workspace.id, identity.actorId, 'intelligence_operation')).toHaveLength(0);
    }
    expect(f.gateway.send).not.toHaveBeenCalled(); expect(f.executor.run).not.toHaveBeenCalled(); expect(f.issues).toHaveLength(0);
  });

  it.each(['missing', 'mismatched'] as const)('rejects %s old-backend echo before parsing private response content', async (kind) => {
    const f = await setup(), p = await page(f);
    let reads = 0;
    p.response.mockImplementationOnce(async (response) => {
      if (kind === 'missing') response.headers.delete(SESSION_BINDING_HEADER);
      else response.headers.set(SESSION_BINDING_HEADER, 'synthetic-wrong-binding');
      const json = response.json.bind(response);
      response.json = async () => { reads++; return json(); };
      return response;
    });
    expect(await p.client.refresh()).toBeNull();
    expect(reads).toBe(0);
    expect(p.client.getSnapshot()).toMatchObject({ denied: true, data: null, verified: false });
    expect(p.transport).toHaveBeenCalledTimes(1);
  });

  it('classifies a dispatched mutation with missing echo as unknown and recovers its actual receipt without replay', async () => {
    const f = await setup(), p = await page(f);
    const command = { action: 'create_chat' as const, operationId: randomUUID(), confirmed: true as const, title: 'Synthetic lost echo', retentionDays: 30 as const };
    p.response.mockImplementationOnce(async (response) => { response.headers.delete(SESSION_BINDING_HEADER); return response; });
    expect(await apiRequest('/api/intelligence', { method: 'POST', body: JSON.stringify(command) }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'unknown', retryable: false } });
    const receipt = resultData(await apiRequest(`/api/intelligence/operations/${command.operationId}`));
    expect(IntelligenceOperationSchema.parse(receipt)).toMatchObject({ state: 'completed', requestHash: await contentHash(command), result: { chatId: command.operationId } });
    expect(f.journal.records(f.ctx.workspaceId, f.ctx.actorId, 'intelligence_chat')).toHaveLength(1);
    expect(p.transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('rejects a late body after page rebinding while preserving the old stored conversation', async () => {
    const f = await setup(), chat = await f.createChat(), p = await page(f);
    p.response.mockImplementationOnce(async (response) => {
      const json = response.json.bind(response);
      response.json = async () => { const body = await json(); p.bind({ ...p.session, actorId: 'synthetic-new-page' }); return body; };
      return response;
    });
    expect(await apiRequest(`/api/intelligence/chats/${chat.id}`)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'preserved' } });
    expect((await f.readChat(chat.id)).id).toBe(chat.id);
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it.each(['send', 'archive', 'settings', 'train'] as const)('recovers the original %s after losing the HTTP response with exactly one side effect', async (action) => {
    const f = await setup(), chat = ChatSchema.parse(await f.command(sendCommand(await f.createChat()))), p = await page(f);
    await p.client.refresh();
    const command = action === 'send' ? sendCommand(chat) : action === 'archive'
      ? { action, id: chat.id, expectedRevision: chat.revision, operationId: randomUUID(), confirmed: true as const }
      : action === 'settings' ? { action, expectedRevision: 0, operationId: randomUUID(), confirmed: true as const, settings: { ...DEFAULT_INTELLIGENCE, steps: 5 } }
      : await f.trainingCommand();
    p.response.mockImplementationOnce(async () => { throw Error('Synthetic response lost after actual HTTP execution'); });
    expect(await p.client.execute(command)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(p.client.getSnapshot().unresolved).toEqual({ command, action, operationId: command.operationId,
      requestHash: await contentHash(command), expectedRevision: command.expectedRevision,
      targetId: 'id' in command ? command.id : action === 'train' ? command.operationId : null });
    expect(await p.client.execute(command)).toBeNull();
    f.restart();
    const receipt = await p.client.readOperation();
    expect(receipt).toMatchObject({ operationId: command.operationId, action, state: 'completed', requestHash: await contentHash(command), readOnly: true, absenceIsFinal: false });
    expect(p.client.getSnapshot().unresolved).toBeNull();
    expect(p.transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(f.gateway.send).toHaveBeenCalledTimes(action === 'send' ? 2 : 1);
    expect(f.issues).toHaveLength(action === 'archive' ? 1 : 0);
    expect(f.executor.run).toHaveBeenCalledTimes(action === 'train' ? 1 : 0);
    if (action === 'send') expect((await f.readChat(chat.id)).messages).toHaveLength(4);
    if (action === 'settings') expect((await f.overview()).revision).toBe(1);
    if (action === 'train') await f.terminal(command.operationId, 'completed');
  });

  it('keeps a pending original send read-only and does not call the gateway again', async () => {
    const f = await setup(), chat = await f.createChat(), p = await page(f), gate = deferred<Awaited<ReturnType<typeof f.gateway.send>>>();
    await p.client.refresh(); f.gateway.send.mockImplementationOnce(() => gate.promise);
    const command = sendCommand(chat), pending = p.client.execute(command);
    try {
      await vi.waitFor(() => expect(f.gateway.send).toHaveBeenCalledTimes(1));
      expect(await p.client.execute(command)).toBeNull();
      const receipt = IntelligenceOperationSchema.parse(await f.ok(`/api/intelligence/operations/${command.operationId}`));
      expect(receipt).toMatchObject({ state: 'pending', result: null, readOnly: true, absenceIsFinal: false });
    } finally { gate.resolve({ ok: true, data: { text: 'Synthetic completed reply', modelId: 'synthetic' } }); await pending; }
    expect((await f.readChat(chat.id)).messages).toHaveLength(2); expect(f.gateway.send).toHaveBeenCalledTimes(1);
    const headers = new Headers(p.transport.mock.calls[0]?.[1]?.headers);
    expect(headers.get(SESSION_BINDING_HEADER)).toBe(await workspaceSessionBinding(p.session));
  });

  it('distinguishes unavailable formal samples from empty knowledge while chat and settings remain usable', async () => {
    const f = await setup();
    f.documents.delete(f.base);
    const overview = await f.overview();
    expect(overview).toMatchObject({ samples: [], samplesStatus: { state: 'unavailable' } });
    const chat = await f.createChat(); expect((await f.readChat(chat.id)).messages).toHaveLength(0);
    await f.settings({ ...DEFAULT_INTELLIGENCE, steps: 5 });
    await rejected(await f.request('/api/intelligence', { ...await f.trainingCommand('lora', ['synthetic-missing']), nodeRevisions: { 'synthetic-missing': f.base } }), 502, 'UPSTREAM');
    expect(f.executor.run).not.toHaveBeenCalled();
    const noEvidence = f.identity(f.ctx.actorId, f.ctx.workspaceId, Object.values(SCOPES).filter((s) => s !== 'evidence:read'));
    await rejected(await f.request('/api/intelligence', undefined, noEvidence), 403, 'FORBIDDEN');
  });

  it('keeps an unknown original operation locked after an unrelated matching settings update', async () => {
    const f = await setup(), p = await page(f); await p.client.refresh();
    const command = { action: 'settings' as const, operationId: randomUUID(), expectedRevision: 0, confirmed: true as const,
      settings: { ...DEFAULT_INTELLIGENCE, steps: 5 } };
    p.transport.mockRejectedValueOnce(Error('Synthetic request delivery is unknown to the client'));
    await p.client.execute(command);
    await f.command({ ...command, operationId: randomUUID() });
    expect(await p.client.refresh()).not.toBeNull();
    expect(p.client.getSnapshot().unresolved?.operationId).toBe(command.operationId);
    expect(await p.client.readOperation()).toBeNull();
    expect(await p.client.execute(command)).toBeNull();
    expect((await f.overview()).revision).toBe(1);
    expect(f.journal.records(f.ctx.workspaceId, f.ctx.actorId, 'intelligence_operation')).toHaveLength(1);
  });

  it('requires process-stop evidence before deleting a failed training run and cleans only once', async () => {
    const f = await setup(), inspect = vi.fn((): 'unknown' | 'stopped' => 'unknown');
    Object.assign(f.executor, { inspect });
    f.executor.run.mockRejectedValueOnce(Error('Synthetic worker failed'));
    const command = await f.trainingCommand(); await f.command(command);
    expect(await f.terminal(command.operationId, 'failed')).toMatchObject({ cleanupReady: false });
    const deletion = { action: 'delete_run' as const, id: command.operationId, operationId: randomUUID(), confirmed: true as const };
    await rejected(await f.request('/api/intelligence', deletion), 409, 'CONFLICT');
    expect(f.executor.remove).not.toHaveBeenCalled();
    inspect.mockReturnValue('stopped');
    expect((await f.overview()).runs[0]).toMatchObject({ state: 'failed', cleanupReady: true });
    expect(await f.command(deletion)).toEqual({ deleted: true, physicalErasure: false });
    await f.command(deletion);
    expect(f.executor.remove).toHaveBeenCalledExactlyOnceWith(f.ctx.workspaceId, 'fixture', command.operationId);
    expect((await f.overview()).runs[0]).toMatchObject({ state: 'deleted', cleanupReady: false });
    expect(f.executor.run).toHaveBeenCalledTimes(1);
  });

  it('validates all guide mutation examples against the current strict command schema', () => {
    const guide = readFileSync('coordination/对话沉淀与训练接入.md', 'utf8');
    const scope: Record<string, unknown> = {
      reviewedTitle: 'Synthetic example', chatShownToUser: { id: randomUUID(), revision: 3 }, reviewedMessage: 'Synthetic example message',
      providerShownToUser: 'local', settingsShownToUser: { revision: 1 }, importanceReviewedByUser: { 'synthetic-node': 0 },
      settingsRevisionShownToUser: 1, approvedSelection: [{ id: 'synthetic-a', revision: 'a'.repeat(40) }, { id: 'synthetic-b', revision: 'b'.repeat(40) }],
      evaluatedLoraRunId: randomUUID(), terminalRunId: randomUUID(),
    };
    // Interpret only the example literal/array forms; never evaluate documentation as JavaScript.
    function value(node: ts.Expression, bindings = scope): unknown {
      if (ts.isStringLiteral(node)) return node.text;
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (ts.isIdentifier(node) && Object.hasOwn(bindings, node.text)) return bindings[node.text];
      if (ts.isPropertyAccessExpression(node)) return (value(node.expression, bindings) as Record<string, unknown>)[node.name.text];
      if (ts.isArrayLiteralExpression(node)) return node.elements.map((entry) => value(entry, bindings));
      if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map((entry) => {
        if (!ts.isPropertyAssignment(entry) || !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))) throw Error('Unsupported guide property');
        return [entry.name.text, value(entry.initializer, bindings)];
      }));
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const call = node.expression;
        if (ts.isIdentifier(call.expression) && call.expression.text === 'crypto' && call.name.text === 'randomUUID') return randomUUID();
        if (ts.isIdentifier(call.expression) && call.expression.text === 'Object' && call.name.text === 'fromEntries')
          return Object.fromEntries(value(node.arguments[0]!, bindings) as [string, unknown][]);
        const callback = node.arguments[0];
        if (call.name.text === 'map' && callback && ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) {
          const parameter = callback.parameters[0]?.name;
          if (!parameter || !ts.isIdentifier(parameter)) throw Error('Unsupported guide callback');
          const body = callback.body;
          return (value(call.expression, bindings) as unknown[]).map((item) => value(body, { ...bindings, [parameter.text]: item }));
        }
      }
      throw Error(`Unsupported guide syntax: ${ts.SyntaxKind[node.kind]}`);
    }
    const actions: string[] = [];
    for (const block of guide.matchAll(/```ts\n([\s\S]*?)\n```/g)) {
      const source = ts.createSourceFile('guide.ts', block[1]!, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'IntelligenceCommandSchema.parse')
          actions.push(IntelligenceCommandSchema.parse(value(node.arguments[0]!)).action);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(actions.sort()).toEqual(['activate', 'archive', 'create_chat', 'deactivate', 'delete_chat', 'delete_run', 'send', 'settings', 'train', 'train']);
  });

  it('keeps the shared acceptance tool health-only by default and refuses live before connecting', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data: { status: 'connected' }, meta: { mode: 'live' } }));
    await expect(runIntelligenceAcceptance(['http://127.0.0.1:4312', '--chat'], transport)).rejects.toThrow('A must schedule');
    expect(transport).not.toHaveBeenCalled();
    await expect(runIntelligenceAcceptance(['http://127.0.0.1:4312', '--allow-fixture-mutations', '--chat'], transport)).rejects.toThrow('not verified');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]?.method).toBe('GET');
    transport.mockClear();
    transport.mockResolvedValue(Response.json({ ok: true, data: { status: 'ready' }, meta: { mode: 'fixture' } }));
    expect(await runIntelligenceAcceptance(['http://127.0.0.1:4312'], transport)).toMatchObject({ outcome: 'passed', scope: 'health_only', reads: 1, mutations: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockClear();
    transport.mockResolvedValue(Response.json({ ok: true, data: { status: 'ready' }, meta: { mode: 'fixture', contractVersion: 'synthetic-old-contract' } }));
    await expect(runIntelligenceAcceptance(['http://127.0.0.1:4312', '--allow-fixture-mutations', '--chat'], transport)).rejects.toThrow('not verified');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]?.method).toBe('GET');
  });

  it('rejects unconfigured, missing and forged identities, cross-origin writes and absent independent consent', async () => {
    await rejected(await createApp(createServices()).request('/api/intelligence'), 503, 'NOT_CONFIGURED');
    const f = await setup();
    await rejected(await f.request('/api/intelligence', undefined, {}), 401, 'UNAUTHORIZED');
    const create = { action: 'create_chat', operationId: randomUUID(), title: 'Synthetic', retentionDays: 30, confirmed: true };
    await rejected(await f.request('/api/intelligence', { ...create, actorId: 'forged', workspaceId: 'forged' }), 422, 'VALIDATION');
    await rejected(await f.request('/api/intelligence', { ...create, confirmed: false }), 422, 'VALIDATION');
    await rejected(await f.request('/api/intelligence', create, { ...f.headers, Origin: 'https://untrusted.invalid' }), 403, 'FORBIDDEN');
    expect((await f.overview()).chats).toHaveLength(0);
    const chat = await f.createChat();
    await rejected(await f.request('/api/intelligence', { ...sendCommand(chat), modelConsent: false }), 422, 'VALIDATION');
    await rejected(await f.request('/api/intelligence', { ...await f.trainingCommand(), trainingConsent: false }), 422, 'VALIDATION');
    const noModel = f.identity(f.ctx.actorId, f.ctx.workspaceId, Object.values(SCOPES).filter((s) => s !== 'model:answer'));
    await rejected(await f.request('/api/intelligence', sendCommand(chat), noModel), 403, 'FORBIDDEN');
    expect((await f.readChat(chat.id)).messages).toHaveLength(0);
    expect(f.gateway.send).not.toHaveBeenCalled();
    expect(f.executor.run).not.toHaveBeenCalled();
  });

  it('isolates chat bodies and settings by trusted actor and workspace, and invalidates revoked sessions', async () => {
    const f = await setup(), chat = await f.createChat();
    await f.settings({ ...DEFAULT_INTELLIGENCE, steps: 7 });
    for (const headers of [f.identity('other-actor'), f.identity(f.ctx.actorId, 'other-workspace')]) {
      await rejected(await f.request(`/api/intelligence/chats/${chat.id}`, undefined, headers), 422, 'VALIDATION');
      await rejected(await f.request('/api/intelligence', { action: 'delete_chat', id: chat.id, expectedRevision: 1, operationId: randomUUID(), confirmed: true }, headers), 409, 'CONFLICT');
    }
    const other = await (await f.request('/api/intelligence', undefined, f.identity('other-actor'))).json();
    expect(other.data).toMatchObject({ revision: 0, settings: { steps: DEFAULT_INTELLIGENCE.steps }, chats: [] });
    expect((await f.readChat(chat.id)).id).toBe(chat.id);
    expect(await f.services.intelligenceCommand!({ ...f.ctx }, { action: 'read_chat', id: chat.id })).toMatchObject({ ok: false });
    f.sessions.revoke(f.token);
    await rejected(await f.request(`/api/intelligence/chats/${chat.id}`), 401, 'UNAUTHORIZED');
  });

  it('preserves full conversation history, revision CAS and operation identity without duplicate model sends', async () => {
    const f = await setup(), chat = await f.createChat(), first = sendCommand(chat);
    const saved = ChatSchema.parse(await f.command(first));
    expect(saved).toMatchObject({ revision: 3, status: 'ready', messages: [{ role: 'user', text: first.text }, { role: 'assistant' }] });
    expect(Date.parse(chat.expiresAt) - Date.parse(chat.createdAt)).toBe(30 * 86400000);
    await f.command(first);
    await rejected(await f.request('/api/intelligence', { ...first, text: 'Changed content' }), 409, 'CONFLICT');
    await rejected(await f.request('/api/intelligence', { ...first, operationId: randomUUID() }), 409, 'CONFLICT');
    const next = sendCommand(saved);
    const final = ChatSchema.parse(await f.command(next));
    expect(final.messages).toHaveLength(4);
    expect(f.gateway.send).toHaveBeenCalledTimes(2);
    expect(f.gateway.send.mock.calls[1]![1].map((m) => m.text)).toEqual([...saved.messages.map((m) => m.text), next.text]);
    expect((await f.readChat(chat.id)).messages).toEqual(final.messages);
  });

  it('does not save or dispatch an unconfigured send, and keeps ambiguous model outcomes read-only', async () => {
    const f = await setup(), chat = await f.createChat();
    f.gateway.status.mockReturnValue([{ id: 'local', ready: false, model: '' }]);
    await rejected(await f.request('/api/intelligence', sendCommand(chat)), 503, 'NOT_CONFIGURED');
    expect((await f.readChat(chat.id)).messages).toHaveLength(0);
    expect(f.gateway.send).not.toHaveBeenCalled();
    f.gateway.status.mockReturnValue([{ id: 'local', ready: true, model: 'synthetic' }]);
    f.gateway.send.mockRejectedValueOnce(Error('Synthetic transport lost'));
    const command = sendCommand(chat);
    await rejected(await f.request('/api/intelligence', command), 409, 'UNKNOWN_RESULT');
    const unknown = await f.readChat(chat.id);
    expect(unknown).toMatchObject({ status: 'unknown', messages: [{ role: 'user', text: command.text }] });
    await rejected(await f.request('/api/intelligence', command), 409, 'UNKNOWN_RESULT');
    await rejected(await f.request('/api/intelligence', sendCommand(unknown)), 409, 'UNKNOWN_RESULT');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
  });

  it('withholds a late assistant reply after trusted session revocation', async () => {
    const f = await setup(), chat = await f.createChat();
    const gate = deferred<Awaited<ReturnType<typeof f.gateway.send>>>();
    f.gateway.send.mockImplementationOnce(() => gate.promise);
    const pending = f.request('/api/intelligence', sendCommand(chat));
    try {
      await vi.waitFor(() => expect(f.gateway.send).toHaveBeenCalledTimes(1));
      f.sessions.revoke(f.token);
    } finally { gate.resolve({ ok: true, data: { text: 'Synthetic late reply must not persist', modelId: 'synthetic' } }); }
    await rejected(await pending, 409, 'UNKNOWN_RESULT');
    const response = await f.request(`/api/intelligence/chats/${chat.id}`, undefined, f.identity(f.ctx.actorId));
    const body = await response.json();
    expect(ChatSchema.parse(body.data)).toMatchObject({ status: 'unknown', messages: [{ role: 'user' }] });
    expect(JSON.stringify(body)).not.toContain('Synthetic late reply must not persist');
  });

  it('archives a complete chat once and hands the saved source to existing capture/handoff', async () => {
    const f = await setup();
    const chat = ChatSchema.parse(await f.command(sendCommand(await f.createChat())));
    const command = { action: 'archive' as const, operationId: randomUUID(), confirmed: true as const, id: chat.id, expectedRevision: chat.revision };
    const archived = await f.command<{ conversationId: string; issueNumber: number }>(command);
    expect(await f.command(command)).toEqual(archived);
    expect(f.issues).toHaveLength(1);
    const saved = resultData(await f.services.readConversation(f.ctx, archived.conversationId));
    expect(saved.segments.map(({ role, text }) => ({ role, text }))).toEqual(chat.messages.map(({ role, text }) => ({ role, text })));
    expect(saved).toMatchObject({ state: 'saved', issueNumber: archived.issueNumber });
    const premise = await f.captureKnowledge('Synthetic independent archive prerequisite');
    const published = await f.handoff(saved, 'Synthetic archived conversation', premise.node);
    expect(published.node).toMatchObject({ confirmation: 'confirmed', conversationId: archived.conversationId });
    expect((await f.readChat(chat.id)).archivedConversationId).toBe(archived.conversationId);
    const retrieval = await f.ok<RetrievalResult>('/api/retrieval/query', { task: premise.task, query: published.node.title, confirmedOnly: true });
    expect(retrieval.paths).toEqual(expect.arrayContaining([expect.objectContaining({ relationIds: [published.relations[0]!.id], nodeIds: [published.node.id, premise.node.id] })]));
    const train = await f.trainingCommand('lora', [published.node.id, premise.node.id]);
    await f.command(train); await f.terminal(train.operationId, 'completed');
    const samples = f.executor.run.mock.calls[0]![0].samples;
    expect(samples.find((s) => s.id === published.node.id)).toMatchObject({ groupId: archived.conversationId });
    expect(samples.find((s) => s.id === published.node.id)?.input).toContain(chat.messages[0]!.text);
    expect(f.executor.run).toHaveBeenCalledTimes(1); expect(f.issues).toHaveLength(2);
    expect((await f.overview()).training.activeRunId).toBeNull();
  });

  it('uses settings CAS, preserves exact retries across service reconstruction and rejects reused IDs with new payloads', async () => {
    const f = await setup();
    const command = { action: 'settings' as const, operationId: randomUUID(), confirmed: true as const,
      expectedRevision: 0, settings: { ...DEFAULT_INTELLIGENCE, provider: 'local' as const, steps: 5 } };
    await f.command(command);
    f.restart();
    expect(await f.command(command)).toMatchObject({ revision: 1, settings: command.settings });
    await rejected(await f.request('/api/intelligence', { ...command, settings: { ...command.settings, steps: 6 } }), 409, 'CONFLICT');
    await rejected(await f.request('/api/intelligence', { ...command, operationId: randomUUID() }), 409, 'CONFLICT');
    expect((await f.overview()).settings).toEqual(command.settings);
  });

  it('reads minimal identity-bound operation receipts without replay, body disclosure or treating absence as final', async () => {
    const f = await setup(), chat = await f.createChat(), command = sendCommand(chat);
    await f.command(command);
    f.restart();
    const receipt = IntelligenceOperationSchema.parse(await f.ok(`/api/intelligence/operations/${command.operationId}`));
    expect(receipt).toMatchObject({ action: 'send', operationId: command.operationId, targetId: chat.id, state: 'completed',
      requestHash: await contentHash(IntelligenceCommandSchema.parse(command)), result: { chatId: chat.id }, readOnly: true, absenceIsFinal: false });
    expect(JSON.stringify(receipt)).not.toContain(command.text);
    const other = await (await f.request(`/api/intelligence/operations/${command.operationId}`, undefined, f.identity('other-actor'))).json();
    expect(IntelligenceOperationSchema.parse(other.data)).toMatchObject({ state: 'not_found', requestHash: null, result: null, absenceIsFinal: false });
    expect(IntelligenceOperationSchema.parse(await f.ok(`/api/intelligence/operations/${randomUUID()}`))).toMatchObject({ state: 'not_found', absenceIsFinal: false });
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
    expect(f.executor.run).not.toHaveBeenCalled();
    expect(f.issues).toHaveLength(0);
  });

  it('binds training to approved node and settings revisions; stale, missing and withdrawn references never dispatch', async () => {
    const f = await setup(), ids = await trainingPair(f);
    const original = await f.trainingCommand('lora', ids);
    await rejected(await f.request('/api/intelligence', { ...original, nodeRevisions: {} }), 409, 'CONFLICT');
    await f.changeNode(ids[0]!, { humanStatement: 'Synthetic revised statement with original evidence.' });
    await rejected(await f.request('/api/intelligence', original), 409, 'CONFLICT');
    const current = await f.trainingCommand('lora', ids);
    await f.settings({ ...DEFAULT_INTELLIGENCE, steps: 5 });
    await rejected(await f.request('/api/intelligence', current), 409, 'CONFLICT');
    const beforeWithdrawal = await f.trainingCommand('lora', ids);
    await f.changeNode(ids[1]!, {}, true);
    await rejected(await f.request('/api/intelligence', beforeWithdrawal), 409, 'CONFLICT');
    expect(f.executor.run).not.toHaveBeenCalled();
    expect((await f.overview()).runs).toHaveLength(0);
  });

  it('excludes zero-weight nodes from dataset and run refs without deleting formal knowledge or source Issues', async () => {
    const f = await setup(), ids = await trainingPair(f);
    const zero = await f.captureKnowledge('Synthetic zero contribution');
    await f.settings({ ...DEFAULT_INTELLIGENCE, importance: { [zero.node.id]: 0 }, steps: 5 });
    const command = await f.trainingCommand('lora', [...ids, zero.node.id]);
    const run = await f.command<TrainingRun>(command);
    await f.terminal(run.id, 'completed');
    const input = f.executor.run.mock.calls[0]![0];
    expect(input.samples.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(input.run.nodeRefs.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(input.samples.every((s) => s.weight > 0)).toBe(true);
    expect(new Set(input.samples.map((s) => s.groupId)).size).toBe(2);
    expect(input.samples.every((s) => s.input.includes('Synthetic evidence'))).toBe(true);
    expect((await f.overview()).samples.find((s) => s.id === zero.node.id)?.weight).toBe(0);
    expect(resultData(await f.services.snapshot(f.ctx)).nodes.some((n) => n.id === zero.node.id)).toBe(true);
    expect(resultData(await f.services.readConversation(f.ctx, zero.saved.id)).segments).not.toHaveLength(0);
    expect(f.issues).toHaveLength(3);
    expect((await f.overview()).training.activeRunId).toBeNull();
  });

  it('requires two independent nonzero source conversations and an installed pretrained runtime', async () => {
    const f = await setup(), ids = await trainingPair(f);
    await f.settings({ ...DEFAULT_INTELLIGENCE, importance: { [ids[1]!]: 0 } });
    await rejected(await f.request('/api/intelligence', await f.trainingCommand('lora', ids)), 422, 'VALIDATION');
    f.executor.pretrainedReady.mockReturnValue(false);
    await rejected(await f.request('/api/intelligence', await f.trainingCommand('lora', ids)), 503, 'NOT_CONFIGURED');
    f.executor.ready.mockReturnValue(false);
    await rejected(await f.request('/api/intelligence', await f.trainingCommand()), 503, 'NOT_CONFIGURED');
    expect(f.executor.run).not.toHaveBeenCalled();
  });

  it('exposes running and failed states, prevents parallel/delete races and never auto-activates a failed run', async () => {
    const f = await setup(), gate = deferred<NonNullable<TrainingRun['metrics']>>();
    f.executor.run.mockImplementationOnce(() => gate.promise);
    const command = await f.trainingCommand();
    try {
      const run = await f.command<TrainingRun>(command);
      expect(run.state).toBe('running');
      expect((await f.overview()).runs[0]?.state).toBe('running');
      await f.command(command);
      await rejected(await f.request('/api/intelligence', await f.trainingCommand()), 409, 'CONFLICT');
      await rejected(await f.request('/api/intelligence', { action: 'delete_run', id: run.id, operationId: randomUUID(), confirmed: true }), 409, 'CONFLICT');
    } finally { gate.reject(Error('Synthetic executor failure; not a real Python run')); }
    await f.terminal(command.operationId, 'failed');
    expect((await f.overview()).training.activeRunId).toBeNull();
    expect(f.executor.run).toHaveBeenCalledTimes(1);
    expect(f.executor.remove).not.toHaveBeenCalled();
    await rejected(await f.request('/api/intelligence', { action: 'activate', id: command.operationId, operationId: randomUUID(), confirmed: true }), 422, 'VALIDATION');
  });

  it('keeps reconstructed in-flight runs interrupted and refuses unverified deletion without restarting training', async () => {
    const f = await setup(), gate = deferred<NonNullable<TrainingRun['metrics']>>();
    f.executor.run.mockImplementationOnce(() => gate.promise);
    const command = await f.trainingCommand();
    try {
      await f.command(command);
      f.restart();
      expect((await f.overview()).runs[0]?.state).toBe('interrupted');
      await rejected(await f.request('/api/intelligence', { action: 'delete_run', id: command.operationId, operationId: randomUUID(), confirmed: true }), 409, 'CONFLICT');
      expect(f.executor.run).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(syntheticMetrics); await f.terminal(command.operationId, 'completed'); }
  });

  it('never activates smoke even when injected synthetic metrics pass; smoke never receives private samples', async () => {
    const f = await setup();
    await rejected(await f.request('/api/intelligence', { ...await f.trainingCommand(), nodeIds: ['k1'] }), 422, 'VALIDATION');
    const command = await f.trainingCommand();
    await f.command(command);
    const run = await f.terminal(command.operationId, 'completed');
    expect(run).toMatchObject({ mode: 'smoke', nodeRefs: [], metrics: syntheticMetrics });
    expect(f.executor.run.mock.calls[0]![0].samples).toEqual([]);
    await rejected(await f.request('/api/intelligence', { action: 'activate', id: run.id, operationId: randomUUID(), confirmed: true }), 422, 'VALIDATION');
    expect((await f.overview()).training.activeRunId).toBeNull();
  });

  it.each([{ reloadVerified: false }, { parameterDelta: 0 }, { weightEffect: 0 }])('fails unverified worker metrics before activation %j', async (patch) => {
    const f = await setup();
    f.executor.run.mockResolvedValueOnce({ ...syntheticMetrics, ...patch });
    const command = await f.trainingCommand();
    await f.command(command);
    const run = await f.terminal(command.operationId, 'failed');
    expect(run.metrics).toBeUndefined();
    expect((await f.overview()).training.activeRunId).toBeNull();
    await rejected(await f.request('/api/intelligence', { action: 'activate', id: run.id, operationId: randomUUID(), confirmed: true }), 422, 'VALIDATION');
  });

  it.each([
    { validationGroups: 0 }, { heldOutAfter: null }, { heldOutBefore: null }, { heldOutAfter: 5 },
  ])('rejects LoRA activation with inadequate independent evaluation %j', async (patch) => {
    const f = await setup(), ids = await trainingPair(f);
    f.executor.run.mockResolvedValueOnce({ ...syntheticMetrics, ...patch });
    const command = await f.trainingCommand('lora', ids);
    await f.command(command);
    await f.terminal(command.operationId, 'completed');
    await rejected(await f.request('/api/intelligence', { action: 'activate', id: command.operationId, operationId: randomUUID(), confirmed: true }), 422, 'VALIDATION');
    expect((await f.overview()).training.activeRunId).toBeNull();
  });

  it.each(['revision', 'withdrawal', 'deletion'] as const)('rechecks LoRA source eligibility after %s and supports explicit deactivation', async (kind) => {
    const f = await setup(), ids = await trainingPair(f);
    const command = await f.trainingCommand('lora', ids);
    await f.command(command);
    await f.terminal(command.operationId, 'completed');
    expect((await f.overview()).training.activeRunId).toBeNull();
    await f.command({ action: 'activate', id: command.operationId, operationId: randomUUID(), confirmed: true });
    expect((await f.overview()).training.activeRunId).toBe(command.operationId);
    if (kind === 'deletion') {
      const plan = resultData(await f.services.previewDelete(f.ctx, [ids[0]!]));
      const approval = await f.ok<Approval>('/api/workspace/approvals/governance', { purpose: 'delete', planId: plan.id, confirmed: true });
      resultData(await f.services.executeDelete(f.ctx, plan, approval));
    } else await f.changeNode(ids[0]!, { humanStatement: 'Synthetic human revision.' }, kind === 'withdrawal');
    await rejected(await f.request('/api/intelligence', { action: 'activate', id: command.operationId, operationId: randomUUID(), confirmed: true }), 409, 'CONFLICT');
    await f.command({ action: 'deactivate', operationId: randomUUID(), confirmed: true });
    expect((await f.overview()).training.activeRunId).toBeNull();
  });

  it('routes independently approved candidate extraction through the active adapter and blocks it after source revision', async () => {
    const f = await setup();
    const first = await f.captureKnowledge('Synthetic adapter source');
    const second = await f.captureKnowledge('Synthetic adapter validation source');
    const command = await f.trainingCommand('lora', [first.node.id, second.node.id]);
    await f.command(command);
    await f.terminal(command.operationId, 'completed');
    await f.command({ action: 'activate', id: command.operationId, operationId: randomUUID(), confirmed: true });
    const state = resultData(await f.services.settingsState!(f.ctx));
    const snapshot = resultData(await f.services.snapshot(f.ctx));
    const settings = { ...state.settings, aiExtraction: true };
    const settingsApproval = await f.ok<Approval>('/api/workspace/approvals/governance', { purpose: 'settings', settings,
      baseRevision: snapshot.revision, expectedSettingsHash: await hashSettings(f.ctx.workspaceId, snapshot.revision, state.settings),
      expectedSettingsRevision: state.revision, confirmed: true });
    resultData(await f.services.saveSettings(f.ctx, settings, settingsApproval));
    async function extraction(source: typeof first) {
      const path = `/api/capture/${source.saved.id}`;
      const scope = { task: source.task, segmentIds: source.saved.segments.map((s) => s.id), scopeConfirmed: true };
      const preview = await f.ok<{ approvalRequest: { contentHash: string; baseRevision: string } }>(`${path}/model-preview`, scope);
      const approval = await f.ok<Approval>(`${path}/model-approve`, { ...scope, expectedInputHash: preview.approvalRequest.contentHash,
        expectedConversationHash: preview.approvalRequest.baseRevision, retentionDays: 7, confirmed: true });
      return f.request(`${path}/extract`, { ...scope, approval, retentionDays: 7, confirmed: true });
    }
    const initial = await extraction(first);
    expect(initial.status, JSON.stringify(await initial.clone().json())).toBe(200);
    expect(f.executor.infer).toHaveBeenCalledTimes(1);
    expect(f.executor.infer.mock.calls[0]!.slice(0, 3)).toEqual([f.ctx.workspaceId, 'fixture', command.operationId]);
    await f.changeNode(first.node.id, { humanStatement: 'Synthetic changed training source.' });
    await rejected(await extraction(second), 409, 'CONFLICT');
    expect(f.executor.infer).toHaveBeenCalledTimes(1);
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it('deletes only the owned terminal run, deactivates it, preserves formal knowledge and discloses no physical erasure', async () => {
    const f = await setup(), ids = await trainingPair(f);
    const command = await f.trainingCommand('lora', ids);
    await f.command(command);
    await f.terminal(command.operationId, 'completed');
    await f.command({ action: 'activate', id: command.operationId, operationId: randomUUID(), confirmed: true });
    const deletion = { action: 'delete_run' as const, id: command.operationId, operationId: randomUUID(), confirmed: true as const };
    const restricted = f.identity(f.ctx.actorId, f.ctx.workspaceId, Object.values(SCOPES).filter((s) => s !== 'data:delete'));
    await rejected(await f.request('/api/intelligence', deletion, restricted), 403, 'FORBIDDEN');
    await rejected(await f.request('/api/intelligence', deletion, f.identity('other-actor')), 409, 'CONFLICT');
    expect(await f.command(deletion)).toEqual({ deleted: true, physicalErasure: false });
    await f.command(deletion);
    expect(f.executor.remove).toHaveBeenCalledTimes(1);
    expect(f.executor.remove).toHaveBeenCalledWith(f.ctx.workspaceId, 'fixture', command.operationId);
    expect((await f.overview()).runs[0]).toMatchObject({ state: 'deleted', nodeRefs: [], datasetHash: '' });
    expect((await f.overview()).training.activeRunId).toBeNull();
    expect(resultData(await f.services.snapshot(f.ctx)).nodes.map((n) => n.id)).toEqual(expect.arrayContaining(ids));
    await rejected(await f.request('/api/intelligence', { action: 'activate', id: command.operationId, operationId: randomUUID(), confirmed: true }), 422, 'VALIDATION');
  });

  it('deletes chat bodies with CAS, leaves capture Issues alone and never resurrects old create/send receipts', async () => {
    const f = await setup();
    const chat = await f.createChat(), command = sendCommand(chat);
    const saved = ChatSchema.parse(await f.command(command));
    const source = await f.command<{ conversationId: string; issueNumber: number }>({ action: 'archive', id: chat.id,
      expectedRevision: saved.revision, operationId: randomUUID(), confirmed: true });
    const archived = await f.readChat(chat.id);
    const deletion = { action: 'delete_chat' as const, id: chat.id, expectedRevision: chat.revision, operationId: randomUUID(), confirmed: true as const };
    await rejected(await f.request('/api/intelligence', deletion), 409, 'CONFLICT');
    expect(await f.command({ ...deletion, expectedRevision: archived.revision })).toEqual({ deleted: true, physicalErasure: false, cnbArchiveDeleted: false });
    await rejected(await f.request(`/api/intelligence/chats/${chat.id}`), 422, 'VALIDATION');
    await rejected(await f.request('/api/intelligence', command), 422, 'VALIDATION');
    await rejected(await f.request('/api/intelligence', { action: 'create_chat', operationId: chat.id, title: f.runtimeId, retentionDays: 30, confirmed: true }), 422, 'VALIDATION');
    expect((await f.overview()).chats).toHaveLength(0);
    const remaining: Conversation = resultData(await f.services.readConversation(f.ctx, source.conversationId));
    expect(remaining.issueNumber).toBe(source.issueNumber);
    expect(remaining.segments.map(({ role, text }) => ({ role, text }))).toEqual(saved.messages.map(({ role, text }) => ({ role, text })));
    expect(f.issues).toHaveLength(1);
  });

  it('retrieves human-confirmed Git nodes through a real dependency path, records adoption and preserves old evidence after revision', async () => {
    const f = await setup();
    const premise = await f.captureKnowledge('Synthetic prerequisite');
    const main = await f.captureKnowledge('Synthetic graph dependent', premise.node);
    const query = { task: main.task, query: main.node.title, confirmedOnly: true };
    const before = await f.ok<RetrievalResult>('/api/retrieval/query', query);
    const nodes = (r: RetrievalResult) => [...r.groups.eligible, ...r.groups.conditional, ...r.groups.conflicts];
    expect(nodes(before).map((n) => n.id)).toEqual(expect.arrayContaining([main.node.id, premise.node.id]));
    expect(before.paths).toEqual(expect.arrayContaining([expect.objectContaining({ relationIds: [main.relations[0]!.id], nodeIds: [main.node.id, premise.node.id] })]));
    const graph = await f.ok<{ nodes: KnowledgeNode[]; relations: Relation[] }>(`/api/retrieval/graph/${main.node.id}?depth=2`);
    expect(graph.relations).toEqual(main.relations);
    expect(graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([main.node.id, premise.node.id]));
    await f.ok('/api/workspace/tasks', { operationId: randomUUID(), task: main.task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true });
    const use = await f.ok<{ storage: { operationId: string; record: EvidenceRecord; baseRevision: string } }>('/api/learning/use', {
      action: 'preview_retrieved', task: main.task, retrieval: before, nodeId: main.node.id, decision: 'adopt', reason: 'Synthetic reviewed reuse.',
    });
    const request = { operationId: use.storage.operationId, record: use.storage.record, baseRevision: use.storage.baseRevision,
      retention: 'until_deleted', confirmed: true };
    const approval = await f.ok<Approval>('/api/workspace/approvals/evidence', request);
    await f.ok('/api/learning/use', { action: 'execute', request, approval });
    const evidence = await f.ok<{ record: EvidenceRecord }>(`/api/learning/records/${use.storage.record.id}`);
    expect((await f.overview()).samples.find((s) => s.id === main.node.id)).toMatchObject({ uses: 1, weight: 1.173, corrected: false });
    await f.changeNode(main.node.id, { humanStatement: 'Synthetic revised conclusion with preserved source.' });
    const after = await f.ok<RetrievalResult>('/api/retrieval/query', query);
    expect(after.snapshotRevision).not.toBe(before.snapshotRevision);
    expect(nodes(after).find((n) => n.id === main.node.id)?.humanStatement).toBe('Synthetic revised conclusion with preserved source.');
    expect((await f.overview()).samples.find((s) => s.id === main.node.id)).toMatchObject({ uses: 0, corrected: true, weight: 1.5 });
    expect(await f.ok(`/api/learning/records/${use.storage.record.id}`)).toEqual(evidence);
    expect(f.executor.run).not.toHaveBeenCalled();
    expect(f.gateway.send).not.toHaveBeenCalled();
  });
});
