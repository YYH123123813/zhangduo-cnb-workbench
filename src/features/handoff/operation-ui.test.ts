import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OriginalOperationLookup, OperationSavePanel } from './OperationControls';
import { PreviewPanel } from './PreviewPanel';
import { draftFixture } from './testing/review';
import { buildChangeSet } from './changes';
import { readableDiff } from './preview';
import { snapshot } from './testing/knowledge';
import { context } from './testing/services';
import { time } from './testing/fixtures';
import type { HandoffOperationReceipt } from '../../contracts/handoff-operation';

describe('Original operation static semantics, not browser acceptance', () => {
  it('keeps private snapshot consent separate and unchecked, with read-only recovery after an unknown save', () => {
    const props = { consent: false, busy: false, unknown: false, saved: null, onConsent: vi.fn(), onSave: vi.fn(), onRead: vi.fn(), href: '#handoff' };
    const html = renderToStaticMarkup(createElement(OperationSavePanel, props));
    expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked=""');
    expect(html).toContain('30'); expect(html).not.toContain('Git 已保存');
    const pinned = renderToStaticMarkup(createElement(OperationSavePanel, { ...props, saved: { expiresAt: time } as HandoffOperationReceipt, onPin: vi.fn() }));
    expect(pinned).toContain('固定当前操作地址');
    const unknown = renderToStaticMarkup(createElement(OperationSavePanel, { ...props, unknown: true }));
    expect(unknown).toContain('核验原预览保存'); expect(unknown).not.toContain('保存本次原预览</button>');
  });
  it('offers named lookup and cancellation controls without any approval or commit action', () => {
    const html = renderToStaticMarkup(createElement(OriginalOperationLookup, { conversationId: 'source', initialChangeSetId: 'original' }));
    expect(html).toContain('原提交预览'); expect(html).toContain('恢复原预览');
    expect(html).not.toContain('提交到 Git'); expect(html).not.toContain('登记本次提交批准');
  });
  it('shows a restored preview as read-only and never calls a saved Git fact unsubmitted', async () => {
    const { draft, review } = draftFixture();
    const result = await buildChangeSet(draft, review, snapshot, context, 'original', 'Original reason', time);
    if (!result.ok) throw Error(result.error.message);
    const preview = { draft, changes: result.data, diff: readableDiff(result.data, snapshot, review.items[0]!.subject) };
    const html = renderToStaticMarkup(createElement(PreviewPanel, { preview, readOnly: true, gitState: 'saved' }));
    expect(html).toContain('只读'); expect(html).toContain('Git 已保存');
    expect(html).not.toContain('未写入 Git'); expect(html).not.toContain('返回修改');
  });
});
