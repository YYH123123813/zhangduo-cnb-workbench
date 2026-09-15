import { describe, expect, it } from 'vitest';
import { prepareContent, safeDisplayText } from './redaction';
import { scanSegments } from './privacy';

const secret = 'Authorization: Bearer sk-fixture_abcdefghijklmnopqrstuvwxyz';
const input = [{ id: 's1', role: 'source' as const, text: `before ${secret} after` }];
describe('C06 redaction and purpose preview', () => {
  it('merges overlapping masks and preserves the original and surrounding text', () => {
    const scan = scanSegments(input);
    if (!scan.ok) throw new Error('scan failed');
    const result = prepareContent(input, scan.data.findings.map((f) => f.id), false);
    expect(result).toEqual({ ok: true, data: [{ ...input[0], text: 'before [已遮盖] after' }] });
    expect(input[0]?.text).toContain(secret);
  });
  it('blocks retained secrets, stale masking choices, and cancelled empty input', () => {
    expect(prepareContent(input, [], true).ok).toBe(false);
    expect(prepareContent(input, ['old-source-mask'], true).ok).toBe(false);
    expect(prepareContent([], [], false).ok).toBe(false);
  });
  it('requires explicit personal-info review when retaining a possible false positive', () => {
    const text = [{ id: 's', role: 'source' as const, text: 'fixture@example.test' }];
    expect(prepareContent(text, [], false).ok).toBe(false);
    expect(prepareContent(text, [], true)).toEqual({ ok: true, data: text });
  });
  it('never puts full detected secrets in default display or live announcements', () => {
    expect(safeDisplayText(input[0]!.text)).toBe('before [已遮盖] after');
    expect(safeDisplayText('ordinary text')).toBe('ordinary text');
  });
});
