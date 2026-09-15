import { describe, expect, it, vi } from 'vitest';
import type { RecoveryAnchor, RecoveryAnchorInput, RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import { contentHash } from '../../contracts/hash';
import { success } from './errors';
import { retainLearningRecovery, readLearningRecoveryAnchor, taskRecoveryInput, reviewRecoveryInput } from './recovery-anchor';
import { context, task } from './testing/fixtures';

const now = Date.parse('2026-09-16T00:00:00Z');
const input: RecoveryAnchorInput = { feature: 'learning', operation: { kind: 'task', operationId: 'task-save-A' },
  binding: { requestHash: 'a'.repeat(64) }, confirmed: true, expiresAt: new Date(now + 3_600_000).toISOString() };
const anchor: RecoveryAnchor = { id: 'b'.repeat(64), actorId: context.actorId, workspaceId: context.workspaceId,
  feature: input.feature, operation: input.operation, binding: input.binding, createdAt: new Date(now).toISOString(), expiresAt: input.expiresAt, readOnly: true };

describe('learning separately consented 1.26 recovery identity', () => {
  it.each(['consent', 'expired', 'tooLong', 'purpose', 'body'] as const)('refuses %s before calling retention', async (change) => {
    const retain = vi.fn(async () => success(anchor));
    const invalid = change === 'consent' ? { ...input, confirmed: false } : change === 'expired' ? { ...input, expiresAt: new Date(now).toISOString() }
      : change === 'tooLong' ? { ...input, expiresAt: new Date(now + 86_400_001).toISOString() }
        : change === 'purpose' ? { ...input, operation: { kind: 'model', operationId: 'm', modelPurpose: 'answer' } } : { ...input, task };
    expect((await retainLearningRecovery(retain, context, invalid, now)).ok).toBe(false);
    expect(retain).not.toHaveBeenCalled();
  });
  it.each(['actor', 'operation', 'hash', 'expiry', 'privateField'] as const)('does not accept a retained %s mismatch', async (field) => {
    const wrong = field === 'actor' ? { ...anchor, actorId: 'other' } : field === 'operation' ? { ...anchor, operation: { kind: 'task', operationId: 'other' } }
      : field === 'hash' ? { ...anchor, binding: { requestHash: 'c'.repeat(64) } } : field === 'expiry' ? { ...anchor, expiresAt: new Date(now + 2000).toISOString() } : { ...anchor, task };
    expect(await retainLearningRecovery(async () => success(wrong as RecoveryAnchor), context, input, now)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
  });
  it('does not retry when retention response is lost', async () => {
    const retain = vi.fn(async () => { throw Error('lost after persist'); });
    expect(await retainLearningRecovery(retain, context, input, now)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(retain).toHaveBeenCalledTimes(1);
  });
  it('binds the full task request and each review event independently', async () => {
    const request = { operationId: 'task-save-A', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30 as const, confirmed: true as const };
    expect((await taskRecoveryInput(request, input.expiresAt)).binding).toEqual({ requestHash: await contentHash(request) });
    const event = { action: 'event' as const, operationId: 'confidence-A', attemptId: 'attempt-A', expectedVersion: 0, event: { type: 'confidence' as const, value: 'high' as const } };
    const { action: _action, ...payload } = event;
    const retained = await reviewRecoveryInput(event, input.expiresAt);
    expect(retained.operation).toEqual({ kind: 'review', operationId: event.operationId });
    expect(retained.binding).toEqual({ requestHash: await contentHash(payload) });
  });
  it('revalidates the current identity before any GET and accepts only the same immutable anchor', async () => {
    const supplied: RecoveryAnchorRead = { identity: anchor, original: null, binding: 'unknown', readOnly: true, retryAllowed: false };
    const transport = vi.fn(async () => success(supplied));
    expect((await readLearningRecoveryAnchor(transport, { ...context, actorId: 'other' }, supplied, now)).ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    expect(await readLearningRecoveryAnchor(transport, context, supplied, now)).toEqual(success(supplied));
    expect(transport.mock.calls).toEqual([[`/api/workspace/recovery-identities/${anchor.id}`]]);
  });
  it('does not trust matched metadata with a missing or different original request hash', async () => {
    const supplied = { identity: anchor, original: null, binding: 'matched', readOnly: true, retryAllowed: false };
    const transport = vi.fn(async () => success(supplied));
    expect((await readLearningRecoveryAnchor(transport, context, supplied, now)).ok).toBe(false);
  });
  it('rejects an anchor that expires while its GET is in flight', async () => {
    const supplied: RecoveryAnchorRead = { identity: anchor, original: null, binding: 'unknown', readOnly: true, retryAllowed: false };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const transport = vi.fn(async () => { clock.mockReturnValue(Date.parse(anchor.expiresAt) + 1); return success(supplied); });
      expect((await readLearningRecoveryAnchor(transport, context, supplied, now)).ok).toBe(false);
    } finally { clock.mockRestore(); }
  });
});
