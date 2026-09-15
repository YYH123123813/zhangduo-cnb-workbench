import { describe, expect, it } from 'vitest';
import type { Approval } from '../../contracts/domain';
import { invalidateSubmission, isSubmissionLocked, newSubmission, settleApproval, settleReceiptRead, settleSubmission } from './submission';

const approval: Approval = { id: 'approval-1', workspaceId: 'workspace-1', actorId: 'actor-1', purpose: 'commit_knowledge',
  objectIds: ['node-1'], baseRevision: 'fixture-base', contentHash: 'fixture-hash',
  approvedAt: '2026-09-05T01:00:00.000Z', expiresAt: '2026-09-05T01:05:00.000Z' };
describe('H10 explicit approval lifecycle', () => {
  it('retains registered approval after a non-writing rejection until it is revoked', () => {
    const state = { ...newSubmission(), approval, pending: true };
    const failed = settleSubmission(state, { ok: false, error: { code: 'CONFLICT', message: 'HEAD moved', retryable: false, dataState: 'preserved', nextAction: 'refresh_preview' } });
    expect(failed.approval).toEqual(approval);
    expect(failed.rejected).toBe(true);
    expect(invalidateSubmission(failed)).toBe(failed);
    expect(isSubmissionLocked(failed)).toBe(true);
  });
  it('unlocks a completed operation so the next candidate can be reviewed', () => {
    const saved = settleSubmission({ ...newSubmission(), approval, pending: true }, { ok: true,
      data: { changeSetId: 'operation-1', revision: 'fixture-commit', commitUrl: 'https://cnb.cool/fixture', indexing: 'pending' } });
    expect(saved.approval).toBeNull();
    expect(isSubmissionLocked(saved)).toBe(false);
    expect(saved.receipt?.indexing).toBe('pending');
  });
  it('keeps an uncertain approval registration distinct from an unknown Git write', () => {
    const uncertain = settleApproval(newSubmission(), { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'response interrupted', retryable: false, dataState: 'unknown', nextAction: 'check_approval' } });
    expect(uncertain.approvalUnknown).toBe(true);
    expect(uncertain.unknown).toBe(false);
    expect(isSubmissionLocked(uncertain)).toBe(true);
    expect(invalidateSubmission(uncertain)).toBe(uncertain);
  });
  it('does not manufacture authorization after a refusal, and accepts only the returned registration', () => {
    const refused = settleApproval(newSubmission(), { ok: false, error: { code: 'FORBIDDEN', message: 'denied', retryable: false, dataState: 'not_written', nextAction: 'request_access' } });
    expect(isSubmissionLocked(refused)).toBe(false);
    const registered = settleApproval(refused, { ok: true, data: approval });
    expect(registered.approval).toEqual(approval);
    expect(registered.approvalUnknown).toBe(false);
  });
  it('resolves an unknown write only when commit readback authoritatively confirms the branch conflict', () => {
    const state = { ...newSubmission(), approval, unknown: true };
    const resolved = settleReceiptRead(state, { ok: false, error: { code: 'CONFLICT', message: 'Branch rejected base',
      retryable: false, dataState: 'preserved', nextAction: 'preview_again' } });
    expect(resolved.unknown).toBe(false); expect(resolved.rejected).toBe(true);
    expect(resolved.approval).toEqual(approval); expect(resolved.receipt).toBeNull();
    expect(isSubmissionLocked(resolved)).toBe(true);
  });
  it('keeps the original uncertainty on failed or unrelated reads, including permission denial', () => {
    const state = { ...newSubmission(), approval, unknown: true };
    for (const error of [
      { code: 'UPSTREAM' as const, dataState: 'preserved' as const, nextAction: 'retry_read' },
      { code: 'FORBIDDEN' as const, dataState: 'not_written' as const, nextAction: 'request_access' },
      { code: 'CONFLICT' as const, dataState: 'preserved' as const, nextAction: 'select_workspace' },
      { code: 'CONFLICT' as const, dataState: 'unknown' as const, nextAction: 'preview_again' },
      { code: 'UNKNOWN_RESULT' as const, dataState: 'unknown' as const, nextAction: 'read_back' },
    ]) expect(settleReceiptRead(state, { ok: false, error: { ...error, message: 'fixture read error', retryable: false } })).toBe(state);
  });
});
