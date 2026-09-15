import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApiResponse } from '../../contracts/api';
import type { RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import { contentHash } from '../../contracts/hash';
import { createRestoredAnswerFlow } from './restored-answer';
import { AnswerRecoveryPanel } from './answer-recovery-view';
import type { AnswerCall } from './answer-client';

const session = { actorId: 'u1', workspace: { id: 'w1', slug: 'fixture/recovery', visibility: 'private', mode: 'fixture' }, scopes: ['workspace:read', 'model:answer'] };
const success = (data: unknown): ApiResponse<unknown> => ({ ok: true, data, meta: { requestId: 'read-only', mode: 'fixture', contractVersion: '1.26.0' } });
async function identity(operationId = 'original-registration'): Promise<RecoveryAnchorRead> {
  const operation = { kind: 'model' as const, operationId, modelPurpose: 'answer' as const };
  return { identity: { id: await contentHash(['retrieval', operation]), actorId: 'u1', workspaceId: 'w1', feature: 'retrieval', operation,
    binding: { contentHash: 'a'.repeat(64), baseRevision: 'fixture-r1' }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), readOnly: true },
    original: { kind: 'model', operationId, actorId: 'u1', workspaceId: 'w1', approvalId: 'actual-approval', recordId: null, purpose: 'answer',
      requestHash: 'b'.repeat(64), contentHash: 'a'.repeat(64), baseRevision: 'fixture-r1', objectIds: ['n1'], approvalExpiresAt: new Date(Date.now() + 600000).toISOString(),
      stage: 'done', readOnly: true, absenceIsFinal: false }, binding: 'matched', readOnly: true, retryAllowed: false };
}
async function setup() {
  const value = await identity();
  const call = vi.fn<AnswerCall>(async (path) => success(path.endsWith('/session') ? session : path.includes('/recovery-identities/') ? value : value.original));
  const onState = vi.fn(); const flow = createRestoredAnswerFlow({ call, onState });
  return { value, call, flow, onState };
}
afterEach(() => vi.useRealTimers());

describe('1.26 new answer component read-only recovery, synthetic DTOs', () => {
  it('verifies trusted identity before reading the original operation, never a preview or answer', async () => {
    const f = await setup(); await f.flow.restore(f.value); await f.flow.inspect();
    expect(f.flow.state.status).toBe('matched'); expect(f.flow.state.metadata?.stage).toBe('done');
    expect(f.flow.leaveState()).toBe('blocked');
    expect(f.call.mock.calls[0]?.[0]).toBe('/api/workspace/session');
    expect(f.call.mock.calls.some(([path]) => path === '/api/workspace/operation-recovery/model/original-registration?modelPurpose=answer')).toBe(true);
    expect(f.call.mock.calls.every(([, init]) => init?.method === 'GET' && !init.body)).toBe(true);
    expect(JSON.stringify(f.flow.state)).not.toMatch(/input|query|answer\.text/);
  });
  it.each(['actor', 'workspace', 'purpose', 'feature', 'operation', 'approval-id', 'hash', 'base', 'id', 'ttl', 'body', 'writable', 'stage'])(
    'rejects a delivered %s mismatch before reading a business operation', async (wrong) => {
      const f = await setup(), value = structuredClone(f.value);
      if (wrong === 'actor') value.identity.actorId = 'other';
      if (wrong === 'workspace') value.identity.workspaceId = 'other';
      if (wrong === 'purpose' && value.identity.operation.kind === 'model') value.identity.operation.modelPurpose = 'review';
      if (wrong === 'feature') value.identity.feature = 'learning';
      if (wrong === 'operation') value.original!.operationId = 'other';
      if (wrong === 'approval-id') value.original!.approvalId = value.original!.operationId;
      if (wrong === 'hash') value.original!.contentHash = 'f'.repeat(64);
      if (wrong === 'base') value.original!.baseRevision = 'fixture-other';
      if (wrong === 'id') value.identity.id = 'c'.repeat(64);
      if (wrong === 'ttl') value.identity.expiresAt = new Date(Date.now() + 90000000).toISOString();
      if (wrong === 'body') Object.assign(value.original!, { text: 'PRIVATE_BODY' });
      if (wrong === 'writable') Object.assign(value, { retryAllowed: true });
      if (wrong === 'stage') value.original!.stage = 'saved';
      await f.flow.restore(value);
      expect(['mismatch', 'unauthorized']).toContain(f.flow.state.status); expect(f.flow.state.metadata).toBeNull();
      expect(f.call.mock.calls.every(([path]) => path.endsWith('/session'))).toBe(true); expect(f.flow.leaveState()).toBe('blocked');
    });
  it.each(['operationId', 'actorId', 'workspaceId', 'purpose', 'approvalId', 'requestHash', 'contentHash', 'baseRevision', 'objectIds'] as const)(
    'rejects a second GET that no longer matches original %s', async (field) => {
      const f = await setup(); f.call.mockImplementation(async (path) => success(path.endsWith('/session') ? session : { ...f.value.original, [field]: field === 'objectIds' ? ['other'] : 'other' }));
      await f.flow.restore(f.value); expect(f.flow.state.status).toBe('unknown'); expect(f.flow.state.metadata).toBeNull();
    });
  it.each(['unknown', 'mismatch', 'missing', 'expired', 'revoked', 'not_registered', 'null', 'error', 'forbidden'])(
    'keeps %s distinct and blocked without model writes', async (kind) => {
      const f = await setup(); const value = structuredClone(f.value);
      if (kind === 'unknown') { value.binding = 'unknown'; value.original = null; }
      if (kind === 'mismatch') { value.binding = 'mismatch'; value.original = null; }
      if (kind === 'expired') value.identity.expiresAt = new Date(Date.now() - 1000).toISOString();
      if (kind === 'revoked') value.original!.stage = 'revoked';
      if (kind === 'not_registered') { value.binding = 'unknown'; value.original = { ...value.original!, stage: 'not_registered', approvalId: null,
        requestHash: null, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null }; }
      if (kind === 'null' || kind === 'error') f.call.mockImplementation(async (path) => { if (path.endsWith('/session')) return success(session); if (kind === 'error') throw Error('network'); return success(null); });
      if (kind === 'forbidden') f.call.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'denied', retryable: false, dataState: 'unknown', nextAction: 'connect' }, meta: { requestId: 'denied', mode: 'fixture', contractVersion: '1.26.0' } });
      await f.flow.restore(kind === 'missing' ? null : value);
      expect(f.flow.state.status).toBe(kind === 'expired' || kind === 'missing' || kind === 'mismatch' ? kind : kind === 'forbidden' ? 'unauthorized' : 'unknown');
      expect(f.flow.leaveState()).toBe('blocked'); expect(f.call.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    });
  it.each(['done', 'discarded', 'not_sent'] as const)('renders metadata %s without promoting it to a trusted answer or terminal receipt', async (stage) => {
    const f = await setup(); f.value.original!.stage = stage; await f.flow.restore(f.value);
    const html = renderToStaticMarkup(createElement(AnswerRecoveryPanel, { state: f.flow.state, onInspect: () => {} }));
    expect(html).toContain(stage); expect(html).not.toMatch(/textarea|生成回答|批准本次|掌握|平台已证明未发送/);
    expect(f.flow.leaveState()).toBe('blocked');
  });
  it('drops late reads from the old component and reconnects using a new GET-only component', async () => {
    const f = await setup(); let resolve!: (v: ApiResponse<unknown>) => void;
    f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const reading = f.flow.restore(f.value); f.flow.dispose(); const count = f.onState.mock.calls.length;
    resolve(success(session)); await reading; expect(f.onState).toHaveBeenCalledTimes(count); expect(f.call).toHaveBeenCalledTimes(1);
    const reconnected = createRestoredAnswerFlow({ call: f.call, onState: vi.fn() }); await reconnected.restore(f.value);
    expect(reconnected.state.status).toBe('matched'); expect(f.call.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('rejects same-content another-operation readback, and clears metadata on identity loss', async () => {
    const f = await setup(); await f.flow.restore(f.value);
    const other = await identity('different-registration');
    f.call.mockImplementation(async (path) => success(path.endsWith('/session') ? session : other));
    await f.flow.inspect(); expect(f.flow.state.status).toBe('mismatch'); expect(f.flow.state.metadata).toBeNull();
    await f.flow.restore(null); expect(f.flow.state.status).toBe('missing'); expect(f.flow.state.identity).toBeNull();
  });
  it('does not let operation A arriving late replace the same component now inspecting B', async () => {
    const f = await setup(), second = await identity('second-operation'); let resolve!: (value: ApiResponse<unknown>) => void;
    f.call.mockImplementation(async (path) => {
      if (path.endsWith('/session')) return success(session);
      if (path.includes('/original-registration?')) return new Promise((done) => { resolve = done; });
      return success(second.original);
    });
    const firstRead = f.flow.restore(f.value); await vi.waitFor(() => expect(resolve).toBeDefined());
    await f.flow.restore(second); resolve(success(f.value.original)); await firstRead;
    expect(f.flow.state.metadata?.operationId).toBe('second-operation'); expect(f.flow.state.identity?.id).toBe(second.identity.id);
    expect(f.call.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});
