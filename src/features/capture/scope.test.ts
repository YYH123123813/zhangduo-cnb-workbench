import { describe, expect, it } from 'vitest';
import { selectSegments } from './scope';
import { conversation } from './fixtures.test-support';

describe('C04 selected scope', () => {
  it('only returns selected text in original order, with independent copies', () => {
    const result = selectSegments(conversation.segments, ['segment-2']);
    expect(result).toEqual({ ok: true, data: [conversation.segments[1]] });
    expect(JSON.stringify(result)).not.toContain('为什么');
    if (result.ok) expect(result.data[0]).not.toBe(conversation.segments[1]);
    expect(selectSegments(conversation.segments, ['segment-2', 'segment-1'])).toEqual({ ok: true, data: conversation.segments });
  });
  it('rejects empty/cancelled, duplicate and stale selections', () => {
    for (const ids of [[], ['segment-1', 'segment-1'], ['previous-issue-segment']]) {
      expect(selectSegments(conversation.segments, ids)).toMatchObject({ ok: false, error: { code: 'VALIDATION', dataState: 'not_written' } });
    }
  });
  it('rejects duplicate source IDs rather than silently widening the selected scope', () => {
    expect(selectSegments([conversation.segments[0]!, conversation.segments[0]!], ['segment-1']).ok).toBe(false);
  });
});
