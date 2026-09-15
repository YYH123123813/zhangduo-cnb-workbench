import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import { CONTRACT_VERSION } from '../../contracts/domain';
import { readCaptureOperationRecovery, readModelOperationRecovery, type RecoveryTransport } from './operation-recovery';

const meta = { requestId: 'capture-recovery-test', mode: 'fixture' as const, contractVersion: CONTRACT_VERSION };
const success = (data: unknown): ApiResponse<unknown> => ({ ok: true, data, meta });
const requestHash = 'a'.repeat(64);
const contentHash = 'b'.repeat(64);
const baseRevision = 'c'.repeat(40);

const capture = (overrides: Partial<OperationRecovery> = {}): OperationRecovery => ({
  kind: 'capture', operationId: 'original-save-operation', actorId: 'actor-1', workspaceId: 'workspace-1',
  approvalId: 'actual-save-approval', recordId: null, purpose: 'save_conversation', requestHash,
  contentHash, baseRevision: 'new', objectIds: ['conversation-1'], approvalExpiresAt: '2026-09-12T12:00:00.000Z',
  stage: 'done', readOnly: true, absenceIsFinal: false, ...overrides,
});

const model = (overrides: Partial<OperationRecovery> = {}): OperationRecovery => ({
  kind: 'model', operationId: 'original-model-operation', actorId: 'actor-1', workspaceId: 'workspace-1',
  approvalId: 'actual-model-approval', recordId: null, purpose: 'extract', requestHash, contentHash,
  baseRevision, objectIds: ['segment-1'], approvalExpiresAt: '2026-09-12T12:00:00.000Z', stage: 'done',
  readOnly: true, absenceIsFinal: false, ...overrides,
});

describe('1.23 capture operation-recovery consumers', () => {
  it('reads capture metadata by the original operation ID and never sends a body', async () => {
    const call = vi.fn<RecoveryTransport>(async () => success(capture()));
    const result = await readCaptureOperationRecovery(call, {
      operationId: 'original-save-operation', actorId: 'actor-1', workspaceId: 'workspace-1',
      purpose: 'save_conversation', requestHash, contentHash, baseRevision: 'new', objectIds: ['conversation-1'],
      approvalId: 'actual-save-approval',
    });

    expect(result).toMatchObject({ ok: true, data: { kind: 'capture', operationId: 'original-save-operation', readOnly: true, absenceIsFinal: false } });
    expect(call).toHaveBeenCalledWith('/api/workspace/operation-recovery/capture/original-save-operation', { method: 'GET' });
    expect(call.mock.calls.every(([, init]) => init?.method === 'GET' && init?.body === undefined)).toBe(true);
  });

  it.each([
    ['actor', { actorId: 'other-actor' }],
    ['workspace', { workspaceId: 'other-workspace' }],
    ['purpose', { purpose: 'model_input' as const }],
    ['request hash', { requestHash: 'd'.repeat(64) }],
    ['content hash', { contentHash: 'e'.repeat(64) }],
    ['base revision', { baseRevision: 'f'.repeat(40) }],
    ['object scope', { objectIds: ['conversation-other'] }],
    ['approval binding', { approvalId: 'other-approval' }],
  ])('keeps a capture %s mismatch unknown', async (_label, patch) => {
    const call = vi.fn<RecoveryTransport>(async () => success(capture(patch)));
    const result = await readCaptureOperationRecovery(call, {
      operationId: 'original-save-operation', actorId: 'actor-1', workspaceId: 'workspace-1',
      purpose: 'save_conversation', requestHash, contentHash, baseRevision: 'new', objectIds: ['conversation-1'],
      approvalId: 'actual-save-approval',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
  });

  it('reads model metadata by the original operation ID, then exposes a distinct actual approval ID', async () => {
    const call = vi.fn<RecoveryTransport>(async () => success(model()));
    const result = await readModelOperationRecovery(call, {
      operationId: 'original-model-operation', actorId: 'actor-1', workspaceId: 'workspace-1',
      purpose: 'extract', requestHash, contentHash, baseRevision, objectIds: ['segment-1'],
    });

    expect(result).toMatchObject({ ok: true, data: { operationId: 'original-model-operation', approvalId: 'actual-model-approval', purpose: 'extract' } });
    expect(call).toHaveBeenCalledWith('/api/workspace/operation-recovery/model/original-model-operation?modelPurpose=extract', { method: 'GET' });
    expect(result.ok && result.data.approvalId).not.toBe(result.ok && result.data.operationId);
  });

  it.each([
    ['actor', { actorId: 'other-actor' }],
    ['workspace', { workspaceId: 'other-workspace' }],
    ['purpose', { purpose: 'model_input' as const }],
    ['request hash', { requestHash: 'd'.repeat(64) }],
    ['content hash', { contentHash: 'e'.repeat(64) }],
    ['base revision', { baseRevision: 'f'.repeat(40) }],
    ['object scope', { objectIds: ['segment-other'] }],
    ['operation ID', { operationId: 'other-operation' }],
  ])('keeps a %s mismatch unknown without exposing recovery metadata', async (_label, patch) => {
    const call = vi.fn<RecoveryTransport>(async () => success(model(patch)));
    const result = await readModelOperationRecovery(call, {
      operationId: 'original-model-operation', actorId: 'actor-1', workspaceId: 'workspace-1',
      purpose: 'extract', requestHash, contentHash, baseRevision, objectIds: ['segment-1'],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
  });

  it('keeps not_registered and unknown non-final, and rejects malformed/null responses', async () => {
    const unresolved = vi.fn<RecoveryTransport>(async () => success(model({ approvalId: null, purpose: null, requestHash: null,
      contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null, stage: 'not_registered' })));
    const expected = { operationId: 'original-model-operation', actorId: 'actor-1', workspaceId: 'workspace-1', purpose: 'extract' as const,
      requestHash, contentHash, baseRevision, objectIds: ['segment-1'] };
    expect(await readModelOperationRecovery(unresolved, expected)).toMatchObject({ ok: true, data: { stage: 'not_registered', absenceIsFinal: false } });

    const malformed = vi.fn<RecoveryTransport>(async () => success({ kind: 'model', operationId: expected.operationId }));
    expect(await readModelOperationRecovery(malformed, expected)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });

    const empty = vi.fn<RecoveryTransport>(async () => success(null));
    expect(await readModelOperationRecovery(empty, expected)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
  });
});
