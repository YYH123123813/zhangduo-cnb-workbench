import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentHash, canonicalJson, hashConversation, hashSegment, hashModelInput } from './hash';
import type { Conversation } from './domain';

const conversation: Conversation = { id: 'c1', workspaceId: 'w1', taskId: 't1', origin: 'paste', sourceAlreadyPersisted: false, segments: [{ id: 's1', role: 'user', text: 'A\nB' }], contentHash: 'pending', createdAt: '2026-09-05T00:00:00Z', state: 'preview' };

describe('shared v1 controlled hashes', () => {
  it('matches UTF-8 SHA-256 and ignores object key insertion order, not array order', async () => {
    expect(canonicalJson({ z: 1, a: 'test' })).toBe('{"a":"test","z":1}');
    expect(await contentHash({ z: 1, a: 'test' })).toBe(createHash('sha256').update('{"a":"test","z":1}').digest('hex'));
    expect(await contentHash({ a: 'test', z: 1 })).toBe(await contentHash({ z: 1, a: 'test' }));
    expect(await contentHash(['a', 'b'])).not.toBe(await contentHash(['b', 'a']));
  });
  it.each([undefined, NaN, Infinity, new Date(), { value: undefined }, [undefined], Array(2)])('rejects ambiguous/non-JSON values (%s)', (value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
  it('rejects cyclic input', () => { const value: { self?: unknown } = {}; value.self = value; expect(() => canonicalJson(value)).toThrow(); });
  it('binds conversation identity, role and scope without changing for a persistence transition', async () => {
    const hash = await hashConversation(conversation);
    expect(await hashConversation({ ...conversation, state: 'saved', issueNumber: 7, sourceAlreadyPersisted: true, contentHash: hash })).toBe(hash);
    expect(await hashConversation({ ...conversation, workspaceId: 'w2' })).not.toBe(hash);
    expect(await hashConversation({ ...conversation, segments: [{ ...conversation.segments[0]!, role: 'assistant' }] })).not.toBe(hash);
  });
  it('binds SourceSpan hashes to exact conversation, segment and text, including UTF-16 emoji', async () => {
    const segment = { id: 's1', text: 'A\u{1f642}B' };
    expect(segment.text.slice(1, 3)).toBe('\u{1f642}');
    expect(await hashSegment('c1', segment)).not.toBe(await hashSegment('c2', segment));
    expect(await hashSegment('c1', segment)).not.toBe(await hashSegment('c1', { ...segment, text: segment.text + 'x' }));
  });
  it('binds model purpose and source IDs to the exact approved text', async () => {
    const value = { purpose: 'extract' as const, text: 'approved text', sourceIds: ['s1'] };
    expect(await hashModelInput(value)).not.toBe(await hashModelInput({ ...value, purpose: 'answer' }));
    expect(await hashModelInput(value)).not.toBe(await hashModelInput({ ...value, sourceIds: ['s2'] }));
  });
});
