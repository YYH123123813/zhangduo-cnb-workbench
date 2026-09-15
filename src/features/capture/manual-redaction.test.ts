import { describe, expect, it } from 'vitest';
import { prepareContent, manualMaskRanges } from './redaction';
import { hashConversation } from '../../contracts/hash';
import { conversation } from './fixtures.test-support';

const segments = [{ id: 's1', role: 'user' as const, text: '项目代号A+B，项目代号A+B。' }, { id: 's2', role: 'source' as const, text: '项目代号A+B保持原样。' }];
describe('C06 explicit local manual redaction', () => {
  it('masks literal occurrences only inside the selected segment, without mutating the source', () => {
    const masks = [{ id: 'm1', segmentId: 's1', text: '项目代号A+B' }];
    expect(prepareContent(segments, [], false, masks)).toEqual({ ok: true, data: [{ ...segments[0], text: '[已遮盖]，[已遮盖]。' }, segments[1]] });
    expect(segments[0]!.text).toContain('项目代号A+B');
    const ranges = manualMaskRanges(segments, masks);
    expect(ranges.ok && ranges.data.length).toBe(2);
    expect(JSON.stringify(ranges)).not.toContain('项目代号A+B');
  });
  it('merges overlaps and treats regular-expression syntax only as literal text', () => {
    const input = [{ id: 's', role: 'source' as const, text: 'abcabcabc [.*] 留下' }];
    expect(prepareContent(input, [], false, [{ id: 'a', segmentId: 's', text: 'abcabc' }, { id: 'b', segmentId: 's', text: '[.*]' }])).toMatchObject({ ok: true, data: [{ text: '[已遮盖] [已遮盖] 留下' }] });
  });
  it('refuses stale, unknown, duplicated, whitespace-only and excessive manual masks', () => {
    for (const masks of [
      [{ id: 'm', segmentId: 'foreign', text: '项目' }], [{ id: 'm', segmentId: 's1', text: 'MISSING' }],
      [{ id: 'm', segmentId: 's1', text: ' ' }], [{ id: 'm', segmentId: 's1', text: '项目' }, { id: 'm', segmentId: 's1', text: '项目' }],
      Array.from({ length: 51 }, (_, i) => ({ id: `m${i}`, segmentId: 's1', text: '项目' })),
    ]) expect(prepareContent(segments, [], true, masks).ok).toBe(false);
  });
  it('allows masking an entire detected credential, but not bypassing a secret with a partial mask', () => {
    const input = [{ id: 's', role: 'source' as const, text: 'CNB_TOKEN=fixture-secret' }];
    expect(prepareContent(input, [], true, [{ id: 'm', segmentId: 's', text: 'fixture-secret' }]).ok).toBe(false);
    expect(prepareContent(input, [], false, [{ id: 'm', segmentId: 's', text: input[0]!.text }])).toMatchObject({ ok: true, data: [{ text: '[已遮盖]' }] });
  });
  it('requires review for retained personal information but not a fully covered address', () => {
    const input = [{ id: 's', role: 'source' as const, text: 'contact fixture@example.test' }];
    expect(prepareContent(input, [], false, [{ id: 'm', segmentId: 's', text: 'fixture' }]).ok).toBe(false);
    expect(prepareContent(input, [], false, [{ id: 'm', segmentId: 's', text: 'fixture@example.test' }])).toMatchObject({ ok: true, data: [{ text: 'contact [已遮盖]' }] });
  });
  it('keeps whole UTF-16 characters and rejects a half-surrogate mask', () => {
    const input = [{ id: 's', role: 'source' as const, text: '编号\uD83D\uDD12完成' }];
    expect(prepareContent(input, [], false, [{ id: 'm', segmentId: 's', text: '\uD83D' }]).ok).toBe(false);
    expect(prepareContent(input, [], false, [{ id: 'm', segmentId: 's', text: '\uD83D\uDD12' }])).toMatchObject({ ok: true, data: [{ text: '编号[已遮盖]完成' }] });
  });
  it('changes the approval hash while retaining stable segment identities', async () => {
    const prepared = prepareContent(segments, [], false, [{ id: 'm', segmentId: 's1', text: '项目代号A+B' }]);
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    expect(prepared.data.map((s) => s.id)).toEqual(segments.map((s) => s.id));
    expect(await hashConversation({ ...conversation, segments: prepared.data })).not.toBe(await hashConversation({ ...conversation, segments }));
  });
});
