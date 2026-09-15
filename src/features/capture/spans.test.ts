import { describe, expect, it } from 'vitest';
import { buildCandidates } from './spans';
import { conversation } from './fixtures.test-support';
import { hashConversation, hashSegment } from '../../contracts/hash';
import type { DecodedCandidates } from './candidates';

async function setup() {
  const value = { ...conversation, segments: [{ id: 's1', role: 'assistant' as const, text: 'A\u{1f600}B\n方法。' }, { id: 's2', role: 'source' as const, text: '未选内容' }] };
  value.contentHash = await hashConversation(value);
  const decoded: DecodedCandidates = { modelId: 'fixture-model', generatedAt: '2026-09-05T04:00:00Z', proposals: [{ title: '限定条件', question: '什么条件适用？', claim: '先核对条件。', kind: 'principle', whyKeep: '避免无条件采用', uncertainties: ['尚无独立支持'], spans: [{ segmentId: 's1', start: 1, end: 3, quote: '\u{1f600}' }] }] };
  return { value, decoded };
}
describe('C11 exact stable source spans', () => {
  it('creates stable candidate/span IDs and shared hashes without claiming source support', async () => {
    const { value, decoded } = await setup();
    const result = await buildCandidates(value, ['s1'], decoded, 'prompt-v1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.data[0]!;
    expect(candidate.state).toBe('proposed');
    expect(candidate.spans[0]).toMatchObject({ conversationId: value.id, segmentId: 's1', start: 1, end: 3, quote: '\u{1f600}', contentHash: await hashSegment(value.id, value.segments[0]!) });
    expect(candidate.sources[0]?.support).toBe('unverified');
    expect(candidate.uncertainties).toEqual(decoded.proposals[0]!.uncertainties);
    const repeated = await buildCandidates(value, ['s1'], decoded, 'prompt-v1');
    if (!repeated.ok) throw new Error('unexpected invalid result');
    expect(repeated.data[0]?.id).toBe(candidate.id);
    expect(repeated.data[0]?.spans).toEqual(candidate.spans);
  });
  it('rejects missing, excluded, out-of-bounds, reversed, and rewritten quotes', async () => {
    const { value, decoded } = await setup();
    for (const span of [{ segmentId: 'missing', start: 0, end: 1, quote: 'A' }, { segmentId: 's2', start: 0, end: 2, quote: '未选' }, { segmentId: 's1', start: 0, end: 500, quote: 'A' }, { segmentId: 's1', start: 3, end: 1, quote: 'A' }, { segmentId: 's1', start: 0, end: 1, quote: '改写' }]) {
      expect((await buildCandidates(value, ['s1'], { ...decoded, proposals: [{ ...decoded.proposals[0]!, spans: [span] }] }, 'prompt-v1')).ok).toBe(false);
    }
  });
  it('rejects a range that slices a surrogate pair even if slice() matches the broken quote', async () => {
    const { value, decoded } = await setup();
    const proposals = [{ ...decoded.proposals[0]!, spans: [{ segmentId: 's1', start: 1, end: 2, quote: '\uD83D' }] }];
    expect((await buildCandidates(value, ['s1'], { ...decoded, proposals }, 'prompt-v1')).ok).toBe(false);
  });
  it('rejects a stale content digest and cancellation without producing candidates', async () => {
    const { value, decoded } = await setup();
    expect((await buildCandidates({ ...value, segments: [{ ...value.segments[0]!, text: 'changed' }] }, ['s1'], decoded, 'prompt-v1')).ok).toBe(false);
    const cancel = new AbortController(); cancel.abort();
    expect((await buildCandidates(value, ['s1'], decoded, 'prompt-v1', cancel.signal)).ok).toBe(false);
  });
});
