import { describe, expect, it, vi } from 'vitest';
import type { RecoveryAnchorRead } from '../../contracts/recovery-anchor';
import type { ReviewOperationReceipt } from '../../contracts/review-session';
import type { ReviewTaskTransport } from './review-task';
import { recoverRetainedLearningOperation } from './retained-operation';
import { success } from './errors';
import { context } from './testing/fixtures';

const now = Date.now();
const receipt: ReviewOperationReceipt = { operationId: 'confidence-A', attemptId: 'attempt-A', workspaceId: context.workspaceId, actorId: context.actorId,
  kind: 'confidence', requestHash: 'a'.repeat(64), expectedVersion: 0, resultingVersion: 1, feedbackVersion: null,
  appliedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), retentionDays: 30, outcome: 'applied' };
const retained: RecoveryAnchorRead = { identity: { id: 'b'.repeat(64), actorId: context.actorId, workspaceId: context.workspaceId, feature: 'learning',
  operation: { kind: 'review', operationId: receipt.operationId }, binding: { requestHash: receipt.requestHash }, createdAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 3_600_000).toISOString(), readOnly: true }, original: { kind: 'review', operationId: receipt.operationId,
  actorId: context.actorId, workspaceId: context.workspaceId, approvalId: null, recordId: receipt.attemptId, purpose: receipt.kind,
  requestHash: receipt.requestHash, contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null, stage: 'saved', readOnly: true, absenceIsFinal: false },
  binding: 'matched', readOnly: true, retryAllowed: false };

describe('retained learning original operation read-only recovery', () => {
  it('requires the dedicated review receipt, never reads a body by default and never POSTs', async () => {
    const transport = vi.fn<ReviewTaskTransport>(async (path) => success(path.includes('/recovery-identities/') ? retained : receipt));
    const result = await recoverRetainedLearningOperation(transport, context, retained);
    expect(result).toMatchObject({ ok: true, data: { receipt } });
    if (result.ok) expect(result.data).not.toHaveProperty('review');
    expect(transport.mock.calls).toEqual([[`/api/workspace/recovery-identities/${retained.identity.id}`],
      [`/api/learning/attempts/${receipt.operationId}?projection=receipt&requestHash=${receipt.requestHash}`]]);
  });
  it.each(['hash', 'version', 'operation', 'feedback', 'null'] as const)('does not treat matched metadata as a successful %s receipt', async (change) => {
    const changed = change === 'hash' ? { ...receipt, requestHash: 'f'.repeat(64) } : change === 'version' ? { ...receipt, resultingVersion: 2 }
      : change === 'operation' ? { ...receipt, operationId: 'another-confidence' } : change === 'feedback' ? { ...receipt, feedbackVersion: 1 } : null;
    const transport = vi.fn<ReviewTaskTransport>(async (path) => success(path.includes('/recovery-identities/') ? retained : changed));
    expect((await recoverRetainedLearningOperation(transport, context, retained, true)).ok).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('keeps unknown original metadata read-only, with no receipt or body lookup', async () => {
    const unknown = { ...retained, binding: 'unknown' as const, original: null };
    const transport = vi.fn<ReviewTaskTransport>(async () => success(unknown));
    expect(await recoverRetainedLearningOperation(transport, context, unknown)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not read the body after recovery consent expires during the receipt read', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const transport = vi.fn<ReviewTaskTransport>(async (path) => {
      if (path.includes('/recovery-identities/')) return success(retained);
      clock.mockReturnValue(Date.parse(retained.identity.expiresAt) + 1); return success(receipt);
    });
    try {
      expect((await recoverRetainedLearningOperation(transport, context, retained, true)).ok).toBe(false);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });
});
