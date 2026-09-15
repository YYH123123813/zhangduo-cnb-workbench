import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/app';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { governanceOperationRequest, governancePayloadSaveState, hasRestorablePayload, jsonGovernancePayload, parseGovernanceOperationState, readGovernanceOperationRecovery, readGovernancePayload, saveGovernancePayload, verifyGovernanceOperationRecovery, verifyGovernancePayload } from './governance-operation';
import { contentHash } from '../../contracts/hash';
import type { GovernanceOperationReceipt, GovernanceOperationState } from '../../contracts/governance-operation';
import type { RequestApi } from './approval-flow';

const base = 'a'.repeat(40);
const identity = { operationId: 'governance-operation-1', actorId: 'actor-1', workspaceId: 'workspace-1' };
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
async function binding() {
  const request = governanceOperationRequest({ operationId: identity.operationId, kind: 'settings', baseRevision: base, payload: { preview: { aiAnswer: false, expectedSettingsRevision: 2 } } });
  const state: GovernanceOperationState = { ...identity, kind: request.kind, baseRevision: base, payload: request.payload, contentHash: await contentHash(request.payload), requestHash: await contentHash(request),
    state: 'available', createdAt: '2026-09-09T00:00:00Z', expiresAt: '2026-10-09T00:00:00Z' };
  const receipt: GovernanceOperationReceipt = { ...identity, kind: request.kind, baseRevision: base, contentHash: state.contentHash, requestHash: state.requestHash, savedAt: state.createdAt, outcome: 'saved' };
  return { request, state, receipt };
}

describe('W6-REQ-010 governance operation consumer', () => {
  it('builds the strict 30-day save request without changing the original operation ID', () => {
    const request = governanceOperationRequest({ operationId: identity.operationId, kind: 'change', baseRevision: base, payload: { preview: { id: 'change-1', statement: 'Original preview' } } });
    expect(request).toEqual({ operationId: identity.operationId, kind: 'change', baseRevision: base, payload: { preview: { id: 'change-1', statement: 'Original preview' } }, expectedRevision: 0, retentionDays: 30, confirmed: true });
  });

  it('rejects payloads that are not explicit bounded JSON requests', () => {
    expect(jsonGovernancePayload({ value: undefined })).toEqual({});
    expect(() => jsonGovernancePayload({ value: new Date() })).toThrow();
    expect(() => governanceOperationRequest({ operationId: identity.operationId, kind: 'change', baseRevision: base, payload: { value: [undefined] } })).toThrow();
  });

  it('accepts only the same actor, workspace and operation ID for restoration', () => {
    const state = parseGovernanceOperationState({ ...identity, kind: 'change', baseRevision: base, contentHash: 'b'.repeat(64), requestHash: 'c'.repeat(64), state: 'available', payload: { preview: { statement: 'Original preview' } }, expiresAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }, identity);
    expect(hasRestorablePayload(state)).toBe(true);
    expect(() => parseGovernanceOperationState({ ...state, actorId: 'other' }, identity)).toThrow();
    expect(() => parseGovernanceOperationState({ ...state, operationId: 'other-operation' }, identity)).toThrow();
  });

  it('does not treat an expired operation without payload as a recoverable draft', () => {
    const state = parseGovernanceOperationState({ ...identity, kind: 'delete', baseRevision: base, contentHash: 'b'.repeat(64), requestHash: 'c'.repeat(64), state: 'expired', expiresAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' }, identity);
    expect(hasRestorablePayload(state)).toBe(false);
  });

  it('keeps local validation and definite conflicts as failures, while preserving unknown results', () => {
    expect(governancePayloadSaveState({ code: 'VALIDATION', dataState: 'preserved' })).toBe('failed');
    expect(governancePayloadSaveState({ code: 'CONFLICT', dataState: 'preserved' })).toBe('conflict');
    expect(governancePayloadSaveState({ code: 'UNKNOWN_RESULT', dataState: 'unknown' })).toBe('unknown');
    expect(governancePayloadSaveState({ code: 'UPSTREAM', dataState: 'partial' })).toBe('unknown');
    expect(governancePayloadSaveState({ code: 'INTERNAL', dataState: 'unknown' })).toBe('unknown');
  });

  it('uses the published shared Services HTTP endpoints and reads the same operation after the request', async () => {
    const platform = await platformFixture(); closers.push(() => platform.journal.close());
    const app = createApp(platform.services);
    const request = governanceOperationRequest({ operationId: 'governance-http-1', kind: 'export', baseRevision: platform.base, payload: { preview: { objectIds: ['k1'], baseRevision: platform.base } } });
    const savedResponse = await app.request('/api/workspace/governance-operations', { method: 'POST', headers: platform.headers, body: JSON.stringify(request) });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json();
    expect(saved.data).toMatchObject({ operationId: request.operationId, kind: 'export', state: 'available', payload: request.payload });
    const readResponse = await app.request(`/api/workspace/governance-operations/${request.operationId}`, { headers: platform.headers });
    expect(readResponse.status).toBe(200);
    expect((await readResponse.json()).data).toMatchObject({ operationId: request.operationId, kind: 'export', actorId: platform.ctx.actorId, workspaceId: platform.ctx.workspaceId, payload: request.payload });
  });

  it('verifies exact payload bytes, request binding and independent receipt rather than HTTP success', async () => {
    const b = await binding();
    expect(await verifyGovernancePayload(b.state, b.receipt, identity, b.request)).toMatchObject({ state: b.state, receipt: b.receipt });
    for (const state of [{ ...b.state, payload: { changed: true } }, { ...b.state, kind: 'delete' }, { ...b.state, baseRevision: 'other-version' }, { ...b.state, requestHash: '0'.repeat(64) }, { ...b.state, payload: undefined }]) {
      await expect(verifyGovernancePayload(state, b.receipt, identity, b.request)).rejects.toThrow();
    }
    for (const receipt of [null, { ...b.receipt, operationId: 'other' }, { ...b.receipt, contentHash: '0'.repeat(64) }, { ...b.receipt, actorId: 'other' }]) {
      await expect(verifyGovernancePayload(b.state, receipt, identity, b.request)).rejects.toThrow();
    }
  });

  it('keeps missing receipts unknown and only reads the same operation after a lost save response', async () => {
    const b = await binding();
    const api = vi.fn<RequestApi>(async (path, init) => {
      if (init?.method === 'POST') throw new Error('Lost save reply');
      return { ok: true, data: path.includes('operation-receipts') ? b.receipt : b.state, meta: { contractVersion: '1.20.0', mode: 'fixture', requestId: 'payload-test' } };
    });
    expect(await saveGovernancePayload(api, b.request, identity)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(await readGovernancePayload(api, identity, b.request)).toMatchObject({ ok: true, data: { state: b.state, receipt: b.receipt } });
    expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(api.mock.calls.slice(1).map(([path]) => path)).toEqual([`/api/workspace/governance-operations/${identity.operationId}`, `/api/workspace/governance-operation-receipts/${identity.operationId}`]);
    api.mockImplementation(async (path) => ({ ok: true, data: path.includes('operation-receipts') ? null : b.state, meta: { contractVersion: '1.20.0', mode: 'fixture', requestId: 'payload-test' } }));
    expect(await readGovernancePayload(api, identity, b.request)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
  });

  it('uses independent shared state and receipt reads for a settings payload and never writes settings itself', async () => {
    const f = await platformFixture(); closers.push(() => f.journal.close());
    const app = createApp(f.services), api = vi.fn<RequestApi>(async (path, init) => (await app.request(path, { ...init, headers: f.headers })).json());
    const b = await binding(), expected = { operationId: b.request.operationId, actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId };
    const request = { ...b.request, baseRevision: f.base };
    expect(await saveGovernancePayload(api, request, expected)).toMatchObject({ ok: true, data: { state: { kind: 'settings', payload: request.payload }, receipt: { outcome: 'saved' } } });
    expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/workspace/governance-operations', `/api/workspace/governance-operations/${request.operationId}`, `/api/workspace/governance-operation-receipts/${request.operationId}`]);
    expect(await f.services.settingsState!(f.ctx)).toMatchObject({ ok: true, data: { revision: 0 } });
    expect(f.git.publish).not.toHaveBeenCalled();
  });

  it('consumes 1.22 governance operation recovery as read-only metadata after the payload and receipt', async () => {
    const f = await platformFixture(); closers.push(() => f.journal.close());
    const app = createApp(f.services), api = vi.fn<RequestApi>(async (path, init) => (await app.request(path, { ...init, headers: f.headers })).json());
    const request = governanceOperationRequest({ operationId: 'governance-recovery-1', kind: 'export', baseRevision: f.base, payload: { preview: { objectIds: ['k1'], baseRevision: f.base } } });
    const expected = { operationId: request.operationId, actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId };
    const saved = await saveGovernancePayload(api, request, expected, { requireRecovery: true });
    expect(saved).toMatchObject({ ok: true, data: { state: { operationId: request.operationId }, receipt: { outcome: 'saved' } } });
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspace/governance-operations', `/api/workspace/governance-operations/${request.operationId}`,
      `/api/workspace/governance-operation-receipts/${request.operationId}`, `/api/workspace/operation-recovery/governance/${request.operationId}`,
    ]);
    expect(api.mock.calls.at(-1)?.[1]?.method).toBeUndefined();
    if (!saved.ok) return;
    const recovery = await readGovernanceOperationRecovery(api, { ...expected, kind: 'export', baseRevision: f.base, contentHash: saved.data.state.contentHash, requestHash: saved.data.state.requestHash }, saved.data.state);
    expect(recovery).toMatchObject({ ok: true, data: { kind: 'governance', operationId: request.operationId, stage: 'saved', readOnly: true, absenceIsFinal: false } });
    expect(recovery).toMatchObject({ ok: true, data: { objectIds: [] } });
  });

  it('keeps governance payload recovery unknown when shared operation metadata changes', async () => {
    const state = (await binding()).state;
    const api = vi.fn<RequestApi>(async () => ({ ok: true, data: { kind: 'governance', operationId: identity.operationId, actorId: identity.actorId, workspaceId: identity.workspaceId,
      approvalId: null, recordId: null, purpose: 'settings', requestHash: state.requestHash, contentHash: 'f'.repeat(64), baseRevision: state.baseRevision,
      objectIds: [], approvalExpiresAt: null, stage: 'saved', readOnly: true, absenceIsFinal: false }, meta: { contractVersion: '1.22.0', mode: 'fixture', requestId: 'recovery-test' } }));
    const result = await readGovernanceOperationRecovery(api, { ...identity, kind: 'settings', baseRevision: state.baseRevision, contentHash: state.contentHash, requestHash: state.requestHash }, state);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
  });
});
