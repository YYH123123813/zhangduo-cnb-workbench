import { describe, expect, it, vi } from 'vitest';
import type { OperationRecovery } from '../../contracts/operation-recovery';
import { failure, success } from './errors';
import { readLearningOperationRecovery, readTaskOperationRecovery } from './operation-recovery';

const identity = { actorId: 'actor-1', workspaceId: 'workspace-1' };
const hash = 'a'.repeat(64);
const revision = 'b'.repeat(40);

function recovery(overrides: Partial<OperationRecovery> = {}): OperationRecovery {
  return {
    kind: 'evidence', operationId: 'use-operation-1', actorId: identity.actorId, workspaceId: identity.workspaceId,
    approvalId: 'approval-1', recordId: 'use-record-1', purpose: 'save_evidence', requestHash: hash,
    contentHash: hash, baseRevision: revision, objectIds: ['use-record-1'], approvalExpiresAt: '2026-09-10T00:00:00Z',
    stage: 'saved', readOnly: true, absenceIsFinal: false, ...overrides,
  };
}

describe('W12 learning operation recovery consumer', () => {
  it('reads saved evidence metadata by the original operation ID without sending a mutation or exposing body text', async () => {
    const transport = vi.fn(async (path: string, init?: RequestInit) => success(recovery({ operationId: 'use-operation-1' })));
    const result = await readLearningOperationRecovery(transport, identity, { kind: 'evidence', operationId: 'use-operation-1' });
    expect(result).toMatchObject({ ok: true, data: { kind: 'evidence', operationId: 'use-operation-1', stage: 'saved', recordId: 'use-record-1', readOnly: true, absenceIsFinal: false } });
    expect(transport).toHaveBeenCalledWith('/api/workspace/operation-recovery/evidence/use-operation-1');
    expect(transport.mock.calls.every(([, init]) => init === undefined || init.method === undefined || init.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE TASK BODY');
  });

  it('supports task operation recovery and preserves non-final unknown stages', async () => {
    const transport = vi.fn(async () => success(recovery({ kind: 'task', operationId: 'task-operation-1', approvalId: null,
      recordId: null, purpose: null, requestHash: null, contentHash: null, baseRevision: null, objectIds: [],
      approvalExpiresAt: null, stage: 'unknown' })));
    const result = await readTaskOperationRecovery(transport, identity, 'task-operation-1');
    expect(result).toMatchObject({ ok: true, data: { kind: 'task', operationId: 'task-operation-1', stage: 'unknown', absenceIsFinal: false } });
    expect(transport).toHaveBeenCalledWith('/api/workspace/operation-recovery/task/task-operation-1');
  });

  it.each([
    ['wrong actor', { actorId: 'other-actor' }],
    ['wrong workspace', { workspaceId: 'other-workspace' }],
    ['wrong operation', { operationId: 'other-operation' }],
    ['wrong kind', { kind: 'task' as const }],
    ['final absence', { absenceIsFinal: true as unknown as false }],
    ['not read only', { readOnly: false as unknown as true }],
  ])('rejects %s metadata as unknown without returning it', async (_label, override) => {
    const transport = vi.fn(async () => success(recovery(override)));
    const result = await readLearningOperationRecovery(transport, identity, { kind: 'evidence', operationId: 'use-operation-1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('use-record-1');
  });

  it('rejects malformed or failed recovery responses and never converts absence into success', async () => {
    const malformed = vi.fn(async () => success({ kind: 'evidence', operationId: 'use-operation-1', stage: 'saved' }));
    expect(await readLearningOperationRecovery(malformed, identity, { kind: 'evidence', operationId: 'use-operation-1' })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    const unavailable = vi.fn(async () => failure('NOT_CONFIGURED', 'Recovery is not connected.'));
    expect(await readLearningOperationRecovery(unavailable, identity, { kind: 'evidence', operationId: 'use-operation-1' })).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
    expect(await readLearningOperationRecovery(unavailable, identity, { kind: 'evidence', operationId: '' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});
