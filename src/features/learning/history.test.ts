import { describe, expect, it } from 'vitest';
import { buildUseDraft, describeHistory } from './history';
import { snapshot, task, useInput } from './testing/fixtures';

describe('L02 versioned use preview', () => {
  it('freezes task conditions and knowledge without fabricating a commit or indexing private text', () => {
    const source = structuredClone(snapshot); const input = structuredClone(useInput);
    const result = buildUseDraft(input, source, 'record-1', task.updatedAt);
    expect(result.ok).toBe(true); if (!result.ok) return;
    source.nodes[0]!.conditions[0]!.text = 'Changed condition';
    input.task.constraints[0]!.text = 'Changed task';
    expect(result.data.taskSnapshot.constraints[0]?.text).toBe('No network');
    expect(result.data.knowledge[0]?.conditions[0]?.text).toBe('A local copy exists');
    expect(result.data.record.nodeRefs[0]?.revision).toBe('fixture:r1');
    expect(result.data.record.answer).toBe(''); expect(result.data.reason).toBe(useInput.reason);
    expect(result.data.indexing).toBe('excluded'); expect(result.data.persistence).toBe('not_saved');
  });
  it('does not replace historical conditions with current knowledge', () => {
    const draft = buildUseDraft(useInput, snapshot, 'record-1', task.updatedAt);
    if (!draft.ok) throw new Error('fixture invalid');
    const updated = { ...snapshot, revision: 'fixture:r2', nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'fixture:r2', conditions: [] })) };
    const history = describeHistory(draft.data.record, updated);
    expect(history.versionState).toBe('changed');
    expect(history.contextState).toBe('not_recorded');
    expect(history.record.nodeRefs[0]?.revision).toBe('fixture:r1');
    expect(history).not.toHaveProperty('currentConditions');
  });
  it('rejects stale versions and invalid record identities before saving', () => {
    expect(buildUseDraft(useInput, { ...snapshot, revision: 'fixture:r2' }, 'record-1', task.updatedAt).ok).toBe(false);
    expect(buildUseDraft(useInput, snapshot, '', task.updatedAt).ok).toBe(false);
  });
});
