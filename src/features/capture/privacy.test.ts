import { describe, expect, it } from 'vitest';
import { scanSegments } from './privacy';

const segments = (text: string) => [{ id: 's1', role: 'source' as const, text }];
describe('C05 deterministic privacy scan', () => {
  it.each([
    'sk-fixture_abcdefghijklmnopqrstuvwxyz', 'ghp_abcdefghijklmnopqrstuvwxyz1234',
    'AKIAABCDEFGHIJKLMNOP', 'AKIDabcdefghijklmnopqrstuvwxyz1234',
    'Authorization: Bearer fixture-secret-123456', 'CNB_TOKEN=fixture-secret-value',
    'password="fixture-password"', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
  ])('blocks a synthetic secret pattern', (text) => {
    const result = scanSegments(segments(text));
    expect(result).toMatchObject({ ok: true, data: { status: 'blocked' } });
    expect(JSON.stringify(result)).not.toContain(text);
  });
  it('marks personal information for human review, not a guarantee of safety', () => {
    const result = scanSegments(segments('contact fixture@example.test or 13800138000'));
    expect(result).toMatchObject({ ok: true, data: { status: 'review' } });
    if (result.ok) expect(result.data.findings.map((f) => f.kind)).toEqual(['email', 'phone']);
  });
  it('returns clear only for the checked scope and never includes the original text', () => {
    expect(scanSegments(segments('先限定适用条件。'))).toMatchObject({ ok: true, data: { status: 'clear', findings: [] } });
  });
  it('fails closed for invalid, empty/cancelled or oversized scan input', () => {
    for (const input of [null, [], segments('x'.repeat(100001)), [{ id: 's', role: 'unknown', text: 'x' }]]) {
      expect(scanSegments(input)).toMatchObject({ ok: false, error: { code: 'VALIDATION', dataState: 'not_written' } });
    }
  });
});
