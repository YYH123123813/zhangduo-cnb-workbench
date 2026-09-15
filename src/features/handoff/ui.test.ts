import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DispositionPicker } from './DispositionPicker';
import { Page } from './client';
import { RelationEditor } from './RelationEditor';
import { node, snapshot } from './testing/knowledge';
import { safeUrl } from './links';
import { readFileSync } from 'node:fs';

describe('H01 native accessible choice controls', () => {
  it('has one named radio group, four choices and no checked default', () => {
    const html = renderToStaticMarkup(createElement(DispositionPicker, { id: 'candidate', value: null, onChange: () => {} }));
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('<legend>');
    expect(html).not.toContain('checked=""');
  });
  it('exposes cancellation and a non-color consequence', () => {
    const html = renderToStaticMarkup(createElement(DispositionPicker, { id: 'candidate', value: 'reject', onChange: () => {} }));
    expect(html).toContain('aria-label="取消选择"');
    expect(html).toContain('不产生正式知识');
  });
});

describe('H12 static UI semantics (not browser layout verification)', () => {
  it('keeps the initial page truthful and the conversation input named', () => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain('工作区未连接');
    expect(html).toContain('for="handoff-conversation"');
    expect(html).not.toContain('Git 已保存');
  });
  it('uses native relation controls and retains an unfinished per-candidate reason', () => {
    const reason = '<script>alert(1)</script>' + '长文本'.repeat(150);
    const html = renderToStaticMarkup(createElement(RelationEditor, { subject: node, snapshot, actorId: 'actor-1', value: [],
      input: { targetId: '', type: '', direction: '', rationale: reason, evidenceIds: [] }, onInputChange: () => {}, onChange: () => {}, onError: () => {} }));
    expect(html).toContain('type="radio"'); expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('aria-label="取消关系编辑"');
  });
  it('contains scoped narrow-screen wrapping and visible focus styles without fixed minimum page width', () => {
    const css = readFileSync(new URL('./handoff.css', import.meta.url), 'utf8');
    expect(css).toContain('overflow-wrap: anywhere'); expect(css).toContain(':focus-visible');
    expect(css).toContain('@media (max-width: 540px)'); expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).not.toMatch(/(?:^|\n)(?:body|html|button|nav)\s*\{/);
  });
  it('does not expose script or credential-bearing URLs as links', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('https://user:secret@example.org')).toBeUndefined();
    expect(safeUrl('https://cnb.cool/fixture')).toBe('https://cnb.cool/fixture');
  });
  it('shows ambiguous relation evidence as an error instead of silently merging two distinct source records', () => {
    const altered = structuredClone(snapshot); altered.nodes[0]!.sources[0]!.excerpt = '另一段原句';
    const html = renderToStaticMarkup(createElement(RelationEditor, { subject: node, snapshot: altered, actorId: 'actor-1', value: [],
      input: { targetId: altered.nodes[0]!.id, type: '', direction: '', rationale: '', evidenceIds: [] }, onInputChange: () => {}, onChange: () => {}, onError: () => {} }));
    expect(html).toContain('来源 ID 对应不同原句或身份');
    expect(html).not.toContain('type="checkbox"');
  });
});
