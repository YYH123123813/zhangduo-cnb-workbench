import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../app/api-client';
import { CONTRACT_VERSION } from '../../contracts/domain';
import type { HandoffDraft } from '../../contracts/domain';
import type { DraftState } from '../../contracts/handoff';
import { contentHash } from '../../contracts/hash';
import { loadReviewTarget } from './load-target';
import { createReview } from './model';
import { draftFixture } from './testing/review';
import { candidate, conversation } from './testing/fixtures';

const meta = { mode: 'fixture' as const, requestId: 'read-1', contractVersion: CONTRACT_VERSION };
vi.mock('../../app/api-client', () => ({ apiRequest: vi.fn() }));
beforeEach(() => vi.mocked(apiRequest).mockReset());
async function savedState(draft: HandoffDraft): Promise<DraftState> {
  const document = { kind: 'draft' as const, value: draft }, source = { kind: 'candidate' as const, candidateId: draft.candidateId! };
  return { id: draft.id, state: 'available', revision: 1, contentHash: await contentHash({ document, source }),
    conversationHash: conversation.contentHash, document, source, retentionDays: 30 };
}
describe('H02 route-target loading is atomic', () => {
  it('selects the requested candidate without copying AI text or writing', async () => {
    const created = createReview(conversation, [candidate(), candidate('candidate-2')]);
    if (!created.ok) throw Error('fixture');
    const read = vi.mocked(apiRequest).mockResolvedValue({ ...created, meta });
    const result = await loadReviewTarget({ conversationId: conversation.id, candidateId: 'candidate-2' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeId).toBe('candidate-2');
      expect(result.data.items[1]?.statement).toBe('');
    }
    expect(read.mock.calls).toEqual([['/api/handoff/conversation-1']]);
  });
  it('returns no replacement review when the second read fails or throws', async () => {
    const { review, draft } = draftFixture();
    const read = vi.mocked(apiRequest).mockResolvedValueOnce({ ok: true, data: review, meta })
      .mockResolvedValueOnce({ ok: false, error: { code: 'FORBIDDEN', message: 'no access', retryable: false, dataState: 'preserved', nextAction: 'request_access' }, meta });
    const target = { conversationId: conversation.id, draftId: draft.id };
    expect(await loadReviewTarget(target)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(review.items[0]?.statement).toBe('');
    read.mockResolvedValueOnce({ ok: true, data: review, meta }).mockRejectedValueOnce(Error('offline'));
    await expect(loadReviewTarget(target)).rejects.toThrow('offline');
    expect(review.items[0]?.statement).toBe('');
  });
  it('restores a matching target only after both reads succeed', async () => {
    const { review, draft } = draftFixture();
    vi.mocked(apiRequest).mockResolvedValueOnce({ ok: true, data: review, meta })
      .mockResolvedValueOnce({ ok: true, data: await savedState(draft), meta });
    const result = await loadReviewTarget({ conversationId: conversation.id, draftId: draft.id, candidateId: draft.candidateId! });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.items[0]?.statement).toBe(draft.node.humanStatement);
    expect(review.items[0]?.statement).toBe('');
  });
  it('does not hydrate the latest mutable draft when an operation recovery address carries its original draft ID', async () => {
    const { review, draft } = draftFixture();
    const read = vi.mocked(apiRequest).mockResolvedValueOnce({ ok: true, data: review, meta });
    const result = await loadReviewTarget({ conversationId: conversation.id, draftId: draft.id, changeSetId: 'change-A', candidateId: draft.candidateId! });
    expect(result.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(review.items[0]?.statement).toBe('');
  });
  it('refuses a missing candidate and a draft for a different selected candidate', async () => {
    const { review, draft } = draftFixture();
    const read = vi.mocked(apiRequest).mockResolvedValueOnce({ ok: true, data: review, meta });
    expect(await loadReviewTarget({ conversationId: conversation.id, candidateId: 'missing' })).toMatchObject({ ok: false });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValueOnce({ ok: true, data: review, meta }).mockResolvedValueOnce({ ok: true, data: await savedState({ ...draft, candidateId: 'other' }), meta });
    expect(await loadReviewTarget({ conversationId: conversation.id, candidateId: 'candidate-1', draftId: draft.id })).toMatchObject({ ok: false });
  });
});
