import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConditionChoices, conditionLabels } from './condition-controls';
import { updateConditionCheck } from './client-state';
import { node } from './test-support';

const n = node('n1', { revision: 'a'.repeat(40), conditions: [{ id: 'same-id', text: 'Long condition '.repeat(80), status: 'confirmed', evidenceIds: [] }] });
describe('R02 tri-state controls, semantic rendering only', () => {
  it('shows three labeled native choices, no default confirmation, and an independent skip action', () => {
    const html = renderToStaticMarkup(createElement(ConditionChoices, { node: n, conditionId: 'same-id', onChange: () => {}, onConfirm: () => {}, onSkip: () => {} }));
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('<legend>本次是否满足？</legend>');
    for (const label of Object.values(conditionLabels)) expect(html).toContain(label);
    expect(html).not.toContain('checked=""'); expect(html).toContain('跳过本次');
    expect(html).toContain(n.id); expect(html).toContain(n.revision); expect(html).toContain('same-id');
  });
  it('requires a selected choice before explicit confirmation and keeps the skip action separate', () => {
    const props = { node: n, conditionId: 'same-id', onChange: () => {}, onConfirm: () => {}, onSkip: () => {} };
    const empty = renderToStaticMarkup(createElement(ConditionChoices, props));
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>.*?确认并重查/);
    const selected = renderToStaticMarkup(createElement(ConditionChoices, { ...props, status: 'not_satisfied' }));
    expect(selected).toMatch(/<input[^>]*value="not_satisfied"[^>]*checked=""|<input[^>]*checked=""[^>]*value="not_satisfied"/);
    expect(selected).toContain('确认并重查'); expect(selected).not.toContain('disabled=""');
  });
  it('uses exact bindings, preserves other checks and never attributes unknown', () => {
    const first = updateConditionCheck([], n, 'same-id', 'satisfied', 'u1')!;
    const second = updateConditionCheck(first, { ...n, id: 'n2' }, 'same-id', 'not_satisfied', 'u1')!;
    expect(first).toHaveLength(1); expect(second).toHaveLength(2);
    const changed = updateConditionCheck(second, { ...n, revision: 'b'.repeat(40) }, 'same-id', 'unknown', 'u1')!;
    expect(changed).toHaveLength(2); expect(changed.find((check) => check.nodeRef.objectId === n.id)).toEqual({
      nodeRef: { workspaceId: n.workspaceId, objectId: n.id, revision: 'b'.repeat(40) }, conditionId: 'same-id', status: 'unknown',
    });
    expect(second[0]!.status).toBe('satisfied');
    expect(updateConditionCheck([], n, 'not-a-condition', 'satisfied', 'u1')).toBeNull();
    expect(updateConditionCheck([], { ...n, revision: 'HEAD' }, 'same-id', 'satisfied', 'u1')).toBeNull();
  });
});
