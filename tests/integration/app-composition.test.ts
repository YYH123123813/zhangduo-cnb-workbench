import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, PageOutlet } from '../../src/app/App';
import { parseRoute } from '../../src/app/routing';
import { TransientRetrieval } from '../../src/app/transient-retrieval';

const seen = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../../src/features/capture/client', () => ({ Page: (props: Record<string, unknown>) => { seen.set('capture', props); return null; } }));
vi.mock('../../src/features/handoff/client', () => ({ Page: (props: Record<string, unknown>) => { seen.set('handoff', props); return null; } }));
vi.mock('../../src/features/retrieval/client', () => ({ Page: (props: Record<string, unknown>) => { seen.set('retrieval', props); return null; } }));
vi.mock('../../src/features/learning/client', () => ({ Page: (props: Record<string, unknown>) => { seen.set('learning', props); return null; } }));
vi.mock('../../src/features/governance/client', () => ({ Page: (props: Record<string, unknown>) => { seen.set('governance', props); return null; } }));

beforeEach(() => seen.clear());
describe('W12 actual shared Page outlet bindings (static, not browser acceptance)', () => {
  it.each([
    ['#capture?conversationId=c1', 'capture', { routeParams: { conversationId: 'c1' } }],
    ['#handoff?conversationId=c1&draftId=d1&changeSetId=op1', 'handoff', { params: { conversationId: 'c1', draftId: 'd1', changeSetId: 'op1' } }],
    [`#retrieval?nodeId=k1&revision=${'a'.repeat(40)}`, 'retrieval', { nodeId: 'k1', revision: 'a'.repeat(40) }],
    ['#learning?taskId=t1&nodeId=k1', 'learning', { routeParams: { taskId: 't1', nodeId: 'k1' } }],
    [`#governance?nodeId=k1&revision=${'a'.repeat(40)}`, 'governance', { nodeId: 'k1', revision: 'a'.repeat(40) }],
    ['#governance?changeSetId=original-change', 'governance', { routeParams: { changeSetId: 'original-change' } }],
    ['#governance?planId=original-plan', 'governance', { routeParams: { planId: 'original-plan' } }],
    ['#governance?approvalId=original-approval', 'governance', { routeParams: { approvalId: 'original-approval' } }],
    ['#governance?draftId=d1&useId=use1&evidenceId=outcome1&taskId=t1', 'governance', { routeParams: { draftId: 'd1', useId: 'use1', evidenceId: 'outcome1', taskId: 't1' } }],
    ['#learning?taskId=t1&useId=use1&evidenceId=outcome1', 'learning', { routeParams: { taskId: 't1', useId: 'use1', evidenceId: 'outcome1' } }],
  ])('passes %s to its owned page without swallowing the query', (hash, page, expected) => {
    const registerLeaveGuard = vi.fn(() => () => undefined), onResult = vi.fn(), onInvalidateResult = vi.fn();
    renderToStaticMarkup(createElement(PageOutlet, { route: parseRoute(String(hash)), exchange: new TransientRetrieval(), registerLeaveGuard, onResult, onInvalidateResult }));
    expect(seen.get(String(page))).toMatchObject({ ...expected as object, registerLeaveGuard });
    if (page === 'retrieval') expect(seen.get('retrieval')).toMatchObject({ onResult, onInvalidateResult });
    expect(seen.size).toBe(1);
  });
  it('exposes five work areas, native navigation, current location and a focusable skip target', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="工作区"'); expect(html).toContain('href="#retrieval" aria-current="page"');
    expect(html).toContain('id="main-content"'); expect(html).toContain('tabindex="-1"'); expect(html).toContain('跳到主内容');
    expect(html).not.toContain('开发基线'); expect(html).not.toContain('集成骨架');
  });
});
