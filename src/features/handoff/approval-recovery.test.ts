import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '../../contracts/domain';
import type { KnowledgeApprovalState } from '../../contracts/approval';
import type { ApiResponse } from '../../contracts/api';
import { handoffPlatformFixture, platformPreview } from './testing/platform';
import { isSubmissionLocked, newSubmission } from './submission';
import { recoverApprovalState } from './approval-recovery';

const fixtures: Awaited<ReturnType<typeof handoffPlatformFixture>>[] = [];
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach((s) => s.journal.close()); });
const data = <T>(result: ApiResponse<T>): T => { if (!result.ok) throw Error(JSON.stringify(result)); return result.data; };
async function setup() {
  const s = await handoffPlatformFixture(); fixtures.push(s);
  const prepared = await platformPreview(s);
  return { s, ...prepared, unknown: { ...newSubmission(), preview: prepared.preview, approvalUnknown: true } };
}

describe('H10 original knowledge approval recovery with actual shared Services, not live', () => {
  it('recovers a lost registration response through GET without registering or committing again', async () => {
    const { s, input, unknown } = await setup();
    const approve = s.services.approveKnowledge!;
    s.services.approveKnowledge = vi.fn(async (...args: Parameters<typeof approve>) => { await approve(...args); throw Error('lost approval response'); });
    expect((await s.request('/approval', input)).result).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    const original = data((await s.request<KnowledgeApprovalState>(`/approval?changeSetId=${input.changes.id}`)).result);
    expect(original.status).toBe('registered'); expect(original.absenceIsFinal).toBe(false);
    const recovered = await recoverApprovalState(unknown, original, s.ctx, Date.now());
    expect(recovered).toMatchObject({ ok: true, data: { approvalUnknown: false, approval: original.approval, unknown: false } });
    expect(s.services.approveKnowledge).toHaveBeenCalledTimes(1); expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('does not turn an absent registration into permission to discard or register a new approval', async () => {
    const { s, input, unknown } = await setup();
    const original = data((await s.request<KnowledgeApprovalState>(`/approval?changeSetId=${input.changes.id}`)).result);
    expect(original).toMatchObject({ status: 'not_registered', absenceIsFinal: false });
    expect(await recoverApprovalState(unknown, original, s.ctx, Date.now())).toMatchObject({ ok: false, error: { nextAction: 'check_approval', dataState: 'unknown' } });
    expect(isSubmissionLocked(unknown)).toBe(true); expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('requires exact operation, actor, workspace, content hash, version and object scope', async () => {
    const { s, input, unknown } = await setup();
    const approval = data((await s.request<Approval>('/approval', input)).result);
    const original = data((await s.request<KnowledgeApprovalState>(`/approval?changeSetId=${input.changes.id}`)).result);
    for (const altered of [{ ...original, changeSetId: 'another' }, { ...original, actorId: 'another' },
      { ...original, approval: { ...approval, contentHash: 'changed' } }, { ...original, approval: { ...approval, baseRevision: 'changed' } },
      { ...original, approval: { ...approval, objectIds: ['other'] } }]) {
      expect(await recoverApprovalState(unknown, altered, s.ctx, Date.now())).toMatchObject({ ok: false });
    }
    expect(unknown.approvalUnknown).toBe(true);
  });
  it('clears the old preview only after authoritative revocation or expiry when Git was never sent', async () => {
    for (const terminal of ['revoked', 'expired']) {
      const { s, input, unknown } = await setup();
      const approval = data((await s.request<Approval>('/approval', input)).result);
      if (terminal === 'revoked') data((await s.request<{ revoked: boolean }>(`/approval/${approval.id}/revoke`, undefined, 'POST')).result);
      else { vi.useFakeTimers(); vi.setSystemTime(Date.parse(approval.expiresAt) + 1); }
      const original = data((await s.request<KnowledgeApprovalState>(`/approval?changeSetId=${input.changes.id}`)).result);
      expect(original.status).toBe(terminal);
      const recovered = await recoverApprovalState(unknown, original, s.ctx, Date.now());
      expect(recovered).toEqual({ ok: true, data: newSubmission() });
      expect(s.git.publish).not.toHaveBeenCalled(); vi.useRealTimers();
    }
  });
  it('never clears a pending or unknown Git operation merely because its approval was revoked', async () => {
    const { s, input, unknown } = await setup();
    const approval = data((await s.request<Approval>('/approval', input)).result);
    await s.request(`/approval/${approval.id}/revoke`, undefined, 'POST');
    const original = data((await s.request<KnowledgeApprovalState>(`/approval?changeSetId=${input.changes.id}`)).result);
    for (const state of [{ ...unknown, unknown: true }, { ...unknown, pending: true }]) {
      expect(await recoverApprovalState(state, original, s.ctx, Date.now())).toMatchObject({ ok: false });
      expect(isSubmissionLocked(state)).toBe(true);
    }
  });
});
