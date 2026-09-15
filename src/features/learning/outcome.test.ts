import { describe, expect, it } from 'vitest';
import { previewOutcome } from './outcome';
import { buildUseDraft } from './history';
import { context, snapshot, task, useInput } from './testing/fixtures';

const base = buildUseDraft(useInput, snapshot, 'record-1', task.updatedAt);
if (!base.ok) throw new Error('Invalid fixture');
const record = base.data.record;
const input = { useRecordId: 'record-1', status: 'failed', summary: 'The copy did not exist.', failureReason: 'A prerequisite was not met.' };

describe('L03 actual outcome attribution', () => {
  it('creates a self-reported failure draft with revision clues, not a knowledge mutation', () => {
    const result = previewOutcome(input, record, context);
    expect(result).toMatchObject({ ok: true, data: { verification: 'self_reported', revisionSuggested: true, persistence: 'not_saved', nodeRefs: useInput.nodeRefs } });
    expect(record.result).toBe('unverified'); expect(snapshot.nodes[0]?.lifecycle).toBe('active');
  });
  it('does not upgrade self-reported success into reviewed evidence', () => {
    const result = previewOutcome({ ...input, status: 'succeeded', failureReason: '' }, record, context);
    expect(result).toMatchObject({ ok: true, data: { verification: 'self_reported', revisionSuggested: false } });
    expect(previewOutcome({ ...input, verification: 'reviewed' }, record, context).ok).toBe(false);
  });
  it('requires a failure reason and refuses foreign, unrelated or non-use evidence', () => {
    expect(previewOutcome({ ...input, failureReason: '' }, record, context).ok).toBe(false);
    expect(previewOutcome({ ...input, useRecordId: 'another' }, record, context).ok).toBe(false);
    expect(previewOutcome(input, { ...record, workspaceId: 'other' }, context)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(previewOutcome(input, { ...record, kind: 'recall' }, context).ok).toBe(false);
  });
});
