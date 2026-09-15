import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import { readAnswerOperationRecovery, type AnswerRecoveryExpectation, type AnswerCall } from './answer-client';

const meta = { requestId: 'fixture', mode: 'fixture' as const, contractVersion: '1.23.0' };
const success = (data: unknown): ApiResponse<unknown> => ({ ok: true, data, meta });
const hash = 'a'.repeat(64);
const revision = 'b'.repeat(40);

const expected: AnswerRecoveryExpectation = {
  operationId: 'original-operation', actorId: 'actor-1', workspaceId: 'workspace-1',
  requestHash: hash, contentHash: 'c'.repeat(64), baseRevision: revision, objectIds: ['node-1', 'node-2'],
  approvalId: 'approval-1', approvalExpiresAt: '2026-09-11T00:00:00.000Z',
};

function recovery(overrides: Partial<OperationRecovery> = {}): OperationRecovery {
  return {
    kind: 'model', operationId: expected.operationId, actorId: expected.actorId, workspaceId: expected.workspaceId,
    approvalId: expected.approvalId ?? null, recordId: null, purpose: 'answer', requestHash: expected.requestHash,
    contentHash: expected.contentHash, baseRevision: expected.baseRevision, objectIds: [...expected.objectIds],
    approvalExpiresAt: expected.approvalExpiresAt ?? null, stage: 'done', readOnly: true, absenceIsFinal: false, ...overrides,
  };
}

describe('1.22 answer operation recovery consumer', () => {
  it('refuses an approvalId masquerading as the original operationId before making a recovery request', async () => {
    const call = vi.fn<AnswerCall>(async () => success(recovery()));
    const result = await readAnswerOperationRecovery(call, { ...expected, operationId: expected.approvalId! });

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(call).not.toHaveBeenCalled();
  });

  it('reads only the original operation metadata with the original operationId, never approvalId or private body', async () => {
    const call = vi.fn<AnswerCall>(async () => success(recovery({ recordId: null })));
    const result = await readAnswerOperationRecovery(call, expected);

    expect(result).toMatchObject({ ok: true, data: { kind: 'model', operationId: expected.operationId, stage: 'done', readOnly: true, absenceIsFinal: false } });
    expect(call).toHaveBeenCalledWith(`/api/workspace/operation-recovery/model/${expected.operationId}?modelPurpose=answer`, { method: 'GET' });
    expect(call.mock.calls.every(([, init]) => init?.method === 'GET' && init?.body === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE ANSWER BODY');
  });

  it('uses answer as the only recovery purpose and rejects an extract/review response as unknown', async () => {
    const call = vi.fn<AnswerCall>(async (path) => {
      expect(path).toBe(`/api/workspace/operation-recovery/model/${expected.operationId}?modelPurpose=answer`);
      return success(recovery({ purpose: 'review' }));
    });
    const result = await readAnswerOperationRecovery(call, expected);

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(call).toHaveBeenCalledOnce();
  });

  it.each([
    ['kind', { kind: 'task' as const }],
    ['operationId', { operationId: 'another-operation' }],
    ['actor', { actorId: 'another-actor' }],
    ['workspace', { workspaceId: 'another-workspace' }],
    ['purpose', { purpose: 'review' }],
    ['request hash', { requestHash: 'd'.repeat(64) }],
    ['content hash', { contentHash: 'e'.repeat(64) }],
    ['base revision', { baseRevision: 'f'.repeat(40) }],
    ['object scope', { objectIds: ['node-other'] }],
    ['approval binding', { approvalId: 'approval-other' }],
    ['read-only marker', { readOnly: false as unknown as true }],
    ['absence marker', { absenceIsFinal: true as unknown as false }],
  ])('rejects %s mismatch as unknown without returning metadata', async (_label, patch) => {
    const call = vi.fn<AnswerCall>(async () => success(recovery(patch)));
    const result = await readAnswerOperationRecovery(call, expected);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain(expected.approvalId);
  });

  it('accepts unresolved not_registered metadata only as non-final unknown and never treats it as not_sent', async () => {
    const call = vi.fn<AnswerCall>(async () => success(recovery({ approvalId: null, purpose: null, requestHash: null,
      contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null, stage: 'not_registered' })));
    const result = await readAnswerOperationRecovery(call, { ...expected, approvalId: undefined, approvalExpiresAt: undefined });
    expect(result).toMatchObject({ ok: true, data: { stage: 'not_registered', absenceIsFinal: false } });
    expect(result.ok && result.data.stage).not.toBe('not_sent');
  });

  it.each([
    ['operationId', { operationId: 'other-operation' }],
    ['actor', { actorId: 'other-actor' }],
    ['workspace', { workspaceId: 'other-workspace' }],
  ])('rejects unresolved %s mismatch instead of exposing an unbound operation', async (_label, patch) => {
    const call = vi.fn<AnswerCall>(async () => success(recovery({ approvalId: null, purpose: null, requestHash: null,
      contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null, stage: 'unknown', ...patch })));
    const result = await readAnswerOperationRecovery(call, { ...expected, approvalId: undefined, approvalExpiresAt: undefined });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
  });

  it('rejects malformed, null, and failed responses without creating a clean terminal state', async () => {
    const malformed = vi.fn<AnswerCall>(async () => success({ kind: 'model', operationId: expected.operationId, stage: 'done' }));
    expect(await readAnswerOperationRecovery(malformed, expected)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });

    const nullResponse = vi.fn<AnswerCall>(async () => success(null));
    expect(await readAnswerOperationRecovery(nullResponse, expected)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });

    const failed = vi.fn<AnswerCall>(async () => ({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'not configured', retryable: false, dataState: 'not_written', nextAction: 'configure_workspace' }, meta }));
    expect(await readAnswerOperationRecovery(failed, expected)).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });

  it('does not accept expired or revoked metadata as proof that the model was not sent', async () => {
    for (const stage of ['expired', 'revoked'] as const) {
      const call = vi.fn<AnswerCall>(async () => success(recovery({ stage })));
      const result = await readAnswerOperationRecovery(call, expected);
      expect(result).toMatchObject({ ok: true, data: { stage, absenceIsFinal: false } });
      expect(result.ok && result.data.stage).not.toBe('not_sent');
    }
  });
});
