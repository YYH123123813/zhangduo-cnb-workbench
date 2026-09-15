import { describe, expect, it } from 'vitest';
import { chooseConfidence, initialConfidence, lockConfidence } from './confidence';

describe('L06 pre-answer confidence', () => {
  it('starts without a default and requires an explicit choice or skip', () => {
    expect(initialConfidence()).toEqual({ value: null, recordedAt: null, locked: false });
    expect(lockConfidence(initialConfidence()).ok).toBe(false);
    for (const value of ['low', 'medium', 'high', 'skipped']) {
      const selected = chooseConfidence(initialConfidence(), value, '2026-09-05T00:00:00Z');
      expect(selected.ok).toBe(true); if (!selected.ok) return;
      expect(lockConfidence(selected.data)).toMatchObject({ ok: true, data: { value, locked: true } });
    }
  });
  it('does not accept model scores or change confidence after answering begins', () => {
    expect(chooseConfidence(initialConfidence(), 0.98, '2026-09-05T00:00:00Z').ok).toBe(false);
    const selected = chooseConfidence(initialConfidence(), 'low', '2026-09-05T00:00:00Z');
    if (!selected.ok) throw new Error('invalid fixture');
    const locked = lockConfidence(selected.data);
    if (!locked.ok) throw new Error('invalid fixture');
    expect(chooseConfidence(locked.data, 'high', '2026-09-05T00:01:00Z')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(locked.data).not.toHaveProperty('mastery');
  });
  it('rejects invalid timing and keeps cancellation local', () => {
    const state = initialConfidence();
    expect(chooseConfidence(state, 'high', 'yesterday').ok).toBe(false);
    expect(state.value).toBeNull(); expect(state.locked).toBe(false);
  });
});
