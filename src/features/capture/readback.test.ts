import { describe, expect, it } from 'vitest';
import { hashConversation } from '../../contracts/hash';
import { conversation } from './fixtures.test-support';
import { checkSavedReceipt } from './readback';

describe('C08 recovered capture identity and cancellation', () => {
  it('accepts a saved source with the exact shared hash', async () => {
    const value = { ...conversation, contentHash: await hashConversation(conversation) };
    expect(await checkSavedReceipt(value, { id: value.id, workspaceId: value.workspaceId })).toEqual({ ok: true, data: value });
  });
  it('refuses mismatched identity, version, content, duplicated IDs and missing storage receipts', async () => {
    const value = { ...conversation, contentHash: await hashConversation(conversation) };
    for (const expected of [{ id: 'other' }, { id: value.id, workspaceId: 'other' }, { id: value.id, contentHash: 'stale' }]) expect((await checkSavedReceipt(value, expected)).ok).toBe(false);
    for (const changed of [{ ...value, state: 'unknown' }, { ...value, issueNumber: undefined }, { ...value, sourceAlreadyPersisted: false }, { ...value, segments: [{ id: 's', role: 'source', text: 'unhashed body' }] }]) expect((await checkSavedReceipt(changed, { id: value.id })).ok).toBe(false);
    const duplicate = { ...value, segments: [value.segments[0]!, value.segments[0]!] }; duplicate.contentHash = await hashConversation(duplicate);
    expect((await checkSavedReceipt(duplicate, { id: value.id })).ok).toBe(false);
  });
  it('ignores a valid late readback after cancellation', async () => {
    const value = { ...conversation, contentHash: await hashConversation(conversation) };
    const controller = new AbortController(); controller.abort();
    expect((await checkSavedReceipt(value, { id: value.id }, controller.signal)).ok).toBe(false);
  });
});
