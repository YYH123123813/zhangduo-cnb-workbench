import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../contracts/api';
import { DEFAULT_INTELLIGENCE, IntelligenceCommandSchema, type IntelligenceMutation, type MemoryChat } from '../contracts/intelligence';
import { contentHash } from '../contracts/hash';
import { CONTRACT_VERSION } from '../contracts/domain';
import { SESSION_BINDING_HEADER, workspaceSessionBinding, type WorkspaceSession } from '../contracts/session';
import { bindIntelligenceSession } from './api-client';
import { IntelligenceClient } from './intelligence-client';

const operationId = '11111111-1111-4111-8111-111111111111';
const meta = { requestId: 'fixture-c', mode: 'fixture' as const, contractVersion: CONTRACT_VERSION };
const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, data, meta });
const error = (code: 'UNKNOWN_RESULT' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_CONFIGURED', dataState: 'unknown' | 'not_written' = 'not_written'): ApiResponse<unknown> =>
  ({ ok: false, error: { code, dataState, message: 'Synthetic failure', retryable: false, nextAction: 'read_only' }, meta });
const data = () => ({ revision: 1, settings: structuredClone(DEFAULT_INTELLIGENCE), providers: [{ id: 'cnb', ready: true, model: 'fixture-only' }],
  training: { ready: false, pretrainedReady: false, activeRunId: null }, samples: [], runs: [], chats: [] });
const chat = (id = 'chat-a'): MemoryChat => ({ id, title: 'Synthetic', revision: 1, messages: [], status: 'ready', provider: 'cnb',
  createdAt: '2026-09-16T00:00:00Z', expiresAt: '2026-10-16T00:00:00Z' });
const command = { action: 'send' as const, operationId, id: 'chat-a', expectedRevision: 1, text: 'fixture draft',
  provider: 'cnb' as const, confirmed: true as const, modelConsent: true as const };
const completed = (): MemoryChat => ({ ...chat(), revision: 3, messages: [
  { id: operationId, role: 'user', text: command.text, createdAt: chat().createdAt },
  { id: `${operationId}:assistant`, role: 'assistant', text: 'fixture reply', createdAt: chat().createdAt },
] });
function deferred() { let resolve!: (value: ApiResponse<unknown>) => void; const promise = new Promise<ApiResponse<unknown>>((r) => { resolve = r; }); return { promise, resolve }; }

describe('C intelligence request controller (injected transport only)', () => {
  it('reads full chat with GET and never uses POST read_chat', async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ok(chat('chat:a'))), client = new IntelligenceClient(request);
    expect((await client.readChat('chat:a'))?.id).toBe('chat:a');
    expect(request.mock.calls[0]?.[0]).toBe('/api/intelligence/chats/chat%3Aa');
    client.dispose();
  });
  it('requires the original operation receipt even when a full chat contains the exact reply', async () => {
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockResolvedValueOnce(error('UNKNOWN_RESULT', 'unknown'))
      .mockResolvedValueOnce(ok(chat())).mockResolvedValueOnce(ok(completed()));
    const client = new IntelligenceClient(request); await client.refresh();
    await client.execute(command);
    expect(client.getSnapshot().unresolved?.operationId).toBe(operationId);
    expect(await client.execute({ ...command, operationId: '22222222-2222-4222-8222-222222222222' })).toBeNull();
    await client.readChat('chat-a'); expect(client.getSnapshot().unresolved).not.toBeNull();
    await client.readChat('chat-a'); expect(client.getSnapshot().unresolved?.operationId).toBe(operationId);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    client.dispose();
  });
  it('does not settle an unknown create from the overview alone', async () => {
    const { messages: _messages, ...summary } = chat(operationId);
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce(ok({ ...data(), chats: [summary] }));
    const client = new IntelligenceClient(request); await client.refresh();
    await client.execute({ action: 'create_chat', operationId, confirmed: true, title: 'Synthetic', retentionDays: 30 });
    await client.refresh(); expect(client.getSnapshot().unresolved?.operationId).toBe(operationId); client.dispose();
  });
  it('redacts private content on binding loss without treating an already-sent mutation as not-written', async () => {
    const receipt = { operationId, action: 'send', targetId: command.id, requestHash: await contentHash(command), state: 'completed',
      result: { chatId: command.id }, updatedAt: chat().createdAt, readOnly: true, absenceIsFinal: false };
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockResolvedValueOnce(error('FORBIDDEN', 'unknown'))
      .mockResolvedValueOnce(ok(data())).mockResolvedValueOnce(ok(receipt));
    const client = new IntelligenceClient(request); await client.refresh(); await client.execute(command);
    expect(client.getSnapshot().denied).toBe(true);
    expect(client.getSnapshot().data).toBeNull();
    expect(JSON.stringify(client.getSnapshot())).not.toContain(command.text);
    await client.refresh();
    expect(client.getSnapshot().unresolved?.operationId).toBe(operationId);
    expect(await client.execute({ ...command, operationId: '22222222-2222-4222-8222-222222222222' })).toBeNull();
    expect((await client.readOperation())?.state).toBe('completed');
    expect(client.getSnapshot().unresolved).toBeNull();
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); client.dispose();
  });
  it('treats transport errors and malformed/mismatched success bodies as unknown writes', async () => {
    for (const response of [ok({ invalid: true }), ok({ ...completed(), id: 'wrong' }), ok(chat())]) {
      const request = vi.fn().mockResolvedValueOnce(ok(data())).mockResolvedValueOnce(response);
      const client = new IntelligenceClient(request); await client.refresh(); await client.execute(command);
      expect(client.getSnapshot().unresolved?.operationId).toBe(operationId); client.dispose();
    }
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockRejectedValueOnce(new Error('timeout'));
    const client = new IntelligenceClient(request); await client.refresh(); await client.execute(command);
    expect(client.getSnapshot().unresolved?.command).toEqual(command); client.dispose();
  });
  it('does not block recovery for an explicit not-written failure', async () => {
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockResolvedValueOnce(error('NOT_CONFIGURED'));
    const client = new IntelligenceClient(request); await client.refresh();
    const result = await client.execute(command);
    expect(result?.ok).toBe(false); expect(client.getSnapshot().unresolved).toBeNull(); client.dispose();
  });
  it('single-flights a double click before React has rendered busy state', async () => {
    const pending = deferred(), request = vi.fn().mockResolvedValueOnce(ok(data())).mockReturnValueOnce(pending.promise);
    const client = new IntelligenceClient(request); await client.refresh();
    const first = client.execute(command), second = await client.execute(command);
    expect(second).toBeNull(); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    pending.resolve(ok(completed())); expect((await first)?.ok).toBe(true); client.dispose();
  });
  it('ignores out-of-order full-chat reads and stale overview snapshots', async () => {
    const one = deferred(), two = deferred(), request = vi.fn().mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
    const client = new IntelligenceClient(request);
    const first = client.readChat('a'), second = client.readChat('b');
    two.resolve(ok(chat('b'))); expect((await second)?.id).toBe('b');
    one.resolve(ok(chat('a'))); expect(await first).toBeNull();
    const older = deferred(), newer = deferred(); request.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const r1 = client.refresh(), r2 = client.refresh();
    newer.resolve(ok({ ...data(), revision: 9 })); await r2;
    older.resolve(ok(data())); await r1;
    expect(client.getSnapshot().data?.revision).toBe(9); client.dispose();
  });
  it('discards late results after unmount and aborts associated requests', async () => {
    const pending = deferred(), request = vi.fn().mockReturnValueOnce(pending.promise);
    const client = new IntelligenceClient(request), reading = client.readChat('chat-a');
    client.dispose(); pending.resolve(ok(chat()));
    expect(await reading).toBeNull(); expect(request.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });
  it('revocation clears sensitive overview and invalidates other reads and pending mutation results', async () => {
    const pending = deferred(), revoked = deferred();
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockReturnValueOnce(pending.promise).mockReturnValueOnce(revoked.promise);
    const client = new IntelligenceClient(request); await client.refresh();
    const old = client.readChat('chat-a'), overview = client.refresh();
    revoked.resolve(error('UNAUTHORIZED')); await overview;
    expect(client.getSnapshot().data).toBeNull(); expect(client.getSnapshot().denied).toBe(true);
    pending.resolve(ok(chat())); expect(await old).toBeNull();
    expect(await client.execute(command)).toBeNull(); client.dispose();
  });
  it('does not falsely unlock a lost settings write after reading identical settings', async () => {
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(ok({ ...data(), revision: 2 }));
    const client = new IntelligenceClient(request); await client.refresh();
    await client.execute({ action: 'settings', operationId, confirmed: true, expectedRevision: 1, settings: data().settings }); await client.refresh();
    expect(client.getSnapshot().unresolved?.action).toBe('settings'); client.dispose();
  });
  it('validates commands before sending and disables writes while read state is unverified', async () => {
    const request = vi.fn().mockResolvedValueOnce(ok(data())); const client = new IntelligenceClient(request);
    expect(await client.execute(command)).toBeNull(); await client.refresh();
    expect((await client.execute({ ...command, text: '' }))?.ok).toBe(false);
    expect(request).toHaveBeenCalledTimes(1); client.dispose();
  });
  it('only releases unknown settings on a matching GET receipt, never a new POST', async () => {
    const mutation: IntelligenceMutation = { action: 'settings', operationId, confirmed: true, expectedRevision: 1, settings: data().settings };
    const receipt = { operationId, action: 'settings', targetId: null, requestHash: await contentHash(mutation), state: 'completed',
      result: { revision: 2 }, updatedAt: chat().createdAt, readOnly: true, absenceIsFinal: false };
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce(ok({ ...receipt, requestHash: '0'.repeat(64) })).mockResolvedValueOnce(ok(receipt));
    const client = new IntelligenceClient(request); await client.refresh(); await client.execute(mutation);
    expect(await client.readOperation()).toBeNull(); expect(client.getSnapshot().unresolved).not.toBeNull();
    expect((await client.readOperation())?.state).toBe('completed'); expect(client.getSnapshot().unresolved).toBeNull();
    expect(request.mock.calls[2]?.[0]).toBe(`/api/intelligence/operations/${operationId}`);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); client.dispose();
  });
  it('keeps not_found, pending, unknown, mismatched action/target/result and invalid receipts blocked', async () => {
    const receipt = { operationId, action: 'send', targetId: command.id, requestHash: await contentHash(command), state: 'completed',
      result: { chatId: command.id }, updatedAt: chat().createdAt, readOnly: true, absenceIsFinal: false };
    for (const invalid of [
      { ...receipt, state: 'not_found', result: null, action: null, requestHash: null, targetId: null },
      { ...receipt, state: 'pending', result: null }, { ...receipt, state: 'unknown', result: null },
      { ...receipt, action: 'archive' }, { ...receipt, targetId: 'other' }, { ...receipt, result: { chatId: 'other' } },
      { ...receipt, operationId: '22222222-2222-4222-8222-222222222222' }, { ...receipt, readOnly: false },
    ]) {
      const request = vi.fn().mockResolvedValueOnce(ok(data())).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(ok(invalid));
      const client = new IntelligenceClient(request); await client.refresh(); await client.execute(command);
      expect(await client.readOperation()).toBeNull(); expect(client.getSnapshot().unresolved).not.toBeNull(); client.dispose();
    }
  });
  it('hashes the schema-normalized original request and accepts a definite failed receipt without auto-retry', async () => {
    const raw = { ...command, text: '  fixture draft  ' };
    const receipt = { operationId, action: 'send', targetId: command.id, requestHash: await contentHash(IntelligenceCommandSchema.parse(raw)),
      state: 'failed', result: null, updatedAt: chat().createdAt, readOnly: true, absenceIsFinal: false };
    const request = vi.fn().mockResolvedValueOnce(ok(data())).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(ok(receipt));
    const client = new IntelligenceClient(request); await client.refresh(); await client.execute(raw);
    expect(JSON.parse(request.mock.calls[1]?.[1]?.body).text).toBe('fixture draft');
    expect((await client.readOperation())?.state).toBe('failed'); expect(client.getSnapshot().unresolved).toBeNull();
    expect(request).toHaveBeenCalledTimes(3); client.dispose();
  });
  it('does not expose a late mutation success after dispose or a revoked mutation', async () => {
    const pending = deferred(), request = vi.fn().mockResolvedValueOnce(ok(data())).mockReturnValueOnce(pending.promise);
    const client = new IntelligenceClient(request); await client.refresh();
    const sending = client.execute(command); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    client.dispose(); pending.resolve(ok(completed())); expect(await sending).toBeNull();
    const deniedRequest = vi.fn().mockResolvedValueOnce(ok(data())).mockResolvedValueOnce(error('UNAUTHORIZED'));
    const deniedClient = new IntelligenceClient(deniedRequest); await deniedClient.refresh(); await deniedClient.execute(command);
    expect(deniedClient.getSnapshot().data).toBeNull(); expect(deniedClient.getSnapshot().accessVersion).toBe(1); deniedClient.dispose();
  });
  it('accepts all exact mutation response shapes and preserves expected revisions in the request', async () => {
    const operation = { operationId, confirmed: true as const };
    const cases: [IntelligenceMutation, unknown][] = [
      [{ ...operation, action: 'create_chat', title: 'Synthetic', retentionDays: 30 }, chat(operationId)],
      [{ ...operation, action: 'archive', id: 'chat-a', expectedRevision: 1 }, { conversationId: `chat-${operationId}`, taskId: 'task-a' }],
      [{ ...operation, action: 'settings', expectedRevision: 1, settings: data().settings }, { revision: 2, settings: data().settings }],
      [{ ...operation, action: 'train', expectedRevision: 1, mode: 'smoke', nodeIds: [], nodeRevisions: {}, trainingConsent: true },
        { id: operationId, mode: 'smoke', state: 'running', createdAt: chat().createdAt, datasetHash: 'synthetic', settingsRevision: 1, sampleCount: 16, nodeRefs: [], message: 'Synthetic' }],
      [{ ...operation, action: 'activate', id: 'run-a' }, { id: 'run-a' }],
      [{ ...operation, action: 'deactivate' }, { id: null }],
      [{ ...operation, action: 'delete_chat', id: 'chat-a', expectedRevision: 1 }, { deleted: true, physicalErasure: false, cnbArchiveDeleted: false }],
      [{ ...operation, action: 'delete_run', id: operationId }, { deleted: true, physicalErasure: false }],
    ];
    for (const [input, output] of cases) {
      const request = vi.fn().mockResolvedValueOnce(ok(data())).mockResolvedValueOnce(ok(output));
      const client = new IntelligenceClient(request); await client.refresh();
      expect((await client.execute(input))?.ok).toBe(true);
      expect(JSON.parse(request.mock.calls[1]?.[1]?.body)).toEqual(input); client.dispose();
    }
  });
  it('rejects a read_operation command through the mutation boundary without POST', async () => {
    const request = vi.fn().mockResolvedValueOnce(ok(data())); const client = new IntelligenceClient(request); await client.refresh();
    // @ts-expect-error Deliberately test an invalid runtime call at the mutation boundary.
    const result = await client.execute({ action: 'read_operation', id: operationId });
    expect(result?.ok).toBe(false); expect(request).toHaveBeenCalledTimes(1); client.dispose();
  });
});

describe('C client through the shared apiRequest binding protocol (synthetic transport)', () => {
  const session: WorkspaceSession = { actorId: 'synthetic-c', workspace: { id: 'fixture-c', slug: 'synthetic/c', visibility: 'private', mode: 'fixture' }, scopes: ['settings:read', 'conversation:read', 'conversation:write'] };
  let unbind: (() => void) | undefined;
  const clients: IntelligenceClient[] = [];
  const client = () => { const value = new IntelligenceClient(); clients.push(value); return value; };
  const response = (value: unknown, init?: RequestInit) => Response.json(ok(value), { headers: { [SESSION_BINDING_HEADER]: new Headers(init?.headers).get(SESSION_BINDING_HEADER) ?? '' } });
  afterEach(() => { clients.splice(0).forEach((value) => value.dispose()); unbind?.(); unbind = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('makes no network request without a verified page binding', async () => {
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    const value = client(); await value.refresh();
    expect(transport).not.toHaveBeenCalled(); expect(value.getSnapshot().denied).toBe(true);
    expect(await value.execute(command)).toBeNull();
  });
  it('uses the shared identity header and the exact approved POST body', async () => {
    unbind = bindIntelligenceSession(session);
    const transport = vi.fn(async (_path: string, init?: RequestInit) => response(init?.method === 'POST' ? completed() : data(), init));
    vi.stubGlobal('fetch', transport);
    const value = client(); await value.refresh(); expect((await value.execute(command))?.ok).toBe(true);
    expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get(SESSION_BINDING_HEADER)).toBe(await workspaceSessionBinding(session));
    expect(transport.mock.calls[1]?.[0]).toBe('/api/intelligence');
    expect(transport.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(IntelligenceCommandSchema.parse(command)));
  });
  it('requires the old receipt after a POST response has no matching server echo', async () => {
    unbind = bindIntelligenceSession(session);
    const receipt = { operationId, action: 'send', targetId: command.id, requestHash: await contentHash(command), state: 'completed',
      result: { chatId: command.id }, updatedAt: chat().createdAt, readOnly: true, absenceIsFinal: false };
    const transport = vi.fn(async (path: string, init?: RequestInit) => init?.method === 'POST'
      ? Response.json(ok(completed())) : response(path.includes('/operations/') ? receipt : data(), init));
    vi.stubGlobal('fetch', transport);
    const value = client(); await value.refresh(); await value.execute(command);
    expect(value.getSnapshot().denied).toBe(true); expect(value.getSnapshot().unresolved?.command).toBeNull();
    expect(value.getSnapshot().unresolved?.operationId).toBe(operationId);
    await value.refresh(); expect(await value.execute(command)).toBeNull();
    expect((await value.readOperation())?.state).toBe('completed');
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('does not deliver old chat contents after an external binding change', async () => {
    unbind = bindIntelligenceSession(session);
    let finish!: (value: Response) => void;
    const transport = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', transport);
    const value = client(), reading = value.readChat('chat-a');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    unbind = bindIntelligenceSession({ ...session, actorId: 'synthetic-other' });
    finish(response(completed(), transport.mock.calls[0]?.[1]));
    expect(await reading).toBeNull(); expect(value.getSnapshot().data).toBeNull(); expect(value.getSnapshot().denied).toBe(true);
  });
  it('aborts a timed-out POST and retains the original operation without retrying', async () => {
    vi.useFakeTimers(); unbind = bindIntelligenceSession(session);
    const transport = vi.fn((path: string, init?: RequestInit) => init?.method !== 'POST' ? Promise.resolve(response(data(), init))
      : new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error(`Synthetic timeout: ${path}`)), { once: true })));
    vi.stubGlobal('fetch', transport);
    const value = client(); await value.refresh(); const sending = value.execute(command);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(90000); expect((await sending)?.ok).toBe(false);
    expect(value.getSnapshot().unresolved?.operationId).toBe(operationId); expect(await value.execute(command)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
