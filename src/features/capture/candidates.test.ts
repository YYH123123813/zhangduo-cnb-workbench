import { describe, expect, it } from 'vitest';
import { decodeCandidates } from './candidates';

const item = { title: '幂等请求', question: '如何避免重复写入？', claim: '对同一操作使用稳定幂等键。', kind: 'method', whyKeep: '重复操作可以读回核验。', uncertainties: ['需要明确键的有效期。'], spans: [{ segmentId: 's1', start: 0, end: 2, quote: '幂等' }] };
const response = (value: unknown, modelId = 'actual-fixture-model') => ({ value, modelId, generatedAt: '2026-09-05T04:00:00Z' });
describe('C10 structured proposals', () => {
  it('accepts zero through three candidates and preserves the upstream model metadata', () => {
    for (const candidates of [[], [item], [item, { ...item, kind: 'question' }, { ...item, kind: 'decision' }]]) {
      const result = decodeCandidates(response({ candidates }, 'different-model-id'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.proposals).toHaveLength(candidates.length);
      expect(result.data.modelId).toBe('different-model-id');
      expect(result.data.generatedAt).toBe('2026-09-05T04:00:00Z');
    }
  });
  it('parses JSON text but rejects invalid schemas, extra candidates and attempts to self-confirm', () => {
    expect(decodeCandidates(response(JSON.stringify({ candidates: [item] }))).ok).toBe(true);
    for (const value of ['```json\n{}\n```', '{bad', { candidates: [item, item, item, item] }, { candidates: [{ ...item, state: 'confirmed' }] }, { candidates: [{ ...item, kind: 'mastered' }] }, { candidates: [{ ...item, title: '   ' }] }, { candidates: [{ ...item, sources: [{ url: 'https://example.test/invented' }] }] }]) {
      expect(decodeCandidates(response(value))).toMatchObject({ ok: false, error: { code: 'UPSTREAM', dataState: 'preserved' } });
    }
  });
  it('rejects missing or invalid provider metadata and missing source spans', () => {
    expect(decodeCandidates({ value: { candidates: [] }, modelId: '', generatedAt: 'yesterday' }).ok).toBe(false);
    expect(decodeCandidates(response({ candidates: [{ ...item, spans: [] }] })).ok).toBe(false);
  });
});
